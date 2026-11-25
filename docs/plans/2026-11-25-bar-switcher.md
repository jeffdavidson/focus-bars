# Bar Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a `⇄ <focus>` folder first on the bookmark bar whose entries switch the current window's focus.

**Architecture:** A new `extension/lib/switcher-folder.js` reconciles the folder in place (it never deletes and recreates it). Swaps and bar copies skip the folder by id. The controller calls `syncSwitcher` under its lock after every change. A new `extension/switch.html` page sends the existing `assign` message and then goes back.

**Tech Stack:** Same as before: plain ES modules and `node --test` against `tests/fake-chrome.js`.

**Spec:** `docs/specs/2026-11-25-bar-switcher-design.md` (and `docs/specs/2026-11-25-focus-bars-design.md`).

## Global Constraints
- Folder title: `⇄ ` (U+21C4 then a space) followed by the active focus name. Entry titles: `✓ <name>` for the active focus, and `    <name>` (four spaces) for the others. Entry URL: `api.runtime.getURL('switch.html?focus=' + encodeURIComponent(id))`.
- An entry is recognised as a switcher link if its URL contains `/switch.html?focus=`, whatever the extension's origin.
- New state fields: `switcherId: string | null` and `showSwitcher: boolean`. A missing `showSwitcher` (state from before this change) means `true`, and a missing `switcherId` means `null`.
- The switcher folder is never moved into a focus folder, never copied into a new focus, and never counted as one of the user's bookmarks.
- **Ruling against the short design:** the design said the folder would be rebuilt. Instead it is *reconciled in place*: titles and URLs are updated, entries are added or removed as needed, and the folder keeps its id. This avoids remove/create churn in Chrome Sync and `onRemoved` events for the extension's own work. Bookmarks the user drops into the folder (anything that isn't a switcher link) are never removed.

## Review Focus
1. **A swap while the switcher is on the bar:** it stays at index 0 and never lands in a focus folder, including when journal recovery resumes after a crash. *(Task 1.)*
2. **"Copy of current bar" when creating a focus:** the switcher is not copied. *(Task 1.)*
3. **The extension's own reconciliation:** it never triggers the "user deleted the switcher" handling. *(Task 3, `own sync is not an external delete`.)*
4. **Reinstall:** a leftover switcher from an earlier install is adopted, not filed under General on the first swap. *(Task 3.)*
5. **Stale entry links** (a focus deleted since the link was made): picking one falls back to General instead of storing an unknown focus. *(Task 4.)*

---

### Task 1: Swaps and copies skip the switcher
**Files:** Modify `extension/lib/swap.js`, `extension/lib/focuses.js` and `tests/fake-chrome.js` (add `runtime.getURL(p)`, returning `'chrome-extension://fakeid/' + p`). Tests go in `tests/swap.test.js` and `tests/focuses.test.js`.

**Interfaces:**
- `moveAllChildren(bookmarks, fromId, toId, skipIds = []) -> Promise<void>`. Children whose id is in `skipIds` are left where they are.
- `runJournal` passes `[state.switcherId]` when moving the bar into `from`.
- `copyTree` skips `state.switcherId` at the top level when copying the bar.

- [ ] **Write failing tests:**
  - `swap leaves the switcher first on the bar`: put a folder `⇄ General` at index 0, set its id as `switcherId`, and swap to Dev. The bar is `['⇄ General','x','y']` and General is `['a','b','c']`. Swap back, and the bar is `['⇄ General','a','b','c']`.
  - `recovery leaves the switcher on the bar`: `_failAfterMoves(1)` with the switcher present, then `recoverJournal`. The switcher is still at bar index 0 and not in General.
  - `copy of current bar skips the switcher`.
- [ ] Run `npm test`. Expected: those 3 FAIL.
- [ ] Implement.
- [ ] Run `npm test`. Expected: all pass.
- [ ] Commit with `feat: swaps and bar copies skip the switcher folder`.

### Task 2: Reconcile the switcher folder
**Files:** Create `extension/lib/switcher-folder.js` and `tests/switcher-folder.test.js`.

**Interfaces:**
- `SWITCH_MARK = '/switch.html?focus='`, `isSwitchLink(url) -> boolean`.
- `syncSwitcher(api) -> Promise<State>`, which handles three cases:
  - **Setting off:** if `showSwitcher === false` and the folder exists, remove it (first set `switcherId = null` and write state, so the resulting `onRemoved` is ignored), then return.
  - **Folder missing:** if `switcherId` is null or the folder is gone, create it at bar index 0.
  - **Then always:**
    - If its index is not 0, move it to index 0.
    - Set its title to `⇄ <active focus name>`.
    - Make its switcher-link children match `focusIds`, in order (update the title and URL of existing ones in place, create missing ones, remove extra ones).
    - Leave any other children untouched.
    - Write the state.

  While `needsRecovery` is set, it does nothing.

- [ ] **Write failing tests:**
  - `creates folder first with entries and check mark`
  - `updates title and check after a swap`, where `switcherId` is unchanged
  - `adds and removes entries as focuses change`
  - `keeps user items dropped into the folder`
  - `moves the folder back to index 0`
  - `showSwitcher false removes the folder`
  - `missing showSwitcher counts as on`
- [ ] Run `npm test`. Expected: FAIL (module missing).
- [ ] Implement.
- [ ] Run `npm test`. Expected: PASS.
- [ ] Commit with `feat: reconcile bookmark-bar switcher folder`.

### Task 3: Setup detection and external changes
**Files:** Modify `extension/lib/setup.js` and `extension/lib/focuses.js`. Tests go in `tests/setup.test.js` and `tests/focuses.test.js`.

**Interfaces:**
- `findStaleSwitcher(bookmarks, barId) -> Promise<string|null>`. Returns the bar's first child if it's a folder whose title starts with `⇄ ` and whose children are all switcher links (at least one). Both no-state paths in `initialize` set `switcherId` from it and `showSwitcher: true`. `freshState` gains both fields.
- `handleExternalChange`: if `id === state.switcherId`, and the folder was either removed or moved to a parent other than `barId`, set `switcherId = null` and `showSwitcher = false` and return `{changed:true}`. If it was moved within the bar, return `{changed:true}` so the controller re-syncs its position.

- [ ] **Write failing tests:**
  - `first run adopts a leftover switcher`: the bar holds `⇄ Dev` with switcher links plus `a`. `switcherId` is set, and a later swap doesn't move it.
  - `reinstall adopts a leftover switcher`
  - `a folder of ordinary bookmarks named ⇄ is not adopted`
  - `user deleting the switcher turns it off`
  - `user moving the switcher off the bar turns it off`
  - `own sync is not an external delete`: replay every `onRemoved`/`onMoved` event fired during a `syncSwitcher` that removes an entry, and expect `{changed:false}` for each, with the setting still on.
- [ ] Run `npm test`. Expected: FAIL.
- [ ] Implement.
- [ ] Run `npm test`. Expected: PASS.
- [ ] Commit with `feat: adopt leftover switcher; user delete turns it off`.

### Task 4: Controller keeps the switcher in sync
**Files:** Modify `extension/lib/controller.js`. Tests go in `tests/controller.test.js`.

**Interfaces:**
- `syncSwitcher(api)` runs inside `exclusive`:
  - at the end of `boot`;
  - after each swap (inside the same locked `runSwap`);
  - after `create`, `rename`, `delete` and `resolveRecovery`;
  - after an `onBookmarkEvent` that changed something;
  - in `onBookmarkChanged(id)`, a new handler that re-syncs when `id` is a focus folder (a rename in the bookmark manager).
- `assign` stores `validFocus(state, focusId)`, never an unknown id.
- Messages: `get` also returns `showSwitcher` (default true). New message `{type:'setShowSwitcher', value: boolean}` sets the field, then syncs.

- [ ] **Write failing tests:**
  - `switcher appears after boot`
  - `switcher label follows window focus`
  - `renaming a focus folder in the manager updates the switcher`
  - `stale switch link falls back to General`
  - `setShowSwitcher toggles the folder`
  - `get reports showSwitcher`
- [ ] Run `npm test`. Expected: FAIL.
- [ ] Implement.
- [ ] Run `npm test`. Expected: PASS.
- [ ] Commit with `feat: controller keeps switcher in sync`.

### Task 5: Switch page, popup checkbox and wiring
**Files:**
- Create `extension/switch.html` and `extension/switch.js`.
- Modify `extension/background.js` (add `bookmarks.onChanged` → `ctl.onBookmarkChanged`), `extension/popup/popup.js` and `popup.css` (add the checkbox), and `tests/background.test.js` (check that `onChanged` has a listener, and the fake gains a `bookmarks.onChanged` event, which it already has).
- `switch.js`:
  1. Read `focus` from the query string.
  2. Get `tab = await chrome.tabs.getCurrent()`.
  3. `await chrome.runtime.sendMessage({type:'assign', windowId: tab.windowId, focusId: focus})`.
  4. Then `history.length > 1 ? history.back() : window.close()`.
  The page body is empty and uses `color-scheme: light dark` to keep the flash minimal.
- Popup: below the actions, a checkbox labelled `Show focus menu on bookmark bar`, bound to `showSwitcher`, which sends `setShowSwitcher`.

- [ ] Update the background smoke test to expect a listener on `bookmarks.onChanged`, then run `npm test`. Expected: FAIL.
- [ ] Implement.
- [ ] Run `npm test`. Expected: PASS.
- [ ] Check the popup checkbox in the browser-pane harness.
- [ ] Commit with `feat: switch page, popup toggle and wiring`, and remove the `spike-bar-folder` branch from GitHub.

### Task 6: Hands-on check (the user runs it)
Reload the extension in the throwaway profile.
1. A `⇄ <focus>` folder appears first on the bar.
2. Picking an entry switches this window's focus, and the label and ✓ follow.
3. After switching between two windows, the folder is never inside **Focus Bars**.
4. Unticking the checkbox removes the folder, and ticking it brings it back.
5. Deleting the folder in the bookmark manager makes it stay gone, and the checkbox shows as unticked.
