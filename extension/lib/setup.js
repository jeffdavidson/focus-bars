import { findRoots } from './roots.js';
import { readState, writeState, readWindows, writeWindows } from './store.js';
import { recoverJournal, swapBar } from './swap.js';
import { findStaleSwitcher, isSwitchLink } from './switcher-folder.js';

export const ROOT_TITLE = 'Focus Bars';
export const GENERAL_TITLE = 'General';
export const REMOVED_PREFIX = 'Removed – ';
export const RECOVERED_TITLE = 'Recovered focus';

async function exists(bookmarks, id) {
  try {
    await bookmarks.get(id);
    return true;
  } catch {
    return false;
  }
}

const isFolder = (n) => n.url === undefined;

function freshState({ barId, rootId, generalId, focusIds, activeId, needsRecovery, switcherId = null }) {
  return { version: 1, barId, rootId, generalId, focusIds, activeId, journal: null, needsRecovery, prints: {}, lastSwapMs: null, switcherId, showSwitcher: true };
}


/** Make sure the container and General folder exist; repair state ids in place. */
async function repair(api, state) {
  const { bookmarks } = api;
  if (!(await exists(bookmarks, state.rootId))) {
    // The whole container is gone, and every focus folder with it.
    const { otherId } = await findRoots(bookmarks);
    const root = await bookmarks.create({ parentId: otherId, title: ROOT_TITLE });
    const general = await bookmarks.create({ parentId: root.id, title: GENERAL_TITLE });
    const wasGeneral = state.activeId === state.generalId;
    state.rootId = root.id;
    state.generalId = general.id;
    state.focusIds = [general.id];
    if (wasGeneral) {
      state.activeId = general.id;
    } else {
      const active = await bookmarks.create({ parentId: root.id, title: RECOVERED_TITLE });
      state.focusIds.push(active.id);
      state.activeId = active.id;
    }
    state.journal = null;
    return;
  }
  if (!(await exists(bookmarks, state.generalId))) {
    const general = await bookmarks.create({ parentId: state.rootId, title: GENERAL_TITLE });
    const old = state.generalId;
    state.focusIds = state.focusIds.map((id) => (id === old ? general.id : id));
    if (!state.focusIds.includes(general.id)) state.focusIds.unshift(general.id);
    if (state.activeId === old) state.activeId = general.id;
    if (state.journal) {
      const swap = (id) => (id === old ? general.id : id);
      state.journal = { ...state.journal, from: swap(state.journal.from), to: swap(state.journal.to) };
    }
    state.generalId = general.id;
  }
}

/**
 * Set up or repair the extension's bookmark folders and state. Cheap and safe
 * to run on every service-worker load.
 * @returns {Promise<import('./store.js').State>}
 */
export async function initialize(api) {
  const { bookmarks, storage } = api;
  const existing = await readState(storage.local);
  if (existing && existing.barId !== (await findRoots(bookmarks)).barId) return moveToShownSet(api, existing);
  if (existing) {
    await repair(api, existing);
    await writeState(storage.local, existing);
    return (await recoverJournal(api)) ?? existing;
  }

  const { barId, otherId } = await findRoots(bookmarks);
  const switcherId = await findStaleSwitcher(bookmarks, barId);
  const others = await bookmarks.getChildren(otherId);
  const rootNode = others.find((n) => isFolder(n) && n.title === ROOT_TITLE);

  if (!rootNode) {
    // First run: the current bar becomes General and stays where it is.
    const root = await bookmarks.create({ parentId: otherId, title: ROOT_TITLE });
    const general = await bookmarks.create({ parentId: root.id, title: GENERAL_TITLE });
    const state = freshState({ barId, rootId: root.id, generalId: general.id, focusIds: [general.id], activeId: general.id, needsRecovery: false, switcherId });
    await writeState(storage.local, state);
    return state;
  }

  // Reinstall, or state lost while the folders remain.
  const [tree] = await bookmarks.getSubTree(rootNode.id);
  const folders = tree.children.filter((n) => isFolder(n) && !n.title.startsWith(REMOVED_PREFIX));
  let general = folders.find((n) => n.title === GENERAL_TITLE);
  if (!general) {
    general = { ...(await bookmarks.create({ parentId: rootNode.id, title: GENERAL_TITLE })), children: [] };
    folders.unshift(general);
  }
  const empty = folders.filter((n) => n.children.length === 0);
  const known = empty.length === 1;
  const state = freshState({
    barId,
    rootId: rootNode.id,
    generalId: general.id,
    focusIds: folders.map((n) => n.id),
    activeId: known ? empty[0].id : general.id,
    needsRecovery: !known,
    switcherId,
  });
  await writeState(storage.local, state);
  return state;
}

/**
 * Chrome now shows a different bookmark bar (account bookmarks were switched on
 * or off). Start over in the set Chrome shows, as a reinstall would, and leave
 * the old set's bookmarks where they are: nothing moves between sets.
 */
async function moveToShownSet(api, old) {
  const { bookmarks, storage } = api;
  if (await exists(bookmarks, old.barId)) {
    // Finish a half-done swap in the old set, then put that set back on General,
    // so its bar looks as it did before Focus Bars and every focus is in its folder.
    old = (await recoverJournal(api)) ?? old;
    if (!old.needsRecovery && old.activeId !== old.generalId && (await exists(bookmarks, old.generalId))) {
      old = await swapBar(api, old.generalId);
    }
  }
  // Our ⇄ menu on the old bar would only go stale. Remove its switch links, and
  // the folder too unless the user filed bookmarks of their own in it.
  if (old.switcherId && (await exists(bookmarks, old.switcherId))) {
    const kids = await bookmarks.getChildren(old.switcherId);
    if (kids.some((k) => isSwitchLink(k.url))) {
      for (const k of kids) if (isSwitchLink(k.url)) await bookmarks.remove(k.id);
      if ((await bookmarks.getChildren(old.switcherId)).length === 0) await bookmarks.remove(old.switcherId);
    }
  }
  await storage.local.remove('state');
  const state = await initialize(api);
  state.showSwitcher = old.showSwitcher ?? true;
  await writeState(storage.local, state);
  const wins = await readWindows(storage.session);
  for (const w of Object.values(wins)) w.focusId = state.activeId;
  await writeWindows(storage.session, wins);
  return state;
}

/** The user said which focus is on the bar. */
export async function resolveRecovery(api, focusId) {
  const state = await readState(api.storage.local);
  state.activeId = focusId;
  state.needsRecovery = false;
  await writeState(api.storage.local, state);
  return state;
}
