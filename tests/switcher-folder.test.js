import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';
import { syncSwitcher, isSwitchLink } from '../extension/lib/switcher-folder.js';
import { readState, writeState } from '../extension/lib/store.js';
import { swapBar } from '../extension/lib/swap.js';
import { createFocus, deleteFocus } from '../extension/lib/focuses.js';

async function patch(api, fields) {
  const st = await readState(api.storage.local);
  Object.assign(st, fields);
  await writeState(api.storage.local, st);
}

async function entries(api, folderId) {
  const kids = await api.bookmarks.getChildren(folderId);
  return kids.map((k) => [k.title, k.url]);
}

const link = (id) => `chrome-extension://fakeid/switch.html?focus=${id}`;

test('creates folder first with entries and check mark', async () => {
  const { api, generalId, devId } = await seeded();
  await patch(api, { showSwitcher: true, switcherId: null });
  const state = await syncSwitcher(api);
  assert.ok(state.switcherId);
  assert.deepEqual(api._titles('1'), ['⇄ General', 'a', 'b', 'c']);
  assert.deepEqual(await entries(api, state.switcherId), [['✓ General', link(generalId)], ['    Dev', link(devId)]]);
  assert.equal((await readState(api.storage.local)).switcherId, state.switcherId);
});

test('missing showSwitcher counts as on', async () => {
  const { api } = await seeded();
  const state = await syncSwitcher(api);
  assert.ok(state.switcherId);
  assert.equal(api._titles('1')[0], '⇄ General');
});

test('updates title and check after a swap', async () => {
  const { api, generalId, devId } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  await swapBar(api, devId);
  const state = await syncSwitcher(api);
  assert.equal(state.switcherId, switcherId, 'same folder, updated in place');
  assert.deepEqual(api._titles('1'), ['⇄ Dev', 'x', 'y']);
  assert.deepEqual(await entries(api, switcherId), [['    General', link(generalId)], ['✓ Dev', link(devId)]]);
});

test('adds and removes entries as focuses change', async () => {
  const { api, generalId, devId } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  const music = await createFocus(api, 'Music', { copyCurrent: false });
  await syncSwitcher(api);
  assert.deepEqual((await entries(api, switcherId)).map((e) => e[0]), ['✓ General', '    Dev', '    Music']);
  await deleteFocus(api, devId, async () => {});
  await syncSwitcher(api);
  assert.deepEqual(await entries(api, switcherId), [['✓ General', link(generalId)], ['    Music', link(music)]]);
});

test('keeps user items dropped into the folder', async () => {
  const { api } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  await api.bookmarks.create({ parentId: switcherId, title: 'mine', url: 'https://mine/' });
  await syncSwitcher(api);
  assert.ok(api._titles(switcherId).includes('mine'));
});

test('moves the folder back to index 0', async () => {
  const { api } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  await api.bookmarks.move(switcherId, { parentId: '1', index: 3 });
  assert.notEqual(api._titles('1')[0], '⇄ General');
  await syncSwitcher(api);
  assert.equal(api._titles('1')[0], '⇄ General');
});

test('recreates the folder if it is gone but the setting is on', async () => {
  const { api } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  await api.bookmarks.removeTree(switcherId);
  const state = await syncSwitcher(api);
  assert.notEqual(state.switcherId, switcherId);
  assert.equal(api._titles('1')[0], '⇄ General');
});

test('showSwitcher false removes the folder', async () => {
  const { api } = await seeded();
  const { switcherId } = await syncSwitcher(api);
  await patch(api, { showSwitcher: false });
  const state = await syncSwitcher(api);
  assert.equal(state.switcherId, null);
  assert.equal(api._exists(switcherId), false);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('does nothing while recovery is needed', async () => {
  const { api } = await seeded();
  await patch(api, { needsRecovery: true });
  await syncSwitcher(api);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('isSwitchLink matches any extension origin', () => {
  assert.equal(isSwitchLink('chrome-extension://abc/switch.html?focus=12'), true);
  assert.equal(isSwitchLink('https://example.com/'), false);
  assert.equal(isSwitchLink(undefined), false);
});
