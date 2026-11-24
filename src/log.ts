/** Structured logging: one JSON object per line, so production logs can be searched and measured
 * (request latency, error rates) instead of read by eye. Secrets never reach the output: key-shaped
 * strings are masked wherever they appear, and credential-named fields are dropped entirely. */

import { maskSecrets } from "./secrets.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Every secret shape the hub masks (src/secrets.ts), plus a wider net for logs only: any OpenCadre-prefixed run of
// 8+ characters, e.g. a key cut short in an error message, which approval text keeps readable but a log never needs.
// oca_/ocr_ are the MCP connector's access and refresh tokens (src/oauth.ts).
const KEY_PATTERN = /\b(agt|org|oci|ocd|oca|ocr|oc|dev)_[A-Za-z0-9]{8,}/g;
// The connector's authorization codes, PKCE verifiers and consent CSRF values have no prefix to match, so they are
// dropped by field name wherever they appear (design §4: the request log's redaction covers /oauth/*).
const SECRET_FIELD =
  /^(authorization|api[-_]?key|apikey|key|token|secret|password|cookie|code|code_verifier|access_token|refresh_token|client_secret|csrf|consent)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskSecrets(value).replace(KEY_PATTERN, "$1_***");
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (value === null || typeof value !== "object") return value;
  // Never hand an uninspected subtree to JSON.stringify after traversal stops.
  if (depth > 4) return "[omitted: depth limit]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) ? "[redacted]" : redact(v, depth + 1)]),
  );
}

function threshold(): number {
  const configured = process.env.OPENCADRE_LOG_LEVEL?.toLowerCase();
  if (configured && configured in RANK) return RANK[configured as LogLevel];
  // Test runs import the hub modules directly; keep their output to real problems.
  return process.env.VITEST ? RANK.warn : RANK.info;
}

export type LogSink = (line: string, level: LogLevel) => void;
const defaultSink: LogSink = (line, level) => (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
let sink: LogSink = defaultSink;

/** For tests: capture lines instead of writing them. Returns a function that restores the default. */
export function setLogSink(next: LogSink): () => void {
  sink = next;
  return () => {
    sink = defaultSink;
  };
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < threshold()) return;
  const entry = { ts: new Date().toISOString(), level, msg: redact(msg), ...(fields ? (redact(fields) as object) : {}) };
  sink(JSON.stringify(entry), level);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
