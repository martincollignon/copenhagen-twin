import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticInstanceCache } from '../js/static-instance-cache.js';

function fixture() {
  const buffer = [], writes = [], moves = [];
  const cache = createStaticInstanceCache((item, slot) => {
    buffer[slot] = item;
    writes.push([item, slot]);
  }, (from, to) => {
    buffer[to] = buffer[from];
    moves.push([from, to]);
  });
  return { cache, buffer, writes, moves };
}

test('reordering unchanged items preserves their slots without writes', () => {
  const { cache, buffer, writes, moves } = fixture();
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  assert.equal(cache.sync([a, b, c]), 3);
  writes.length = 0;
  assert.equal(cache.sync([c, a, b]), 3);
  assert.deepEqual(buffer, [a, b, c]);
  assert.deepEqual(writes, []);
  assert.deepEqual(moves, []);
});

test('removals compact survivors before new items occupy freed capacity', () => {
  const { cache, buffer, writes, moves } = fixture();
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  cache.sync(items.slice(0, 4));
  writes.length = 0;
  assert.equal(cache.sync([items[3], items[4]]), 2);
  assert.deepEqual(new Set(buffer.slice(0, 2)), new Set([items[3], items[4]]));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], items[4]);
  assert.ok(writes[0][1] < 2, 'new items use the final batch capacity');
  assert.ok(moves.length > 0, 'survivor data is copied into active slots');
  assert.equal(cache.sync([items[4]]), 1);
  assert.equal(buffer[0], items[4]);
});

test('emptying and replacing a batch never retains stale identities', () => {
  const { cache, buffer, writes } = fixture();
  const first = { id: 1 }, replacement = { id: 1 };
  cache.sync([first]);
  assert.equal(cache.sync([]), 0);
  assert.equal(cache.sync([first]), 1);
  assert.equal(cache.sync([replacement]), 1);
  assert.equal(buffer[0], replacement);
  assert.deepEqual(writes.map(([item]) => item), [first, first, replacement]);
});

test('changing memberships keeps every active slot correct over repeated compaction', () => {
  const { cache, buffer } = fixture();
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  for (let step = 0; step < 100; step++) {
    const wanted = items.filter(item => ((item.id * 7 + step * 3) % 13) < 8);
    const count = cache.sync(wanted);
    assert.equal(count, wanted.length);
    assert.deepEqual(new Set(buffer.slice(0, count)), new Set(wanted));
  }
});
