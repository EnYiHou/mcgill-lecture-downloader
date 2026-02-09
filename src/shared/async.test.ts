import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './async';

describe('mapWithConcurrency', () => {
  it('preserves order and settles all items', async () => {
    const items = [1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 2, (value) => Promise.resolve(value * 2));

    expect(results).toEqual([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
      { status: 'fulfilled', value: 6 },
      { status: 'fulfilled', value: 8 }
    ]);
  });

  it('captures rejections without failing entire batch', async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 2, (value) => {
      if (value === 2) {
        return Promise.reject(new Error('bad item'));
      }
      return Promise.resolve(value);
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});
