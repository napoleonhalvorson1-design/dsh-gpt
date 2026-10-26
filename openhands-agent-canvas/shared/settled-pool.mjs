const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

export async function settledPool(items, worker, { concurrency = 4, signal } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError('concurrency must be an integer from 1 to 32');
  }
  // The native getter validates the signal's brand, including forged prototypes.
  if (signal !== undefined) readAborted.call(signal);

  const results = Array.from({ length: items.length }, () => ({ status: 'skipped' }));
  let next = 0;

  async function run() {
    while (next < results.length) {
      if (signal !== undefined && readAborted.call(signal)) return;
      const index = next++;
      try {
        const value = await worker(items[index], index, signal);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, run));
  return results;
}
