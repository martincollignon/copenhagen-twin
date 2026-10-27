// js/yield-frame.js
// Cooperative scheduling for the tile builds: let the render loop have the main thread between slices of work.

/** Resolves on the next animation frame, or after 50 ms (a background tab never fires frames; the boot has no loop yet). */
export const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
  setTimeout(go, 50);
});

/**
 * `await slice()` inside a long build: returns at once while the current slice has used less than `budgetMs`, otherwise waits for
 * the next frame and starts a new slice.
 */
export function createSlicer(budgetMs = 8, wait = nextFrame) {
  let start = performance.now();
  return async () => {
    if (performance.now() - start < budgetMs) return;
    await wait();
    start = performance.now();
  };
}

/**
 * A slicer shared by concurrent tile builds. Every waiter joins the same frame wait and budget reset, then
 * checks the shared clock again in case another continuation already used the new slice.
 */
export function createSharedSlicer(budgetMs = 5, { wait = nextFrame, now = () => performance.now() } = {}) {
  let start = now();
  let waiting = null;
  return async () => {
    while (now() - start >= budgetMs) {
      if (!waiting) {
        const previousStart = start;
        waiting = Promise.resolve().then(wait).then(() => {
          if (start === previousStart) start = now();
        }).finally(() => { waiting = null; });
      }
      await waiting;
    }
  };
}
