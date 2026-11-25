// THROWAWAY speed test for Focus Bars (plan Task 0). Not product code.
// Alternates the bookmark bar between folders "Spike A" and "Spike B" on every
// window switch and logs how long each swap takes.

async function roots() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = root.children;
  const bar = kids.find((n) => n.folderType === 'bookmarks-bar') ?? kids[0];
  const other = kids.find((n) => n.folderType === 'other') ?? kids[1];
  return { barId: bar.id, otherId: other.id };
}

async function moveAll(fromId, toId) {
  const kids = await chrome.bookmarks.getChildren(fromId);
  for (const k of kids) await chrome.bookmarks.move(k.id, { parentId: toId });
  return kids.length;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { otherId } = await roots();
  const a = await chrome.bookmarks.create({ parentId: otherId, title: 'Spike A' });
  const b = await chrome.bookmarks.create({ parentId: otherId, title: 'Spike B' });
  for (let i = 1; i <= 30; i++) {
    await chrome.bookmarks.create({ parentId: b.id, title: `Spike ${i}`, url: `https://example.com/${i}` });
  }
  // The current bar contents count as "A" and stay on the bar: A's folder is empty while A is shown.
  await chrome.storage.local.set({ aId: a.id, bId: b.id, onBar: 'A', n: 0, times: [] });
  console.log('Spike ready: bar = A. Switch windows to swap.');
});

let chain = Promise.resolve();

async function swap() {
  const { barId } = await roots();
  const s = await chrome.storage.local.get(['aId', 'bId', 'onBar', 'n', 'times']);
  if (!s.aId) return;
  const [curId, nextId, next] = s.onBar === 'A' ? [s.aId, s.bId, 'B'] : [s.bId, s.aId, 'A'];
  const t0 = performance.now();
  const out = await moveAll(barId, curId);
  const inn = await moveAll(nextId, barId);
  const ms = Math.round(performance.now() - t0);
  const n = s.n + 1;
  const times = [...s.times, ms].slice(-50);
  await chrome.storage.local.set({ onBar: next, n, times });
  const sorted = [...times].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`swap ${n}: ${ms} ms (moved ${out} off, ${inn} on) — median of last ${times.length}: ${median} ms`);
  await chrome.action.setBadgeText({ text: String(ms) });
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chain = chain.then(swap).catch((e) => console.error('swap failed', e));
});
