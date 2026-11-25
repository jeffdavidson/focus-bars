import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';
import { createController } from '../extension/lib/controller.js';
import { readState, writeState, readWindows } from '../extension/lib/store.js';

/** Deterministic clock, ids and timers. */
function harness(startAt = 1_000_000) {
  let t = startAt;
  let n = 0;
  const timers = new Map();
  let nextTimer = 1;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    uuid: () => `k${++n}`,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    /** Run every timer due by now (after advancing). */
    async runDue() {
      for (const [id, { fn, at }] of [...timers]) {
        if (at <= t) { timers.delete(id); await fn(); }
      }
    },
  };
}

async function setup({ windows } = {}) {
  const s = await seeded({ windows: windows ?? [{ id: 1, focused: true, tabs: ['https://g/1'] }, { id: 2, tabs: ['https://m/1'] }] });
  const h = harness();
  const ctl = createController(s.api, h);
  return { ...s, h, ctl };
}

test('focus change swaps to window\'s focus', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(2, devId);
  await ctl.onFocusChanged(2);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  await ctl.onFocusChanged(1);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('ignores non-normal and NONE', async () => {
  const { api, ctl, devId } = await setup({
    windows: [{ id: 1, focused: true, tabs: ['https://g/1'] }, { id: 3, type: 'devtools', tabs: [] }],
  });
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  const before = api._events.length;
  await ctl.onFocusChanged(-1);
  await ctl.onFocusChanged(3);
  assert.equal(api._events.length, before, 'no bookmark changes');
  assert.equal((await readWindows(api.storage.session))[3], undefined);
});

test('new window inherits active focus', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  api._windows.push({ id: 5, type: 'normal', focused: false, tabs: [] });
  await ctl.onWindowCreated({ id: 5, type: 'normal' });
  assert.equal((await readWindows(api.storage.session))[5].focusId, devId);
});

test('closed window is removed from the map', async () => {
  const { api, ctl } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.onWindowRemoved(2);
  assert.equal((await readWindows(api.storage.session))[2], undefined);
});

test('tab changes update the window fingerprint after debounce', async () => {
  const { api, ctl, h } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  h.advance(61_000);
  await h.runDue();
  api._addTab(2, 'https://m/2');
  ctl.onTabsChanged(2);
  ctl.onTabsChanged(2);
  h.advance(2_000);
  await h.runDue();
  const { printKey } = (await readWindows(api.storage.session))[2];
  const print = (await readState(api.storage.local)).prints[printKey];
  assert.deepEqual(print.urls.sort(), ['https://m/1', 'https://m/2']);
  assert.equal(print.lastSeen, h.now());
});

async function seedPrints(api, prints) {
  const st = await readState(api.storage.local);
  st.prints = prints;
  await writeState(api.storage.local, st);
}

test('restart restores focus by fingerprint', async () => {
  const { api, ctl, generalId, devId, h } = await setup({
    windows: [
      { id: 11, focused: true, tabs: ['https://github.com/', 'https://mdn/'] },
      { id: 12, tabs: ['https://music/1', 'https://music/2'] },
    ],
  });
  await seedPrints(api, {
    pDev: { urls: ['https://github.com/', 'https://mdn/'], focusId: devId, lastSeen: h.now() },
    pGen: { urls: ['https://music/1', 'https://music/2', 'https://music/3'], focusId: generalId, lastSeen: h.now() },
  });
  await ctl.boot();
  await ctl.restoreWindows();
  const map = await readWindows(api.storage.session);
  assert.equal(map[11].focusId, devId);
  assert.equal(map[11].printKey, 'pDev');
  assert.equal(map[12].focusId, generalId);
  assert.deepEqual(api._titles('1'), ['x', 'y'], 'focused window 11 is Dev');
});

test('late-restored window matches once its tabs arrive', async () => {
  const { api, ctl, devId, h } = await setup({ windows: [{ id: 1, focused: true, tabs: ['https://other/'] }] });
  await seedPrints(api, { pDev: { urls: ['https://github.com/', 'https://mdn/'], focusId: devId, lastSeen: h.now() } });
  await ctl.boot();
  await ctl.restoreWindows();
  // Session restore creates the window first, then its tabs (not loaded yet).
  api._windows.push({ id: 20, type: 'normal', focused: false, tabs: [] });
  await ctl.onWindowCreated({ id: 20, type: 'normal' });
  assert.equal((await readWindows(api.storage.session))[20].unmatched, true);
  api._addTab(20, { pendingUrl: 'https://github.com/' });
  api._addTab(20, { pendingUrl: 'https://mdn/' });
  ctl.onTabsChanged(20);
  h.advance(2_000);
  await h.runDue();
  const entry = (await readWindows(api.storage.session))[20];
  assert.equal(entry.focusId, devId);
  assert.equal(entry.printKey, 'pDev');
  assert.equal(entry.unmatched, undefined);
});

test('unmatched windows get a fingerprint when the restore period ends', async () => {
  const { api, ctl, h } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  h.advance(60_000);
  await h.runDue();
  const map = await readWindows(api.storage.session);
  const prints = (await readState(api.storage.local)).prints;
  assert.equal(map[1].unmatched, undefined);
  assert.deepEqual(prints[map[1].printKey].urls, ['https://g/1']);
  assert.deepEqual(prints[map[2].printKey].urls, ['https://m/1']);
});

test('boot does not reassign known windows', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(2, devId);
  const before = await readWindows(api.storage.session);
  const ctl2 = createController(api, harness()); // worker woke up again
  await ctl2.boot();
  assert.deepEqual(await readWindows(api.storage.session), before);
});

test('assign updates print and swaps when focused', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  const entry = (await readWindows(api.storage.session))[1];
  assert.equal(entry.focusId, devId);
  assert.equal((await readState(api.storage.local)).prints[entry.printKey].focusId, devId);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  await ctl.assign(2, devId); // window 2 is not focused: no swap needed, bar already Dev
  assert.equal((await readWindows(api.storage.session))[2].focusId, devId);
});

test('needsRecovery blocks swaps until resolved', async () => {
  const { api, ctl, devId } = await setup();
  const st = await readState(api.storage.local);
  st.needsRecovery = true;
  await writeState(api.storage.local, st);
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(2, devId);
  const before = api._events.length;
  await ctl.onFocusChanged(2);
  assert.equal(api._events.length, before);
  assert.equal(api._badge(), '?');
  await ctl.handleMessage({ type: 'resolveRecovery', focusId: devId });
  const map = await readWindows(api.storage.session);
  assert.equal(map[1].focusId, devId, 'every window starts on the focus that is on the bar');
  assert.equal((await readState(api.storage.local)).needsRecovery, false);
});

test('badge shows active focus', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  assert.equal(api._badge(), 'Gene');
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  assert.equal(api._badge(), 'Dev');
});

test('external bookmark change updates badge', async () => {
  const { api, ctl, devId, rootId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  await api.bookmarks.update(devId, { title: 'Code' });
  const [node] = await api.bookmarks.getSubTree(devId);
  await api.bookmarks.removeTree(devId);
  const r = await ctl.onBookmarkEvent('removed', devId, { parentId: rootId, node });
  assert.equal(r.changed, true);
  assert.equal(api._badge(), 'Code');
});

test('get message describes this window', async () => {
  const { ctl, generalId, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(2, devId);
  const r = await ctl.handleMessage({ type: 'get', windowId: 2 });
  assert.deepEqual(r.focuses, [{ id: generalId, name: 'General' }, { id: devId, name: 'Dev' }]);
  assert.equal(r.current, devId);
  assert.equal(r.generalId, generalId);
  assert.equal(r.needsRecovery, false);
});

test('create message adds focus and assigns it to the window', async () => {
  const { api, ctl } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  const { id } = await ctl.handleMessage({ type: 'create', windowId: 1, name: 'Music', copyCurrent: true });
  assert.equal((await readWindows(api.storage.session))[1].focusId, id);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c'], 'copy of bar now on bar');
  assert.deepEqual(api._titles((await readState(api.storage.local)).generalId), ['a', 'b', 'c']);
});

test('delete message removes focus and moves its windows to General', async () => {
  const { api, ctl, generalId, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(1, devId);
  await ctl.handleMessage({ type: 'delete', focusId: devId });
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
  assert.equal((await readWindows(api.storage.session))[1].focusId, generalId);
  assert.equal(api._badge(), 'Gene');
});

test('fingerprint write during a swap does not clobber swap state', async () => {
  const { api, ctl, h, devId, generalId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  h.advance(60_000);
  await h.runDue();
  await ctl.assign(2, devId);
  // Window 2 gains focus (swap to Dev) while window 1's tab update lands mid-swap.
  api._windows[0].focused = false;
  api._windows[1].focused = true;
  api._addTab(1, 'https://g/2');
  ctl.onTabsChanged(1);
  h.advance(2_000);
  let tabs = null;
  api.bookmarks.onMoved.addListener(() => { tabs ??= h.runDue(); }); // lands mid-swap
  await ctl.onFocusChanged(2);
  await tabs;
  const state = await readState(api.storage.local);
  assert.equal(state.journal, null);
  assert.equal(state.activeId, devId);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  const key = (await readWindows(api.storage.session))[1].printKey;
  assert.deepEqual(state.prints[key].urls.sort(), ['https://g/1', 'https://g/2']);
});

test('bookmark event during a swap does not clobber swap state', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  await ctl.assign(2, devId);
  api._windows[0].focused = false;
  api._windows[1].focused = true;
  const pending = [];
  api.bookmarks.onMoved.addListener((id, info) => pending.push(ctl.onBookmarkEvent('moved', id, info)));
  await ctl.onFocusChanged(2);
  await Promise.all(pending);
  const state = await readState(api.storage.local);
  assert.equal(state.journal, null);
  assert.equal(state.activeId, devId);
});

test('quick switching skips intermediate swaps', async () => {
  const { api, ctl, rootId, devId, generalId } = await setup({
    windows: [{ id: 1, focused: true, tabs: ['https://g/1'] }, { id: 2, tabs: ['https://d/1'] }, { id: 3, tabs: ['https://m/1'] }],
  });
  await ctl.boot();
  await ctl.restoreWindows();
  const music = await api.bookmarks.create({ parentId: rootId, title: 'Music' });
  const st = await readState(api.storage.local);
  st.focusIds.push(music.id);
  await writeState(api.storage.local, st);
  await ctl.assign(2, devId);
  await ctl.assign(3, music.id);
  const targets = [];
  const set = api.storage.local.set;
  api.storage.local.set = async (obj) => {
    const j = obj.state?.journal;
    if (j?.phase === 'toFolder' && targets.at(-1) !== j.to) targets.push(j.to);
    return set(obj);
  };
  api._slowMoves(10);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = [ctl.onFocusChanged(2)];
  await wait(5);
  all.push(ctl.onFocusChanged(3));
  await wait(5);
  all.push(ctl.onFocusChanged(1));
  await Promise.all(all);
  assert.deepEqual(targets, [devId, generalId], 'Music swap skipped');
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('picking a focus in the popup swaps even if the window is not reported focused', async () => {
  const { api, ctl, devId } = await setup();
  await ctl.boot();
  await ctl.restoreWindows();
  api._windows[0].focused = false; // the popup may hold focus on macOS
  await ctl.handleMessage({ type: 'assign', windowId: 1, focusId: devId });
  assert.deepEqual(api._titles('1'), ['x', 'y']);
});

test('restore period finishes on next wake if its timer was lost', async () => {
  const { api, ctl, h } = await setup();
  await ctl.boot();
  await ctl.restoreWindows(); // worker dies before the 60 s timer fires
  h.advance(61_000);
  const ctl2 = createController(api, h);
  await ctl2.boot();
  const map = await readWindows(api.storage.session);
  const prints = (await readState(api.storage.local)).prints;
  assert.equal(map[1].unmatched, undefined);
  assert.deepEqual(prints[map[1].printKey].urls, ['https://g/1']);
});
