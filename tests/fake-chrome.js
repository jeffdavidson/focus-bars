// In-memory stand-in for the parts of chrome.* that Focus Bars uses.
// Shaped like the real API (promise-returning), plus a few `_` helpers for tests.

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    _fire: (...args) => listeners.forEach((fn) => fn(...args)),
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
 * @param {{bar?: Node[], other?: Node[], windows?: {id:number, type?:string, focused?:boolean, tabs?:(string|{url?:string,pendingUrl?:string})[]}[]}} seed
 * Node = {title, url?, children?: Node[]}
 */
export function createFakeChrome(seed = {}) {
  const nodes = new Map(); // id -> {id, parentId, title, url?, children?: string[], folderType?}
  let nextId = 100;
  let movesLeft = Infinity;
  const events = []; // every fired bookmark event, in order: {name, args}

  const onMoved = makeEvent();
  const onRemoved = makeEvent();
  const onCreated = makeEvent();
  const onChanged = makeEvent();

  function add(parentId, { title, url, children }, fixedId, folderType) {
    const id = fixedId ?? String(nextId++);
    const node = { id, parentId, title: title ?? '' };
    if (url !== undefined) node.url = url;
    else node.children = [];
    if (folderType) node.folderType = folderType;
    nodes.set(id, node);
    if (parentId != null) nodes.get(parentId).children.push(id);
    for (const c of children ?? []) add(id, c);
    return id;
  }

  add(null, { title: '', children: [] }, '0');
  add('0', { title: 'Bookmarks bar' }, '1', 'bookmarks-bar');
  add('0', { title: 'Other bookmarks' }, '2', 'other');
  for (const n of seed.bar ?? []) add('1', n);
  for (const n of seed.other ?? []) add('2', n);

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
  };

  const tabs = {
    async query({ windowId } = {}) {
      return structuredClone(wins.filter((w) => windowId == null || w.id === windowId).flatMap((w) => w.tabs));
    },
  };

  let badge = '';
  const action = {
    async setBadgeText({ text }) {
      badge = text;
    },
    async setBadgeBackgroundColor() {},
  };

  return {
    bookmarks,
    storage: { local: makeStorageArea(), session: makeStorageArea() },
    windows,
    tabs,
    action,

    // ---- test helpers ----
    /** Titles of a folder's children, in order. */
    _titles: (parentId) => need(parentId).children.map((c) => nodes.get(c).title),
    /** Id of the first node with this title (depth-first). */
    _id: (title) => [...nodes.values()].find((n) => n.title === title)?.id,
    /** Whether a node exists. */
    _exists: (id) => nodes.has(String(id)),
    /** Let n moves succeed, then make the next one throw (once). */
    _failAfterMoves: (n) => {
      movesLeft = n;
    },
    /** Every bookmark event fired so far: [{name, args}]. */
    _events: events,
    _badge: () => badge,
    /** Mutable window list for tests: [{id, type, focused, tabs:[{id, url?, pendingUrl?}]}]. */
    _windows: wins,
    _addTab: (windowId, t) => {
      wins.find((w) => w.id === windowId).tabs.push({ id: nextTabId++, windowId, ...(typeof t === 'string' ? { url: t } : t) });
    },
  };
}
