/** Outbound email, behind ONE small seam (docs/ops/SMTP-PROVIDER.md §5).
 *
 * Two states, chosen by the environment at startup and nothing else:
 *
 *   - Unconfigured (the default): `NoopSender`. Every send is a logged no-op that resolves
 *     `{ ok: false, reason: "unconfigured" }`. It never throws and never touches the network, so a hub
 *     with no provider behaves exactly as it did before this module existed.
 *   - `OPENCADRE_RESEND_API_KEY` and `OPENCADRE_MAIL_FROM` both set: `ResendSender`, which POSTs to
 *     Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email) with `fetch` and a
 *     timeout. No SDK: a plain HTTPS call is the whole integration, and a native dependency would not
 *     install on every box this hub is built on.
 *
 * A send NEVER throws. Every failure comes back as a value naming what happened, so a caller (a request
 * handler, a webhook, a sweep) cannot be broken by the mail provider, and the ledger in src/emails.ts
 * can decide whether to try again. The API key is sent in the Authorization header and appears nowhere
 * else: not in a return value, not in an error, not in a log line.
 */
import { log } from "./log.js";

export const RESEND_API_KEY_VAR = "OPENCADRE_RESEND_API_KEY";
export const MAIL_FROM_VAR = "OPENCADRE_MAIL_FROM";
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Long enough for a slow provider, short enough that a sweep never hangs on one message. */
export const SEND_TIMEOUT_MS = 10_000;

export interface OutboundEmail {
  /** Overrides the sender's configured From. The ledger passes the From it froze at the first attempt, so a retry
   * after the operator changed OPENCADRE_MAIL_FROM still sends the identical body under the same idempotency key. */
  from?: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Sent as Resend's `Idempotency-Key` header: a retry with the same key within 24 hours is answered
   * with the first result instead of a second email. At most 256 characters. */
  idempotencyKey?: string;
}

export type SendOutcome =
  | { ok: true; provider: string; messageId: string }
  /** No provider configured. Nothing was attempted. */
  | { ok: false; reason: "unconfigured" }
  /** HTTP 429. `code` is Resend's error name (daily_quota_exceeded, monthly_quota_exceeded,
   * rate_limit_exceeded) when it gave one; `retryAfterMs` is when trying again could succeed. */
  | { ok: false; reason: "rate_limited"; code: string | null; retryAfterMs: number; detail: string }
  /** The provider refused this message for good (a 4xx other than 429): retrying the same request
   * cannot succeed, so nothing should. */
  | { ok: false; reason: "rejected"; status: number; code: string | null; detail: string }
  /** A 5xx, a timeout, a network error, or Resend's 409 `concurrent_idempotent_requests` (another request with
   * this key is still in flight): the message may or may not have been accepted. A retry of the IDENTICAL request
   * under the same idempotency key is safe within 24 hours. */
  | { ok: false; reason: "failed"; status: number | null; detail: string };

export interface EmailSender {
  send(message: OutboundEmail): Promise<SendOutcome>;
  /** The From this sender uses when a message names none; null when it sends nothing. */
  readonly from: string | null;
  isConfigured(): boolean;
  /** For logs and the startup line. Never a credential. */
  describe(): string;
}

/** The default: sends nothing, says so, never throws. */
export class NoopSender implements EmailSender {
  readonly from = null;
  async send(message: OutboundEmail): Promise<SendOutcome> {
    log.debug("email not sent: no mail provider configured", { subject: message.subject });
    return { ok: false, reason: "unconfigured" };
  }
  isConfigured(): boolean { return false; }
  describe(): string { return `none (set ${RESEND_API_KEY_VAR} and ${MAIL_FROM_VAR} to send email)`; }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
/** A transport failure as its class and code only, e.g. "network error: TypeError (ECONNRESET)". */
export function describeTransportError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
  if (name === "TimeoutError" || name === "AbortError") return `no answer within ${timeoutMs} ms`;
  const code = [e?.code, e?.cause?.code].find((c): c is string => typeof c === "string" && SAFE_CODE.test(c));
  return `network error: ${name}${code ? ` (${code})` : ""}`;
}

/** Seconds from a `retry-after` header, else the fallback. Resend sends it with a rate-limit 429. */
function retryAfterMs(response: Response, fallbackMs: number): number {
  const raw = Number(response.headers.get("retry-after"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw * 1000, 86_400_000) : fallbackMs;
}

/** Milliseconds until the next UTC midnight, when the free tier's daily quota resets (Resend: "a UTC
 * calendar day ... resets at midnight UTC, not a rolling 24-hour window"). */
export function msUntilUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}

export class ResendSender implements EmailSender {
  constructor(
    private readonly config: { apiKey: string; from: string },
    private readonly post: Fetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = SEND_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get from(): string { return this.config.from; }
  isConfigured(): boolean { return Boolean(this.config.apiKey && this.config.from); }

  /** Belt and braces: any text this class returns (and the ledger may log or store) has the key's value cut out,
   * even text that came from the provider. The primary rule is that transport errors are never copied at all. */
  private scrub(text: string): string {
    return this.config.apiKey ? text.split(this.config.apiKey).join("[redacted]") : text;
  }
  describe(): string { return `Resend API, from ${this.config.from}`; }

  async send(message: OutboundEmail): Promise<SendOutcome> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      "content-type": "application/json",
    };
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey.slice(0, 256);
    let response: Response;
    try {
      response = await this.post(RESEND_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: message.from ?? this.config.from, to: message.to, subject: message.subject, html: message.html, text: message.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // NEVER the error's message: a transport error (fetch, undici, a proxy agent) can quote the request, headers
      // included, and so the key. Only its class and a short system code (ECONNRESET, UND_ERR_...) are kept, and
      // those are scrubbed too.
      return { ok: false, reason: "failed", status: null, detail: this.scrub(describeTransportError(err, this.timeoutMs)) };
    }
    const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown; message?: unknown } | null;
    if (response.ok) {
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (id) return { ok: true, provider: "resend", messageId: id };
      return { ok: false, reason: "failed", status: response.status, detail: "the provider answered success with no message id" };
    }
    const code = typeof body?.name === "string" ? this.scrub(body.name.slice(0, 64)) : null;
    const detail = this.scrub(typeof body?.message === "string" ? body.message.slice(0, 300) : `HTTP ${response.status}`);
    // Resend: "There is another request in progress with the same idempotency key. Try the request again later."
    // Retryable, unlike `invalid_idempotent_request` (same key, different body), which stays a permanent rejection.
    if (response.status === 409 && code === "concurrent_idempotent_requests") return { ok: false, reason: "failed", status: 409, detail };
    if (response.status === 429) {
      const fallback = code === "daily_quota_exceeded" ? msUntilUtcMidnight(this.now())
        : code === "monthly_quota_exceeded" ? 24 * 3_600_000
        : 60_000;
      // A quota 429 is not cleared by waiting a second, whatever a header says: wait for the reset.
      const wait = code === "daily_quota_exceeded" || code === "monthly_quota_exceeded" ? fallback : retryAfterMs(response, fallback);
      return { ok: false, reason: "rate_limited", code, retryAfterMs: wait, detail };
    }
    if (response.status >= 400 && response.status < 500) return { ok: false, reason: "rejected", status: response.status, code, detail };
    return { ok: false, reason: "failed", status: response.status, detail };
  }
}

/** Both variables, or no provider at all. One set without the other is logged as a misconfiguration
 * (by name only) and treated as unconfigured, so a half-finished setup never sends from a guessed address. */
export function senderFromEnv(env: Record<string, string | undefined> = process.env): EmailSender {
  const apiKey = env[RESEND_API_KEY_VAR]?.trim() ?? "";
  const from = env[MAIL_FROM_VAR]?.trim() ?? "";
  if (apiKey && from) return new ResendSender({ apiKey, from });
  if (apiKey || from) {
    log.warn("email is not configured: set both variables or neither", { set: apiKey ? RESEND_API_KEY_VAR : MAIL_FROM_VAR, missing: apiKey ? MAIL_FROM_VAR : RESEND_API_KEY_VAR });
  }
  return new NoopSender();
}

let sender: EmailSender = senderFromEnv();

export function emailSender(): EmailSender {
  return sender;
}

/** Swaps the sender (tests, or a future provider). */
export function useEmailSender(next: EmailSender): void {
  sender = next;
}

export function emailIsConfigured(): boolean {
  return sender.isConfigured();
}
