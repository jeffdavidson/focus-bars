// Signed-in Chrome can keep two bookmark sets: one on this device (syncing=false)
// and one saved in the Google account (syncing=true), each with its own bar and
// "Other bookmarks". Chrome shows the account bar. Focus Bars must work in the
// set Chrome shows, follow it when that changes, and never move bookmarks
// between the two sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './fake-chrome.js';
import { seeded } from './helpers.js';
import { findRoots } from '../extension/lib/roots.js';
import { initialize } from '../extension/lib/setup.js';
import { handleExternalChange } from '../extension/lib/focuses.js';
import { readState, writeState, readWindows, writeWindows } from '../extension/lib/store.js';
import { createController } from '../extension/lib/controller.js';

const link = (t) => ({ title: t, url: `https://${t}/` });

/** Ids of every node under `id`, depth-first, so tests can prove nothing left a set. */
async function idsUnder(api, id) {
  const [node] = await api.bookmarks.getSubTree(id);
  const out = [];
  const walk = (n) => { out.push(n.id); (n.children ?? []).forEach(walk); };
  (node.children ?? []).forEach(walk);
  return out.sort();
}

for (const accountFirst of [false, true]) {
  test(`findRoots picks the account bar and the account Other bookmarks (account ${accountFirst ? 'first' : 'second'})`, async () => {
    const api = createFakeChrome({ account: {}, accountFirst });
    const accBar = api._id('Bookmarks Bar');
    const accOther = api._id('Other Bookmarks');
    assert.deepEqual(await findRoots(api.bookmarks), { barId: accBar, otherId: accOther });
  });
}

test('first run with two sets makes the account bar General and keeps the device set untouched', async () => {
  const api = createFakeChrome({ bar: [link('d1')], account: { bar: [link('a1'), link('a2')] } });
  const accBar = api._id('Bookmarks Bar');
  const accOther = api._id('Other Bookmarks');
  const state = await initialize(api);
  assert.equal(state.barId, accBar);
  assert.equal((await api.bookmarks.get(state.rootId))[0].parentId, accOther, 'Focus Bars in the account set');
  assert.deepEqual(api._titles(accBar), ['a1', 'a2']);
  assert.deepEqual(api._titles('1'), ['d1']);
  assert.deepEqual(api._titles('2'), [], 'nothing created in the device set');
});

test('account bookmarks switched on after install: Focus Bars moves to the shown bar, leaving the device set as it was', async () => {
  const { api, rootId } = await seeded();
  // The device bar's switcher, as a running extension leaves it.
  const sw = await api.bookmarks.create({ parentId: '1', index: 0, title: '⇄ General' });
  await api.bookmarks.create({ parentId: sw.id, title: '✓ General', url: 'chrome-extension://fakeid/switch.html?focus=x' });
  const st = await readState(api.storage.local);
  await writeState(api.storage.local, { ...st, switcherId: sw.id, showSwitcher: false });
  await writeWindows(api.storage.session, { 7: { focusId: st.generalId, printKey: 'k' } });
  const deviceFocusBars = await idsUnder(api, rootId);

  const { barId: accBar, otherId: accOther } = api._addAccountSet({ bar: [link('a1')] });
  const state = await initialize(api);

  assert.equal(state.barId, accBar);
  assert.equal((await api.bookmarks.get(state.rootId))[0].parentId, accOther);
  assert.equal(state.activeId, state.generalId);
  assert.deepEqual(state.focusIds, [state.generalId]);
  assert.equal(state.needsRecovery, false);
  assert.equal(state.showSwitcher, false, 'settings carried over');
  assert.equal(state.journal, null);
  assert.deepEqual(api._titles(accBar), ['a1'], 'shown bar untouched');
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c'], 'old switcher removed from the hidden bar, nothing else');
  assert.deepEqual(await idsUnder(api, rootId), deviceFocusBars, 'device Focus Bars left exactly as it was');
  const wins = await readWindows(api.storage.session);
  assert.equal(wins[7].focusId, state.generalId, 'open windows follow to the new General');
});

test('moving to the account set adopts a Focus Bars folder already there', async () => {
  const { api } = await seeded();
  api._addAccountSet({
    bar: [link('a1')],
    other: [{ title: 'Focus Bars', children: [
      { title: 'General', children: [] },
      { title: 'Dev', children: [link('x')] },
      { title: 'Bass', children: [] },
    ] }],
  });
  const state = await initialize(api);
  const accRoot = state.rootId;
  assert.deepEqual(api._titles(accRoot), ['General', 'Dev', 'Bass']);
  assert.equal(state.focusIds.length, 3);
  assert.equal(state.needsRecovery, true, 'two empty folders: ask which one is on the bar');
});

test('account bookmarks switched off: Focus Bars returns to the device set and adopts its folders', async () => {
  const api = createFakeChrome({ bar: [link('d1')], account: { bar: [link('a1')] }, accountFirst: true });
  await initialize(api);
  const accBar = api._id('Bookmarks Bar');
  const accOther = api._id('Other Bookmarks');
  api._dropNode(accBar);
  api._dropNode(accOther);
  const state = await initialize(api);
  assert.equal(state.barId, '1');
  assert.equal((await api.bookmarks.get(state.rootId))[0].parentId, '2');
});

test('a swap that died in the old set is finished there before moving on', async () => {
  const { api, generalId, devId } = await seeded();
  // Half-done swap General -> Dev: a, b already filed away; c still on the bar.
  await api.bookmarks.move(api._id('a'), { parentId: generalId });
  await api.bookmarks.move(api._id('b'), { parentId: generalId });
  const st = await readState(api.storage.local);
  await writeState(api.storage.local, { ...st, journal: { from: generalId, to: devId, phase: 'toFolder' } });

  const { barId: accBar } = api._addAccountSet({ bar: [link('a1')] });
  const state = await initialize(api);
  assert.equal(state.barId, accBar);
  assert.equal(state.journal, null);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c'], 'General complete again');
  assert.deepEqual(api._titles('1'), ['x', 'y'], 'Dev on the old bar, all in one place');
});

test('a deleted Focus Bars folder is rebuilt in the same set as the bar', async () => {
  const api = createFakeChrome({ bar: [link('d1')], account: { bar: [link('a1')] } });
  const st = await initialize(api);
  const accOther = api._id('Other Bookmarks');
  await api.bookmarks.removeTree(st.rootId);
  await handleExternalChange(api, 'removed', st.rootId, {});
  const state = await readState(api.storage.local);
  assert.equal((await api.bookmarks.get(state.rootId))[0].parentId, accOther);
  assert.deepEqual(api._titles('2'), [], 'device set untouched');
});

test('boot after account bookmarks are switched on puts the ⇄ menu on the shown bar', async () => {
  const { api } = await seeded();
  const { barId: accBar } = api._addAccountSet({ bar: [link('a1')] });
  const ctl = createController(api);
  await ctl.boot();
  assert.deepEqual(api._titles(accBar), ['⇄ General', 'a1']);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('the shown bar disappearing while running moves Focus Bars to the remaining set', async () => {
  const api = createFakeChrome({ bar: [link('d1')], account: { bar: [link('a1')] }, accountFirst: true });
  const ctl = createController(api);
  await ctl.boot();
  const accBar = api._id('Bookmarks Bar');
  await api.bookmarks.removeTree(accBar);
  await ctl.onBookmarkEvent('removed', accBar, {});
  const state = await readState(api.storage.local);
  assert.equal(state.barId, '1');
  assert.deepEqual(api._titles('1'), ['⇄ General', 'd1']);
});
