// Bounded parallelism for independent provider calls. Caps concurrent
// legs so a many-channel fan-out cannot trip provider rate limits.
// Results keep input order regardless of completion order.
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const cap = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= cap) {
      await new Promise<void>((resume) => waiting.push(resume));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
