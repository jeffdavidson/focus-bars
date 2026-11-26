// In-memory stand-in for the parts of chrome.* that Focus Bars uses.
// Shaped like the real API (promise-returning), plus a few `_` helpers for tests.

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    _fire: (...args) => listeners.forEach((fn) => fn(...args)),
    _count: () => listeners.length,
  };
}

function makeStorageArea() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      data = { ...data, ...structuredClone(obj) };
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    _dump: () => structuredClone(data),
  };
}

/**
 * @param {{bar?: Node[], other?: Node[], account?: {bar?: Node[], other?: Node[]}, accountFirst?: boolean, windows?: {id:number, type?:string, focused?:boolean, tabs?:(string|{url?:string,pendingUrl?:string})[]}[]}} seed
 * `account` adds a second, account-saved set (syncing=true) after the device set, or before it with `accountFirst`.
 * Node = {title, url?, children?: Node[]}
 */
export function createFakeChrome(seed = {}) {
  const nodes = new Map(); // id -> {id, parentId, title, url?, children?: string[], folderType?}
  let nextId = 100;
  let movesLeft = Infinity;
  let moveDelayMs = 0;
  const events = []; // every fired bookmark event, in order: {name, args}

  const onMoved = makeEvent();
  const onRemoved = makeEvent();
  const onCreated = makeEvent();
  const onChanged = makeEvent();

  function add(parentId, { title, url, children }, fixedId, folderType, syncing) {
    const id = fixedId ?? String(nextId++);
    const node = { id, parentId, title: title ?? '' };
    if (url !== undefined) node.url = url;
    else node.children = [];
    if (folderType) node.folderType = folderType;
    if (syncing !== undefined) node.syncing = syncing;
    nodes.set(id, node);
    if (parentId != null) nodes.get(parentId).children.push(id);
    for (const c of children ?? []) add(id, c);
    return id;
  }

  /** A second, account-saved set of top-level folders (syncing=true), as Chrome adds when account bookmarks are on. */
  function addAccountSet({ bar = [], other = [] } = {}) {
    const barId = add('0', { title: 'Bookmarks Bar' }, undefined, 'bookmarks-bar', true);
    const otherId = add('0', { title: 'Other Bookmarks' }, undefined, 'other', true);
    for (const n of bar) add(barId, n);
    for (const n of other) add(otherId, n);
    return { barId, otherId };
  }

  add(null, { title: '', children: [] }, '0');
  if (seed.account && seed.accountFirst) addAccountSet(seed.account);
  add('0', { title: 'Bookmarks bar' }, '1', 'bookmarks-bar', false);
  add('0', { title: 'Other bookmarks' }, '2', 'other', false);
  for (const n of seed.bar ?? []) add('1', n);
  for (const n of seed.other ?? []) add('2', n);
  if (seed.account && !seed.accountFirst) addAccountSet(seed.account);

  /** Every node reports the storage of the top-level folder it lives in. */
  function syncingOf(n) {
    while (n && n.syncing === undefined && n.parentId != null) n = nodes.get(n.parentId);
    return n?.syncing;
  }

  function need(id) {
    const n = nodes.get(String(id));
    if (!n) throw new Error(`Can't find bookmark for id.`);
    return n;
  }

  function view(n, deep) {
    const out = { id: n.id, title: n.title };
    if (n.parentId != null) {
      out.parentId = n.parentId;
      out.index = nodes.get(n.parentId).children.indexOf(n.id);
    }
    if (n.url !== undefined) out.url = n.url;
    if (n.folderType) out.folderType = n.folderType;
    const syncing = syncingOf(n);
    if (syncing !== undefined) out.syncing = syncing;
    if (deep && n.children) out.children = n.children.map((c) => view(nodes.get(c), true));
    return out;
  }

  function fire(evt, name, ...args) {
    events.push({ name, args: structuredClone(args) });
    evt._fire(...args);
  }

  function detach(n) {
    const siblings = nodes.get(n.parentId).children;
    const index = siblings.indexOf(n.id);
    siblings.splice(index, 1);
    return index;
  }

  function dropSubtree(id) {
    const n = nodes.get(id);
    for (const c of n.children ?? []) dropSubtree(c);
    nodes.delete(id);
  }

  const bookmarks = {
    async getTree() {
      return [view(nodes.get('0'), true)];
    },
    async getSubTree(id) {
      return [view(need(id), true)];
    },
    async getChildren(id) {
      const n = need(id);
      if (!n.children) throw new Error('Not a folder.');
      return n.children.map((c) => view(nodes.get(c), false));
    },
    async get(ids) {
      return [].concat(ids).map((id) => view(need(id), false));
    },
    async create({ parentId, title, url, index }) {
      const parent = need(parentId);
      if (!parent.children) throw new Error('Parent is not a folder.');
      const id = add(parent.id, { title, url });
      if (index != null) {
        detach(nodes.get(id));
        parent.children.splice(index, 0, id);
      }
      const v = view(nodes.get(id), false);
      fire(onCreated, 'onCreated', id, v);
      return v;
    },
    async move(id, { parentId, index }) {
      if (movesLeft <= 0) {
        movesLeft = Infinity;
        throw new Error('Simulated service-worker death during move');
      }
      movesLeft -= 1;
      if (moveDelayMs) await new Promise((r) => setTimeout(r, moveDelayMs));
      const n = need(id);
      const target = need(parentId ?? n.parentId);
      if (!target.children) throw new Error('Target is not a folder.');
      const oldParentId = n.parentId;
      const oldIndex = detach(n);
      n.parentId = target.id;
      if (index == null || index > target.children.length) target.children.push(n.id);
      else target.children.splice(index, 0, n.id);
      fire(onMoved, 'onMoved', n.id, {
        parentId: target.id,
        index: target.children.indexOf(n.id),
        oldParentId,
        oldIndex,
      });
      return view(n, false);
    },
    async update(id, changes) {
      const n = need(id);
      if (changes.title !== undefined) n.title = changes.title;
      if (changes.url !== undefined) n.url = changes.url;
      fire(onChanged, 'onChanged', n.id, { title: n.title, url: n.url });
      return view(n, false);
    },
    async removeTree(id) {
      const n = need(id);
      const v = view(n, true);
      const parentId = n.parentId;
      const index = detach(n);
      dropSubtree(n.id);
      fire(onRemoved, 'onRemoved', n.id, { parentId, index, node: v });
    },
    async remove(id) {
      const n = need(id);
      if (n.children?.length) throw new Error("Can't remove non-empty folder.");
      return bookmarks.removeTree(id);
    },
    onMoved,
    onRemoved,
    onCreated,
    onChanged,
  };

  // Windows and tabs
  let nextTabId = 1;
  const wins = (seed.windows ?? []).map((w) => ({
    id: w.id,
    type: w.type ?? 'normal',
    focused: !!w.focused,
    tabs: (w.tabs ?? []).map((t) => ({ id: nextTabId++, windowId: w.id, ...(typeof t === 'string' ? { url: t } : t) })),
  }));

  const windows = {
    WINDOW_ID_NONE: -1,
    async getAll({ populate } = {}) {
      return wins.map((w) => (populate ? structuredClone(w) : { ...w, tabs: undefined }));
    },
    async get(id, { populate } = {}) {
      const w = wins.find((x) => x.id === id);
      if (!w) throw new Error(`No window with id: ${id}.`);
      return populate ? structuredClone(w) : { ...w, tabs: undefined };
    },
    async getLastFocused({ populate } = {}) {
      return windows.get((wins.find((w) => w.focused) ?? wins[0]).id, { populate });
    },
    async getCurrent(opts) {
      return windows.getLastFocused(opts);
    },
    onFocusChanged: makeEvent(),
    onCreated: makeEvent(),
    onRemoved: makeEvent(),
  };

  const tabs = {
    async query({ windowId } = {}) {
      return structuredClone(wins.filter((w) => windowId == null || w.id === windowId).flatMap((w) => w.tabs));
    },
    onCreated: makeEvent(),
    onUpdated: makeEvent(),
    onRemoved: makeEvent(),
    onAttached: makeEvent(),
    onDetached: makeEvent(),
  };

  const commands = { onCommand: makeEvent() };

  const runtime = {
    getURL: (path) => `chrome-extension://fakeid/${path}`,
    onStartup: makeEvent(),
    onInstalled: makeEvent(),
    onMessage: makeEvent(),
  };

  let badge = '';
  const action = {
    async setBadgeText({ text }) {
      badge = text;
    },
    async setBadgeBackgroundColor() {},
    async setTitle({ title: t }) {
      title = t;
    },
  };
  let title = '';

  return {
    bookmarks,
    storage: { local: makeStorageArea(), session: makeStorageArea() },
    windows,
    tabs,
    action,
    runtime,
    commands,

    // ---- test helpers ----
    /** Titles of a folder's children, in order. */
    _titles: (parentId) => need(parentId).children.map((c) => nodes.get(c).title),
    /** Id of the first node with this title (depth-first). */
    _id: (title) => [...nodes.values()].find((n) => n.title === title)?.id,
    /** Turn on account bookmarks: add a syncing=true bar and Other bookmarks. Returns their ids. */
    _addAccountSet: addAccountSet,
    /** Turn account bookmarks off again: the account folders vanish (no events, as when Chrome does it). */
    _dropNode: (id) => {
      detach(nodes.get(id));
      dropSubtree(id);
    },
    /** Whether a node exists. */
    _exists: (id) => nodes.has(String(id)),
    /** Let n moves succeed, then make the next one throw (once). */
    _failAfterMoves: (n) => {
      movesLeft = n;
    },
    /** Make every move take `ms` real milliseconds. */
    _slowMoves: (ms) => {
      moveDelayMs = ms;
    },
    /** Every bookmark event fired so far: [{name, args}]. */
    _events: events,
    _badge: () => badge,
    _title: () => title,
    /** Mutable window list for tests: [{id, type, focused, tabs:[{id, url?, pendingUrl?}]}]. */
    _windows: wins,
    _addTab: (windowId, t) => {
      wins.find((w) => w.id === windowId).tabs.push({ id: nextTabId++, windowId, ...(typeof t === 'string' ? { url: t } : t) });
    },
  };
}
