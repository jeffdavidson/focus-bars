import { readState, writeState, readWindows, writeWindows } from './store.js';
import { swapBar } from './swap.js';
import { createSwitcher } from './switcher.js';
import { initialize, resolveRecovery } from './setup.js';
import { listFocuses, createFocus, renameFocus, deleteFocus, handleExternalChange } from './focuses.js';
import { matchWindows, prunePrints } from './fingerprint.js';

export const RESTORE_MS = 60_000;
export const DEBOUNCE_MS = 2_000;
const NONE = -1;

const urlsOf = (tabs) => [...new Set((tabs ?? []).map((t) => t.url || t.pendingUrl).filter(Boolean))];
const validFocus = (state, id) => (state.focusIds.includes(id) ? id : state.generalId);

/**
 * All of the extension's behaviour, driven by Chrome events. Holds no state of
 * its own beyond timers: everything lives in chrome.storage, so a fresh
 * controller after a service-worker restart behaves the same.
 */
export function createController(api, {
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const debounces = new Map();

  const switcher = createSwitcher(async (focusId) => {
    const state = await readState(api.storage.local);
    if (!state || state.needsRecovery) return;
    await swapBar(api, validFocus(state, focusId));
    await updateBadge();
  });

  async function updateBadge() {
    const state = await readState(api.storage.local);
    if (!state) return;
    let text = '?';
    if (!state.needsRecovery) {
      try {
        text = (await api.bookmarks.get(state.activeId))[0].title.slice(0, 4);
      } catch {
        text = '';
      }
    }
    await api.action.setBadgeText({ text });
  }

  async function getWindow(windowId) {
    try {
      return await api.windows.get(windowId, { populate: true });
    } catch {
      return null;
    }
  }

  async function inRestore() {
    const { restoreUntil } = await api.storage.session.get('restoreUntil');
    return restoreUntil != null && now() < restoreUntil;
  }

  async function swapIfFocused(windowId) {
    const win = await getWindow(windowId);
    if (!win?.focused) return;
    const map = await readWindows(api.storage.session);
    if (map[windowId]) await switcher.request(map[windowId].focusId);
  }

  /** Save the window's current tabs as its fingerprint. */
  async function writePrint(windowId, urls) {
    const map = await readWindows(api.storage.session);
    const entry = map[windowId];
    if (!entry) return;
    const state = await readState(api.storage.local);
    delete entry.unmatched;
    state.prints[entry.printKey] = { urls, focusId: entry.focusId, lastSeen: now() };
    await writeState(api.storage.local, state);
    await writeWindows(api.storage.session, map);
  }

  async function refreshTabs(windowId) {
    const map = await readWindows(api.storage.session);
    const entry = map[windowId];
    if (!entry) return;
    const urls = urlsOf(await api.tabs.query({ windowId }));
    if (urls.length === 0) return;
    if (entry.unmatched && (await inRestore())) {
      const state = await readState(api.storage.local);
      const claimed = new Set(Object.entries(map).filter(([id]) => id !== String(windowId)).map(([, e]) => e.printKey));
      const candidates = Object.fromEntries(Object.entries(state.prints).filter(([k]) => !claimed.has(k)));
      const key = matchWindows([{ id: windowId, urls }], candidates)[windowId];
      if (key) {
        map[windowId] = { focusId: validFocus(state, state.prints[key].focusId), printKey: key };
        await writeWindows(api.storage.session, map);
        await swapIfFocused(windowId);
      }
      return; // still restoring: don't overwrite anything yet
    }
    await writePrint(windowId, urls);
  }

  /** End of the restore period: windows that never matched start their own fingerprint. */
  async function finishRestore() {
    await api.storage.session.set({ restoreUntil: null });
    const map = await readWindows(api.storage.session);
    for (const [id, entry] of Object.entries(map)) {
      if (!entry.unmatched) continue;
      const urls = urlsOf(await api.tabs.query({ windowId: Number(id) }));
      await writePrint(Number(id), urls);
    }
  }

  async function addWindow(win) {
    const state = await readState(api.storage.local);
    const map = await readWindows(api.storage.session);
    if (map[win.id]) return;
    map[win.id] = { focusId: state.activeId, printKey: uuid() };
    if (await inRestore()) map[win.id].unmatched = true;
    await writeWindows(api.storage.session, map);
  }

  async function assign(windowId, focusId) {
    const map = await readWindows(api.storage.session);
    map[windowId] = { ...(map[windowId] ?? { printKey: uuid() }), focusId };
    delete map[windowId].unmatched;
    await writeWindows(api.storage.session, map);
    const win = await getWindow(windowId);
    await writePrint(windowId, urlsOf(win?.tabs));
    await swapIfFocused(windowId);
  }

  return {
    /** Every service-worker load: repair folders, finish any interrupted swap. */
    async boot() {
      await initialize(api);
      await updateBadge();
    },

    /** Chrome start-up or install: give every open window its focus back. */
    async restoreWindows() {
      const state = await readState(api.storage.local);
      const wins = (await api.windows.getAll({ populate: true })).filter((w) => w.type === 'normal');
      const matched = matchWindows(wins.map((w) => ({ id: w.id, urls: urlsOf(w.tabs) })), state.prints);
      const map = {};
      for (const w of wins) {
        const key = matched[w.id];
        map[w.id] = key
          ? { focusId: validFocus(state, state.prints[key].focusId), printKey: key }
          : { focusId: state.activeId, printKey: uuid(), unmatched: true };
      }
      await writeWindows(api.storage.session, map);
      state.prints = prunePrints(state.prints, new Set(Object.values(matched)), now());
      await writeState(api.storage.local, state);
      await api.storage.session.set({ restoreUntil: now() + RESTORE_MS });
      setTimer(finishRestore, RESTORE_MS);
      const focused = wins.find((w) => w.focused);
      if (focused) await switcher.request(map[focused.id].focusId);
      await updateBadge();
    },

    async onFocusChanged(windowId) {
      if (windowId === NONE) return;
      const win = await getWindow(windowId);
      if (!win || win.type !== 'normal') return;
      await addWindow(win);
      const map = await readWindows(api.storage.session);
      await switcher.request(map[windowId].focusId);
    },

    async onWindowCreated(win) {
      if (win.type !== 'normal') return;
      await addWindow(win);
    },

    async onWindowRemoved(windowId) {
      const map = await readWindows(api.storage.session);
      delete map[windowId];
      await writeWindows(api.storage.session, map);
    },

    /** Debounced per window. */
    onTabsChanged(windowId) {
      if (windowId == null || windowId === NONE) return;
      clearTimer(debounces.get(windowId));
      debounces.set(windowId, setTimer(() => {
        debounces.delete(windowId);
        return refreshTabs(windowId).catch((e) => console.error('Focus Bars: tab update failed', e));
      }, DEBOUNCE_MS));
    },

    assign,

    async onBookmarkEvent(kind, id, info) {
      const r = await handleExternalChange(api, kind, id, info);
      if (r.changed) await updateBadge();
      return r;
    },

    async handleMessage(msg) {
      switch (msg.type) {
        case 'get': {
          const state = await readState(api.storage.local);
          const map = await readWindows(api.storage.session);
          return {
            focuses: await listFocuses(api),
            current: map[msg.windowId]?.focusId ?? state.activeId,
            generalId: state.generalId,
            needsRecovery: state.needsRecovery,
            lastSwapMs: state.lastSwapMs,
          };
        }
        case 'assign':
          await assign(msg.windowId, msg.focusId);
          return { ok: true };
        case 'create': {
          const id = await createFocus(api, msg.name, { copyCurrent: !!msg.copyCurrent });
          await assign(msg.windowId, id);
          return { id };
        }
        case 'rename':
          await renameFocus(api, msg.focusId, msg.name);
          await updateBadge();
          return { ok: true };
        case 'delete':
          await deleteFocus(api, msg.focusId, (id) => switcher.request(id));
          await updateBadge();
          return { ok: true };
        case 'resolveRecovery': {
          await resolveRecovery(api, msg.focusId);
          const map = await readWindows(api.storage.session);
          for (const e of Object.values(map)) e.focusId = msg.focusId;
          await writeWindows(api.storage.session, map);
          await updateBadge();
          return { ok: true };
        }
        default:
          throw new Error(`Unknown message: ${msg.type}`);
      }
    },
  };
}
