/* ═══════════════════════════════════════════════════════════════
   gnoke-sync-lite  v1.2
   Offline-first, branch-scoped event courier.
   ─────────────────────────────────────────────────────────────
   PRINCIPLE  :  No shared state. Only shared events.
   DEVICE     :  Execution unit  (offline-first)
   SERVER     :  Event collector + branch filter
   SYNC       :  Delayed courier delivery

   MENTAL MODEL
     Device = Truck  │  Event = Parcel
     Server = Depot  │  Sync  = Delivery

   PUBLIC API
     GnokeSync.init(cfg)            → configure (call after identity resolves)
     GnokeSync.logEvent(type,e,p)   → queue event locally — no network
     GnokeSync.push()               → chunk + dispatch queued events
     GnokeSync.pull()               → branch-scoped fetch + master overwrite
     GnokeSync.authorize(token)     → activate QR sync token
     GnokeSync.start(ms?)           → begin push loop (default 30 s)
     GnokeSync.isReady()            → true if endpoint + QR auth both set
     GnokeSync.getQueueSnapshot()   → read-only copy of current queue (v1.2)
     GnokeSync.T                    → event-type constants
   RULES
     • branchId MUST be resolved before init() is called
     • push() is a no-op if not authorised or no endpoint
     • pull() hard-overwrites master lists (riders, branches)
     • Max 10 events per request — protects low-end devices on 2G
     • App runs fine with no backend — every public fn is safe to call

   v1.2 changes (bridge-readiness, non-breaking):
     • init() now accepts an optional onLogEvent hook
     • logEvent() emits onLogEvent after the queue write
     • getQueueSnapshot() exposes a read-only copy of the queue
     • All new surface is optional; existing behaviour unchanged

   Designed to be reused across Gnoke webapps.
   Zero dependencies. No build step required.
═══════════════════════════════════════════════════════════════ */

(function (root) {
  'use strict';

  /* ── CONSTANTS ────────────────────────────────────────────── */

  const QUEUE_KEY = 'gnoke_sync_queue';
  const AUTH_KEY  = 'gnoke_sync_auth';
  const MAX_CHUNK = 10; // 2G-safe batch ceiling per spec

  /** Event types — use explicit domain events; never raw strings in caller code. */
  const T = Object.freeze({
    CREATE          : 'CREATE',
    UPDATE          : 'UPDATE',
    DELETE          : 'DELETE',
    CLOSE_LEAD      : 'CLOSE_LEAD',
    CONFIRM_PAYMENT : 'CONFIRM_PAYMENT',
    REASSIGN_RIDER  : 'REASSIGN_RIDER',
  });

  /* ── CONFIG ───────────────────────────────────────────────── */

  let _cfg = {
    endpoint       : '',       // set via init() — library works without it
    phone          : null,     // operator phone   (human anchor)
    dk             : null,     // device key        (install identity)
    branchId       : null,     // CRITICAL — must be set before any sync op
    onStatusChange : null,     // fn(recordId, status) → caller updates UI/storage
    onMasterUpdate : null,     // fn(entity, items)    → caller hard-overwrites local list
  };

  // v1.2 — observability hook (optional, set via init())
  let _onLogEvent = null;      // fn(type, entity, payload, parcel)

  /* ── QUEUE ────────────────────────────────────────────────── */

  const _loadQ = () => {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
    catch { return []; }
  };
  const _saveQ = q => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));

  /* ── AUTH ─────────────────────────────────────────────────── */

  const _getAuth      = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; } };
  const _isAuthorized = () => { const a = _getAuth(); return a?.syncAuthorized === true && !!a?.syncToken; };

  /* ── PARCEL FACTORY ───────────────────────────────────────── */
  /*
    Every queued event is a self-describing parcel.
    The server needs no shared schema — the parcel carries its own context.
  */
  function _makeParcel(type, entity, payload) {
    return {
      id       : Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type,                     // one of T.*
      entity,                   // 'booking' | 'rider' | 'branch' …
      phone    : _cfg.phone,
      dk       : _cfg.dk,
      branchId : _cfg.branchId,
      payload,
      ts       : new Date().toISOString(),
      status   : 'pending',
    };
  }

  /* ── PUBLIC: logEvent ─────────────────────────────────────── */
  /*
    Store locally ONLY. No network. Safe to call while offline.
    This is the ONLY write path into the event queue.

    v1.2: emits onLogEvent after queue write (best-effort, non-blocking).
    The hook receives (type, entity, payload, parcel) so an external
    mediator (e.g. GnokeBridge) can observe without touching the queue.
  */
  function logEvent(type, entity, payload) {
    const parcel = _makeParcel(type, entity, payload);
    const q = _loadQ();
    q.push(parcel);
    _saveQ(q);

    // v1.2 — notify bridge / external observer after queue write
    _onLogEvent?.(type, entity, payload, parcel);

    return parcel;
  }

  /* ── PUBLIC: push ─────────────────────────────────────────── */
  /*
    Flush pending queue in chunks of MAX_CHUNK.
    Requires: endpoint configured + QR authorisation active.
    On network failure: leaves parcels as 'pending' for next loop.
    On server rejection: marks chunk as 'failed', notifies caller.
  */
  async function push() {
    if (!_cfg.endpoint)   return { ok: false, reason: 'no_endpoint' };
    if (!_isAuthorized()) return { ok: false, reason: 'not_authorized' };

    const pending = _loadQ().filter(p => p.status === 'pending' || p.status === 'failed');
    if (!pending.length)  return { ok: true, pushed: 0 };

    const { syncToken } = _getAuth();
    let pushed = 0;

    for (let i = 0; i < pending.length; i += MAX_CHUNK) {
      const chunk = pending.slice(i, i + MAX_CHUNK);
      const ids   = new Set(chunk.map(p => p.id));

      try {
        const res = await fetch(`${_cfg.endpoint}/dispatch`, {
          method  : 'POST',
          headers : {
            'Content-Type' : 'application/json',
            'X-Sync-Token' : syncToken,
          },
          body: JSON.stringify({ branchId: _cfg.branchId, events: chunk }),
        });

        /* Re-read queue — state may have shifted while awaiting */
        const live       = _loadQ();
        const nextStatus = res.ok ? 'synced' : 'failed';
        live.forEach(p => { if (ids.has(p.id)) p.status = nextStatus; });
        _saveQ(live);

        if (res.ok) {
          pushed += chunk.length;
          chunk.forEach(p => _cfg.onStatusChange?.(p.payload?.id, 'synced'));
        } else {
          chunk.forEach(p => _cfg.onStatusChange?.(p.payload?.id, 'failed'));
        }
      } catch {
        /* Network down — parcels stay 'pending', retry on next loop */
      }
    }

    return { ok: true, pushed };
  }

  /* ── PUBLIC: pull ─────────────────────────────────────────── */
  /*
    Branch-scoped fetch from server.

    MASTER LIST RULE (critical):
    Riders, Branches → HARD OVERWRITE via onMasterUpdate callback.
    localList = serverList — no appending, no merging.
    This is the only permanent fix for "ghost duplicate" records.
    If Admin renames or deletes a rider on the server, this propagates instantly.
  */
  async function pull() {
    if (!_cfg.endpoint)   return { ok: false, reason: 'no_endpoint' };
    if (!_isAuthorized()) return { ok: false, reason: 'not_authorized' };

    const { syncToken } = _getAuth();

    try {
      const res = await fetch(
        `${_cfg.endpoint}/updates?branchId=${encodeURIComponent(_cfg.branchId)}`,
        { headers: { 'X-Sync-Token': syncToken } }
      );
      if (!res.ok) return { ok: false, reason: 'server_error' };

      const data = await res.json();

      /* Hard-overwrite each master list present in the response */
      ['riders', 'branches'].forEach(entity => {
        if (Array.isArray(data[entity])) {
          _cfg.onMasterUpdate?.(entity, data[entity]);
        }
      });

      return { ok: true, data };
    } catch {
      return { ok: false, reason: 'network_error' };
    }
  }

  /* ── PUBLIC: authorize ────────────────────────────────────── */
  /*
    Called after admin QR is scanned and token is validated.
    Token must be present in every subsequent push/pull request.
    This is the ONLY activation path — sync is disabled by default.
  */
  function authorize(token) {
    if (!token || String(token).length < 8) return false;
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      syncAuthorized : true,
      syncToken      : String(token),
      authorizedAt   : new Date().toISOString(),
    }));
    return true;
  }

  /* ── PUBLIC: init ─────────────────────────────────────────── */
  /*
    Configure and arm the library.
    Call AFTER identity is resolved (profile + device key available).
    branchId is required — all sync is scoped to it.

    v1.2: accepts optional onLogEvent hook.
    The hook is called by logEvent() after every queue write.
    It MUST NOT mutate the parcel or the queue — observe only.
  */
  function init(config) {
    if (!config?.phone || !config?.dk || !config?.branchId) {
      console.warn('[gnoke-sync] init() requires phone, dk, and branchId.');
    }

    // v1.2 — capture observability hook before spreading config
    if (typeof config?.onLogEvent === 'function') {
      _onLogEvent = config.onLogEvent;
    }

    Object.assign(_cfg, config);

    return {
      authorized : _isAuthorized(),
      branchId   : _cfg.branchId,
      pending    : _loadQ().filter(p => p.status === 'pending').length,
    };
  }

  /* ── PUBLIC: start ────────────────────────────────────────── */
  /* Begin the push loop. Fires immediately, then every intervalMs. */
  function start(intervalMs = 30_000) {
    push();
    setInterval(push, intervalMs);
  }

  /* ── PUBLIC: getQueueSnapshot (v1.2) ─────────────────────── */
  /*
    Returns a shallow copy of the current queue for external inspection.
    Read-only by convention — callers MUST NOT mutate the returned array.
    Use this instead of reaching into localStorage directly.
  */
  function getQueueSnapshot() {
    return _loadQ();
  }

  /* ── PUBLIC: isReady / isAuthorized ──────────────────────── */
  const isReady      = () => !!_cfg.endpoint && _isAuthorized();
  const isAuthorized = () => _isAuthorized();

  /* ── EXPORT ───────────────────────────────────────────────── */

  root.GNOKE_SYNC = Object.freeze({
    T,
    init,
    logEvent,
    push,
    pull,
    authorize,
    start,
    isReady,
    isAuthorized,
    getQueueSnapshot,   // v1.2
  });

  /*
    Backward-compat hook — commit() in script.js calls this.
    Routes directly to logEvent so no caller code needs to change
    before the app is fully wired to GNOKE_SYNC.logEvent directly.
  */
  root.__syncHook = record => logEvent(T.CREATE, 'booking', record);

})(window);
