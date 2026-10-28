/** Keep immutable items densely packed without rewriting instances that remain in the batch. */
export function createStaticInstanceCache(write, move) {
  const items = [], seen = new Map();
  let generation = 0;
  return {
    sync(wanted) {
      generation++;
      for (const item of wanted) if (seen.has(item)) seen.set(item, generation);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (seen.get(item) === generation) continue;
        seen.delete(item);
        const last = items.pop();
        if (i < items.length) {
          items[i] = last;
          move(items.length, i);
        }
      }
      for (const item of wanted) {
        if (seen.has(item)) continue;
        const slot = items.length;
        items.push(item);
        seen.set(item, generation);
        write(item, slot);
      }
      return items.length;
    }
  };
}
