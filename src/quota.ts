/** Epoch seconds at the end of the current UTC quota day. */
export function nextUtcMidnightEpoch(now = Date.now()): number {
  return (Math.floor(now / 86_400_000) + 1) * 86_400;
}

const pacificClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

/** Represent the Pacific wall clock as a UTC timestamp for offset arithmetic. */
function pacificWallTime(now: number): number {
  const parts = Object.fromEntries(pacificClock.formatToParts(now).map((p) => [p.type, p.value]));
  return Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
}

/** Epoch seconds at the next YouTube Data API quota reset (Pacific midnight). */
export function nextPacificMidnightEpoch(now = Date.now()): number {
  const localNow = new Date(pacificWallTime(now));
  const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + 1);
  let reset = midnight;
  // Resolve the offset at midnight itself, rather than carrying today's offset
  // across a DST change. The second pass rechecks it at the candidate reset.
  for (let pass = 0; pass < 2; pass++) reset += midnight - pacificWallTime(reset);
  return reset / 1000;
}
