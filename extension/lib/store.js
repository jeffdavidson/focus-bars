/** @typedef {{
 *   version: 1,
 *   barId: string, rootId: string, generalId: string,
 *   focusIds: string[],
 *   activeId: string,
 *   journal: {from: string, to: string, phase: 'toFolder'|'toBar'} | null,
 *   needsRecovery: boolean,
 *   prints: Record<string, {urls: string[], focusId: string, lastSeen: number}>,
 *   lastSwapMs: number | null
 * }} State */

/** @returns {Promise<State|null>} */
export async function readState(local) {
  const { state } = await local.get('state');
  return state ?? null;
}

/** @param {State} state */
export async function writeState(local, state) {
  await local.set({ state });
}

/** @returns {Promise<Record<string, {focusId: string, printKey: string, unmatched?: boolean}>>} */
export async function readWindows(session) {
  const { windows } = await session.get('windows');
  return windows ?? {};
}

export async function writeWindows(session, map) {
  await session.set({ windows: map });
}
