# Chrome Web Store submission: Focus Bars 1.0.0

Copy each field into the Developer Dashboard. The upload file is `dist/focus-bars-1.0.0.zip` (built with `npm run package`).

---

## Store listing tab

**Name** *(taken from the manifest)*: Focus Bars

**Summary** *(taken from the manifest's description, 132 characters at most)*: A different bookmark bar for each window's focus.

**Description:**

```
Give every Chrome window its own bookmark bar.

Working on several things at once? Keep a window for each one: development in one, music in another, a project in a third. Focus Bars gives each window a "focus" (a named set of bookmarks), and Chrome's bookmark bar shows the bookmarks for the window you're in. Click into another window and the bar follows.

HOW IT WORKS
• Your current bookmark bar becomes the "General" focus. Nothing is moved on install.
• Create a focus from the toolbar icon. Add bookmarks to the bar as usual, and they belong to that window's focus.
• Switch focus from the toolbar menu, from the ⇄ folder at the start of the bar, or with a keyboard shortcut.
• Each window remembers its focus, even after you quit and reopen Chrome.

KEYBOARD SHORTCUTS (change them at chrome://extensions/shortcuts)
• Next focus: Ctrl+Shift+→ on Mac, Alt+Shift+→ on Windows/Linux
• Previous focus: Ctrl+Shift+← on Mac, Alt+Shift+← on Windows/Linux
• Open the menu: Option+Shift+F on Mac, Alt+Shift+F on Windows/Linux

YOUR BOOKMARKS ARE SAFE
Bookmarks are only ever moved, never deleted. While a focus isn't on the bar, its bookmarks are kept in Other bookmarks → Focus Bars → <focus name>. Deleting a focus keeps its bookmarks in a "Removed –" folder.

GOOD TO KNOW
• Chrome has one bookmark bar, so switching the focus changes what every window's bar shows. Each window still remembers its own focus.
• With Chrome Sync on, every switch is synced to your other devices. It works best on one device, or with bookmark sync turned off there.
• If you uninstall, delete the ⇄ folder from your bar by hand. Your other bookmarks stay where they are.

PRIVACY
Everything stays on your computer. Focus Bars sends no data anywhere: no servers, no analytics, no ads.
```

**Category:** Productivity → Workflow & Planning

**Language:** English

**Graphic assets:**
- **Store icon:** `extension/icons/128.png` (128×128).
- **Screenshots** (at least 1, up to 5, at **1280×800** or 640×400): take them in your throwaway profile. See the hand-off notes for how. Suggested shots:
  1. A window on "Dev" with its bookmarks on the bar, and the ⇄ menu open showing the focuses.
  2. The toolbar menu open: the focus list, "+ New focus…" and the bar-menu checkbox.
  3. Two windows side by side, each on a different focus. Click into one so its bar shows.
- **Small promo tile** (440×280): optional, so leave it out.

---

## Privacy tab

**Single purpose:**

```
Shows a different set of bookmarks on Chrome's bookmark bar for each browser window, according to the "focus" the user has chosen for that window.
```

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `bookmarks` | `Core function: moves the user's bookmarks between the bookmark bar and per-focus folders under "Other bookmarks → Focus Bars", and keeps a "⇄" menu folder on the bar for switching focus.` |
| `storage` | `Remembers which focus each window uses, which focus is currently on the bar, and the user's settings. Stored locally only.` |
| `tabs` | `Reads the web addresses of tabs open in each window so the extension can recognise each window after Chrome restarts and restore its focus. Used and stored locally only; never transmitted.` |

**Are you using remote code?** No. All code is in the package.

**Data usage:** what user data does it collect?
- Tick **Web history**. The extension stores the addresses of open tabs locally to recognise windows. It never leaves the device, but declaring it is the cautious choice.
- Leave every other category unticked.
- Tick all three certifications: data isn't sold to third parties, isn't used for anything unrelated to the single purpose, and isn't used for creditworthiness or lending.

**Privacy policy URL:** `https://gist.github.com/jeffdavidson/bb6506ef085663a50f1027a8d77b7766`

This is a public gist copy of `PRIVACY.md`. If you change the policy, update the gist too with `gh gist edit bb6506ef085663a50f1027a8d77b7766 PRIVACY.md`.

---

## Distribution tab
- **Visibility:**
  - **Unlisted:** anyone with the link can install it, and it doesn't appear in search.
  - **Public:** listed in the store and searchable.
  - **Private:** only for testers you name.
- **Regions:** all regions.
- **Pricing:** free.
