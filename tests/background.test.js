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
    api.bookmarks.onRemoved, api.bookmarks.onMoved, api.bookmarks.onChanged,
  ];
  for (const e of events) assert.ok(e._count() >= 1, 'listener registered');
  api.runtime.onInstalled._fire({ reason: 'install' });
  const reply = await new Promise((resolve) =>
    api.runtime.onMessage._fire({ type: 'create', windowId: 1, name: 'Dev', copyCurrent: false }, {}, resolve));
  assert.equal(reply.ok, true, reply.error);
  const got = await new Promise((resolve) => api.runtime.onMessage._fire({ type: 'get', windowId: 1 }, {}, resolve));
  assert.deepEqual(got.result.focuses.map((f) => f.name), ['General', 'Dev']);
  assert.equal(got.result.current, reply.result.id);
  assert.deepEqual(api._titles('1'), ['⇄ Dev'], 'window 1 now shows the empty Dev bar (plus the switcher)');
  assert.equal(api._badge(), 'Dev');
  const bad = await new Promise((resolve) => api.runtime.onMessage._fire({ type: 'nope' }, {}, resolve));
  assert.equal(bad.ok, false);
  delete globalThis.chrome;
  mock.timers.reset();
});

test('quick messages from the switch page are acknowledged before the swap', async () => {
  const api = createFakeChrome({ bar: [{ title: 'a', url: 'https://a/' }], windows: [{ id: 1, focused: true, tabs: ['https://a/'] }] });
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.chrome = api;
  await import('../extension/background.js?quick');
  api.runtime.onInstalled._fire({ reason: 'install' });
  const created = await new Promise((resolve) =>
    api.runtime.onMessage._fire({ type: 'create', windowId: 1, name: 'Dev', copyCurrent: false }, {}, resolve));
  const generalId = (await new Promise((resolve) => api.runtime.onMessage._fire({ type: 'get', windowId: 1 }, {}, resolve))).result.generalId;
  let ack = null;
  api.runtime.onMessage._fire({ type: 'assign', windowId: 1, focusId: generalId, quick: true }, {}, (r) => { ack = r; });
  assert.deepEqual(ack, { ok: true }, 'answered synchronously');
  for (let i = 0; i < 50 && api._titles('1').length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(api._titles('1'), ['⇄ General', 'a'], 'swap still happens');
  assert.ok(created.ok);
  delete globalThis.chrome;
  mock.timers.reset();
});

async function loadFresh(tag, seed) {
  const api = createFakeChrome(seed ?? { bar: [{ title: 'a', url: 'https://a/' }], windows: [{ id: 1, focused: true, tabs: ['https://a/'] }] });
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.chrome = api;
  await import(`../extension/background.js?${tag}`);
  return api;
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const done = () => { delete globalThis.chrome; mock.timers.reset(); };

test('a Chrome update does not rebuild the window map', async () => {
  const api = await loadFresh('cu', {
    bar: [{ title: 'a', url: 'https://a/' }],
    windows: [{ id: 1, focused: true, tabs: ['https://a/'] }, { id: 2, tabs: ['chrome://newtab/'] }],
  });
  api.runtime.onInstalled._fire({ reason: 'install' });
  await settle();
  const before = (await api.storage.session.get('windows')).windows[2].focusId; // General
  await new Promise((resolve) =>
    api.runtime.onMessage._fire({ type: 'create', windowId: 1, name: 'Dev', copyCurrent: false }, {}, resolve));
  api.runtime.onInstalled._fire({ reason: 'chrome_update' });
  await settle();
  const { windows } = await api.storage.session.get('windows');
  assert.equal(windows[2].focusId, before, 'an unrecognisable window keeps its focus');
  done();
});

test('a failed switch from the bar shows ! on the badge', async () => {
  const api = await loadFresh('err');
  api.runtime.onInstalled._fire({ reason: 'install' });
  await settle();
  api.runtime.onMessage._fire({ type: 'no-such-message', quick: true }, {}, () => {});
  await settle();
  assert.equal(api._badge(), '!');
  assert.match(api._title(), /Focus Bars/);
  done();
});

test('manifest declares the shortcuts and background listens for them', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.commands['next-focus'].suggested_key, { default: 'Alt+Shift+Right', mac: 'MacCtrl+Shift+Right' });
  assert.deepEqual(manifest.commands['previous-focus'].suggested_key, { default: 'Alt+Shift+Left', mac: 'MacCtrl+Shift+Left' });
  assert.deepEqual(manifest.commands._execute_action.suggested_key, { default: 'Alt+Shift+F', mac: 'Alt+Shift+F' });
  const api = await loadFresh('cmd');
  assert.ok(api.commands.onCommand._count() >= 1);
  done();
});
