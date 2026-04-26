/* ═══════════════════════════════════════════════════════════════
   gnoke-db.js — v1.3.2
   Local-first persistence layer for web apps.
   Filesystem is the source of truth. RAM mirror is the fast path.
   ───────────────────────────────────────────────────────────────
   Edmund Sparrow © 2026 — MIT License
   Part of the Gnoke Suite

   Architecture:
   - Each collection is a .jsonl file in the mounted folder
   - Every write (insert/update/delete) is an appended event
   - open() replays each .jsonl once into a per-collection Map (_ram)
   - query() serves directly from _ram — O(1) per record, zero disk reads
   - save/update/remove mutate _ram immediately, then append to disk
   - _gnoke.json tracks manifest: version, created, collections

   Record format (one line per record in .jsonl):
   {"id":"...","type":"insert|update|delete","ts":1234,"v":1,"p":{}}

   Stability guarantees:
   - Per-file write queue prevents concurrent stream corruption
   - Shelf (IndexedDB) catches writes when native FS fails
   - open() drains shelf before resolving — no write is lost silently
   - Pending writes tagged __pending=true in RAM until disk confirms
   - hasPendingWrites(collection?) exposes persistence state to callers

   v1.1.0 changes:
   - configure() accepts onWrite, onRecover, onQuery hooks
   - _append() emits onWrite after confirmed native write
   - _drainShelf() emits onRecover per recovered item
   - query() emits onQuery with collection + result count

   v1.2.0 changes:
   - _ram: Map<collection, Map<id, record>> — loaded once at open()
   - _lineCount: Map<collection, number> — raw line count per file
   - query() reads from _ram, zero disk I/O
   - save/update/remove mutate _ram before async disk write
   - _replayFile() — shared boot and recovery helper
   - _compact() — triggered at COMPACT_THRESHOLD lines
   - onCompact hook added to configure()

   v1.3.0 changes (firmware-grade hardening):

   FIX 1 — onCompact hook received previousLineCount=0 because the
            counter was overwritten before the hook fired. Now captured
            into `prev` before any mutation and passed correctly.

   FIX 2 — Compaction is now crash-resilient via dual-file strategy.
            Instead of truncating the live file in place, _compact():
              1. Writes full snapshot to <collection>.compact.tmp
              2. Deletes the original .jsonl
              3. Writes a fresh .jsonl from the .tmp content
              4. Deletes the .tmp
            Worst-case crash scenarios:
              - Crash after step 1: .tmp exists, original intact → safe
              - Crash after step 2: .tmp exists, no .jsonl → open()
                detects orphan .tmp via _recoverCompactTmp() and
                promotes it to .jsonl before booting RAM
              - Crash after step 3: both exist → open() deletes stale
                .tmp (fresh .jsonl already complete)
            _recoverCompactTmp() runs in open() before _bootRAM().

   FIX 3 — RAM ↔ Disk divergence made visible. Records written to
            _ram before disk confirmation are tagged __pending=true.
            On confirmed disk write (or shelf recovery), __pending is
            removed. hasPendingWrites(collection?) returns true if any
            live record in _ram still carries the tag. This lets the
            UI surface "saving…" state and lets the SharedWorker (Phase
            3) know which records are not yet durable.
   v1.3.1 changes (atomic integrity):

   FIX 4 — _compact() was snapshotting __pending records, writing
            speculative data to disk as if it were confirmed truth.
            Snapshot now filters to confirmed records only:
              [...map.values()].filter(rec => !rec.__pending)
            Pending records remain in RAM and the shelf. After recovery,
            _drainShelf() appends them to the compacted file normally.
            Disk is now a strict subset of confirmed RAM — never ahead,
            never speculative. This is the firmware-grade persistence rule.

   v1.3.2 changes (scoped pending-delete fix):

   FIX 5 — _pendingDeletes was a Set<id>. hasPendingWrites(collection)
            checked _pendingDeletes.size > 0 before any collection scoping,
            so a pending delete in 'bookings' caused hasPendingWrites('riders')
            to return true — a false positive. Changed _pendingDeletes to a
            Map<id, collection>. remove() now stores the collection alongside
            the id. hasPendingWrites(collection) filters the Map by collection
            before checking. Global check (no argument) is unchanged.
═══════════════════════════════════════════════════════════════ */

const GnokeDB = (() => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const VERSION           = '1.3.2';
  const MANIFEST          = '_gnoke.json';
  const DB_NAME           = 'gnoke-db-shadow';
  const DB_VERSION        = 1;
  const COMPACT_THRESHOLD = 500;    // log lines before compaction fires
  const TMP_SUFFIX        = '.compact.tmp';

  // ── Hooks (optional) ─────────────────────────────────────────
  let onError      = (ctx, err) => console.error(`GnokeDB [${ctx}]:`, err);
  let onReady      = ()         => {};
  let onRecovered  = (n)        => {};
  let onWrite      = null;   // fn({ collection, record, timestamp })
  let onRecover    = null;   // fn({ file, line })
  let onQuery      = null;   // fn({ collection, count })
  let onCompact    = null;   // fn({ collection, recordCount, previousLineCount })

  // ── Internal state ───────────────────────────────────────────
  let _handle  = null;
  let _idb     = null;
  let _queues  = {};
  let _ready   = false;

  // RAM mirror
  const _ram          = new Map();   // Map<collection, Map<id, record>>
  const _lineCount    = new Map();   // Map<collection, number>
  const _pendingDeletes = new Map(); // Map<id, collection> of delete ops not yet confirmed to disk

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  async function open() {
    _idb = await _openIDB();

    const stored = await _idbGet('handles', 'workspace');
    if (stored) {
      const perm = await stored.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        _handle = stored;
      } else {
        const req = await stored.requestPermission({ mode: 'readwrite' });
        _handle = req === 'granted' ? stored : null;
      }
    }

    if (!_handle) {
      try {
        _handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await _idbPut('handles', _handle, 'workspace');
        await _writeManifest();
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('GnokeDB: Folder selection cancelled.');
        throw err;
      }
    }

    // FIX 2 — recover any orphaned .compact.tmp files from a previous
    // crash before we boot RAM from the .jsonl files.
    await _recoverCompactTmp();

    // Boot RAM mirror (replay all .jsonl files once)
    await _bootRAM();

    // Drain shelf into live RAM
    const recovered = await _drainShelf();
    if (recovered > 0) onRecovered(recovered);

    _ready = true;
    onReady();

    return { version: VERSION, folder: _handle.name };
  }

  // ── save() ──────────────────────────────────────────────────
  async function save(collection, payload) {
    _assertReady();
    const id  = _uid();
    const rec = _envelope(id, 'insert', payload);

    // FIX 3 — tag as pending before RAM apply
    rec.__pending = true;
    _ramApply(collection, rec);

    await _append(collection, rec);
    return id;
  }

  // ── update() ────────────────────────────────────────────────
  async function update(collection, id, payload) {
    _assertReady();
    if (!id) throw new Error('GnokeDB.update: id is required.');
    const rec = _envelope(id, 'update', payload);

    rec.__pending = true;
    _ramApply(collection, rec);

    await _append(collection, rec);
    return id;
  }

  // ── remove() ────────────────────────────────────────────────
  // For deletes, _ramApply removes the record from the Map entirely,
  // so there is nothing left to tag. We track pending deletes via
  // _pendingDeletes so hasPendingWrites() can still report them.
  async function remove(collection, id) {
    _assertReady();
    if (!id) throw new Error('GnokeDB.remove: id is required.');
    const rec = _envelope(id, 'delete', null);

    _pendingDeletes.set(id, collection);
    _ramApply(collection, rec);

    await _append(collection, rec);
    return id;
  }

  // ── query() ─────────────────────────────────────────────────
  // Reads from _ram — zero disk I/O.
  // __pending tags are present in returned records; callers may
  // inspect rec.__pending to render an unsaved indicator in UI.
  async function query(collection, filter) {
    _assertReady();

    if (!_ram.has(collection)) {
      await _replayFile(collection);
    }

    let results = [..._ram.get(collection).values()];
    if (typeof filter === 'function') results = results.filter(filter);

    onQuery?.({ collection, count: results.length });
    return results;
  }

  // ── hasPendingWrites(collection?) ───────────────────────────
  // Returns true if any record in RAM has not yet been confirmed to disk.
  // Pass a collection name to scope the check, or omit for all collections.
  // FIX 3 — exposes RAM ↔ Disk divergence state.
  // FIX 5 — scoped pending-delete check. _pendingDeletes is now a
  // Map<id, collection> so we can filter by collection correctly.
  function hasPendingWrites(collection) {
    if (collection) {
      // Check pending deletes scoped to this collection only
      for (const col of _pendingDeletes.values()) {
        if (col === collection) return true;
      }
      // Check pending RAM writes for this collection
      const map = _ram.get(collection);
      if (!map) return false;
      for (const rec of map.values()) {
        if (rec.__pending) return true;
      }
      return false;
    }

    // Global check — any collection
    if (_pendingDeletes.size > 0) return true;
    for (const map of _ram.values()) {
      for (const rec of map.values()) {
        if (rec.__pending) return true;
      }
    }
    return false;
  }

  // ── drop() ──────────────────────────────────────────────────
  async function drop(collection) {
    _assertReady();
    try {
      await _handle.removeEntry(_filename(collection));
      _ram.delete(collection);
      _lineCount.delete(collection);
    } catch (err) {
      onError('drop', err);
    }
  }

  // ── collections() ───────────────────────────────────────────
  async function collections() {
    _assertReady();
    const names = [];
    for await (const [name] of _handle.entries()) {
      if (name.endsWith('.jsonl')) names.push(name.replace('.jsonl', ''));
    }
    return names;
  }

  // ── configure() ─────────────────────────────────────────────
  function configure(opts = {}) {
    if (typeof opts.onError     === 'function') onError     = opts.onError;
    if (typeof opts.onReady     === 'function') onReady     = opts.onReady;
    if (typeof opts.onRecovered === 'function') onRecovered = opts.onRecovered;
    if (typeof opts.onWrite     === 'function') onWrite     = opts.onWrite;
    if (typeof opts.onRecover   === 'function') onRecover   = opts.onRecover;
    if (typeof opts.onQuery     === 'function') onQuery     = opts.onQuery;
    if (typeof opts.onCompact   === 'function') onCompact   = opts.onCompact;
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — RAM Mirror
  // ════════════════════════════════════════════════════════════

  async function _bootRAM() {
    try {
      for await (const [name] of _handle.entries()) {
        if (!name.endsWith('.jsonl')) continue;
        const collection = name.replace('.jsonl', '');
        await _replayFile(collection);
      }
    } catch (err) {
      onError('bootRAM', err);
    }
  }

  async function _replayFile(collection) {
    const map  = new Map();
    const file = _filename(collection);
    let   lines = 0;

    try {
      const fh   = await _handle.getFileHandle(file, { create: true });
      const f    = await fh.getFile();
      const text = await f.text();

      for (const line of text.split('\n')) {
        const rec = _parseLine(line);
        if (!rec) continue;
        lines++;
        _applyToMap(map, rec);
      }
    } catch (err) {
      onError('replayFile', err);
    }

    _ram.set(collection, map);
    _lineCount.set(collection, lines);
  }

  function _ramApply(collection, rec) {
    if (!_ram.has(collection)) _ram.set(collection, new Map());
    _applyToMap(_ram.get(collection), rec);
  }

  // _applyToMap: single source of truth for merge logic.
  // Used by both _replayFile (boot) and _ramApply (live writes).
  // Keeping these identical is non-negotiable — any divergence
  // between boot state and runtime state is a latent bug.
  function _applyToMap(map, rec) {
    if (rec.type === 'delete') {
      map.delete(rec.id);
    } else {
      const existing = map.get(rec.id);
      if (existing && rec.type === 'update') {
        map.set(rec.id, { ...existing, ...rec, p: { ...existing.p, ...rec.p } });
      } else {
        map.set(rec.id, rec);
      }
    }
  }

  function _clearPending(rec) {
    if (rec) delete rec.__pending;
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Compaction (FIX 1 + FIX 2)
  // ════════════════════════════════════════════════════════════

  // ── _recoverCompactTmp() ─────────────────────────────────────
  // Runs at open() before _bootRAM(). Handles three crash scenarios:
  //
  //   Scenario A — crash after tmp written, original still exists:
  //     Both files present. .jsonl is intact. Discard .tmp.
  //
  //   Scenario B — crash after original deleted, before .jsonl rewritten:
  //     Only .tmp present. Promote .tmp → .jsonl.
  //
  //   Scenario C — crash after .jsonl fully rewritten, .tmp still present:
  //     Both present. Cannot distinguish from A without a generation
  //     counter. Safe default: keep .jsonl (more recently written), discard .tmp.
  async function _recoverCompactTmp() {
    try {
      const tmpFiles = [];
      for await (const [name] of _handle.entries()) {
        if (name.endsWith(TMP_SUFFIX)) tmpFiles.push(name);
      }

      for (const tmpName of tmpFiles) {
        const baseName = tmpName.slice(0, -TMP_SUFFIX.length) + '.jsonl';
        let jsonlExists = false;

        try {
          await _handle.getFileHandle(baseName);
          jsonlExists = true;
        } catch { /* not found */ }

        if (jsonlExists) {
          // Scenario A or C — .jsonl intact, discard stale .tmp
          try { await _handle.removeEntry(tmpName); } catch { /* ignore */ }
        } else {
          // Scenario B — promote .tmp to .jsonl
          try {
            const tmpFh      = await _handle.getFileHandle(tmpName);
            const tmpContent = await (await tmpFh.getFile()).text();

            const newFh      = await _handle.getFileHandle(baseName, { create: true });
            const writable   = await newFh.createWritable({ keepExistingData: false });
            await writable.write(tmpContent);
            await writable.close();

            await _handle.removeEntry(tmpName);
          } catch (err) {
            onError('recoverCompactTmp', err);
          }
        }
      }
    } catch (err) {
      onError('recoverCompactTmp', err);
    }
  }

  // ── _compact(collection) ─────────────────────────────────────
  // FIX 1: `prev` captured before any mutation.
  // FIX 2: dual-file write — snapshot goes to .compact.tmp first.
  //
  // Steps:
  //   1. Write snapshot → <collection>.compact.tmp
  //   2. Delete original .jsonl
  //   3. Write fresh .jsonl from snapshot
  //   4. Delete .tmp
  //
  // __pending tags are stripped from the snapshot — they are a
  // runtime concept only and must never appear in the log file.
  async function _compact(collection) {
    const map = _ram.get(collection);

    // FIX 1 — capture BEFORE any mutation
    const previousLineCount = _lineCount.get(collection) || 0;

    if (!map || map.size === 0) {
      await _truncateFile(_filename(collection));
      _lineCount.set(collection, 0);
      onCompact?.({ collection, recordCount: 0, previousLineCount });
      return;
    }

    // Only snapshot records confirmed to disk (__pending records are still
    // in the shelf and will append naturally after recovery — snapshotting
    // them would write speculative data as if it were durable truth).
    const snapshot = [...map.values()]
      .filter(rec => !rec.__pending)
      .map(rec => {
        const clean = { ...rec };
        delete clean.__pending;
        return JSON.stringify({ ...clean, type: 'insert' }) + '\n';
      })
      .join('');

    const tmpName   = _filename(collection).replace('.jsonl', '') + TMP_SUFFIX;
    const jsonlName = _filename(collection);

    try {
      // Step 1
      const tmpFh       = await _handle.getFileHandle(tmpName, { create: true });
      const tmpWritable = await tmpFh.createWritable({ keepExistingData: false });
      await tmpWritable.write(snapshot);
      await tmpWritable.close();

      // Step 2
      await _handle.removeEntry(jsonlName);

      // Step 3
      const newFh       = await _handle.getFileHandle(jsonlName, { create: true });
      const newWritable = await newFh.createWritable({ keepExistingData: false });
      await newWritable.write(snapshot);
      await newWritable.close();

      // Step 4
      await _handle.removeEntry(tmpName);

      _lineCount.set(collection, map.size);
      onCompact?.({ collection, recordCount: map.size, previousLineCount });

    } catch (err) {
      onError('compact', err);
      // _recoverCompactTmp() handles cleanup on next open().
    }
  }

  async function _truncateFile(filename) {
    try {
      const fh       = await _handle.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable({ keepExistingData: false });
      await writable.close();
    } catch (err) {
      onError('truncate', err);
    }
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Write pipeline
  // ════════════════════════════════════════════════════════════

  function _append(collection, rec) {
    const file = _filename(collection);

    // Strip __pending before writing to disk — runtime tag only.
    const diskRec = { ...rec };
    delete diskRec.__pending;
    const line = JSON.stringify(diskRec) + '\n';

    const prev = _queues[file] || Promise.resolve();

    _queues[file] = prev
      .then(() => _nativeAppend(file, line))
      .then(() => {
        // Disk confirmed — clear pending tag from the live RAM record.
        // FIX 3: look up the current live record by id and clear the tag.
        if (rec.type !== 'delete') {
          const map  = _ram.get(collection);
          const live = map?.get(rec.id);
          if (live) _clearPending(live);
        } else {
          _pendingDeletes.delete(rec.id);
        }

        const count = (_lineCount.get(collection) || 0) + 1;
        _lineCount.set(collection, count);

        onWrite?.({ collection, record: diskRec, timestamp: Date.now() });

        if (count > COMPACT_THRESHOLD) {
          _queues[file] = _queues[file].then(() => _compact(collection));
        }
      })
      .catch(async () => {
        // Native write failed — shelf it.
        // Record stays __pending in RAM until shelf drain confirms it.
        try {
          await _idbAdd('shelf', { file, line, ts: Date.now() });
        } catch (e) {
          onError('shelf', e);
        }
      });

    return _queues[file];
  }

  async function _nativeAppend(filename, line) {
    try {
      const fh       = await _handle.getFileHandle(filename, { create: true });
      const existing = await (await fh.getFile()).size;
      const writable = await fh.createWritable({ keepExistingData: true });
      await writable.seek(existing);
      await writable.write(line);
      await writable.close();
    } catch (err) {
      onError('nativeAppend', err);
      throw err;
    }
  }

  // ── Shelf drain ──────────────────────────────────────────────
  // v1.3: clears __pending from the RAM record after disk confirms.
  async function _drainShelf() {
    const pending = await _idbGetAll('shelf');
    if (!pending.length) return 0;

    let recovered = 0;
    for (const item of pending) {
      try {
        await _nativeAppend(item.file, item.line);
        await _idbDelete('shelf', item.id);

        const rec = _parseLine(item.line);
        if (rec) {
          const collection = item.file.replace('.jsonl', '');

          // Apply to RAM defensively (should already be there)
          _ramApply(collection, rec);

          // FIX 3 — clear pending tag now that disk has confirmed it
          if (rec.type !== 'delete') {
            const map  = _ram.get(collection);
            const live = map?.get(rec.id);
            if (live) _clearPending(live);
          } else {
            _pendingDeletes.delete(rec.id);
          }

          const count = (_lineCount.get(collection) || 0) + 1;
          _lineCount.set(collection, count);
        }

        onRecover?.({ file: item.file, line: item.line });
        recovered++;
      } catch {
        break;
      }
    }
    return recovered;
  }

  // ── Manifest ─────────────────────────────────────────────────
  async function _writeManifest() {
    try {
      const manifest = {
        gnoke  : VERSION,
        created: new Date().toISOString(),
        note   : 'This folder is managed by GnokeDB. Each .jsonl file is a collection.'
      };
      const fh       = await _handle.getFileHandle(MANIFEST, { create: true });
      const writable = await fh.createWritable();
      await writable.write(JSON.stringify(manifest, null, 2));
      await writable.close();
    } catch (err) {
      onError('manifest', err);
    }
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — IndexedDB (shadow shelf)
  // ════════════════════════════════════════════════════════════

  function _openIDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles');
        }
        if (!db.objectStoreNames.contains('shelf')) {
          db.createObjectStore('shelf', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = ()  => rej(req.error);
    });
  }

  function _idbGet(store, key) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbPut(store, value, key) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).put(value, key);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbAdd(store, value) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).add(value);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbGetAll(store) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => res(req.result ?? []);
      req.onerror   = () => rej(req.error);
    });
  }

  function _idbDelete(store, key) {
    return new Promise((res, rej) => {
      const req = _idb.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Utilities
  // ════════════════════════════════════════════════════════════

  function _uid() {
    return 'gdb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function _filename(collection) {
    return collection.replace(/[^a-z0-9_-]/gi, '_') + '.jsonl';
  }

  function _envelope(id, type, payload) {
    return { id, type, ts: Date.now(), v: 1, p: payload };
  }

  function _parseLine(line) {
    if (!line.trim()) return null;
    try { return JSON.parse(line); }
    catch { return null; }
  }

  function _assertReady() {
    if (!_ready) throw new Error('GnokeDB: call open() before using the database.');
  }

  // ── Expose ───────────────────────────────────────────────────
  return { open, save, update, remove, query, drop, collections, configure, hasPendingWrites };

})();

// Browser global — works as <script src> or ES module
if (typeof window !== 'undefined') window.GnokeDB = GnokeDB;
if (typeof module !== 'undefined') module.exports = GnokeDB;
