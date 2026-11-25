/** Overlap of two URL sets (intersection / union). Two empty sets score 0. */
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both += 1;
  return both / (A.size + B.size - both);
}

/**
 * Match windows to stored fingerprints. Highest-scoring pairs win first; each
 * window and each print is used at most once.
 * @param {{id: number, urls: string[]}[]} wins
 * @returns {Record<string, string>} windowId -> printKey
 */
export function matchWindows(wins, prints, threshold = 0.5) {
  const pairs = [];
  for (const w of wins) {
    for (const [key, p] of Object.entries(prints)) {
      const score = jaccard(w.urls, p.urls);
      if (score >= threshold) pairs.push({ win: w.id, key, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const out = {};
  const used = new Set();
  for (const { win, key } of pairs) {
    if (win in out || used.has(key)) continue;
    out[win] = key;
    used.add(key);
  }
  return out;
}

/** Drop prints that are not live and were last seen more than `maxAgeMs` ago. */
export function prunePrints(prints, liveKeys, now, maxAgeMs = 30 * 24 * 3600 * 1000) {
  return Object.fromEntries(
    Object.entries(prints).filter(([key, p]) => liveKeys.has(key) || now - p.lastSeen <= maxAgeMs),
  );
}
