# Bar switcher: pick a focus from the bookmark bar

*Short design, 2026-11-25. This adds to `2026-11-25-focus-bars-design.md`.*

## Intent
The user wants to change a window's focus from the bookmark bar itself, not only from the toolbar icon. Extensions can't add controls to the bar. A bookmark **folder** on the bar already opens as a native drop-down, though, so the extension keeps one special folder there as the switcher.

## Approaches
1. **A switcher folder on the bar (chosen).** It's visible and right where the user looks. Picking an entry briefly hops the current tab to an extension page and straight back. The user tried this in a throwaway test (`spike-bar-folder` branch) and found the hop acceptable.
2. **A keyboard shortcut.** No hop and no extra bookmark, but nothing visible on the bar. Not chosen, though it could be added later.
3. **The toolbar popup only (today).** Kept, and it works exactly as before.

## Design
- **The folder.** It always sits first on the bar. Its title is `⇄ <focus name>`, the focus currently on the bar. It holds one entry per focus, in the same order as the popup, with `✓` before the current one. Each entry is a link to the extension's own page, `switch.html?focus=<focusId>`.
- **Picking an entry.** The switch page finds its own window through `chrome.tabs.getCurrent()` and sends the background `{type:'assign', windowId, focusId}`, the same message the popup sends, so the bar swaps right away. It waits for the reply, then calls `history.back()`. If the entry was opened in a new tab, it closes that tab instead.
- **Swaps never move it.** Swapping and journal recovery skip the switcher folder, so it stays first on the bar and never ends up in a focus folder.
- **It stays current.** The folder is rebuilt after every swap, and after any create, rename or delete. *(My call: the extension rebuilds its contents rather than editing them in place. That's simpler, and the folder is small.)*
- **It can be turned off.** The popup gets a checkbox, "Show focus menu on bookmark bar", which is on by default. If the user deletes the folder in the bookmark manager, that counts as turning it off. Nothing recreates it until they tick the box again. *(My call.)*
- **Install, reinstall and uninstall.** On start-up, any folder first on the bar whose title starts with `⇄ ` and holds only `switch.html` links is treated as the switcher, never as the user's bookmarks, and is rebuilt. After an uninstall the folder stays on the bar with links that no longer work, and the user deletes it by hand. This is noted in the README / popup help.

## Not doing
- A keyboard shortcut. That's a separate small addition if wanted later.
- Opening the switcher's page without the hop, which Chrome doesn't allow from a bookmark click.

## Testing
- **Unit tests against the fake:**
  - swaps and journal recovery leave the switcher first on the bar and out of every focus folder;
  - the switcher is rebuilt with the right title and entries after a swap, create, rename and delete;
  - deleting the switcher turns the setting off and it isn't recreated;
  - turning the setting back on recreates it;
  - start-up recognises an existing switcher.
- **A hands-on check in the throwaway profile:** pick focuses from the bar in two windows, and confirm the folder never appears inside **Focus Bars**.
