# Focus Bars: one bookmark bar per window

*Design document, 2026-11-25. Working name "Focus Bars".*

## Intent

The user works in several Chrome windows at once. Each window holds the tabs for one topic, such as software development or music, and changing focus means switching windows. Chrome has only one bookmark bar, so it shows the same bookmarks in every window, and most of them don't fit the topic at hand.

Focus Bars is a Chrome extension that gives each window a **focus**, which is a named set of bookmarks. The real bookmark bar swaps to the focus of whichever window is active. You set a window's focus once, and the extension remembers it, including after Chrome restarts.

Success means switching windows brings up the right bookmarks without any extra step, the bar still looks and works like Chrome's own, and no bookmark is ever lost.

## Goals

- Several named focuses, each with its own set of bookmark-bar contents.
- Each window is assigned a focus, and the bookmark bar shows the focus of the active window.
- The window-to-focus assignment survives a Chrome restart.
- You customize a focus by editing the bookmark bar normally while in a window with that focus. There is no separate editor.
- Create, rename and delete focuses from the extension's toolbar popup.
- Installing the extension loses nothing, and uninstalling it leaves every bookmark in plain, visible folders.

## Non-goals (for now)

- Automatic focus selection, whether by the site you're on, the tabs in a window, or the time of day.
- A different focus on each device, or coordination between devices that both run the extension.
- Publishing to the Chrome Web Store. It will be loaded unpacked for personal use first.
- Swapping anything other than the bookmark bar, such as the "Other bookmarks" contents or tab groups.

## Anti-goals (a failure even if it technically works)

- Any bookmark lost, duplicated, or ending up in the wrong focus, including after a crash, a quick run of window switches, or an uninstall.
- A bar that visibly churns or lags enough to be distracting on every window switch.
- Bookmarks hidden in extension storage instead of real bookmark folders.

## Constraints

- **Extensions cannot draw inside Chrome's bookmark bar.** The only way to get a native-looking bar is to change what is in the real one through the `chrome.bookmarks` API.
- **There is one bookmark bar per profile**, shared by every window. Swapping on each window switch is therefore inherent to this design.
- **Manifest V3.** The background code is a service worker that can be shut down at any moment, so all state must be kept in `chrome.storage`, not in variables.
- **Chrome Sync.** If bookmark sync is on, every swap is synced to the user's other devices. Their bars change too, and the sync traffic grows. This is accepted and documented, not solved (see Known risks).
- **Window IDs do not survive a restart.** After a restart, windows must be matched to their focus some other way (see Restoring after restart).

## Approaches considered

1. **Swap the contents of the native bookmark bar (chosen).** It is exactly Chrome's own bar: native look, every page including `chrome://` pages, normal drag-and-drop editing. The costs are a possible brief flicker on each swap, sync churn, and the fact that the extension really is moving bookmarks around.
2. **Draw a separate bar of the extension's own**, either as a strip added to the top of each web page, in the side panel, or on a custom new-tab page. It is flexible and never touches real bookmarks, but it doesn't look native, can't appear on Chrome's own pages or the Web Store, and needs its own editing interface. Rejected because the user wants the native bar.
3. **Chrome profiles, with no extension.** Each profile already has its own bookmark bar, which gives per-window bars for free. But profiles also separate logins, history and extensions. The user went with the extension. This option is recorded so it can be revisited.

The user chose approach 1, with the focus chosen per window and set by hand once per window.

## Design

### Where bookmarks live

- A folder **"Focus Bars"** under **Other bookmarks** holds one subfolder per focus, such as `Focus Bars/Dev`, `Focus Bars/Music` and `Focus Bars/General`.
- The **active** focus's bookmarks sit on the bookmark bar itself, and its folder is empty while they are there. Every **inactive** focus's bookmarks sit in its folder.
- A focus is identified by its folder's bookmark ID, and its display name is the folder's title. *(My call: this means renaming the folder in Chrome's bookmark manager also renames the focus.)*
- **The extension keeps its own list of focuses** (folder IDs, in `chrome.storage.local`). A folder only counts as a focus if it's on that list, so folders the user creates by hand inside "Focus Bars" are ignored. *(My call.)*
- If a focus folder is deleted or moved out of "Focus Bars" in the bookmark manager (`chrome.bookmarks.onRemoved` / `onMoved`), the extension drops that focus from its list and moves its windows to General. If that focus was active, its bookmarks are on the bar, so the extension recreates an empty folder with the same name and keeps it as the active focus. This avoids mixing those bookmarks into General. Nothing is lost. *(Changed during planning.)* If General's own folder disappears, recreate it. *(My call.)*
- Find the bookmark-bar and "Other bookmarks" nodes from the bookmark tree (using `folderType` where available, and falling back to the root's children in order), not by hard-coded IDs.

### First run

- Create `Focus Bars/General`. The current bar contents *become* General and stay on the bar, so nothing moves on install.
- General is the active focus, and every existing window is assigned General.

### Reinstall, or saved state missing while the folders remain

This happens after an uninstall and reinstall, after the extension's data is cleared, or when the "Focus Bars" folder arrives through sync. *(My call:)*

- Rebuild the focus list from the subfolders of "Focus Bars", except those named `Removed – …`.
- The active focus's folder is empty while its bookmarks are on the bar, so **if exactly one focus folder is empty, that focus is the one on the bar.** Make it active.
- If none or several are empty, do not swap anything. The popup asks "Which focus is on your bookmark bar right now?" and stays in that state until the user answers. Window switches do nothing until then.
- Window assignments are not recoverable this way, so every window starts on the focus that is on the bar.

### Swapping

When the bar must change from focus A to focus B:

1. Write a **journal** entry `{from: A, to: B, phase: 'toFolder'}` to `chrome.storage.local`.
2. Move every child of the bookmark bar, in order, into A's folder, then set the journal's phase to `'toBar'`.
3. Move every child of B's folder, in order, onto the bookmark bar.
4. Record B as the active focus and clear the journal.

- **One swap at a time.** Swaps run through a single queue. If several window switches happen while a swap is running, only the most recent target matters. The intermediate swaps are skipped.
- **Crash recovery.** On service-worker start-up, if a journal entry exists, finish it **from the recorded phase**. If the phase is `'toFolder'`, finish step 2, then do step 3. If the phase is `'toBar'`, only finish step 3. Never re-run step 2 at that point, because it would push B's bookmarks that already reached the bar into A's folder. *(Corrected during planning.)*
- If A and B are the same focus, do nothing.

### When a swap happens

- `chrome.windows.onFocusChanged` fires when the user changes window. Ignore `WINDOW_ID_NONE`, which fires when Chrome loses focus to another app, and windows that aren't normal browser windows (popups, devtools).
- Swap to the newly focused window's focus.
- **New windows** inherit the focus that was active when they were opened. Changing the focus in the popup applies to the current window and swaps right away.

### Restoring after restart

- Keep the current window-to-focus assignments in `chrome.storage.session`, keyed by window ID.
- Also keep a **fingerprint** of each window in `chrome.storage.local`: the set of its tab URLs and its focus, updated (debounced) as tabs change.
- On start-up, and whenever a window is created, compare its tabs to the stored fingerprints. Assign the focus of the best match if the overlap is strong enough. Otherwise use the inheritance rule above. *(The builder chooses the matching method and threshold. Something like Jaccard overlap of 50% or more is a reasonable start.)*
- Fingerprints for windows that no longer exist and haven't matched anything for a while (say 30 days) are deleted.

### Popup (toolbar icon)

```
 Focus for this window:  ● Dev   ○ Music   ○ General
 ─────────────────────
 + New focus…    Rename…    Delete…
```

- **Pick a focus:** assigns it to the current window and swaps.
- **New focus:** asks for a name and whether to start empty or as a copy of the current bar. A copy duplicates the bookmarks.
- **Rename:** renames the focus folder.
- **Delete:** asks for confirmation. Windows using that focus switch to General, and its folder is removed from the focus list and renamed `Removed – <name>` (it stays under "Focus Bars", and is never counted as a focus) rather than deleted, because Chrome has no bookmark trash. General can't be deleted. *(My call.)*
- The toolbar icon's badge shows a short form of the current window's focus, such as "Dev". *(My call, so you can see which focus is active at a glance.)*

### Customizing

You edit the bookmark bar the normal way. Because the active focus's bookmarks are on the bar, any change is automatically part of that focus, and the next swap moves it into the focus's folder.

### Uninstalling

The bar keeps whatever focus was last active, and every other focus stays in `Other bookmarks/Focus Bars/…` as an ordinary folder.

## Known risks

- **Flicker or slowness on swap.** Each bookmark is a separate API move, and the bar redraws as they happen. **The first build step is a throwaway test** that swaps two bars of about 30 bookmarks back and forth on window focus. It checks how long a swap takes and how it looks before anything else is built. **Pass:** a 30-bookmark swap finishes in under about 300 ms, and the bar looks like it changes in one go, not item by item. *(My call on the numbers.)* **Spike result (2026-11-25): passed.** The user ran it in a throwaway profile with a 30-bookmark bar and reported that swaps look fast. Exact milliseconds were not recorded. If it fails, stop and come back to the user with what was measured. Any fallback, such as nesting each focus inside one folder on the bar, changes the "native bar" goal, so it's the user's decision.
- **Sync.** With bookmark sync on, each swap is synced to the user's other devices. Running the extension on two synced devices at once would make them fight over the bar. For now this is documented: use it on one device, or turn off bookmark sync there.
- **Editing during a swap.** If the user drags a bookmark onto the bar while a swap is moving items, it could land in the wrong focus. Swaps take a moment, so this is accepted.

## Left to the builder

- File layout, plain JavaScript or TypeScript, and whether to use a build step. Keep it light. A plain unpacked MV3 extension is fine.
- The details of matching windows after a restart.
- Popup styling.
- Tests. Pure logic, such as queue coalescing, journal recovery and fingerprint matching, should be unit-tested with a stubbed `chrome.bookmarks`. The real swap is checked by hand in Chrome.

## Manual check (2026-11-25): passed

The user ran the plan's Task 8 checklist in a throwaway Chrome profile with sync off. Every step behaved as described:

1. The extension loaded, the badge showed "Gene", and the bar was unchanged.
2. Creating "Dev" emptied the bar and the badge showed "Dev".
3. Two windows each kept their own focus, and the bar followed the active window.
4. After rapid switching, the bar matched the window the user stopped in, and the folders were intact.
5. After quitting and reopening Chrome, both windows got their focus back.
6. Deleting the active focus's folder in the bookmark manager: the folder was recreated, and the bar kept its bookmarks.
7. Deleting a focus from the popup: the `confirm()` prompt appeared, and the bookmarks were kept in "Removed – Dev".

Observed and expected: because Chrome has one shared bar, changing the focus also changes what a background window's bar shows. Each window still keeps its own focus.

## Two bookmark sets (2026-11-26, version 1.0.1)

Found when the extension was installed in a real, signed-in profile. Newer Chrome can keep two complete bookmark sets in one profile: one saved in the Google account (`syncing=true`) and one kept only on this device (`syncing=false`). Each set has its own bookmark bar and its own Other bookmarks. Chrome shows both bars as one strip: the account bar's items first, then the device bar's (confirmed in that profile: the device bar's ⇄ folder sat in the » overflow after 65 account bookmarks). Version 1.0.0 recorded the first bar Chrome reported at install and never checked again. Account bookmarks were switched on after install, so every swap, the ⇄ menu and the focus folders went to the hidden device set. Deletions made in the Bookmark Manager (in the account set) never reached the folders the extension tracked.

The change:

- **Switch the account bar.** Prefer the `syncing=true` bar when there is one: it comes first on screen, so the ⇄ menu is visible, and it's where Chrome saves new bookmarks once the user is signed in. Always use the Other bookmarks from the same set. (Switching both bars, with each focus split across two folders, was considered and set aside by the user: twice the work and risk, for people who keep many bookmarks only on their device.)
- **Say what doesn't switch.** Items on the device bar stay on in every focus. When there are any (Focus Bars' own leftover ⇄ folders aren't counted), the popup shows a note with the count, an "Open Bookmark Manager" button (the user can move them to their account there) and "Don't show again". Focus Bars never moves them itself.
- **Re-check it.** The check runs on every service-worker start, and when the tracked bar is deleted.
- **Start over in the shown set when it changes,** as a reinstall would:
  - adopt a Focus Bars folder already there (asking which focus is on the bar if that's unclear), or make the current bar General;
  - carry over the ⇄ menu setting;
  - point open windows at the new active focus;
  - first, while the old bar still exists, finish any half-done swap there and swap that set back to General, so its bar looks as it did before Focus Bars and each focus's bookmarks are in its folder;
  - remove the switch links from the old ⇄ folder, and the folder itself unless the user filed their own bookmarks in it.
- **Never move bookmarks between the two sets.** The old set's Focus Bars folder is left where it is. Its focuses don't appear in the menus while the other set is shown; switching back adopts them again without a recovery question.

