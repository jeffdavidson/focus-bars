import { findRoots, getExisting } from './roots.js';
import { readState, writeState, readWindows, writeWindows } from './store.js';
import { moveAllChildren } from './swap.js';
import { ROOT_TITLE, GENERAL_TITLE, REMOVED_PREFIX, RECOVERED_TITLE } from './setup.js';

/** @returns {Promise<{id: string, name: string}[]>} */
export async function listFocuses(api) {
  const state = await readState(api.storage.local);
  const nodes = await getExisting(api.bookmarks, state.focusIds);
  return nodes.map((n) => ({ id: n.id, name: n.title }));
}

/** Trim and check a focus name; throws a message the popup can show. */
async function checkName(api, name, exceptId) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Please enter a name.');
  if (clean.startsWith(REMOVED_PREFIX)) throw new Error(`Names can't start with “${REMOVED_PREFIX.trim()}”.`);
  const taken = (await listFocuses(api)).some((f) => f.id !== exceptId && f.name.toLowerCase() === clean.toLowerCase());
  if (taken) throw new Error(`A focus called “${clean}” already exists.`);
  return clean;
}

async function copyTree(bookmarks, fromId, toId, skipIds = []) {
  for (const n of await bookmarks.getChildren(fromId)) {
    if (skipIds.includes(n.id)) continue;
    if (n.url !== undefined) {
      await bookmarks.create({ parentId: toId, title: n.title, url: n.url });
    } else {
      const folder = await bookmarks.create({ parentId: toId, title: n.title });
      await copyTree(bookmarks, n.id, folder.id);
    }
  }
}

/** @returns {Promise<string>} the new focus id */
export async function createFocus(api, name, { copyCurrent }) {
  name = await checkName(api, name);
  const state = await readState(api.storage.local);
  const folder = await api.bookmarks.create({ parentId: state.rootId, title: name });
  if (copyCurrent) await copyTree(api.bookmarks, state.barId, folder.id, [state.switcherId]);
  state.focusIds.push(folder.id);
  await writeState(api.storage.local, state);
  return folder.id;
}

export async function renameFocus(api, focusId, name) {
  await api.bookmarks.update(focusId, { title: await checkName(api, name, focusId) });
}

/** Point every window and stored fingerprint using `fromId` at `toId`. */
async function remapUsers(api, state, fromId, toId) {
  const wins = await readWindows(api.storage.session);
  for (const w of Object.values(wins)) if (w.focusId === fromId) w.focusId = toId;
  await writeWindows(api.storage.session, wins);
  for (const p of Object.values(state.prints)) if (p.focusId === fromId) p.focusId = toId;
}

/**
 * Delete a focus from the popup. Its bookmarks are kept in "Removed – <name>".
 * @param {(id: string) => Promise<void>} swap  used to move the bar to General first if needed
 */
export async function deleteFocus(api, focusId, swap) {
  let state = await readState(api.storage.local);
  if (focusId === state.generalId) throw new Error('General cannot be deleted');
  if (!state.focusIds.includes(focusId)) throw new Error('Unknown focus');
  if (state.activeId === focusId) {
    await swap(state.generalId);
    state = await readState(api.storage.local);
  }
  const [node] = await api.bookmarks.get(focusId);
  state.focusIds = state.focusIds.filter((id) => id !== focusId);
  await remapUsers(api, state, focusId, state.generalId);
  await writeState(api.storage.local, state);
  await api.bookmarks.update(focusId, { title: REMOVED_PREFIX + node.title });
}

/**
 * React to a bookmark removed or moved outside the extension.
 * @param {'removed'|'moved'} kind
 * @returns {Promise<{changed: boolean}>}
 */
export async function handleExternalChange(api, kind, id, info = {}) {
  const { bookmarks } = api;
  const state = await readState(api.storage.local);
  if (!state || state.journal) return { changed: false };

  // The switcher: syncSwitcher decides what happened from the tree as it is now.
  if (id && id === state.switcherId) return { changed: true };

  if (id === state.rootId) {
    // A moved container keeps its folders; only a deletion needs repair.
    if (kind === 'moved') return { changed: false };
    const lostTitle = (fid) => info.node?.children?.find((c) => c.id === fid)?.title;
    const { otherId } = await findRoots(bookmarks);
    const root = await bookmarks.create({ parentId: otherId, title: ROOT_TITLE });
    const general = await bookmarks.create({ parentId: root.id, title: GENERAL_TITLE });
    const oldGeneral = state.generalId;
    const oldActive = state.activeId;
    let activeId = general.id;
    if (oldActive !== oldGeneral) {
      const active = await bookmarks.create({ parentId: root.id, title: lostTitle(oldActive) ?? RECOVERED_TITLE });
      activeId = active.id;
    }
    state.rootId = root.id;
    state.generalId = general.id;
    state.activeId = activeId;
    state.focusIds = activeId === general.id ? [general.id] : [general.id, activeId];
    const wins = await readWindows(api.storage.session);
    for (const w of Object.values(wins)) w.focusId = w.focusId === oldActive ? activeId : general.id;
    await writeWindows(api.storage.session, wins);
    for (const p of Object.values(state.prints)) p.focusId = p.focusId === oldActive ? activeId : general.id;
    await writeState(api.storage.local, state);
    return { changed: true };
  }

  if (!state.focusIds.includes(id)) return { changed: false };
  if (kind === 'moved' && info.parentId === state.rootId) return { changed: false };

  const isActive = id === state.activeId;
  const isGeneral = id === state.generalId;
  if (isActive || isGeneral) {
    // Recreate the folder in place so nothing on the bar or in General's slot is orphaned.
    let title = info.node?.title;
    if (!title && kind === 'moved') title = (await bookmarks.get(id))[0].title;
    if (isGeneral) title = GENERAL_TITLE;
    const index = state.focusIds.indexOf(id);
    const folder = await bookmarks.create({ parentId: state.rootId, title: title ?? RECOVERED_TITLE });
    state.focusIds[index] = folder.id;
    if (isActive) state.activeId = folder.id;
    if (isGeneral) state.generalId = folder.id;
    await remapUsers(api, state, id, folder.id);
  } else {
    state.focusIds = state.focusIds.filter((f) => f !== id);
    await remapUsers(api, state, id, state.generalId);
  }
  await writeState(api.storage.local, state);
  return { changed: true };
}

/**
 * While a focus is on the bar its folder should be empty. Anything the user
 * adds there (⌘D into "Dev", a drag in the bookmark manager) belongs on the bar,
 * so move it to the end of the bar. Decided from the folder's contents now.
 * @returns {Promise<{changed: boolean}>}
 */
export async function drainActiveFolder(api) {
  const state = await readState(api.storage.local);
  if (!state || state.journal || state.needsRecovery) return { changed: false };
  let kids;
  try {
    kids = await api.bookmarks.getChildren(state.activeId);
  } catch {
    return { changed: false }; // folder missing: setup/recovery repairs it
  }
  if (kids.length === 0) return { changed: false };
  await moveAllChildren(api.bookmarks, state.activeId, state.barId);
  return { changed: true };
}
