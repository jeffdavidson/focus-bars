// Opened from the bookmark bar's "⇄" folder. Switch this window's focus, then
// return to the page the user was on (or close the tab if it was opened in a new one).
const focusId = new URLSearchParams(location.search).get('focus');

function leave() {
  if (history.length > 1) history.back();
  else window.close();
}

try {
  const tab = await chrome.tabs.getCurrent();
  if (focusId && tab) {
    await chrome.runtime.sendMessage({ type: 'assign', windowId: tab.windowId, focusId, quick: true });
  }
} catch (e) {
  console.error('Focus Bars: switch failed', e);
} finally {
  leave();
}
