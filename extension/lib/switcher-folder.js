import { readState, writeState } from './store.js';

export const SWITCHER_PREFIX = '⇄ ';
export const SWITCH_MARK = '/switch.html?focus=';

/** Whether a bookmark URL is one of the switcher's own entries (any extension origin). */
export const isSwitchLink = (url) => typeof url === 'string' && url.startsWith('chrome-extension://') && url.includes(SWITCH_MARK);

async function getOrNull(bookmarks, id) {
  if (!id) return null;
  try {
    return (await bookmarks.get(id))[0];
  } catch {
    return null;
  }
}

/**
 * Keep the "⇄ <focus>" folder first on the bookmark bar, with one entry per
 * focus. Reconciled in place: the folder keeps its id, entries are updated,
 * added or removed, and anything else the user dropped in is left alone.
 * @returns {Promise<import('./store.js').State>}
 */
export async function syncSwitcher(api) {
  const { bookmarks, storage } = api;
  const state = await readState(storage.local);
  if (!state || state.needsRecovery) return state;

  let folder = await getOrNull(bookmarks, state.switcherId);

  if (state.showSwitcher === false) {
    if (state.switcherId !== null && state.switcherId !== undefined) {
      state.switcherId = null; // written first so our own onRemoved is not mistaken for the user's
      await writeState(storage.local, state);
    }
    if (folder) await bookmarks.removeTree(folder.id);
    return state;
  }

  const names = new Map((await bookmarks.get(state.focusIds)).map((n) => [n.id, n.title]));
  const title = SWITCHER_PREFIX + (names.get(state.activeId) ?? '');

  if (!folder) {
    folder = await bookmarks.create({ parentId: state.barId, index: 0, title });
    state.switcherId = folder.id;
    await writeState(storage.local, state);
  } else {
    if (folder.parentId !== state.barId || folder.index !== 0) {
      await bookmarks.move(folder.id, { parentId: state.barId, index: 0 });
    }
    if (folder.title !== title) await bookmarks.update(folder.id, { title });
  }

  const links = (await bookmarks.getChildren(folder.id)).filter((n) => isSwitchLink(n.url));
  for (const [i, id] of state.focusIds.entries()) {
    const want = {
      title: (id === state.activeId ? '✓ ' : '    ') + (names.get(id) ?? ''),
      url: api.runtime.getURL(`switch.html?focus=${encodeURIComponent(id)}`),
    };
    const have = links[i];
    if (!have) await bookmarks.create({ parentId: folder.id, ...want });
    else if (have.title !== want.title || have.url !== want.url) await bookmarks.update(have.id, want);
  }
  for (const extra of links.slice(state.focusIds.length)) await bookmarks.removeTree(extra.id);

  state.switcherId = folder.id;
  await writeState(storage.local, state);
  return state;
}
