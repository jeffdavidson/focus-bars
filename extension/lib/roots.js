/**
 * Find the bookmark bar Chrome shows, and the "Other bookmarks" from the same set,
 * without relying on fixed ids.
 *
 * A signed-in profile can have two sets: one saved in the Google account
 * (syncing=true) and one only on this device. Chrome shows the account bar, so
 * prefer it, and always pair it with the Other bookmarks of the same set so
 * Focus Bars never moves bookmarks between the two.
 */
export async function findRoots(bookmarks) {
  const [root] = await bookmarks.getTree();
  const kids = root.children ?? [];
  const bars = kids.filter((n) => n.folderType === 'bookmarks-bar');
  const bar = bars.find((n) => n.syncing === true) ?? bars[0] ?? kids[0];
  const others = kids.filter((n) => n.folderType === 'other');
  const other = others.find((n) => n.syncing === bar.syncing) ?? others[0] ?? kids[1];
  return { barId: bar.id, otherId: other.id };
}

/** Look up bookmarks by id, skipping any that no longer exist (bookmarks.get rejects on one missing id). */
export async function getExisting(bookmarks, ids) {
  const out = [];
  for (const id of ids) {
    try {
      out.push((await bookmarks.get(id))[0]);
    } catch {
      // deleted; its onRemoved will catch up
    }
  }
  return out;
}
