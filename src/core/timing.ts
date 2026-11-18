/** Elapsed milliseconds from a performance.now() start, rounded to one decimal. */
export function roundMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}
