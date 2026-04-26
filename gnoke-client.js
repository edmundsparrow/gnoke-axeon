/* ═══════════════════════════════════════════════════════════════
   gnoke-client.js — v1.0.0
   Thin client stub. Connects app tabs to the gnoke-worker.js kernel.
   ───────────────────────────────────────────────────────────────
   Edmund Sparrow © 2026 — MIT License
   Part of the Gnoke Suite

   USAGE (in any app tab):

     // 1. Connect
     await GnokeClient.connect();

     // 2. Use — same shape as GnokeDB direct calls
     const id = await GnokeClient.save('bookings', { name: 'Adaeze' });
     const rows = await GnokeClient.query('bookings');
     await GnokeClient.update('bookings', id, { status: 'confirmed' });
     await GnokeClient.remove('bookings', id);

     // 3. Listen for changes from other tabs
     GnokeClient.onStateUpdate((collection, op, id, record) => {
       if (collection === 'bookings') renderBookings();
     });

     // 4. Listen for master list overwrites (riders, branches)
     GnokeClient.onMasterUpdate((entity, items) => {
       if (entity === 'riders') setRiders(items);
     });

     // 5. Force sync / pull manually (usually automatic)
     await GnokeClient.sync();
     await GnokeClient.pull();

     // 6. Check persistence state
     const dirty = await GnokeClient.hasPendingWrites('bookings');

   BROADCAST EVENTS:
     STATE_UPDATED  → onStateUpdate listeners fire
     MASTER_UPDATE  → onMasterUpdate listeners fire
     SYNC_STATUS    → onSyncStatus listeners fire

   FILTER SUPPORT:
     query() accepts an optional filter function. It is serialized as
     a string and reconstructed inside the worker. Keep filters simple
     — they must be self-contained (no closure variables from the tab).

     Example:
       const open = await GnokeClient.query(
         'bookings',
         rec => rec.p?.status === 'open'
       );

   FALLBACK (SharedWorker not supported):
     IE and some older Androids do not support SharedWorker. If
     GnokeClient detects this, it falls back to direct GnokeDB calls
     in the same tab. The API surface is identical. State is not shared
     across tabs in fallback mode — it degrades to v1.2 behaviour.

   REQUIREMENTS:
     - Served over HTTPS or localhost (SharedWorker restriction)
     - gnoke-worker.js reachable at WORKER_PATH (configure below)
     - gnoke-db.js loaded in the tab only if SharedWorker is unavailable
═══════════════════════════════════════════════════════════════ */

const GnokeClient = (() => {
  'use strict';

  // ── Configuration ────────────────────────────────────────────
  // Adjust WORKER_PATH if your file layout differs.
  const WORKER_PATH = '/gnoke-worker.js';

  // ── Internal state ───────────────────────────────────────────
  let _port            = null;   // MessagePort to the SharedWorker
  let _worker          = null;   // SharedWorker instance (null in fallback)
  let _fallback        = false;  // true if SharedWorker unavailable
  let _connected       = false;
  let _connectPromise  = null;

  // Pending request map: _id → { resolve, reject }
  const _pending = new Map();

  // Broadcast listener registries
  const _stateListeners  = new Set();  // STATE_UPDATED
  const _masterListeners = new Set();  // MASTER_UPDATE
  const _syncListeners   = new Set();  // SYNC_STATUS

  // ── ID generator ─────────────────────────────────────────────
  let _seq = 0;
  function _uid() {
    return `gc_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC — connect()
     Call once per tab, before any other method.
     Returns a Promise that resolves when the worker is booted
     and the DB is open and ready.
  ════════════════════════════════════════════════════════════ */

  function connect() {
    if (_connectPromise) return _connectPromise;

    _connectPromise = (async () => {
      if (!('SharedWorker' in self || 'SharedWorker' in window)) {
        // Fallback — SharedWorker not supported in this browser.
        // Requires gnoke-db.js to be loaded as a <script> in the tab.
        console.warn('[gnoke-client] SharedWorker unavailable — falling back to direct GnokeDB.');
        _fallback = true;
        await GnokeDB.open();
        _connected = true;
        return;
      }

      _worker = new SharedWorker(WORKER_PATH);
      _port   = _worker.port;

      _port.onmessage = _onMessage;
      _port.start();

      // Send OPEN — waits for worker boot + GnokeDB.open() to resolve.
      await _send({ cmd: 'OPEN' });
      _connected = true;
    })();

    return _connectPromise;
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC — DB operations
     API matches GnokeDB exactly. Transparent to callers.
  ════════════════════════════════════════════════════════════ */

  async function save(collection, payload) {
    _assertConnected();
    if (_fallback) return GnokeDB.save(collection, payload);
    const { id } = await _send({ cmd: 'SAVE', collection, payload });
    return id;
  }

  async function update(collection, id, payload) {
    _assertConnected();
    if (_fallback) return GnokeDB.update(collection, id, payload);
    await _send({ cmd: 'UPDATE', collection, id, payload });
    return id;
  }

  async function remove(collection, id) {
    _assertConnected();
    if (_fallback) return GnokeDB.remove(collection, id);
    await _send({ cmd: 'REMOVE', collection, id });
    return id;
  }

  // filter must be a self-contained function (no closure variables).
  // It is serialised with .toString() and eval'd in the worker.
  async function query(collection, filter) {
    _assertConnected();
    if (_fallback) return GnokeDB.query(collection, filter);
    const msg = { cmd: 'QUERY', collection };
    if (typeof filter === 'function') msg.filter = filter.toString();
    const { results } = await _send(msg);
    return results;
  }

  async function hasPendingWrites(collection) {
    _assertConnected();
    if (_fallback) return GnokeDB.hasPendingWrites(collection);
    const { hasPending } = await _send({ cmd: 'PENDING', collection });
    return hasPending;
  }

  async function sync() {
    _assertConnected();
    if (_fallback) return;
    return _send({ cmd: 'SYNC' });
  }

  async function pull() {
    _assertConnected();
    if (_fallback) return;
    return _send({ cmd: 'PULL' });
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC — Broadcast listeners
     Register callbacks to react to worker-originated events.
     All listeners are fire-and-forget from the worker's side —
     the worker does not wait for listeners to complete.
  ════════════════════════════════════════════════════════════ */

  // Fires when any tab writes to any collection.
  // fn(collection, op, id, record)
  //   op: 'save' | 'update' | 'remove'
  //   record: the payload that was written (undefined for remove)
  function onStateUpdate(fn) {
    if (typeof fn === 'function') _stateListeners.add(fn);
    return () => _stateListeners.delete(fn);  // returns an unsubscribe fn
  }

  // Fires when pull() receives a master list overwrite from the server.
  // fn(entity, items)
  //   entity: 'riders' | 'branches'
  //   items: the full server-authoritative array
  function onMasterUpdate(fn) {
    if (typeof fn === 'function') _masterListeners.add(fn);
    return () => _masterListeners.delete(fn);
  }

  // Fires after each push() cycle.
  // fn(pendingCount)
  function onSyncStatus(fn) {
    if (typeof fn === 'function') _syncListeners.add(fn);
    return () => _syncListeners.delete(fn);
  }

  /* ════════════════════════════════════════════════════════════
     INTERNAL — message handling
  ════════════════════════════════════════════════════════════ */

  function _onMessage(evt) {
    const msg = evt.data;
    if (!msg) return;

    // Broadcast — no _id, routes to registered listeners.
    if (msg.broadcast) {
      _handleBroadcast(msg);
      return;
    }

    // Response — matched to a pending request by _id.
    if (msg._id) {
      const pending = _pending.get(msg._id);
      if (!pending) return;
      _pending.delete(msg._id);

      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || 'Worker error'));
      }
    }
  }

  function _handleBroadcast(msg) {
    switch (msg.broadcast) {
      case 'STATE_UPDATED':
        for (const fn of _stateListeners) {
          try { fn(msg.collection, msg.op, msg.id, msg.record); } catch { /* listener error */ }
        }
        break;

      case 'MASTER_UPDATE':
        for (const fn of _masterListeners) {
          try { fn(msg.entity, msg.items); } catch { /* listener error */ }
        }
        break;

      case 'SYNC_STATUS':
        for (const fn of _syncListeners) {
          try { fn(msg.pending); } catch { /* listener error */ }
        }
        break;
    }
  }

  /* ════════════════════════════════════════════════════════════
     INTERNAL — request/response over postMessage
  ════════════════════════════════════════════════════════════ */

  function _send(msg) {
    return new Promise((resolve, reject) => {
      const _id = _uid();
      _pending.set(_id, { resolve, reject });

      try {
        _port.postMessage({ ...msg, _id });
      } catch (err) {
        _pending.delete(_id);
        reject(err);
      }
    });
  }

  function _assertConnected() {
    if (!_connected) {
      throw new Error('[gnoke-client] Call connect() before using GnokeClient.');
    }
  }

  /* ════════════════════════════════════════════════════════════
     EXPORT
  ════════════════════════════════════════════════════════════ */

  return Object.freeze({
    connect,
    save,
    update,
    remove,
    query,
    hasPendingWrites,
    sync,
    pull,
    onStateUpdate,
    onMasterUpdate,
    onSyncStatus,
  });

})();

// Browser global
if (typeof window !== 'undefined') window.GnokeClient = GnokeClient;



