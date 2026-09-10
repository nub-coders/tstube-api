/**
 * Python float formatting for `time_taken`.
 *
 * main.py computes `elapsed = round(time.time() - start, 2)` then embeds it via
 * an f-string. Python renders a float with `.0` when it is integral ("1.0 sec")
 * and drops trailing zeros otherwise ("0.12 sec"), so `String(1)` / `toFixed(2)`
 * alone would not match.
 */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function pyFloatStr(x: number): string {
  const r = round2(x);
  if (Number.isInteger(r)) return `${r.toFixed(1)}`;
  return String(r);
}

/** Seconds since `startMs`, formatted like Python's `f"{round(dt,2)} sec"`. */
export function timeTaken(startMs: number): string {
  return `${pyFloatStr((Date.now() - startMs) / 1000)} sec`;
}

/**
 * Python-style `round()`: half-to-even on exact halves, matching CPython's
 * behaviour for the doubles we produce (averages, percentages).
 */
export function pyRound(x: number, digits = 0): number {
  const f = Math.pow(10, digits);
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return (floor % 2 === 0 ? floor : floor + 1) / f;
  }
  return Math.round(scaled) / f;
}

/** Python `repr(float)`: integral values keep one decimal (5.0), others minimal. */
export function pyNumStr(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(Number.parseFloat(n.toPrecision(12)));
}

/** Python `round(x, d)` then f-string it. */
export function pyRoundStr(x: number, digits = 0): string {
  return pyNumStr(pyRound(x, digits));
}

/** Python `f"{n:,}"` — thousands separators. */
export function comma(n: number): string {
  return Math.trunc(n).toLocaleString('en-US');
}
