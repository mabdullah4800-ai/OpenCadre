/** In-process request metrics for the hub (reliability sprint R0.3). One process, so plain counters are
 * enough: a rolling five-minute window for alerting, and totals since start. Long-poll routes count as
 * requests but are left out of latency, because their duration is the wait the client asked for. */

const WINDOW_MINUTES = 5;
const MAX_SAMPLES_PER_MINUTE = 2000;
const LONG_POLL = [/^\/v1\/messages\/wait$/, /^\/v1\/events\/wait$/, /^\/v1\/approvals\/[^/]+\/wait$/];

interface Bucket {
  minute: number;
  requests: number;
  errors5xx: number;
  latenciesMs: number[];
}

const buckets: Bucket[] = [];
/** Start time of every request still in flight. A request that never finishes (a hung long-poll, a
 * deadlock) would otherwise never reach recordRequest and stay invisible to the window. */
const inFlight = new Map<number, number>();
let nextRequestId = 0;
/** Longest legitimate request: long-polls cap at 280 s, so anything past this is stuck. */
const STUCK_AFTER_MS = 300_000;

export function requestStarted(now = Date.now()): number {
  const id = ++nextRequestId;
  inFlight.set(id, now);
  return id;
}
export function requestFinished(id: number): void {
  inFlight.delete(id);
}
const totals = { requests: 0, errors5xx: 0, errors4xx: 0 };

export const isLongPoll = (path: string) => LONG_POLL.some((re) => re.test(path));

function bucketFor(minute: number): Bucket {
  let bucket = buckets.at(-1);
  if (!bucket || bucket.minute !== minute) {
    bucket = { minute, requests: 0, errors5xx: 0, latenciesMs: [] };
    buckets.push(bucket);
  }
  while (buckets.length && buckets[0].minute <= minute - WINDOW_MINUTES) buckets.shift();
  return bucket;
}

export function recordRequest(path: string, status: number, ms: number, now = Date.now()): void {
  const bucket = bucketFor(Math.floor(now / 60_000));
  bucket.requests++;
  totals.requests++;
  if (status >= 500) {
    bucket.errors5xx++;
    totals.errors5xx++;
  } else if (status >= 400) {
    totals.errors4xx++;
  }
  if (!isLongPoll(path) && bucket.latenciesMs.length < MAX_SAMPLES_PER_MINUTE) bucket.latenciesMs.push(ms);
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export interface AlertThresholds {
  /** Fraction of window requests that returned 5xx. */
  errorRate: number;
  p95Ms: number;
  /** The error-rate alert needs at least this many requests (a single failure isn't a rate). */
  minRequests: number;
  /** The latency alert needs at least this many timed samples; a slow hub should page even at night. */
  minLatencySamples: number;
}

export function alertThresholds(env = process.env): AlertThresholds {
  const num = (raw: string | undefined, fallback: number) => (raw && Number.isFinite(Number(raw)) ? Number(raw) : fallback);
  return {
    errorRate: num(env.OPENCADRE_ALERT_ERROR_RATE, 0.02),
    p95Ms: num(env.OPENCADRE_ALERT_P95_MS, 1000),
    minRequests: num(env.OPENCADRE_ALERT_MIN_REQUESTS, 20),
    minLatencySamples: num(env.OPENCADRE_ALERT_MIN_LATENCY_SAMPLES, 3),
  };
}

export function windowStats(now = Date.now(), thresholds = alertThresholds()) {
  const current = Math.floor(now / 60_000);
  const recent = buckets.filter((b) => b.minute > current - WINDOW_MINUTES);
  const requests = recent.reduce((n, b) => n + b.requests, 0);
  const errors5xx = recent.reduce((n, b) => n + b.errors5xx, 0);
  const latencies = recent.flatMap((b) => b.latenciesMs).sort((a, b) => a - b);
  const errorRate = requests ? errors5xx / requests : 0;
  const p95Ms = percentile(latencies, 95);
  const errorRateHigh = requests >= thresholds.minRequests && errorRate > thresholds.errorRate;
  const p95High = latencies.length >= thresholds.minLatencySamples && p95Ms !== null && p95Ms > thresholds.p95Ms;
  const ages = [...inFlight.values()].map((started) => now - started);
  const stuckRequests = ages.filter((age) => age > STUCK_AFTER_MS).length;
  return {
    window: {
      minutes: WINDOW_MINUTES,
      requests,
      errors5xx,
      errorRate: Math.round(errorRate * 10_000) / 10_000,
      p50Ms: percentile(latencies, 50),
      p95Ms,
    },
    inFlight: { requests: inFlight.size, oldestSeconds: ages.length ? Math.round(Math.max(...ages) / 1000) : 0, stuck: stuckRequests },
    alerts: { healthy: !errorRateHigh && !p95High && stuckRequests === 0, errorRateHigh, p95High, stuckRequests: stuckRequests > 0, thresholds },
  };
}

export function totalsSnapshot() {
  return { ...totals };
}

/** For tests only. */
export function resetMetrics(): void {
  buckets.length = 0;
  inFlight.clear();
  totals.requests = totals.errors5xx = totals.errors4xx = 0;
}
