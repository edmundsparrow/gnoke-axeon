/* ═══════════════════════════════════════════════════════════════
   gnoke-bridge.js — v1.2.1
   Traffic controller for GnokeDB + GnokeSync-lite

   PURPOSE:
   - Normalize events between DB and Sync
   - Prevent duplicate propagation loops
   - Enforce sync policies (priority, dedupe, batching logic)
   - Provide deterministic flow control

   PRINCIPLE:
   "No system talks directly. All movement passes through the Bridge."

   DEPENDENCIES (OPTIONAL HOOKS ONLY):
   - GnokeDB.onWrite
   - GnokeSync.onLogEvent

   ZERO HARD DEPENDENCY ON INTERNAL IMPLEMENTATION

   v1.1.0 fixes (no architecture changes):
   FIX 1 — _hash(): add ts fallback so undefined event.id never
            causes hash collisions across unrelated events.
   FIX 2 — normalizeDBEvent(): GnokeDB record.type is always
            insert/update/delete. Domain event types (CONFIRM_PAYMENT,
            REASSIGN_RIDER) live in the payload (record.p.type).
            Now resolves payload domain type first, storage type as
            fallback — so HIGH_PRIORITY routing actually fires.
   FIX 3 — _applyToDB(): UPDATE events must call db.update(), not
            db.save(). db.save() always inserts a new record.
            UPDATE now routes to db.update(entity, recordId, payload).
            Falls back to db.save() only if no record ID is present.
   FIX 4 — version string updated to v1.1.0 in init() return value.

   v1.2.0 fixes:
   FIX 5 — pendingOutbox persisted to localStorage. The in-memory Map
            was wiped on every page reload, meaning a DB write that
            hadn't synced yet would lose its echo-loop guard and could
            be re-applied to the DB when Sync replayed it after reload.
            Now uses the same load/save pattern as GnokeSync's queue.
   FIX 6 — DELETE guard: if recordId is missing the operation is now
            blocked, logged via console.warn, and dropped cleanly
            rather than silently passing undefined to db.remove().
═══════════════════════════════════════════════════════════════ */

(function (root) {
  'use strict';

  /* ────────────────────────────────────────────────────────────
     INTERNAL STATE
  ──────────────────────────────────────────────────────────── */

  const seen = new Set();            // prevents echo loops (session-scoped, intentional)

  // FIX 5 — pendingOutbox persisted to localStorage so the echo-loop
  // guard survives page reloads. Same load/save pattern as GnokeSync.
  const OUTBOX_KEY = 'gnoke_bridge_outbox';

  function _loadOutbox() {
    try { return new Map(JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []); }
    catch { return new Map(); }
  }

  function _saveOutbox(map) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify([...map])); }
    catch { /* localStorage full — outbox stays in memory this session */ }
  }

  let _cfg = {
    sync: null,
    db: null,
    enableAutoSync: true,
    dedupeWindowMs: 10_000,
  };

  /* ────────────────────────────────────────────────────────────
     UTILITY: SAFE HASH FOR DEDUPE
  ──────────────────────────────────────────────────────────── */

  // FIX 1 — event.id is undefined for some events (e.g. CREATE before
  // DB assigns an id, or Sync parcels with no record id). Falling back
  // to ts prevents multiple distinct events collapsing to the same hash.
  function _hash(event) {
    const stableId  = event.id || event.ts;
    const stableRef = event.payload?.id || event.entity || '';
    return `${stableId}:${event.type}:${stableRef}`;
  }

  function _isDuplicate(hash) {
    if (seen.has(hash)) return true;
    seen.add(hash);
    setTimeout(() => seen.delete(hash), _cfg.dedupeWindowMs);
    return false;
  }

  /* ────────────────────────────────────────────────────────────
     NORMALIZATION LAYER
  ──────────────────────────────────────────────────────────── */

  // FIX 2 — GnokeDB v1.1 onWrite emits:
  //   { collection, record: { id, type, ts, v, p }, timestamp }
  // record.type is always the storage operation: insert | update | delete.
  // Domain event types (CONFIRM_PAYMENT, REASSIGN_RIDER, etc.) are set
  // by the app inside the payload and stored under record.p.type.
  // Priority routing in _shouldSync() needs the domain type, not the
  // storage operation. Resolve payload domain type first; fall back to
  // storage type so INSERT/UPDATE/DELETE still flow through correctly.
  function normalizeDBEvent(evt) {
    const storageType = String(evt.record?.type || '').toUpperCase();
    const domainType  = String(evt.record?.p?.type || '').toUpperCase();

    return {
      source:  'db',
      type:    domainType || storageType,   // domain first, storage as fallback
      opType:  storageType,                 // always the raw DB operation
      entity:  evt.collection,
      id:      evt.record?.id,
      payload: evt.record?.p || {},
      ts:      evt.timestamp || Date.now()
    };
  }

  function normalizeSyncEvent(type, entity, payload, parcel) {
    return {
      source:  'sync',
      type:    String(type).toUpperCase(),
      entity,
      id:      parcel?.id,
      payload,
      ts:      Date.now()
    };
  }

  /* ────────────────────────────────────────────────────────────
     DB → SYNC FLOW
  ──────────────────────────────────────────────────────────── */

  function onDBWrite(evt) {
    const event = normalizeDBEvent(evt);
    const hash  = _hash(event);

    if (_isDuplicate(hash)) return;

    // store pending outbound event
    const pendingOutbox = _loadOutbox();
    pendingOutbox.set(event.id, event);
    _saveOutbox(pendingOutbox);

    // decide if it should sync immediately
    if (_shouldSync(event)) {
      _dispatchToSync(event);
    }
  }

  function _shouldSync(event) {
    if (!_cfg.enableAutoSync) return false;

    const HIGH_PRIORITY = [
      'CONFIRM_PAYMENT',
      'DELETE',
      'REASSIGN_RIDER'
    ];

    // After FIX 2, event.type is the domain type (e.g. CONFIRM_PAYMENT)
    // so this comparison now works as intended.
    return HIGH_PRIORITY.includes(event.type);
  }

  function _dispatchToSync(event) {
    if (!_cfg.sync) return;

    _cfg.sync.logEvent(
      event.type,
      event.entity,
      {
        ...event.payload,
        __bridge_id: event.id
      }
    );
  }

  /* ────────────────────────────────────────────────────────────
     SYNC → DB FLOW
  ──────────────────────────────────────────────────────────── */

  function onSyncEvent(type, entity, payload, parcel) {
    const event = normalizeSyncEvent(type, entity, payload, parcel);
    const hash  = _hash(event);

    if (_isDuplicate(hash)) return;

    // prevent echo loop: if this originated from DB, ignore
    if (payload?.__bridge_id) {
      const pendingOutbox = _loadOutbox();
      if (pendingOutbox.has(payload.__bridge_id)) {
        pendingOutbox.delete(payload.__bridge_id);
        _saveOutbox(pendingOutbox);
        return;
      }
    }

    // Apply safe write back into DB
    _applyToDB(event);
  }

  function _applyToDB(event) {
    if (!_cfg.db) return;

    // FIX 3 — db.save() always appends a new insert record.
    // UPDATE events must use db.update(collection, id, payload)
    // so the log correctly records an update against the existing id.
    // Record ID precedence: payload carries it from the server;
    // parcel id (event.id) is a fallback for bridge-originated events.
    const recordId = event.payload?.id || event.id;

    switch (event.type) {
      case 'CREATE':
        _cfg.db.save(event.entity, event.payload);
        break;

      case 'UPDATE':
        if (recordId) {
          _cfg.db.update(event.entity, recordId, event.payload);
        } else {
          // No id available — safe-insert rather than silently drop
          _cfg.db.save(event.entity, event.payload);
        }
        break;

      case 'DELETE':
        if (!recordId) {
          console.warn('[gnoke-bridge] DELETE blocked — no recordId resolved.', event);
          break;
        }
        _cfg.db.remove(event.entity, recordId);
        break;

      default:
        // ignore unknown types safely
        break;
    }
  }

  /* ────────────────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────────────────── */

  function init(config) {
    _cfg.db            = config.db            || null;
    _cfg.sync          = config.sync          || null;
    _cfg.enableAutoSync = config.enableAutoSync ?? true;
    _cfg.dedupeWindowMs = config.dedupeWindowMs ?? 10000;

    // Attach hooks (non-invasive)
    if (_cfg.db?.configure) {
      _cfg.db.configure({
        onWrite: onDBWrite
      });
    }

    if (_cfg.sync?.init) {
      _cfg.sync.init({
        onLogEvent: onSyncEvent
      });
    }

    // FIX 4 — version string
    return {
      ready:  true,
      bridge: 'gnoke-bridge-v1.2.1'
    };
  }

  function forceSync() {
    if (!_cfg.sync) return;
    return _cfg.sync.push();
  }

  function forcePull() {
    if (!_cfg.sync) return;
    return _cfg.sync.pull();
  }

  function getPending() {
    return Array.from(_loadOutbox().values());
  }

  /* ────────────────────────────────────────────────────────────
     EXPORT
  ──────────────────────────────────────────────────────────── */

  root.GnokeBridge = Object.freeze({
    init,
    forceSync,
    forcePull,
    getPending
  });

})(typeof self !== 'undefined' ? self : window);