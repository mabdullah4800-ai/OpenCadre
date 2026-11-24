import { db, newId } from "./db.js";
import { log } from "./log.js";
import { maskAndCap } from "./secrets.js";
import { createRateLimiter } from "./ratelimit.js";
import { encryptPushPayload, vapidAuthorization, vapidKeysFromEnv, type VapidKeys } from "./web-push.js";
import { postWebhook, privateTargetsAllowed } from "./webhook-guard.js";

/** Phone approvals (reliability sprint R4). A person turns on notifications in the console, on their phone or
 * desktop; when an agent asks for a clearance, the people who can decide it get a Web Push notification that
 * opens the approval. The message is end-to-end encrypted to the device (src/web-push.ts), so the browser's
 * push service carries it but can't read the command. Disabled until the VAPID keys are set. */

export const MAX_DEVICES_PER_PERSON = 10;
const ACTION_CHARS = 140;
/** Push services hold an undelivered notification this long. An approval request expires in minutes. */
const TTL_SECONDS = 600;
/** An agent stuck in a loop of clearance requests must not bury a phone. Past this, requests still reach the
 * approver's inbox and the console, but phones stay quiet until the minute is up. */
export const APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN = Number(process.env.OPENCADRE_APPROVAL_PUSHES_PER_MIN) || 12;
const approvalPushLimiter = createRateLimiter({ limit: APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN, windowMs: 60_000 });

/** The hub POSTs to endpoints a browser gave it, so they are limited to the real push services
 * (on top of the webhook guard's public-address rule). Lifted only in local development and tests. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function pushConfig(env = process.env): { enabled: boolean; publicKey: string | null } {
  const keys = vapidKeysFromEnv(env);
  return { enabled: Boolean(keys), publicKey: keys?.publicKey ?? null };
}

export type SubscriptionInput = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null; deviceLabel?: unknown };

export function validateSubscription(input: SubscriptionInput): { ok: true; endpoint: string; p256dh: string; auth: string; deviceLabel: string | null } | { ok: false; error: string } {
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh : "";
  const auth = typeof input.keys?.auth === "string" ? input.keys.auth : "";
  if (!endpoint || endpoint.length > 2048) return { ok: false, error: "endpoint is required" };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: "endpoint is not a valid URL" };
  }
  if (!privateTargetsAllowed()) {
    if (url.protocol !== "https:") return { ok: false, error: "endpoint must use https" };
    if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return { ok: false, error: "endpoint isn't a known browser push service" };
  }
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
  const p256 = b64.test(p256dh) ? Buffer.from(p256dh, "base64url") : Buffer.alloc(0);
  const secret = b64.test(auth) ? Buffer.from(auth, "base64url") : Buffer.alloc(0);
  if (p256.length !== 65 || p256[0] !== 0x04) return { ok: false, error: "keys.p256dh must be the subscription's P-256 public key" };
  if (secret.length !== 16) return { ok: false, error: "keys.auth must be the subscription's 16-byte auth secret" };
  const label = typeof input.deviceLabel === "string" ? input.deviceLabel.trim().slice(0, 80) : "";
  return { ok: true, endpoint, p256dh: p256.toString("base64url"), auth: secret.toString("base64url"), deviceLabel: label || null };
}

/** Saves a device for a person. The same endpoint again updates it (and moves it to this person if another
 * account used that browser). Beyond MAX_DEVICES_PER_PERSON, the oldest device is dropped. */
export function saveSubscription(personId: string, input: SubscriptionInput): { ok: true; id: string } | { ok: false; error: string } {
  const valid = validateSubscription(input);
  if (!valid.ok) return valid;
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?`).get(valid.endpoint) as { id: string } | undefined;
    const rowId = existing?.id ?? newId();
    db.prepare(
      `INSERT INTO push_subscriptions (id, person_id, endpoint, p256dh, auth, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth,
         device_label = excluded.device_label, created_at = excluded.created_at, failure_count = 0, last_failure_at = NULL`,
    ).run(rowId, personId, valid.endpoint, valid.p256dh, valid.auth, valid.deviceLabel, now);
    db.prepare(
      `DELETE FROM push_subscriptions WHERE person_id = ? AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE person_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(personId, personId, MAX_DEVICES_PER_PERSON);
    return rowId;
  })();
  return { ok: true, id };
}

/** Removes one of the caller's own devices. Another person's endpoint is left alone (and reported as not found). */
export function deleteSubscription(personId: string, endpoint: unknown): boolean {
  if (typeof endpoint !== "string") return false;
  return db.prepare(`DELETE FROM push_subscriptions WHERE person_id = ? AND endpoint = ?`).run(personId, endpoint).changes > 0;
}

export function listDevices(personId: string) {
  return (db.prepare(
    `SELECT id, endpoint, device_label, created_at, last_success_at, last_failure_at, failure_count
     FROM push_subscriptions WHERE person_id = ? ORDER BY created_at DESC`,
  ).all(personId) as Array<{ id: string; endpoint: string; device_label: string | null; created_at: string; last_success_at: string | null; last_failure_at: string | null; failure_count: number }>)
    .map((d) => ({
      id: d.id,
      // service is for display; endpoint lets the console recognise the browser it is running in.
      service: new URL(d.endpoint).hostname,
      endpoint: d.endpoint,
      deviceLabel: d.device_label,
      createdAt: d.created_at,
      lastSuccessAt: d.last_success_at,
      lastFailureAt: d.last_failure_at,
      failing: d.failure_count > 0,
    }));
}

export interface PushMessage {
  type: "approval" | "test";
  title: string;
  body: string;
  /** Console path the notification opens. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  workspaceId?: string;
  approvalId?: string;
  risk?: string;
}

type SubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendOne(sub: SubscriptionRow, message: PushMessage, keys: VapidKeys): Promise<"sent" | "gone" | "failed"> {
  let status: number;
  try {
    const body = encryptPushPayload(Buffer.from(JSON.stringify(message)), { p256dh: sub.p256dh, auth: sub.auth });
    status = await postWebhook(sub.endpoint, {
      authorization: vapidAuthorization(sub.endpoint, keys),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(TTL_SECONDS),
      urgency: "high",
    }, body, 10_000);
  } catch (err) {
    status = 0;
    log.warn("push send failed", { service: safeHost(sub.endpoint), error: err });
  }
  if (status >= 200 && status < 300) {
    db.prepare(`UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?`).run(new Date().toISOString(), sub.id);
    return "sent";
  }
  // 404/410: the browser unsubscribed or the subscription expired. It will never work again.
  if (status === 404 || status === 410) {
    db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
    return "gone";
  }
  if (status) log.warn("push service refused a notification", { service: safeHost(sub.endpoint), status });
  db.prepare(`UPDATE push_subscriptions SET last_failure_at = ?, failure_count = failure_count + 1 WHERE id = ?`).run(new Date().toISOString(), sub.id);
  return "failed";
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
}

export async function pushToPeople(personIds: string[], message: PushMessage, env = process.env): Promise<{ sent: number; gone: number; failed: number }> {
  const result = { sent: 0, gone: 0, failed: 0 };
  const keys = vapidKeysFromEnv(env);
  if (!keys || personIds.length === 0) return result;
  const unique = [...new Set(personIds)];
  const subs = db.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE person_id IN (${unique.map(() => "?").join(",")})`,
  ).all(...unique) as SubscriptionRow[];
  const outcomes = await Promise.all(subs.map((s) => sendOne(s, message, keys)));
  for (const o of outcomes) result[o]++;
  return result;
}

/** Who can decide a clearance: the person behind the named approver when it's a member's own agent,
 * otherwise the workspace's owners and admins (an "Operator" key, or no approver named). */
export function approvalRecipients(orgId: string, approverAgentId: string | null): string[] {
  if (approverAgentId) {
    const member = db.prepare(`SELECT person_id FROM workspace_members WHERE org_id = ? AND agent_id = ?`).get(orgId, approverAgentId) as { person_id: string } | undefined;
    if (member) return [member.person_id];
  }
  return db.prepare(`SELECT person_id FROM workspace_members WHERE org_id = ? AND role IN ('owner', 'admin') ORDER BY created_at`)
    .pluck().all(orgId) as string[];
}

type PushApproval = { id: string; org_id: string; action: string; risk: string; requested_by_agent_name: string; project_name?: string | null };

export function approvalPushMessage(approval: PushApproval, workspaceName: string): PushMessage {
  // The action is stored masked; masking again before the cut keeps the notification safe whatever reaches it.
  const action = maskAndCap(approval.action, ACTION_CHARS);
  return {
    type: "approval",
    title: `Approval needed · ${workspaceName}`,
    // The project is named, so a person deciding for several projects knows which fleet is asking.
    body: `${approval.requested_by_agent_name}${approval.project_name ? ` in ${approval.project_name}` : ""} wants to run: ${action}`,
    url: `/app/?workspace=${encodeURIComponent(approval.org_id)}#approval-${encodeURIComponent(approval.id)}`,
    tag: `approval-${approval.id}`,
    workspaceId: approval.org_id,
    approvalId: approval.id,
    risk: approval.risk,
  };
}

/** Called after a clearance is requested and left pending. Never throws: a push problem must not fail the request. */
export async function notifyApprovalByPush(
  approval: PushApproval,
  approverAgentId: string | null,
): Promise<void> {
  try {
    if (!pushConfig().enabled) return;
    if (!approvalPushLimiter.check(`org:${approval.org_id}`).ok) {
      log.warn("approval push skipped: workspace over its per-minute limit", { approvalId: approval.id, limit: APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN });
      return;
    }
    const org = db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(approval.org_id) as { name: string } | undefined;
    const outcome = await pushToPeople(approvalRecipients(approval.org_id, approverAgentId), approvalPushMessage(approval, org?.name ?? "OpenCadre"));
    if (outcome.sent || outcome.failed || outcome.gone) log.info("approval push", { approvalId: approval.id, ...outcome });
  } catch (err) {
    log.error("approval push failed", { approvalId: approval.id, error: err });
  }
}
