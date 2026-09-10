/**
 * Prometheus metrics — port of utils/metrics.py.
 *
 * In-process counters rendered in the text exposition format. Per-process state
 * is correct for Prometheus (it scrapes each replica as its own target).
 */

type Key = string;

const reqTotal = new Map<Key, number>();
const latencySum = new Map<string, number>();
const latencyCount = new Map<string, number>();

let streamTtfbSum = 0;
let streamTtfbCount = 0;
let upstreamConnectSum = 0;
let upstreamConnectCount = 0;
let upstreamConnectSlow = 0;
let streamBytesTotal = 0;
let streamActive = 0;
const streamErrors = new Map<string, number>();

const SLOW_CONNECT_S = 1.0;

function inc(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

export function record(method: string, path: string, status: number, duration: number): void {
  inc(reqTotal, `${method}\u0000${path}\u0000${status}`);
  inc(latencySum, `${method}\u0000${path}`, duration);
  inc(latencyCount, `${method}\u0000${path}`);
}

export function recordUpstreamConnect(duration: number): void {
  upstreamConnectSum += duration;
  upstreamConnectCount += 1;
  if (duration > SLOW_CONNECT_S) upstreamConnectSlow += 1;
}

export function recordStreamTtfb(duration: number): void {
  streamTtfbSum += duration;
  streamTtfbCount += 1;
}

export function recordStreamBytes(n: number): void {
  streamBytesTotal += n;
}

export function recordStreamError(code: string | number): void {
  inc(streamErrors, String(code));
}

export function streamStarted(): void {
  streamActive += 1;
}

export function streamFinished(): void {
  streamActive -= 1;
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sortedKeys<V>(m: Map<string, V>): string[] {
  return [...m.keys()].sort();
}

export function render(): string {
  const lines: string[] = [
    '# HELP http_requests_total Total HTTP requests by method, path and status.',
    '# TYPE http_requests_total counter',
  ];
  for (const k of sortedKeys(reqTotal)) {
    const [method, path, status] = k.split('\u0000');
    lines.push(
      `http_requests_total{method="${esc(method!)}",path="${esc(path!)}",status="${status}"} ${
        reqTotal.get(k) ?? 0
      }`,
    );
  }
  lines.push(
    '# HELP http_request_duration_seconds Request latency by method and path.',
    '# TYPE http_request_duration_seconds summary',
  );
  for (const k of sortedKeys(latencySum)) {
    const [method, path] = k.split('\u0000');
    const labels = `method="${esc(method!)}",path="${esc(path!)}"`;
    lines.push(`http_request_duration_seconds_sum{${labels}} ${latencySum.get(k) ?? 0}`);
    lines.push(`http_request_duration_seconds_count{${labels}} ${latencyCount.get(k) ?? 0}`);
  }
  lines.push(
    '# HELP stream_ttfb_seconds Time from proxy request to first byte sent to client.',
    '# TYPE stream_ttfb_seconds summary',
    `stream_ttfb_seconds_sum ${streamTtfbSum}`,
    `stream_ttfb_seconds_count ${streamTtfbCount}`,
    '# HELP stream_upstream_connect_seconds Time to receive upstream response headers.',
    '# TYPE stream_upstream_connect_seconds summary',
    `stream_upstream_connect_seconds_sum ${upstreamConnectSum}`,
    `stream_upstream_connect_seconds_count ${upstreamConnectCount}`,
    '# HELP stream_upstream_connect_slow_total Upstream connects slower than ' +
      `${SLOW_CONNECT_S}s (DNS/CDN degradation signal).`,
    '# TYPE stream_upstream_connect_slow_total counter',
    `stream_upstream_connect_slow_total ${upstreamConnectSlow}`,
    '# HELP stream_bytes_total Bytes proxied to clients.',
    '# TYPE stream_bytes_total counter',
    `stream_bytes_total ${streamBytesTotal}`,
    '# HELP stream_active Streams currently being proxied.',
    '# TYPE stream_active gauge',
    `stream_active ${streamActive}`,
    '# HELP stream_errors_total Stream failures by upstream status or error class.',
    '# TYPE stream_errors_total counter',
  );
  for (const code of sortedKeys(streamErrors)) {
    lines.push(`stream_errors_total{code="${esc(code)}"} ${streamErrors.get(code) ?? 0}`);
  }
  return lines.join('\n') + '\n';
}

/** Test helper — drop all in-process state. */
export function resetMetrics(): void {
  reqTotal.clear();
  latencySum.clear();
  latencyCount.clear();
  streamTtfbSum = 0;
  streamTtfbCount = 0;
  upstreamConnectSum = 0;
  upstreamConnectCount = 0;
  upstreamConnectSlow = 0;
  streamBytesTotal = 0;
  streamActive = 0;
  streamErrors.clear();
}
