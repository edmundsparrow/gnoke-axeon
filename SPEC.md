# SPEC.md
**Version:** 1.0 — Edmund Sparrow © 2026
**Applies to:** GnokeDB v1.1 · GnokeSync v1.2 · GnokeBridge v1.2

---

## What the Kernel Is

Three files. One job each.

| File | Role | Source of truth |
|---|---|---|
| `gnoke-db.js` | Stores records | Filesystem (.jsonl) |
| `sync.js` | Moves events | localStorage queue |
| `gnoke-bridge.js` | Controls flow | Mediates the other two |

**Rule zero:** No module talks directly to another. All movement passes through the Bridge.

---

## 1. The Event Shape

Every piece of data moving through the system is an **event**. Every event has this structure:

```js
{
  type:    "CONFIRM_ORDER",   // domain action — what happened
  entity:  "records",        // collection name — where it belongs
  id:      "gdb_abc123",     // record ID — which record
  payload: {}                // data — what changed
}
```

### Rules
- `type` is always a domain action in SCREAMING_SNAKE_CASE. It describes **what happened**, not the database operation.
- `entity` matches a GnokeDB collection name exactly.
- `id` is the GnokeDB-assigned record ID (`gdb_` prefix). Never invent your own.
- `payload` carries the record's data. If your app needs a domain type inside the payload, store it as `payload.type`.

---

## 2. Allowed Event Types

The kernel has three built-in types. Everything else is yours to define.

| Type | Direction | Meaning |
|---|---|---|
| `CREATE` | Sync → DB | New record arrived from server |
| `UPDATE` | Sync → DB | Existing record changed on server |
| `DELETE` | Both | Record removed |

**Adding domain types for your app:** Define them in GnokeSync's `T` constant. If a type needs immediate sync (e.g. a payment confirmation, a status change), add it to `HIGH_PRIORITY` in GnokeBridge. Example:

```js
// In gnoke-sync.js T constant — add your domain events:
CONFIRM_ORDER  : 'CONFIRM_ORDER',
CANCEL_ITEM    : 'CANCEL_ITEM',
REASSIGN_AGENT : 'REASSIGN_AGENT',

// In gnoke-bridge.js _shouldSync() HIGH_PRIORITY list:
const HIGH_PRIORITY = ['CONFIRM_ORDER', 'DELETE', 'REASSIGN_AGENT'];
```

---

## 3. Who Does What

| Module | Can do | Cannot do |
|---|---|---|
| **DB** | Store, update, delete, query records | Contact Sync or Bridge |
| **Sync** | Queue events, push to server, pull from server | Write directly to DB |
| **Bridge** | Normalize events, route, deduplicate, apply incoming writes to DB | Invent business logic or store application state |
| **Your app** | Call DB methods directly, call `logEvent` on Sync for non-priority events | Bypass the Bridge for inter-module communication |

---

## 4. The Flow

### DB write → server (outbound)
```
Your app writes to DB
  → GnokeDB fires onWrite hook
    → Bridge normalizes the event
      → if HIGH_PRIORITY: Bridge calls Sync.logEvent immediately
        → Sync queues the parcel
          → Sync.push() delivers it to the server
```

### Server update → DB (inbound)
```
Sync.pull() fetches from server
  → Bridge receives onLogEvent
    → Bridge checks echo-loop guard (was this sent by us?)
      → if new: Bridge calls db.update() or db.save() or db.remove()
        → GnokeDB appends the event to the .jsonl log
```

### Echo loop prevention
When the Bridge sends an event to Sync, it tags it with `__bridge_id`. If that event comes back from the server, the Bridge recognises the tag and drops it. This is how the system avoids writing the same record twice.

---

## 5. The Record Format (GnokeDB)

Every record stored on disk looks like this:

```json
{"id":"gdb_abc123","type":"insert","ts":1234567890,"v":1,"p":{}}
```

- `type` here is the **storage operation** (`insert` / `update` / `delete`), not the domain event type.
- `p` is the payload your app wrote.
- `v` is the version counter (reserved for future use).
- Never write to `.jsonl` files manually. Always go through GnokeDB.

---

## 6. Startup Sequence

Always initialise in this order:

```js
// 1. Open the database (prompts folder picker on first run)
await GnokeDB.open();

// 2. Wire up the bridge (attaches hooks to both modules)
GnokeBridge.init({
  db:   GnokeDB,
  sync: GNOKE_SYNC,
  enableAutoSync: true,
  dedupeWindowMs: 10000,
});

// 3. Configure sync identity (after profile/device key is resolved)
GNOKE_SYNC.init({
  phone:    userPhone,
  dk:       deviceKey,
  branchId: activeBranchId,
  endpoint: 'https://your-server.com',
  onStatusChange: (id, status) => { /* update your UI */ },
  onMasterUpdate: (entity, items) => { /* overwrite your local list */ },
});

// 4. Authorize sync (after QR scan)
GNOKE_SYNC.authorize(tokenFromQR);

// 5. Start the push loop
GNOKE_SYNC.start(30_000); // every 30 seconds
```

**Never call `GNOKE_SYNC.init()` directly for Bridge wiring.** GnokeBridge's `init()` calls it internally. Calling it again will overwrite the `onLogEvent` hook.

---

## 7. Writing from Your App

```js
// Save a new record (DB only — non-priority event)
const id = await GnokeDB.save('records', {
  type:   'CLOSE_ITEM',     // domain type lives in payload
  label:  'Example record',
  amount: 4500,
});

// Save a high-priority record (Bridge will auto-sync it immediately)
const id = await GnokeDB.save('records', {
  type:    'CONFIRM_ORDER',
  orderId: 'order_xyz',
  amount:  12000,
});

// Query with optional filter
const open = await GnokeDB.query('records', r => r.p.status === 'open');

// Force sync immediately (e.g. on button press)
await GnokeBridge.forceSync();

// Force pull from server
await GnokeBridge.forcePull();
```

---

## 8. What Master Lists Are

Some entities are **master lists** — they are owned and authorised by the server, not the device. When `pull()` brings them down, they **completely replace** the local copy. There is no merge.

Examples: staff lists, product catalogues, branch directories, agent rosters — any list where the server is the single source of truth.

If your app has master list entities, add their names to the array in `gnoke-sync.js`'s `pull()` function:

```js
['agents', 'products', 'locations'].forEach(entity => {
  if (Array.isArray(data[entity])) {
    _cfg.onMasterUpdate?.(entity, data[entity]);
  }
});
```

---

## 9. What the Kernel Does Not Handle

These are deliberately out of scope. Do not try to solve them inside the kernel files:

- **Conflict resolution** between two devices editing the same record simultaneously — handle this server-side.
- **User authentication** — the QR token is a sync gate, not an identity system.
- **Multi-tab sync** — Trio Standalone is designed for one active tab. Use Full Kernel mode (gnoke-worker.js + gnoke-client.js) if you need shared state across tabs.
- **Pagination of large collections** — use GnokeDB's `filter` argument in `query()` to limit results in your app layer.

---

## 11. Folder Picker — UX & Device Notes

`GnokeDB.open()` calls `showDirectoryPicker()`, which the browser will **only allow inside a direct user gesture** (a tap or click). It cannot be called on page load. Every app must have a dedicated button to trigger it.

**Recommended pattern:**

```js
if (!window.showDirectoryPicker) {
  // Show: "Please open this app in Chrome to connect your workspace"
  return;
}

document.getElementById('connect-workspace').addEventListener('click', async () => {
  const info = await GnokeDB.open();
  // info.folder is the chosen folder name — show it in the UI
  // so the user can confirm they connected the right workspace
  document.getElementById('connect-workspace').hidden = true;
  GnokeBridge.init({ db: GnokeDB, sync: GNOKE_SYNC });
  // continue with GNOKE_SYNC.init(...)
});
```

**On returning visits:** if the browser has lost the stored permission, `GnokeDB.open()` will call `requestPermission()` — this also requires a user gesture. The same button handles both the first-time and returning-visit cases correctly.

**Android / Infinix devices:** The HiOS built-in browser does not reliably support the File System Access API. Target **Chrome for Android** (v86+, Android 10+). Show a clear message if `window.showDirectoryPicker` is absent rather than letting the button silently fail.

### Workspace Status Indicator

Rather than a button that disappears after first use, make it a persistent status chip in the app header. It serves as both a connection indicator and the re-connect trigger if permission lapses.

| State | Appearance | Meaning | Tap action |
|---|---|---|---|
| No workspace | Grey — "Connect Workspace" | First run or cleared storage | Opens folder picker |
| Connected | Green — folder name + ✓ | Permission active | None |
| Permission lapsed | Amber — "Reconnect Workspace" | Browser dropped the grant | Re-opens folder picker |

Showing the folder name (e.g. `my-workspace-folder`) is important on shared devices — the user can confirm they are in the correct workspace before starting.

**Recommended pattern:**

```js
async function initWorkspace() {
  // Silent check on page load — no prompt, no gesture needed
  const stored = await idbGet('handles', 'workspace');
  if (stored) {
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      // Already connected — go straight to green, no tap required
      showStatus('connected', stored.name);
      await bootKernel();
      return;
    }
  }
  // Needs a gesture — show grey or amber chip and wait
  showStatus(stored ? 'lapsed' : 'disconnected');
}

document.getElementById('workspace-chip').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    alert('Please open this app in Chrome to connect your workspace.');
    return;
  }
  const info = await GnokeDB.open();   // handles both first-run and permission restore
  showStatus('connected', info.folder);
  await bootKernel();
});

async function bootKernel() {
  GnokeBridge.init({ db: GnokeDB, sync: GNOKE_SYNC });
  GNOKE_SYNC.init({ phone, dk, branchId, endpoint, onStatusChange, onMasterUpdate });
  if (GNOKE_SYNC.isAuthorized()) GNOKE_SYNC.start(30_000);
}
```

---

## 10. Adding a New App — Checklist

- [ ] Load scripts in order: `gnoke-db.js`, `sync.js`, `gnoke-bridge.js`
- [ ] Trigger `GnokeDB.open()` from a "Connect Workspace" button — never on page load
- [ ] Show `info.folder` name in the UI after open() resolves so users can confirm the right workspace
- [ ] Use a persistent status chip (grey / green / amber) rather than a button that disappears
- [ ] On page load, call `queryPermission` silently — only show the chip prompt if permission needs restoring
- [ ] Check for `window.showDirectoryPicker` and show a "use Chrome" message if absent
- [ ] Call startup sequence (Section 6) before any read or write
- [ ] Store domain event type inside `payload.type`, not as a top-level field your app invents
- [ ] Only add new `HIGH_PRIORITY` types if they genuinely need immediate sync
- [ ] Never read `.jsonl` files or `localStorage` keys directly — always go through the module APIs
- [ ] Test offline: all writes should survive a page reload and sync when connection returns