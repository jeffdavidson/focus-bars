// Opened from the bookmark bar's "⇄" folder. Switch this window's focus, then
// return to the page the user was on — or, if the entry was opened in a new tab
// (middle-click, "Open all"), close that tab.
const focusId = new URLSearchParams(location.search).get('focus');
let tab = null;

try {
  tab = await chrome.tabs.getCurrent();
  if (focusId && tab) {
    await chrome.runtime.sendMessage({ type: 'assign', windowId: tab.windowId, focusId, quick: true });
  }
} catch (e) {
  console.error('Focus Bars: switch failed', e);
} finally {
  if (history.length > 1) history.back();
  else if (tab) chrome.tabs.remove(tab.id);
  else window.close();
}
