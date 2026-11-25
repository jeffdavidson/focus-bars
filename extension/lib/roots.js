/** Find the bookmark bar and "Other bookmarks" nodes without relying on fixed ids. */
export async function findRoots(bookmarks) {
  const [root] = await bookmarks.getTree();
  const kids = root.children ?? [];
  const bar = kids.find((n) => n.folderType === 'bookmarks-bar') ?? kids[0];
  const other = kids.find((n) => n.folderType === 'other') ?? kids[1];
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
