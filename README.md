# Focus Bars

A Chrome extension that gives each window its own **focus**: a named set of bookmarks. Chrome's bookmark bar shows the focus of whichever window you're in.

## Install (unpacked)
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Whatever is on your bookmark bar right now becomes the **General** focus. Nothing is moved.

## Use
- **Choose a focus** from the toolbar icon or from the **⇄** folder at the start of the bar. You can make a new focus from the toolbar icon.
- **Edit a focus** by editing the bar as usual while you're in a window using that focus.
- **Where bookmarks live.** Each focus's bookmarks are kept in **Other bookmarks → Focus Bars → <name>** while that focus isn't on the bar.
- **Turn off the ⇄ folder** from the toolbar menu, or by deleting it.
- **Keyboard shortcuts** (change them at `chrome://extensions/shortcuts`):
  - next focus: ⌃⇧→ on Mac, Alt+Shift+→ on Windows/Linux;
  - previous focus: ⌃⇧← on Mac, Alt+Shift+← on Windows/Linux;
  - open the menu: ⌥⇧F on Mac, Alt+Shift+F on Windows/Linux.

## Good to know
- **There is one bookmark bar in Chrome.** Switching the focus changes what every window's bar shows. Each window still remembers its own focus.
- **Chrome Sync.** With bookmark sync on, every switch is synced to your other devices. Use Focus Bars on one device, or turn off bookmark sync there.
- **Signed in with bookmarks saved to your Google Account?** Chrome then keeps two sets of bookmarks and shows both bars as one: your account bookmarks first, then those saved only on this device. Focus Bars switches the account part. Bookmarks saved only on this device stay on the bar in every focus; the toolbar menu tells you how many, and you can move them to your account in the Bookmark Manager. If you switch account bookmarks on or off, Focus Bars starts fresh in the set Chrome now shows and leaves the other set as it was.
- **Uninstalling:**
  - The bar keeps whichever focus was last on it.
  - Every other focus stays in **Other bookmarks → Focus Bars** as an ordinary folder.
  - The **⇄** folder stays on the bar with links that no longer work. Delete it by hand.

## Develop
`npm test` runs the unit tests (Node's built-in runner, no dependencies) against an in-memory fake of `chrome.*`. Design documents and plans are in `docs/`.
