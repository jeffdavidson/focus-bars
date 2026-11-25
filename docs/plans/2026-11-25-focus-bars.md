# Focus Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension that gives each window a "focus" and swaps the real bookmark bar's contents to the active window's focus.

**Architecture:** All logic lives in small ES modules under `extension/lib/`. Each module takes the Chrome API as a parameter (`api`) and never reads the global `chrome`, so it can be unit-tested against an in-memory fake. `background.js` only wires Chrome events to `lib/controller.js`, and the popup talks to the background through `chrome.runtime.sendMessage`. State lives in `chrome.storage.local` (persistent) and `chrome.storage.session` (window IDs).

**Tech Stack:** Plain JavaScript (ES modules), no build step and no dependencies. Tests use Node's built-in runner (`node --test`, Node 26 is installed).

**Spec:** `docs/specs/2026-11-25-focus-bars-design.md` (read it before starting any task).

## Global Constraints

- **Never run the extension in the user's everyday Chrome profile.** Every manual check uses a new, throwaway Chrome profile with bookmark sync turned **off**. Never drive the user's own Chrome with Claude in Chrome. The user loads the extension unpacked (`chrome://extensions` → Developer mode → Load unpacked → `focus-bars/extension`).
- The git repo is `focus-bars/` itself (`git init` there). Never touch the parent `Claude_dev/` folder or its other projects.
- Manifest V3, `"permissions": ["bookmarks", "storage", "tabs"]`, `"background": {"service_worker": "background.js", "type": "module"}`, `"action": {"default_popup": "popup/popup.html"}`.
- Container folder title: `Focus Bars`, under **Other bookmarks**. Default focus title: `General`. Deleted-focus folder title: `Removed – <name>` (en dash, U+2013).
- Restart matching threshold: Jaccard ≥ 0.5. Fingerprint pruning age: 30 days.
- A swap must preserve bookmark order. Bookmarks are only ever **moved**, never copied or deleted, except for an explicit "copy of current bar" when creating a focus.
- `lib/` modules receive `api` = `{ bookmarks, storage, windows, tabs, action }`, shaped like `chrome.*`, and never touch the global `chrome`.

## Review Focus

1. **Quick window switching during a swap.** Only the last requested focus ends up on the bar, no bookmark ends up in the wrong folder, and intermediate swaps are skipped. *(Task 2, `switcher coalesces to latest`.)*
2. **Service worker killed in the middle of a swap.** On restart the journal is replayed, and replaying it any number of times gives the same result as a clean swap. *(Task 1, both `recoverJournal after partial move …` tests.)* This also covers the worker waking up after being shut down for idling: setup runs again, but known windows keep their focus. *(Task 6, `boot does not reassign known windows`.)*
3. **A focus folder deleted or moved in the bookmark manager**, including the active one and General. Windows fall back to General, and no bookmark becomes unreachable. The extension's own swap moves never trigger this handling. *(Task 4, `external delete` tests and `swap moves are not treated as external`.)*
4. **Focus leaving Chrome, or moving to a popup or devtools window.** `WINDOW_ID_NONE` and windows of type other than `normal` never cause a swap. *(Task 6, `ignores non-normal and NONE`.)*
5. **Two similar windows after a restart.** Each stored fingerprint is given to at most one window, and the closer match wins. *(Task 5, `matchWindows assigns each print once`.)*

## File Structure

```
focus-bars/
  package.json                 "type": "module", script "test": "node --test tests/"
  .gitignore
  docs/specs/…  docs/plans/…
  spike/                       Task 0 only, throwaway
    manifest.json  spike.js
  extension/
    manifest.json
    background.js              event wiring only
    lib/
      roots.js                 find bar / "Other bookmarks" nodes
      store.js                 read/write state + window map
      swap.js                  journaled bar swap + recovery
      switcher.js              serialized, coalescing swap queue
      setup.js                 first run, reinstall recovery
      focuses.js               create / rename / delete / external changes
      fingerprint.js           restart matching
      controller.js            window events, assignment, badge, popup messages
    popup/
      popup.html  popup.css  popup.js
  tests/
    fake-chrome.js             in-memory chrome.* fake
    swap.test.js  switcher.test.js  setup.test.js
    focuses.test.js  fingerprint.test.js  controller.test.js
```

### Shared state shape (`chrome.storage.local`, key `state`)

```js
/** @typedef {{
 *   version: 1,
 *   barId: string, rootId: string, generalId: string,
 *   focusIds: string[],            // the extension's own list (spec: "keeps its own list")
 *   activeId: string,              // focus whose bookmarks are on the bar
 *   journal: {from: string, to: string, phase: 'toFolder'|'toBar'} | null,
 *   needsRecovery: boolean,        // reinstall case where the active focus is unknown
 *   prints: Record<string, {urls: string[], focusId: string, lastSeen: number}>,
 *   lastSwapMs: number | null
 * }} State */
```

`chrome.storage.session` key `windows`: `Record<windowId, {focusId: string, printKey: string, unmatched?: boolean}>`.

---

### Task 0: Repo setup and speed spike (THROWAWAY, HARD STOP)

**Files:**
- Create: `package.json`, `.gitignore` (`node_modules/`, `.DS_Store`), `spike/manifest.json`, `spike/spike.js`

- [ ] **Step 1:** `cd focus-bars && git init`. Commit the existing `docs/` together with `package.json` and `.gitignore`: `git commit -m "docs: design spec and plan"`.
- [ ] **Step 2:** Write `spike/`. It is an MV3 extension with the `bookmarks` permission. Window events need no permission. On install it creates `Other bookmarks/Spike A` holding the current bar contents (moved) and `Spike B` holding 30 new bookmarks (`https://example.com/1` … `/30`), and records which folder is "on the bar". On `windows.onFocusChanged` (ignoring `WINDOW_ID_NONE`) it alternates A and B: it moves the bar's children into the current folder, then the other folder's children onto the bar. It measures each swap with `performance.now()` and `console.log`s `swap N: X ms`.
- [ ] **Step 3: Hand to the user, then STOP.** Tell the user exactly this:
  1. Create a new Chrome profile (profile icon → Add → Continue without an account), and leave sync off.
  2. Add about 30 bookmarks to that profile's bar, or let the spike's 30 be enough.
  3. Load `focus-bars/spike` unpacked, open two windows, and click between them about 10 times.
  4. Report the `swap N: X ms` lines (Extensions page → "service worker" link → Console), and say whether the bar changes in one go or item by item.

  **Pass:** median under about 300 ms, and the bar visibly changes in one go. **Do not start Task 1 until the user reports the result.** If it fails, stop and bring the numbers back. Any fallback is the user's decision (spec, Known risks).
- [ ] **Step 4:** After the user reports, add a "Spike result" line to the spec, `git rm -r spike`, and commit with `chore: record spike result, remove spike`.

---

### Task 1: Test fake, roots, store, journaled swap

**Files:**
- Create: `tests/fake-chrome.js`, `extension/lib/roots.js`, `extension/lib/store.js`, `extension/lib/swap.js`, `tests/swap.test.js`

**Interfaces:**
- Produces:
  - `createFakeChrome({ bar?: Node[], other?: Node[], windows?: {id, type, tabs: string[]}[] }) -> api`, where `Node = {title, url?, children?}`. It implements `bookmarks.{getTree, getChildren, getSubTree, get, create, move, update, removeTree}`, `bookmarks.{onMoved, onRemoved}.addListener`, `storage.{local, session}.{get, set}`, `windows.{getAll({populate}), get}`, `tabs.query`, and `action.setBadgeText`. It also exposes test helpers: `api._titles(parentId) -> string[]` (child titles in order), `api._fire(eventPath, ...args)`, and `api._failAfterMoves(n)`, which makes the (n+1)th `move` throw to simulate the service worker being killed. Like Chrome, the fake fires `onMoved`/`onRemoved` for every move and removal, including the extension's own. The bar node has `folderType: 'bookmarks-bar'` and id `'1'`; Other bookmarks has `folderType: 'other'` and id `'2'`.
  - `findRoots(bookmarks) -> Promise<{barId, otherId}>`. It uses `folderType` and falls back to the root's first and second children.
  - `readState(local) -> Promise<State|null>`, `writeState(local, state) -> Promise<void>`, `readWindows(session) -> Promise<Record<string,{focusId, printKey}>>`, `writeWindows(session, map) -> Promise<void>`.
  - `moveAllChildren(bookmarks, fromId, toId) -> Promise<void>`. Moves children in order, appending to the end of `toId`.
  - `swapBar(api, toId) -> Promise<State>`. Does nothing if `toId === activeId`. Otherwise it goes through these steps in order:
    1. Write the journal `{from: activeId, to: toId, phase: 'toFolder'}`.
    2. Move the bar's children into `from`.
    3. Write `phase: 'toBar'`.
    4. Move `to`'s children onto the bar.
    5. Set `activeId = toId`, clear the journal, and store `lastSwapMs`.

    It returns the new state.
  - `recoverJournal(api) -> Promise<State>`. If there is a journal, it resumes **from the recorded phase**:
    - For `toFolder`, it finishes moving the bar into `from`, then does the `toBar` step.
    - For `toBar`, it only finishes moving `to`'s children onto the bar. It never moves the bar back into `from`, because some of `to`'s bookmarks are already there.

    If the `from` or `to` folder no longer exists, it creates an empty replacement under the root titled `Recovered focus`, swaps the replacement's id into `focusIds`, `activeId` and the journal, and carries on. It never throws in a loop. It assumes `rootId` exists; Task 3's setup recreates it first.

- [ ] **Step 1: Write failing tests** in `tests/swap.test.js`, using a seeded state (bar = `[a, b, c]`, folder Dev = `[x, y]`, active = General):
  - `swapBar moves bar to active folder and target onto bar`: bar titles are `['x','y']`, General's titles are `['a','b','c']`, Dev's are `[]`, and `activeId === devId`.
  - `swapBar preserves order including subfolders`: one bar item is a folder with children, and it arrives intact and in place.
  - `swapBar to active is a no-op`: zero moves.
  - `recoverJournal after partial move to folder`: call `_failAfterMoves(2)` and swap to Dev (it throws), then `recoverJournal`. The result matches the clean-swap test exactly. Running `recoverJournal` a second time changes nothing.
  - `recoverJournal after partial move to bar`: call `_failAfterMoves(4)`. All three bar items have moved and one of Dev's two has too. After `recoverJournal`, the bar is `['x','y']` and General is `['a','b','c']`. No Dev item ends up in General.
  - `recoverJournal with missing folder`: remove Dev's folder while the journal is mid-swap. Recovery finishes without throwing, a `Recovered focus` folder takes Dev's place, and no bar item is lost.
  - `findRoots falls back without folderType`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement `fake-chrome.js`, `roots.js`, `store.js` and `swap.js` to the interfaces above.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit with `feat: journaled bookmark bar swap`.

---

### Task 2: Switcher (one swap at a time, latest wins)

**Files:**
- Create: `extension/lib/switcher.js`, `tests/switcher.test.js`

**Interfaces:**
- Produces: `createSwitcher(runSwap: (focusId) => Promise<void>) -> { request(focusId): Promise<void> }`. Only one `runSwap` runs at a time. Requests made while one is running replace each other, so only the most recent one runs next. Every pending `request` promise resolves when the queue goes idle. If `runSwap` throws, the error is logged and the queue carries on.

- [ ] **Step 1: Write failing tests:**
  - `switcher coalesces to latest`: request A, then B, C and D while A is still running. The `runSwap` calls are exactly `['A','D']`.
  - `switcher runs one at a time`: the number of `runSwap` calls running at once never goes above 1.
  - `switcher survives a failing swap`: A throws and the next request still runs.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: coalescing swap queue`.

---

### Task 3: Setup (first run, normal start, reinstall recovery)

**Files:**
- Create: `extension/lib/setup.js`, `tests/setup.test.js`

**Interfaces:**
- Consumes: `findRoots`, `readState`/`writeState`, `recoverJournal`.
- Produces:
  - `initialize(api) -> Promise<State>`. There are three cases:
    1. **No state and no `Focus Bars` folder:** create `Focus Bars` and `Focus Bars/General` (empty). Set `activeId = generalId`, `focusIds = [generalId]`, `needsRecovery = false`. Move nothing.
    2. **State exists:** make sure the `Focus Bars` folder and the General folder still exist, recreating either one if it's missing and updating `rootId`, `generalId` and `focusIds`. Then run `recoverJournal` and return the state. `initialize` is cheap and safe to run on every service-worker load.
    3. **No state, but a `Focus Bars` folder exists** (reinstall): `focusIds` = its subfolders whose titles don't start with `Removed – `. `generalId` = the subfolder titled `General`, created if missing. If exactly one focus folder is empty, it becomes `activeId` with `needsRecovery = false`. Otherwise set `needsRecovery = true` and `activeId = generalId` (a placeholder that is never swapped while `needsRecovery` is set).
  - `resolveRecovery(api, focusId) -> Promise<State>`. Sets `activeId = focusId` and `needsRecovery = false`.

- [ ] **Step 1: Write failing tests:** `first run keeps bar in place`, `first run twice is idempotent`, `restart replays journal`, `missing Focus Bars folder is recreated`, `reinstall picks the single empty folder`, `reinstall with two empty folders needs recovery`, `reinstall ignores Removed folders`, `resolveRecovery clears flag`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: first-run and reinstall setup`.

---

### Task 4: Focus management and external changes

**Files:**
- Create: `extension/lib/focuses.js`, `tests/focuses.test.js`

**Interfaces:**
- Consumes: `readState`/`writeState`, `readWindows`/`writeWindows`, `swapBar`.
- Produces:
  - `listFocuses(api) -> Promise<{id, name}[]>`. Lists the focuses in `focusIds` order, with each name read from the folder's current title.
  - `createFocus(api, name, { copyCurrent: boolean }) -> Promise<string>`. Creates the folder under the root and adds it to `focusIds`. When `copyCurrent` is true, it **recursively** copies the bar's current contents into the new folder (`create` for each URL, and a new folder plus its children for each subfolder).
  - `renameFocus(api, focusId, name) -> Promise<void>`
  - `deleteFocus(api, focusId, swap: (id) => Promise<void>) -> Promise<void>`. Rejects for General. If the focus is active, it calls `swap(generalId)` first. Windows assigned to it move to General. The folder is renamed `Removed – <name>` and dropped from `focusIds`.
  - `handleExternalChange(api, kind: 'removed'|'moved', id, info) -> Promise<{changed: boolean}>`.
    - **If `id === rootId`**, meaning the whole `Focus Bars` folder was deleted or moved: if it was moved, adopt its new location (the folders inside are intact), and if it was deleted, recreate `Focus Bars`, General and an empty folder for the active focus. Then drop the other focuses and move their windows to General. The bar's bookmarks are untouched. The inactive focuses' bookmarks went with the folder the user deleted.
    - Otherwise it acts only if `id` is in `focusIds` and either `kind === 'removed'` or `info.parentId !== rootId`. In that case:
    - The focus is dropped and its windows move to General.
    - **If it was the active focus**, a new empty folder with the same title is created under the root and takes its place in `focusIds`, and its windows keep it. *(Deviation from the spec, which said the bar's bookmarks "become General's". That would mix them with General's stored bookmarks, so the active focus is recreated instead. Nothing is lost either way.)*
    - If the General folder is the one removed, it is recreated (empty, or as the active slot if it was active).

- [ ] **Step 1: Write failing tests:**
  - `create empty focus`
  - `create copy of current bar copies nested folders`: the bar is unchanged and the new folder holds an identical tree.
  - `rename changes folder title`
  - `delete inactive focus renames to Removed and reassigns windows`
  - `delete active focus swaps to General first`: afterwards the bar holds General's items and the removed folder holds what was on the bar.
  - `cannot delete General`
  - `external delete of inactive focus reassigns windows to General`
  - `external delete of active focus recreates it`
  - `external move out of Focus Bars drops focus`
  - `external delete of whole Focus Bars folder recreates it`: afterwards, `swapBar` to General succeeds and the bar's items are intact.
  - `swap moves are not treated as external`: replay every `onMoved` event the fake fired during a `swapBar`, and `handleExternalChange` returns `{changed:false}` for each.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: focus create/rename/delete and external changes`.

---

### Task 5: Fingerprints (restart matching)

**Files:**
- Create: `extension/lib/fingerprint.js`, `tests/fingerprint.test.js`

**Interfaces:**
- Produces (pure functions, no `api`):
  - `jaccard(a: string[], b: string[]) -> number`. Two empty sets score 0.
  - `matchWindows(wins: {id, urls}[], prints: State['prints'], threshold = 0.5) -> Record<windowId, printKey>`. Scores every (window, print) pair at or above the threshold, then assigns greedily from the highest score down. Each window and each print is used at most once.
  - `prunePrints(prints, liveKeys: Set<string>, now, maxAgeMs = 30*24*3600*1000) -> prints`. Removes prints that are not live and whose `lastSeen` is older than `maxAgeMs`.

- [ ] **Step 1: Write failing tests:** `jaccard basics`, `matchWindows below threshold leaves unmatched`, `matchWindows assigns each print once` (two windows both overlap one print, and the higher score wins while the other window gets none), `prunePrints keeps live and recent`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: window fingerprint matching`.

---

### Task 6: Controller (window events, assignment, badge, messages)

**Files:**
- Create: `extension/lib/controller.js`, `tests/controller.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `createController(api) -> {`
  - `boot(): Promise<void>`. Runs on **every** service-worker load. It runs `initialize`, which includes `recoverJournal`, then updates the badge. It does not touch the window map.
  - `restoreWindows(): Promise<void>`. Runs only on `runtime.onStartup` and `onInstalled`. For each current normal window (from `windows.getAll({populate:true})`) it runs `matchWindows` against `prints`. Matched windows get that print's focus and key. Unmatched windows get the active focus, a new key (`crypto.randomUUID()`) and an `unmatched: true` flag in the session map. It then writes the window map, prunes prints, swaps to the focused window's focus, and opens a **restore window of 60 s**.
  - `onFocusChanged(windowId): Promise<void>`. Ignores `-1` (`WINDOW_ID_NONE`), windows of type other than `normal`, and every window while `needsRecovery` is set. A window missing from the session map is added the same way as `onWindowCreated`. Otherwise it calls `switcher.request(focusOf(windowId))`.
  - `onWindowCreated(win)`. Normal windows inherit the current `activeId`, get a new print key, and are marked `unmatched: true` if the restore window is open.
  - `onWindowRemoved(windowId)`. Removes the window from the session map (its print stays in storage for the restart).
  - `onTabsChanged(windowId)`. Debounced by 2 s per window. A tab's address is `tab.url || tab.pendingUrl`, because restored tabs that haven't loaded yet may only have `pendingUrl`. Empty addresses are ignored.
    - **If the window is `unmatched` and the restore window is still open**, it first tries `matchWindows` for that window against the prints no other live window has claimed. On a match, it adopts that print's focus and key, clears `unmatched`, and swaps if the window has focus. This covers session restore, which creates windows before their tabs exist.
    - Otherwise it updates the window's print `urls` and `lastSeen`.
  - `assign(windowId, focusId)`. Updates the map and the print's `focusId`, then requests a swap if that window has focus.
  - `onBookmarkEvent(kind, id, info)`. Calls `handleExternalChange`, and updates the badge if anything changed.
  - `handleMessage(msg) -> Promise<any>`. Handles the popup messages listed in Task 7.
  
  `}`. The badge is global, with `action.setBadgeText({text})` set to the first 4 characters of the active focus name. This is deliberate: the bar is shared by every window, so the badge always says what the bar is showing.

- [ ] **Step 1: Write failing tests:**
  - `focus change swaps to window's focus`
  - `ignores non-normal and NONE`
  - `new window inherits active focus`
  - `restart restores focus by fingerprint`: seed `prints`, run `restoreWindows` with windows whose tabs match, and check that each window gets the right focus.
  - `late-restored window matches once its tabs arrive`: the window is created with no tabs during the restore window, its tabs appear (with `pendingUrl` only), and after the debounce it has the matching focus.
  - `boot does not reassign known windows`: the session map already has windows. Running `boot` again leaves the map unchanged.
  - `assign updates print and swaps when focused`
  - `needsRecovery blocks swaps until resolved`
  - `badge shows active focus`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Inject a `now()` function and a debounce timer so the tests are deterministic.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: controller wiring window and bookmark events`.

---

### Task 7: Extension shell (manifest, background, popup)

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/popup/popup.{html,css,js}`, `extension/icons/` (simple 16/48/128 PNGs, generated or plain shapes)

**Interfaces:**
- Consumes: `createController`.
- Popup messages (`chrome.runtime.sendMessage`) and their replies:
  - `{type:'get', windowId}` returns `{focuses:{id,name}[], current: focusId, needsRecovery, lastSwapMs}`
  - `{type:'assign', windowId, focusId}`
  - `{type:'create', windowId, name, copyCurrent}`. Creates the focus and assigns it to this window.
  - `{type:'rename', focusId, name}`
  - `{type:'delete', focusId}`. The popup asks for confirmation (`confirm()`) before sending it.
  - `{type:'resolveRecovery', focusId}`

- [ ] **Step 1:** `background.js` builds `createController(chrome)` and registers every listener **synchronously at the top level** (MV3 requirement): `windows.onFocusChanged/onCreated/onRemoved`, `tabs.onUpdated/onRemoved/onAttached/onDetached` (calling `onTabsChanged`), `bookmarks.onRemoved/onMoved`, `runtime.onStartup/onInstalled` (calling `restoreWindows`), and `runtime.onMessage` (calling `handleMessage`, then `return true`). At the top level, `const ready = controller.boot()` runs on **every** worker load, including when an event wakes the worker after it was shut down for being idle. Every handler awaits `ready` first.
- [ ] **Step 2:** The popup matches the spec layout: a radio list for this window's focus, then "+ New focus…", "Rename…" and "Delete…" (General has no delete option). When `needsRecovery` is set, the popup shows only "Which focus is on your bookmark bar right now?" with a radio list and a Confirm button. A small grey line at the bottom shows `Last swap: N ms`.
- [ ] **Step 3:** Run `npm test` (still all pass). Then run `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json'))"` to confirm the manifest is valid JSON.
- [ ] **Step 4:** Commit with `feat: extension manifest, background and popup`.

---

### Task 8: Manual check in a throwaway profile (user runs it)

- [ ] **Step 1:** Give the user this checklist. Use the same throwaway profile as Task 0 with sync off, and remove the spike first.
  1. Load `focus-bars/extension` unpacked. The bar is unchanged, `Other bookmarks/Focus Bars/General` exists, and the badge reads "Gene".
  2. Create "Dev" (empty) in window 1, and add three bookmarks to the bar.
  3. Open window 2 and set it to General. The bar shows the original bookmarks. Click back to window 1, and Dev's three are back.
  4. Click between the windows quickly about 10 times, then stop. The bar matches the window you stopped in, and no folder has gained or lost anything.
  5. Quit Chrome completely and reopen it (with "Continue where you left off" on). Each window gets its focus back.
  6. Delete the Dev folder in the bookmark manager while in window 1. Nothing is lost, and the popup still works.
  7. Delete a focus from the popup. A `Removed – …` folder appears.
- [ ] **Step 2:** Fix anything that fails, starting with a failing unit test that reproduces it, then commit. When everything passes, record the result in the spec and commit with `docs: manual check passed`.
