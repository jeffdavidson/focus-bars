# Keyboard shortcuts for switching focus

*Short design, 2026-11-25. Approved by the user.*

## Intent
Switch the current window's focus without the mouse.

## Approaches
1. **Next and previous shortcuts, plus a shortcut that opens the menu (chosen).** These use Chrome's `commands`. There is no tab hop, and users can change the keys at `chrome://extensions/shortcuts`.
2. **A shortcut that only opens the menu.** That still needs the mouse or arrow keys afterwards. It's included in option 1 anyway.
3. **One shortcut per focus.** Chrome allows only 4 suggested keys, and focuses are created dynamically. Rejected.

## Design
| Command | Mac | Windows/Linux |
|---|---|---|
| `next-focus` | ⌃⇧→ (`MacCtrl+Shift+Right`) | `Alt+Shift+Right` |
| `previous-focus` | ⌃⇧← (`MacCtrl+Shift+Left`) | `Alt+Shift+Left` |
| `_execute_action` (opens the menu) | ⌥⇧F (`Alt+Shift+F`) | `Alt+Shift+F` |

- **Which window:** next and previous act on the window the shortcut was pressed in, using the `tab.windowId` passed to `commands.onCommand`. If there is no tab, they use the focused normal window.
- **Order:** they step through the focuses in the menu's order and wrap around. They use the same `assign` path as the popup, so the bar, the badge and the ⇄ label all update.
- **While the extension is asking which focus is on the bar, they do nothing.**
- **Why not ⌥⇧←/→ on the Mac:** that combination selects words in text fields.
