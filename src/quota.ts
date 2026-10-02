/** Epoch seconds at the end of the current UTC quota day. */
export function nextUtcMidnightEpoch(now = Date.now()): number {
  return (Math.floor(now / 86_400_000) + 1) * 86_400;
}
