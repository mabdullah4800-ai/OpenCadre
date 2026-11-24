/** Secret masking for text agents send the hub: approval actions, details and notes, clearance reports, task text, event
 * payloads, logs.
 * Zero dependencies. A command typed with a key in it (`ALPHA="agt_…" node x.mjs`, `curl -H "Authorization: Bearer …"`,
 * `GITHUB_TOKEN=ghp_… gh …`) must never be stored or shown to the workspace as typed.
 *
 * Secret-shaped substrings become a fixed mask that keeps a short prefix, so a reader still knows what kind of secret
 * was there (`agt_***`, `Bearer ***`, `GITHUB_TOKEN=***`). Everything else is left exactly as it was: masking must not
 * change what an approver reads about the command itself. The result is stable: masking masked text changes nothing.
 *
 * Accepted limit: agt_/org_/dev_ keys are matched without a word boundary (so a key glued onto other text is still
 * masked), which means a word that merely ends in one of these prefixes and is followed by 16+ letters or digits
 * over-masks, e.g. `myorg_abcdefghijklmnop` becomes `myorg_***`. Hiding a harmless identifier is preferred to showing
 * a key.
 *
 * Keep in step with scripts/opencadre-secrets.mjs (the copy the approval gate runs on the client; tests/secrets.test.ts
 * runs both over the same cases). */

import { createHash } from "node:crypto";

export const MASK = "***";

/** Token shapes, applied in order. Each replacement keeps only the non-secret prefix. Every pattern runs in linear time
 * (no unbounded scan that restarts at each position), since agents choose the text. */
const TOKEN_RULES: Array<[RegExp, string | ((match: string) => string)]> = [
  // Authorization: Bearer <token>. A real token has a digit; "Bearer authentication" in prose is left alone.
  [/\b(Bearer)\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // JWTs: three base64url segments, the first a JSON header ("eyJ").
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, `eyJ${MASK}`],
  // OpenCadre: agt_ agent keys, org_ bootstrap keys, dev_ computer credentials (48 hex), oc_/ocd_ connect codes (10),
  // oci_ invite tokens (base64url). The lengths keep identifiers such as org_settings or oc_session readable.
  // agt_/org_/dev_ need no word boundary before them: a key glued onto other text (xxxxagt_…, a cut mid-word) still
  // masks, and 16+ letters and digits after one of these prefixes is not an identifier (cargo_dev_build stays).
  [/(agt|org|dev)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/g, `$1_${MASK}`],
  [/\b(ocd|oc)_[A-Za-z0-9]{10}(?![A-Za-z0-9_-])/g, `$1_${MASK}`],
  [/\boci_[A-Za-z0-9_-]{20,}/g, `oci_${MASK}`],
  // oca_/ocr_ MCP connector access and refresh tokens (src/oauth.ts, 48 hex).
  [/\b(oca|ocr)_[A-Za-z0-9]{16,}/g, `$1_${MASK}`],
  // Stripe-style secret and restricted keys.
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{8,}/g, `$1${MASK}`],
  [/\brk_[A-Za-z0-9]{16,}/g, `rk_${MASK}`],
  // the payment provider API keys (pdl_live_apikey_… / pdl_sdbx_apikey_…) and notification-destination secrets (pdl_ntfset_…).
  // https://developer.paddle.com/api-reference/about/authentication
  [/\b(pdl_(?:live|sdbx)_apikey_|pdl_ntfset_)[A-Za-z0-9_]{8,}/g, `$1${MASK}`],
  // OpenAI/Anthropic-style sk-… keys: a run of 20+ letters and digits, so hyphenated words (sk-learn-docs) stay.
  [/\bsk-[A-Za-z0-9_-]+/g, (match) => (/[A-Za-z0-9]{20}/.test(match) ? `sk-${MASK}` : match)],
  // GitHub tokens.
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}/g, `$1_${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  // Slack tokens.
  [/\b(xox[abpr])-[A-Za-z0-9-]{10,}/g, `$1-${MASK}`],
  // AWS access key ids, Google API keys, npm tokens.
  [/\bAKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g, `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}/g, `AIza${MASK}`],
  [/\bnpm_[A-Za-z0-9]{20,}/g, `npm_${MASK}`],
  // Credentials in a URL: scheme://user:password@host keeps the user.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // A secret flag followed by its value (the --flag=value form is an assignment, below).
  [/(?<![\w-])(--(?:password|passwd|token|secret|api-key|api_key|apikey))\s+(?!-)("[^"]*"|'[^']*'|["'][^]*|[^\s;&|<>()`]+)/gi, `$1 ${MASK}`],
];

/** NAME=value / NAME: value / --name=value. Only the name and separator are matched, so an assignment inside a
 * non-secret value (--env=API_TOKEN=x) is still seen. Not after "/": scheme://token:***@host is a URL, masked above. */
const ASSIGNMENT = /(?<![A-Za-z0-9_/])([A-Za-z][A-Za-z0-9_-]{0,63})(["']?)(\s*[=:]\s*)/g;
/** A value ends at whitespace or a shell operator, so masking never hides the rest of the command. A quoted value ends
 * at its closing quote; with no closing quote (text cut mid-value, e.g. TOKEN="lgZ at a 200-character summary limit) it
 * runs to the end of the text, newlines included: where the value ends is unknown, so the rest is masked rather than
 * risk showing part of a multi-line secret. */
const VALUE = /"[^"]*"|'[^']*'|["'][^]*|[^\s;&|<>()`"']+/y;
/** An Authorization scheme word (Basic, Bearer, Digest, token): letters and hyphens only. */
const AUTH_SCHEME = /^[A-Za-z][A-Za-z-]*$/;
/** The credential after a scheme: spaces or tabs, then one bare token (never a shell operator or a quote). */
const AUTH_CREDENTIAL = /[ \t]+([^\s;&|<>()`"']+)/y;

const isAuthorizationName = (name: string) => name.toUpperCase().includes("AUTHORIZATION");

/** A secret-looking name: TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, APIKEY, ACCESS_KEY, PRIVATE_KEY, CREDENTIAL, AUTH,
 * AUTHORIZATION (anywhere: Proxy-Authorization), or exactly KEY. TOKEN and AUTH count as a whole word or suffix
 * (GITHUB_TOKEN, BASIC_AUTH), so max_tokens and author don't. There is no general *_KEY rule, and exactly KEY counts
 * only outside a flag: `sort --key=2` and `--key=path` stay, while KEY=x, `export KEY=x`, `key: "x"` and
 * `--build-arg KEY=x` (an env-style assignment after a space) are masked. Every other name masks in flag form too
 * (--password=x, --api-key=x, --token=x, --secret=x). */
function isSecretName(name: string, isFlag: boolean): boolean {
  const n = name.toUpperCase().replace(/-/g, "_");
  return /PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTHORIZATION|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/.test(n)
    || (n === "KEY" && !isFlag)
    || /(^|_)(AUTH|TOKEN)(_|$)/.test(n)
    || /TOKEN$/.test(n);
}

function maskAssignments(text: string): string {
  let out = "";
  let last = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    // A name right after "-" is a flag (--key=2). ASSIGNMENT itself still matches after "-", so --password=x masks.
    if (!isSecretName(m[1], text[m.index - 1] === "-")) continue;
    const end = m.index + m[0].length;
    VALUE.lastIndex = end;
    const value = VALUE.exec(text);
    if (!value) continue;
    let start = end;
    let stop = end + value[0].length;
    // "Authorization: Basic dXNlcjpwYXNz": keep the scheme, mask the credential after it.
    if (isAuthorizationName(m[1]) && AUTH_SCHEME.test(value[0])) {
      AUTH_CREDENTIAL.lastIndex = stop;
      const credential = AUTH_CREDENTIAL.exec(text);
      if (credential) {
        start = stop + credential[0].length - credential[1].length;
        stop += credential[0].length;
      }
    }
    // A quoted value keeps its quotes, so the text around it (JSON, a shell string) still reads the same; an unterminated
    // one keeps only its opening quote (TOKEN="***), which masks to itself again.
    const token = text.slice(start, stop);
    const quote = start === end && (token[0] === '"' || token[0] === "'") ? token[0] : "";
    const closed = quote && token.length > 1 && token.endsWith(quote) ? quote : "";
    out += text.slice(last, start) + quote + MASK + closed;
    last = stop;
    ASSIGNMENT.lastIndex = last;
  }
  return out + text.slice(last);
}

/** The text with every secret-shaped substring masked. */
export function maskSecrets(text: string): string {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of TOKEN_RULES) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return maskAssignments(out);
}

/** Past the cut, so a secret that straddles it is still whole when masked and never stored half-visible. */
const CUT_MARGIN = 1024;

/** Masked text at most `max` characters long (plus `ellipsis` when cut). Only `max` + a margin is ever scanned, whatever
 * an agent sends, and the cut is made after masking, so it can never leave a fragment of a secret that no longer looks
 * like one. Use this, never slice-then-mask, wherever agent text is shortened. */
export function maskAndCap(text: string, max: number, ellipsis = "…"): string {
  const masked = maskSecrets(text.slice(0, max + CUT_MARGIN));
  return masked.length > max ? `${masked.slice(0, max)}${ellipsis}` : masked;
}

/** Every string inside a JSON-like value masked (keys are left as they are). */
export function maskDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, depth + 1)])) as T;
}

/** An event row for output, its JSON payload masked. The stored row is never rewritten: events are hash-chained. */
export function maskEventRow<T extends { payload: string }>(row: T): T {
  let payload: string;
  try {
    payload = JSON.stringify(maskDeep(JSON.parse(row.payload)));
  } catch {
    payload = maskSecrets(row.payload);
  }
  return payload === row.payload ? row : { ...row, payload };
}

/** Which masking policy this build applies: a digest of the masker's actual rules and code (every token rule's pattern,
 * flags and replacement, the assignment/value/authorization patterns, and the functions that apply them), so it changes
 * whenever masking semantics can, with nothing to bump by hand. Stored beside text indexed for search (tasks.search_text,
 * migration 54): text built under another version is never searched until it is rebuilt under this one. A change that
 * only reformats this module's compiled code changes it too, which costs one rebuild and nothing else. */
export const MASKING_VERSION: string = createHash("sha256")
  .update(JSON.stringify([
    MASK,
    TOKEN_RULES.map(([pattern, replacement]) => [pattern.source, pattern.flags, typeof replacement === "string" ? replacement : replacement.toString()]),
    [ASSIGNMENT, VALUE, AUTH_SCHEME, AUTH_CREDENTIAL].map((pattern) => [pattern.source, pattern.flags]),
    [isAuthorizationName, isSecretName, maskAssignments, maskSecrets].map((fn) => fn.toString()),
  ]))
  .digest("hex")
  .slice(0, 16);
