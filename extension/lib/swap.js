import { readState, writeState } from './store.js';

const now = () => (globalThis.performance ? performance.now() : Date.now());

/** Move every child of `fromId`, in order, to the end of `toId`. */
export async function moveAllChildren(bookmarks, fromId, toId) {
  const kids = await bookmarks.getChildren(fromId);
  for (const k of kids) await bookmarks.move(k.id, { parentId: toId });
}

async function exists(bookmarks, id) {
  try {
    await bookmarks.get(id);
    return true;
  } catch {
    return false;
  }
}

/** Replace a vanished focus folder with an empty "Recovered focus" folder; returns the new id. */
async function replaceMissing(api, state, id) {
  const folder = await api.bookmarks.create({ parentId: state.rootId, title: 'Recovered focus' });
  const swapId = (x) => (x === id ? folder.id : x);
  state.focusIds = state.focusIds.map(swapId);
  state.activeId = swapId(state.activeId);
  if (state.generalId === id) state.generalId = folder.id;
  if (state.journal) state.journal = { ...state.journal, from: swapId(state.journal.from), to: swapId(state.journal.to) };
  return folder.id;
}

/** Run (or resume) the journaled swap described by state.journal. */
async function runJournal(api, state) {
  const { bookmarks, storage } = api;
  for (const key of ['from', 'to']) {
    if (!(await exists(bookmarks, state.journal[key]))) await replaceMissing(api, state, state.journal[key]);
  }
  await writeState(storage.local, state);

  if (state.journal.phase === 'toFolder') {
    await moveAllChildren(bookmarks, state.barId, state.journal.from);
    state.journal = { ...state.journal, phase: 'toBar' };
    await writeState(storage.local, state);
  }
  // phase 'toBar': never move the bar back into `from` — some of `to`'s items are already there.
  await moveAllChildren(bookmarks, state.journal.to, state.barId);
  state.activeId = state.journal.to;
  state.journal = null;
  await writeState(storage.local, state);
  return state;
}

/** Swap the bookmark bar to focus `toId`. @returns {Promise<import('./store.js').State>} */
export async function swapBar(api, toId) {
  const state = await readState(api.storage.local);
  if (toId === state.activeId) return state;
  const t0 = now();
  state.journal = { from: state.activeId, to: toId, phase: 'toFolder' };
  await writeState(api.storage.local, state);
  const done = await runJournal(api, state);
  done.lastSwapMs = Math.round(now() - t0);
  await writeState(api.storage.local, done);
  return done;
}

/** Finish an interrupted swap, if any. Safe to call any number of times. */
export async function recoverJournal(api) {
  const state = await readState(api.storage.local);
  if (!state?.journal) return state;
  return runJournal(api, state);
}
