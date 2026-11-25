import { createFakeChrome } from './fake-chrome.js';
import { writeState } from '../extension/lib/store.js';

/**
 * A fake with the extension already set up:
 * bar = [a, b, c] (General is active), Other bookmarks/Focus Bars/{General: [], Dev: [x, y]}.
 */
export async function seeded({ windows } = {}) {
  const api = createFakeChrome({
    bar: [{ title: 'a', url: 'https://a/' }, { title: 'b', url: 'https://b/' }, { title: 'c', url: 'https://c/' }],
    other: [
      {
        title: 'Focus Bars',
        children: [
          { title: 'General', children: [] },
          { title: 'Dev', children: [{ title: 'x', url: 'https://x/' }, { title: 'y', url: 'https://y/' }] },
        ],
      },
    ],
    windows,
  });
  const ids = { rootId: api._id('Focus Bars'), generalId: api._id('General'), devId: api._id('Dev') };
  await writeState(api.storage.local, {
    version: 1,
    barId: '1',
    rootId: ids.rootId,
    generalId: ids.generalId,
    focusIds: [ids.generalId, ids.devId],
    activeId: ids.generalId,
    journal: null,
    needsRecovery: false,
    prints: {},
    lastSwapMs: null,
  });
  return { api, ...ids };
}
