import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './fake-chrome.js';

test('background registers listeners and answers popup messages', async () => {
  const api = createFakeChrome({ bar: [{ title: 'a', url: 'https://a/' }], windows: [{ id: 1, focused: true, tabs: ['https://a/'] }] });
  mock.timers.enable({ apis: ['setTimeout'] }); // don't leave the 60 s restore timer running
  globalThis.chrome = api;
  await import('../extension/background.js');
  const events = [
    api.runtime.onStartup, api.runtime.onInstalled, api.runtime.onMessage,
    api.windows.onFocusChanged, api.windows.onCreated, api.windows.onRemoved,
    api.tabs.onCreated, api.tabs.onUpdated, api.tabs.onRemoved, api.tabs.onAttached, api.tabs.onDetached,
    api.bookmarks.onRemoved, api.bookmarks.onMoved,
  ];
  for (const e of events) assert.ok(e._count() >= 1, 'listener registered');
  api.runtime.onInstalled._fire({ reason: 'install' });
  const reply = await new Promise((resolve) =>
    api.runtime.onMessage._fire({ type: 'create', windowId: 1, name: 'Dev', copyCurrent: false }, {}, resolve));
  assert.equal(reply.ok, true, reply.error);
  const got = await new Promise((resolve) => api.runtime.onMessage._fire({ type: 'get', windowId: 1 }, {}, resolve));
  assert.deepEqual(got.result.focuses.map((f) => f.name), ['General', 'Dev']);
  assert.equal(got.result.current, reply.result.id);
  assert.deepEqual(api._titles('1'), [], 'window 1 now shows the empty Dev bar');
  assert.equal(api._badge(), 'Dev');
  const bad = await new Promise((resolve) => api.runtime.onMessage._fire({ type: 'nope' }, {}, resolve));
  assert.equal(bad.ok, false);
  delete globalThis.chrome;
  mock.timers.reset();
});
