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
 * its own beyond timers and a lock: everything lives in chrome.storage, so a
 * fresh controller after a service-worker restart behaves the same.
 *
 * Every read-modify-write of stored state runs inside `exclusive`, so a tab
 * update or bookmark event arriving mid-swap can never overwrite the swap's
 * journal (or be overwritten by it). Swaps are requested only outside it.
 */
export function createController(api, {
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const debounces = new Map();

  let tail = Promise.resolve();
  function exclusive(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  const switcher = createSwitcher((focusId) => exclusive(async () => {
    const state = await readState(api.storage.local);
    if (!state || state.needsRecovery) return;
    await swapBar(api, validFocus(state, focusId));
  }).then(updateBadge));

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

  /** Save the window's current tabs as its fingerprint. Call only inside `exclusive`. */
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

  /** @returns {Promise<boolean>} whether the window just matched a stored fingerprint */
  const refreshTabsLocked = (windowId) => exclusive(async () => {
    const map = await readWindows(api.storage.session);
    const entry = map[windowId];
    if (!entry) return false;
    const urls = urlsOf(await api.tabs.query({ windowId }));
    if (urls.length === 0) return false;
    if (entry.unmatched && (await inRestore())) {
      const state = await readState(api.storage.local);
      const claimed = new Set(Object.entries(map).filter(([id]) => id !== String(windowId)).map(([, e]) => e.printKey));
      const candidates = Object.fromEntries(Object.entries(state.prints).filter(([k]) => !claimed.has(k)));
      const key = matchWindows([{ id: windowId, urls }], candidates)[windowId];
      if (!key) return false; // still restoring: don't overwrite anything yet
      map[windowId] = { focusId: validFocus(state, state.prints[key].focusId), printKey: key };
      await writeWindows(api.storage.session, map);
      return true;
    }
    await writePrint(windowId, urls);
    return false;
  });

  async function refreshTabs(windowId) {
    if (await refreshTabsLocked(windowId)) await swapIfFocused(windowId);
  }

  /** End of the restore period: windows that never matched start their own fingerprint. */
  const finishRestore = () => exclusive(async () => {
    await api.storage.session.set({ restoreUntil: null });
    const map = await readWindows(api.storage.session);
    for (const [id, entry] of Object.entries(map)) {
      if (!entry.unmatched) continue;
      const urls = urlsOf(await api.tabs.query({ windowId: Number(id) }));
      await writePrint(Number(id), urls);
    }
  });

  const addWindow = (win) => exclusive(async () => {
    const state = await readState(api.storage.local);
    const map = await readWindows(api.storage.session);
    if (map[win.id]) return;
    map[win.id] = { focusId: state.activeId, printKey: uuid() };
    if (await inRestore()) map[win.id].unmatched = true;
    await writeWindows(api.storage.session, map);
  });

  /** @param {{fromPopup?: boolean}} opts  the popup belongs to the window, so always swap */
  async function assign(windowId, focusId, { fromPopup = false } = {}) {
    await exclusive(async () => {
      const map = await readWindows(api.storage.session);
      map[windowId] = { ...(map[windowId] ?? { printKey: uuid() }), focusId };
      delete map[windowId].unmatched;
      await writeWindows(api.storage.session, map);
      const win = await getWindow(windowId);
      await writePrint(windowId, urlsOf(win?.tabs));
    });
    if (fromPopup) await switcher.request(focusId);
    else await swapIfFocused(windowId);
  }

  return {
    /** Every service-worker load: repair folders, finish any interrupted swap. */
    async boot() {
      await exclusive(() => initialize(api));
      // The restore-end timer dies with the worker; finish the period on the next wake instead.
      const { restoreUntil } = await api.storage.session.get('restoreUntil');
      if (restoreUntil != null && now() >= restoreUntil) await finishRestore();
      await updateBadge();
    },

    /** Chrome start-up or install: give every open window its focus back. */
    async restoreWindows() {
      const focusTo = await exclusive(async () => {
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
        const focused = wins.find((w) => w.focused);
        return focused ? map[focused.id].focusId : null;
      });
      setTimer(() => finishRestore().catch((e) => console.error('Focus Bars: restore finish failed', e)), RESTORE_MS);
      if (focusTo) await switcher.request(focusTo);
      await updateBadge();
    },

    async onFocusChanged(windowId) {
      if (windowId === NONE) return;
      const win = await getWindow(windowId);
      if (!win || win.type !== 'normal') return;
      // Read without the lock so a focus change arriving mid-swap reaches the
      // switcher at once and replaces any request still waiting there.
      let entry = (await readWindows(api.storage.session))[windowId];
      if (!entry) {
        await addWindow(win);
        entry = (await readWindows(api.storage.session))[windowId];
      }
      await switcher.request(entry.focusId);
    },

    async onWindowCreated(win) {
      if (win.type !== 'normal') return;
      await addWindow(win);
    },

    onWindowRemoved: (windowId) => exclusive(async () => {
      const map = await readWindows(api.storage.session);
      delete map[windowId];
      await writeWindows(api.storage.session, map);
    }),

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
      const r = await exclusive(() => handleExternalChange(api, kind, id, info));
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
          await assign(msg.windowId, msg.focusId, { fromPopup: true });
          return { ok: true };
        case 'create': {
          const id = await exclusive(() => createFocus(api, msg.name, { copyCurrent: !!msg.copyCurrent }));
          await assign(msg.windowId, id, { fromPopup: true });
          return { id };
        }
        case 'rename':
          await renameFocus(api, msg.focusId, msg.name);
          await updateBadge();
          return { ok: true };
        case 'delete': {
          const state = await readState(api.storage.local);
          if (state.activeId === msg.focusId) await switcher.request(state.generalId);
          await exclusive(() => deleteFocus(api, msg.focusId, async () => {
            throw new Error('Focus is still on the bar; try again');
          }));
          await updateBadge();
          return { ok: true };
        }
        case 'resolveRecovery': {
          await exclusive(async () => {
            await resolveRecovery(api, msg.focusId);
            const map = await readWindows(api.storage.session);
            for (const e of Object.values(map)) e.focusId = msg.focusId;
            await writeWindows(api.storage.session, map);
          });
          await updateBadge();
          return { ok: true };
        }
        default:
          throw new Error(`Unknown message: ${msg.type}`);
      }
    },
  };
}
