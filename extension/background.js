import { createController } from './lib/controller.js';

const ctl = createController(chrome);

// Runs on every service-worker load, including when an event wakes it after it
// was shut down for idling. Every handler waits for it.
const ready = ctl.boot().catch((e) => console.error('Focus Bars: boot failed', e));

const run = (fn) => (...args) => {
  ready.then(() => fn(...args)).catch((e) => console.error('Focus Bars:', e));
};

// MV3: register every listener synchronously at top level.
chrome.runtime.onStartup.addListener(run(() => ctl.restoreWindows()));
chrome.runtime.onInstalled.addListener(run(() => ctl.restoreWindows()));

chrome.windows.onFocusChanged.addListener(run((windowId) => ctl.onFocusChanged(windowId)));
chrome.windows.onCreated.addListener(run((win) => ctl.onWindowCreated(win)));
chrome.windows.onRemoved.addListener(run((windowId) => ctl.onWindowRemoved(windowId)));

chrome.tabs.onCreated.addListener(run((tab) => ctl.onTabsChanged(tab.windowId)));
chrome.tabs.onUpdated.addListener(run((tabId, change, tab) => {
  if ('url' in change) ctl.onTabsChanged(tab.windowId);
}));
chrome.tabs.onRemoved.addListener(run((tabId, info) => {
  if (!info.isWindowClosing) ctl.onTabsChanged(info.windowId);
}));
chrome.tabs.onAttached.addListener(run((tabId, info) => ctl.onTabsChanged(info.newWindowId)));
chrome.tabs.onDetached.addListener(run((tabId, info) => ctl.onTabsChanged(info.oldWindowId)));

chrome.bookmarks.onRemoved.addListener(run((id, info) => ctl.onBookmarkEvent('removed', id, info)));
chrome.bookmarks.onMoved.addListener(run((id, info) => ctl.onBookmarkEvent('moved', id, info)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready
    .then(() => ctl.handleMessage(msg))
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the channel open for the async reply
});
