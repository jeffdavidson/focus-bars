/**
 * Runs swaps one at a time. Requests made while a swap is running replace each
 * other, so only the most recent one runs next. Every pending request resolves
 * when the queue goes idle.
 * @param {(focusId: string) => Promise<void>} runSwap
 */
export function createSwitcher(runSwap) {
  let running = null; // promise of the drain loop, or null when idle
  let pending = null; // latest requested focus id not yet started

  async function drain() {
    while (pending !== null) {
      const id = pending;
      pending = null;
      try {
        await runSwap(id);
      } catch (e) {
        console.error('Focus Bars: swap failed', e);
      }
    }
    running = null;
  }

  return {
    request(focusId) {
      pending = focusId;
      if (!running) running = drain();
      return running;
    },
  };
}
