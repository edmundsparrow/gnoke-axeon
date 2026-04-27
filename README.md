# GNOKE-AXEON 
## Version: 2.0 (Kernel Edition)
## Author: Edmund Sparrow © 2026
## Purpose: Portable, self-contained architecture guide for any developer picking up this codebase

---

## ⚠️ FILE INVENTORY — READ THIS FIRST

The canonical Gnoke-Axeon system is exactly **five files**.

| Canonical Filename   | Version | Source                    |
|----------------------|---------|---------------------------|
| `gnoke-db.js`        | v1.3.2  | standalone        |
| `gnoke-worker.js`    | v1.0.1  | standalone        |
| `gnoke-client.js`    | v1.0.0  | standalone        |
| `gnoke-bridge.js`    | v1.2.0  | standalon         |
| `gnoke-sync.js`      | v1.2    | standalone        |

**Global names exposed on `self` / `window`:**

| File             | Global exported     |
|------------------|---------------------|
| `gnoke-db.js`    | `GnokeDB`           |
| `gnoke-worker.js`| *(no global — it is the kernel)* |
| `gnoke-client.js`| `GnokeClient`       |
| `gnoke-bridge.js`| `GnokeBridge`       |
| `gnoke-sync.js`  | `GNOKE_SYNC`        |

> **Critical:** `gnoke-sync.js` exports `GNOKE_SYNC` (all caps + underscore), not `GnokeSync`. This is intentional and must not be changed. The worker wires it as `sync: GNOKE_SYNC`.

---

## 🧠 WHAT THIS SYSTEM IS

Gnoke-Axeon is a **local-first browser runtime**. It behaves like a mini backend running entirely inside the browser — no server required for core operation.

It was built for field operations apps (logistics, dispatch, bookings) running on low-RAM Android devices (Infinix) on unreliable West African mobile networks (2G/3G). Every design decision reflects that constraint.

**The core guarantee:** data is never lost, even if the network dies, the tab crashes, or the device reboots mid-write.

---

## 🏗️ ARCHITECTURE — FIVE LAYERS

```
[ UI TABS ]  ← your HTML/JS apps
     │
     ▼  postMessage (via GnokeClient)
[ gnoke-worker.js ]  ← SharedWorker kernel (ONE instance for all tabs)
     │
     │  direct calls
     ▼
[ gnoke-db.js ]  ← Storage engine
     │  RAM mirror (Map) + .jsonl append log + IndexedDB shelf
     │
     ▼  onWrite hook
[ gnoke-bridge.js ]  ← Traffic controller / event normalizer
     │
     ▼  logEvent / push / pull
[ gnoke-sync.js ]  ← Offline-first network courier
     │
     ▼
[ Your HTTP server endpoint ]  ← plain JSON, no database required
```

**The rule:** nothing talks across layers except through defined hooks. DB never calls Sync directly. Bridge observes DB via `onWrite` hook. Bridge talks to Sync via `logEvent`. The Worker is the only thing that calls DB.

---

## 📁 FILE RESPONSIBILITIES

### gnoke-db.js — Storage Engine
- Maintains `_ram`: a `Map<collection, Map<id, record>>` — the authoritative read source
- Writes append-only `.jsonl` log files via the **File System Access API**
- Uses **IndexedDB as a shelf** — a fallback when native FS write fails mid-crash
- Tracks `__pending` on RAM records until disk confirms the write
- Compacts the log at **500 lines** (rewrites to clean snapshot, atomic via `.compact.tmp`)
- On `open()`: replays log from disk into RAM, drains the IndexedDB shelf, recovers any interrupted compaction

**Public API:**
```js
await GnokeDB.open()                          // boot — call once
await GnokeDB.save(collection, payload)       // returns id
await GnokeDB.update(collection, id, payload)
await GnokeDB.remove(collection, id)
await GnokeDB.query(collection, filterFn?)    // reads from RAM only
GnokeDB.hasPendingWrites(collection?)         // true if unconfirmed writes exist
await GnokeDB.drop(collection)
await GnokeDB.collections()                   // list all known collections
GnokeDB.configure({ onWrite, onReady, onCompact, onRecover, onQuery, onError })
```

**Key constants:**
- `COMPACT_THRESHOLD = 500` — lines before compaction fires
- `DB_NAME = 'gnoke-db-shadow'` — IndexedDB database name
- Files on disk: `{collection}.jsonl`, shelf: IndexedDB `gnoke-db-shadow`

**Design rule — disk is recovery only:**
RAM is the read layer. Disk is the durability layer. A record marked `__pending` in RAM is real and queryable — it just hasn't been confirmed to disk yet. `hasPendingWrites()` tells you this state.

---

### gnoke-worker.js — SharedWorker Kernel
- Hosts GnokeDB, GnokeBridge, and GNOKE_SYNC inside a single SharedWorker
- One instance serves all open tabs simultaneously
- Boots once via `_bootPromise` — subsequent OPEN commands from other tabs resolve instantly
- Routes commands: `OPEN | SAVE | UPDATE | REMOVE | QUERY | PENDING | SYNC | PULL`
- Broadcasts state changes to all tabs after every confirmed write
- Manages `_ports` Set — stale ports (closed tabs) are pruned lazily on failed postMessage

**Boot sequence:**
1. First tab calls `GnokeClient.connect()` → worker boots
2. Worker calls `GnokeBridge.init({ db: GnokeDB, sync: GNOKE_SYNC })`
3. Worker calls `GnokeDB.open()` — triggers folder picker in the initiating tab
4. DB replays disk → RAM mirror is live
5. All tabs connected

**Broadcast events emitted to all tabs:**
```
STATE_UPDATED  → { collection, op, id, record }   // after every write
SYNC_STATUS    → { pending }                        // after each push() cycle
MASTER_UPDATE  → { entity, items }                 // after pull() master overwrite
```

**importScripts load order (must not change):**
```js
importScripts('./gnoke-db.js', './gnoke-bridge.js', './gnoke-sync.js');
```

---

### gnoke-client.js — Tab Stub
- Thin wrapper. No persistence logic, no sync logic.
- Sends postMessage commands to the SharedWorker, returns Promises.
- API surface is **identical to GnokeDB** — tabs don't know or care about the worker.
- Falls back to direct `GnokeDB` calls in the same tab if SharedWorker is unavailable (older Android).

**Usage:**
```js
await GnokeClient.connect();

const id = await GnokeClient.save('bookings', { name: 'Adaeze', status: 'open' });
const rows = await GnokeClient.query('bookings', rec => rec.p?.status === 'open');
await GnokeClient.update('bookings', id, { status: 'confirmed' });
await GnokeClient.remove('bookings', id);

GnokeClient.onStateUpdate((collection, op, id, record) => { /* re-render */ });
GnokeClient.onMasterUpdate((entity, items) => { /* overwrite local rider list */ });
GnokeClient.onSyncStatus((pendingCount) => { /* update sync indicator */ });

await GnokeClient.sync();  // manual push
await GnokeClient.pull();  // manual pull
```

**Filter functions must be self-contained** — no closure variables. They are serialized with `.toString()` and reconstructed in the worker via `new Function()`.

---

### gnoke-bridge.js — Traffic Controller
- Sits between DB and Sync. Neither layer talks to the other directly.
- Observes DB writes via `GnokeDB.configure({ onWrite })` hook
- Observes Sync receives via `GNOKE_SYNC.init({ onLogEvent })` hook
- Normalizes event shapes from both sides into a common format
- Prevents echo loops: tracks `pendingOutbox` in `localStorage` (`gnoke_bridge_outbox`). Events originating from DB are tagged with `__bridge_id`. When Sync returns the same event, the Bridge detects the tag, drops it, and does NOT write it back to DB.
- Enforces auto-sync policy: only `CONFIRM_PAYMENT`, `DELETE`, and `REASSIGN_RIDER` trigger immediate sync. All others queue for the next push cycle.

**Event normalization — critical detail:**
GnokeDB's `record.type` is always the storage operation: `insert | update | delete`.
Domain event types (`CONFIRM_PAYMENT`, `REASSIGN_RIDER`) live in `record.p.type` (the payload).
The Bridge resolves `record.p.type` first, falls back to `record.type`. This is how priority routing actually fires.

**Init:**
```js
GnokeBridge.init({ db: GnokeDB, sync: GNOKE_SYNC });
// Called by the Worker. Do not call from app tabs.
```

**Public API (called by Worker only):**
```js
GnokeBridge.forceSync()   // triggers GNOKE_SYNC.push()
GnokeBridge.forcePull()   // triggers GNOKE_SYNC.pull()
GnokeBridge.getPending()  // returns array of unsynced outbox events
```

---

### gnoke-sync.js — Network Courier
- Offline-first event queue. `logEvent()` never touches the network.
- Queues parcels to `localStorage` (`gnoke_sync_queue`)
- `push()` flushes in chunks of **10** (2G-safe ceiling)
- `pull()` fetches branch-scoped updates and **hard-overwrites** master lists (riders, branches) — no merging, no appending. This is the permanent fix for ghost duplicate records.
- Auth-gated: all push/pull requires a QR sync token. App works fully offline without it.
- Branch-scoped: every parcel carries `branchId`. Server filters by branch.

**Init (called by Bridge internally):**
```js
GNOKE_SYNC.init({
  phone, dk, branchId,      // identity — must be resolved before init
  endpoint,                  // your server base URL
  onStatusChange,            // fn(recordId, status) — update UI
  onMasterUpdate,            // fn(entity, items) — hard-overwrite local list
  onLogEvent,                // fn(type, entity, payload, parcel) — Bridge hook
});
```

**Auth:**
```js
GNOKE_SYNC.authorize(token);  // call after QR scan
GNOKE_SYNC.isReady();         // true if endpoint + auth both set
```

**Auto-loop:**
```js
GNOKE_SYNC.start(30_000);  // push every 30s — call from Worker after boot if needed
```

**Event type constants:**
```js
GNOKE_SYNC.T.CREATE | UPDATE | DELETE | CLOSE_LEAD | CONFIRM_PAYMENT | REASSIGN_RIDER
```

---

## 🔁 DATA FLOWS

### Write path (tab → disk)
```
Tab calls GnokeClient.save()
  → postMessage SAVE to Worker
  → Worker calls GnokeDB.save()
    → record written to RAM (marked __pending)
    → async native FS append starts
      → on success: __pending cleared, onWrite hook fires
        → Bridge normalizes event
        → if HIGH_PRIORITY: Bridge dispatches to GNOKE_SYNC.logEvent()
        → GNOKE_SYNC queues parcel to localStorage
      → on FS failure: record shelved to IndexedDB
  → Worker replies { id } to tab
  → Worker broadcasts STATE_UPDATED to all tabs
```

### Read path (always RAM)
```
Tab calls GnokeClient.query()
  → postMessage QUERY to Worker
  → Worker calls GnokeDB.query() — reads from _ram Map directly
  → Returns results (no disk read)
```

### Recovery path (on boot)
```
GnokeDB.open()
  → _replayFile(): reads .jsonl line by line → rebuilds _ram
  → _drainShelf(): appends any shelved IndexedDB records to .jsonl
  → _recoverCompactTmp(): if .compact.tmp exists, resumes interrupted compaction
  → RAM is live
```

### Sync path
```
GNOKE_SYNC.push()
  → reads localStorage queue (status: pending | failed)
  → sends chunks of 10 to /dispatch endpoint
  → on success: marks parcels 'synced', fires onStatusChange
  → on failure: leaves as 'pending', retry on next loop

GNOKE_SYNC.pull()
  → GET /updates?branchId=...
  → for each entity in [riders, branches]: hard-overwrite via onMasterUpdate
  → Worker receives via Bridge hook → broadcasts MASTER_UPDATE to all tabs
```

---

## ⚙️ WIRING — HOW THE WORKER BOOTS

```js
// Inside gnoke-worker.js _boot():

GnokeBridge.init({
  db  : GnokeDB,
  sync: GNOKE_SYNC,      // ← GNOKE_SYNC, not GnokeSync. This is correct.
});

GnokeDB.configure({
  onCompact: ({ collection, recordCount, previousLineCount }) => {
    console.log(`compacted ${collection}: ${previousLineCount} → ${recordCount} lines`);
  },
  onReady: () => { _booted = true; },
});

await GnokeDB.open();
_booted = true;
```

Bridge.init() internally calls:
- `GnokeDB.configure({ onWrite: onDBWrite })` — observes all DB writes
- `GNOKE_SYNC.init({ onLogEvent: onSyncEvent })` — observes all Sync receives

These are the two wires that connect the layers. No other cross-layer calls exist.

---

## 🧩 KNOWN DESIGN CONSTRAINTS

**SharedWorker lifetime:** The worker lives as long as one tab has a live port. All tabs closed = worker terminated. Next tab to open re-runs `GnokeDB.open()` (wake path — no folder picker, just permission re-check and RAM rebuild from disk).

**Mobile browser caveat:** On low-RAM Android, the browser may terminate background workers even with tabs open. Sync parcels survive in `localStorage` and replay on next boot. DB state survives in `.jsonl` files and shelf. No data is lost — only the active sync loop dies.

**File System Access API:** Requires HTTPS or localhost. On first open, the user must grant folder access via a browser dialog. Permission persists for the session. On wake (worker restart), the browser re-checks the stored handle — usually silent, no picker.

**Filter serialization:** `GnokeClient.query(collection, fn)` serializes `fn` with `.toString()` and reconstructs it in the worker via `new Function()`. Filters must be self-contained — no variables from the calling tab's closure.

**Exclusive file ownership:** GnokeDB assumes it is the only writer to the `.jsonl` files. The SharedWorker architecture enforces this — only the worker calls GnokeDB. Do not edit `.jsonl` files manually while the app is running.

**localStorage keys used:**
- `gnoke_sync_queue` — GNOKE_SYNC event queue
- `gnoke_sync_auth` — QR auth token
- `gnoke_bridge_outbox` — Bridge echo-loop guard

---

## 🐛 BUG HISTORY (for context)

| Version | File | Fix |
|---------|------|-----|
| v1.1.0 | gnoke-bridge.js | Hash collision on undefined event.id; domain type vs storage type confusion; UPDATE used save() instead of update(); version string |
| v1.2.0 | gnoke-bridge.js | pendingOutbox persisted to localStorage; DELETE guard on missing recordId |
| v1.3.0 | gnoke-db.js | RAM mirror introduced; compaction hardening |
| v1.3.1 | gnoke-db.js | Compaction was snapshotting `__pending` records to disk (speculative data). Now filters to confirmed records only. |
| v1.3.2 | gnoke-db.js | `_pendingDeletes` changed from `Set<id>` to `Map<id,collection>`. `hasPendingWrites('riders')` was returning true if any delete was pending anywhere. Now correctly scoped. |
| v1.0.1 | gnoke-worker.js | `GnokeDB._folderName` was never defined on the public API. OPEN reply now captures folder name from `GnokeDB.open()` return value. |

---

## <> INSTRUCTIONS FOR THE RECEIVING Developer

When extending or debugging this system, respect these rules:

1. **Never mix layer responsibilities.** DB does not know about Sync. Sync does not know about DB. Bridge is the only connector. Worker is the only caller of DB.

2. **All writes go through the Worker.** App tabs never call GnokeDB directly (except in fallback mode). If you add a new operation, add it as a Worker command and a GnokeClient method.

3. **`GNOKE_SYNC` is the correct global name** for gnoke-sync.js. Do not rename it to `GnokeSync`.

4. **RAM is truth. Disk is recovery.** Never add a read path that goes to disk at query time. `GnokeDB.query()` reads from `_ram` only.

5. **The compaction filter is load-bearing.** `_compact()` must only snapshot records where `!rec.__pending`. Breaking this causes speculative data to appear on disk.

6. **hasPendingWrites() is collection-scoped.** It uses `Map<id, collection>` for delete tracking. Do not revert to a `Set`.

7. **Bridge echo-loop guard is critical.** Every DB-originated event gets a `__bridge_id`. Bridge checks this on Sync return. Breaking this causes duplicate records on every sync cycle.

8. **Do not add a heartbeat to `_ports` management** unless you have evidence of zombie port memory pressure in production. The lazy-prune-on-failure pattern is intentional and sufficient for the target device profile.

---

*End of Gnoke-Axeon Handoff Document v2.1*

---

## ✅ ARCHITECTURE VERIFICATION

| Layer | File | Version | Status |
|---|---|---|---|
| Kernel | `gnoke-worker.js` | v1.0.1 | Centralized state, single RAM mirror, broadcast-after-commit |
| Storage Engine | `gnoke-db.js` | v1.3.2 | Disk is strict subset of RAM. Compaction is crash-safe |
| Traffic Controller | `gnoke-bridge.js` | v1.2.1 | Worker-compatible. Echo-loop guard intact |
| Network Courier | `gnoke-sync.js` | v1.2.1 | Worker-compatible. Truck/Depot delivery model intact |
| Tab Peripheral | `gnoke-client.js` | v1.0.0 | Transparent API over SharedWorker bus |

The system is a **deterministic runtime**. With the `window → self` fix applied to Bridge and Sync, the `ReferenceError` that would have silently bricked the Worker on boot is eliminated. The stack boots reliably across modern desktop browsers and the target Android/Infinix field environment.