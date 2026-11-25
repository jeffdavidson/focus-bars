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
 * A switcher folder nobody is tracking — left by an earlier install, or by a
 * crash between creating it and saving its id: first on the bar, a "⇄ " title,
 * and at least one switch link (the user may have dropped their own items in).
 * @returns {Promise<string|null>}
 */
export async function findStaleSwitcher(bookmarks, barId) {
  const [first] = await bookmarks.getChildren(barId);
  if (!first || first.url !== undefined || !first.title.startsWith(SWITCHER_PREFIX)) return null;
  const kids = await bookmarks.getChildren(first.id);
  return kids.some((k) => isSwitchLink(k.url)) ? first.id : null;
}

/**
 * Keep the "⇄ <focus>" folder first on the bookmark bar, with one entry per
 * focus. Decides from the bookmark tree as it is now, never from the order
 * events arrived in (a sleeping service worker sees them late):
 * - the tracked folder is gone, or no longer on the bar → the user removed it:
 *   turn the setting off and leave whatever they did alone;
 * - nothing tracked and the setting is on → adopt a leftover switcher, else create one.
 * Reconciled in place: the folder keeps its id, entries are updated, added or
 * removed, and anything else the user dropped in is left alone.
 * @returns {Promise<import('./store.js').State>}
 */
export async function syncSwitcher(api) {
  const { bookmarks, storage } = api;
  const state = await readState(storage.local);
  if (!state || state.needsRecovery) return state;

  let folder = await getOrNull(bookmarks, state.switcherId);

  if (state.switcherId && (!folder || folder.parentId !== state.barId)) {
    state.switcherId = null;
    state.showSwitcher = false;
    await writeState(storage.local, state);
    return state;
  }

  if (state.showSwitcher === false) {
    if (folder) {
      // Remove first, then forget it: a crash in between leaves a tracked id
      // with no folder, which the next sync reads as "off" — the right answer.
      await bookmarks.removeTree(folder.id);
      state.switcherId = null;
      await writeState(storage.local, state);
    }
    return state;
  }

  const names = new Map((await bookmarks.get(state.focusIds)).map((n) => [n.id, n.title]));
  const title = SWITCHER_PREFIX + (names.get(state.activeId) ?? '');

  if (!folder) {
    const staleId = await findStaleSwitcher(bookmarks, state.barId);
    folder = staleId
      ? (await bookmarks.get(staleId))[0]
      : await bookmarks.create({ parentId: state.barId, index: 0, title });
    state.switcherId = folder.id;
    await writeState(storage.local, state);
  }
  if (folder.index !== 0) await bookmarks.move(folder.id, { parentId: state.barId, index: 0 });
  if (folder.title !== title) await bookmarks.update(folder.id, { title });

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

  await writeState(storage.local, state);
  return state;
}
