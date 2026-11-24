import { bumpRefusal, connectorHealth, mergeConnectorReports, validateConnectorReport, type RefusalReason } from "./connector-health.js";
import { currentCliPackage } from "./cli-package.js";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { db, newId } from "./db.js";
import { hashKey, type AuthedAgent } from "./auth.js";
import { emitEvent } from "./events.js";
import { AgentNameError, checkAgentName, isOnline } from "./service.js";
import { addressHeld, checkProfileNameShape, describeClash, LEGACY_SESSION_NAME, nameClash, nameKey, ProfileNameError, profileAddress, randomWord } from "./agent-names.js";
import { parseStampOrNull, toSqliteTime } from "./timestamps.js";
import { CONNECT_CLIENTS, type ConnectClient } from "./connect.js";
import { disconnectAgent } from "./live.js";
import { endHeldRequests } from "./revocation.js";
import { PAUSED_ERROR } from "./kill-switch.js";
import { agentLimitRefusal, readOnlyRefusal, type PlanLimitRefusal, type ReadOnlyRefusal } from "./billing.js";
import { PROJECT_NAME_HEADER, PROJECT_NOT_ENABLED, projectKeyOf, projectNameFor, sanitizeProject, setProjectEnabled, isProjectEnabled, enabledProjectKeys, type ProjectView } from "./projects.js";
import { resolveIncomingProjectKey, resolveProjectKey } from "./project-stamps.js";

export { sanitizeProject };

/** Per-session identity (docs/design/SESSION_MODEL.md): computer -> tools -> project -> sessions.
 *
 * A device is one computer (older rows were one tool on one computer; their `client` is kept, informational). An
 * operator mints it with a one-time `ocd_` code, and the CLI trades that code for a `dev_` credential that every tool
 * set up on that computer shares. Only SHA-256 hashes of both are stored. A device credential is never an identity by
 * itself: every request also names its tool session (X-OpenCadre-Session), its tool (X-OpenCadre-Client) and its
 * project (X-OpenCadre-Project), and the hub resolves that to the session's own agent, creating it on first sight, but
 * only in a project the workspace has enabled (src/projects.ts). The lookup is always scoped to the credential's own
 * device and workspace, so a device can never act as another device's session, as a named agent, or as an operator. */

const CODE_TTL_MS = 15 * 60 * 1000;
// Same alphabet as connect codes: 32 symbols (5 unbiased bits each), no 0/O or 1/I.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_CHARS = 10;
const CREDENTIAL_PATTERN = /^dev_[0-9a-f]{48}$/;

export const SESSION_HEADER = "x-opencadre-session";
export const HOST_SESSION_HEADER = "x-opencadre-host-session";
export const CLIENT_HEADER = "x-opencadre-client";
export const PROJECT_HEADER = "x-opencadre-project";
export { PROJECT_NAME_HEADER };
/** "1" (or "true"): resolve an existing live session only, never create or revive one. Hooks send it, so a process that
 * has no MCP proxy (a desktop helper process, say) can't bring a session agent into being. */
export const RESOLVE_ONLY_HEADER = "x-opencadre-resolve-only";
/** "1" (or "true"): a RESOLVE-ONLY caller may adopt the one live session this device already has in this project,
 * when a chat's tool hands it no id its own MCP child can see (Codex). It applies only to the resolve-only refusal,
 * so a creating caller is untouched, and it is opt-in per client (scripts/opencadre-clients.mjs `sessionIdSource`)
 * precisely so no client that knows its own seat can ever wear another live chat's identity. Two or more live
 * candidates are refused LOUDLY rather than guessed between. */
export const ADOPT_LIVE_HEADER = "x-opencadre-adopt-live";
/** Set by a proxy that has served a `tools/call` — proof a chat is behind the session. Promotes
 * `agents.liveness` from 'process' to 'chat'. The hub cannot infer this itself: /mcp receives headers
 * and never the JSON-RPC method. Mirrored in scripts/opencadre-config.mjs. */
export const CHAT_PROVEN_HEADER = "x-opencadre-chat-proven";
export const NO_SESSION_ERROR = "no OpenCadre session for this chat yet";
export const AMBIGUOUS_SESSION_ERROR = "more than one live OpenCadre session in this project; not guessing which one is this chat";
export const REMOVED_SESSION_ERROR = "an operator removed this session; start a new chat to connect again";
/** Only ever used by deviceAuthError's read_only case, which deviceRefusalResponse does not reach: the real refusal
 * body is built by src/billing.ts, and this is the sentence a reader sees if that intercept is ever removed. */
export const READ_ONLY_ERROR = "this workspace is read-only: its plan lapsed, and writes resume when it is put back on one";

type Actor = { id: string; name: string };

export class DeviceError extends Error {
  constructor(message: string, readonly status: 400) {
    super(message);
  }
}

/** Anything shaped like a device credential goes down the device path, so it can never fall through to agent-key auth. */
export function isDeviceCredential(bearer: string | undefined): bearer is string {
  return typeof bearer === "string" && bearer.startsWith("dev_");
}

export function looksLikeDeviceCode(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase().startsWith("ocd_");
}

function generateDeviceCode(): string {
  return `ocd_${Array.from(randomBytes(CODE_CHARS), (b) => CODE_ALPHABET[b & 31]).join("")}`;
}

function normalizeDeviceCode(raw: unknown): string | null {
  const m = typeof raw === "string" ? raw.trim().match(/^ocd_([a-z0-9]{10})$/i) : null;
  return m ? `ocd_${m[1].toUpperCase()}` : null;
}

// SQLite datetime('now') format, so JS-written times compare and parse like the rest of the agents
// table. Both conversions now come from src/timestamps.ts, which is the one definition of each.
const sqliteTime = toSqliteTime;
const parseTime = (value: string | null): number | null => {
  const ms = parseStampOrNull(value);
  return ms !== null && Number.isFinite(ms) ? ms : null;
};

export function sessionTtlMs(): number {
  const hours = Number(process.env.OPENCADRE_SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

/** A device credential can open sessions, so a leaked one could otherwise create agents without bound. */
export function maxSessionsPerDevice(): number {
  const n = Number(process.env.OPENCADRE_MAX_SESSIONS_PER_DEVICE);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

// --- Devices ----------------------------------------------------------------------------------

function checkDeviceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new DeviceError("name is required", 400);
  if (name.length > 80) throw new DeviceError("name must be at most 80 characters", 400);
  if (/\p{Cc}/u.test(name)) throw new DeviceError("name must not contain control characters", 400);
  return name;
}

/** POST /v1/org/devices. The row exists before redemption so the console can show "waiting" for it. */
export function createDevice(
  orgId: string,
  creator: Actor,
  rawName: unknown,
  rawClient: unknown,
): { deviceId: string; code: string; expiresAt: string; client: ConnectClient } {
  const name = checkDeviceName(rawName);
  const client = rawClient === undefined || rawClient === null ? "auto" : rawClient;
  if (!(CONNECT_CLIENTS as readonly unknown[]).includes(client)) {
    throw new DeviceError(`client must be one of ${CONNECT_CLIENTS.join(", ")}`, 400);
  }
  const deviceId = newId();
  const code = generateDeviceCode();
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO devices (id, org_id, name, client, code_hash, code_expires_at, created_by_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, orgId, name, client, hashKey(code), expiresAt, creator.id, new Date(now).toISOString());
    emitEvent({ orgId, type: "device.created", actor: creator, subjectType: "device", subjectId: deviceId, payload: { name, client } });
  })();
  return { deviceId, code, expiresAt, client: client as ConnectClient };
}

export type DeviceRedeemResult =
  | { ok: true; merged: false; deviceCredential: string; deviceId: string; computerName: string; client: ConnectClient; orgName: string }
  | { ok: true; merged: true; deviceCredential: null; deviceId: string; computerName: string; client: ConnectClient; orgName: string }
  | { ok: false; status: 404 | 410 | 402 | 423; error: string };

/** POST /v1/connect/redeem with an ocd_ code: single use, looked up by hash only.
 *
 * Reconnecting updates the same computer. When the caller also proves it already is a computer, with `currentCredential`
 * (a valid, unrevoked device credential in the SAME workspace as the code), the code's fresh row is marked merged into
 * that computer and never gets a credential; the computer's own credential stays as it is. Any other credential (unknown,
 * revoked, malformed, or from another workspace) is ignored, and the code makes a new computer as before. Either way the
 * code is spent. The credential is only ever compared by hash, and never logged or returned. */
export function redeemDeviceCode(raw: unknown, currentCredential?: unknown): DeviceRedeemResult {
  const code = normalizeDeviceCode(raw);
  const notFound = { ok: false, status: 404, error: "unknown connect code" } as const;
  if (!code) return notFound;
  return db.transaction((): DeviceRedeemResult => {
    const row = db.prepare(
      `SELECT d.id, d.org_id, d.name, d.client, d.code_expires_at, d.code_redeemed_at, d.revoked_at, o.name AS org_name, o.paused_at
       FROM devices d JOIN organizations o ON o.id = d.org_id WHERE d.code_hash = ?`,
    ).get(hashKey(code)) as
      | { id: string; org_id: string; name: string; client: ConnectClient; code_expires_at: string; code_redeemed_at: string | null; revoked_at: string | null; org_name: string; paused_at: string | null }
      | undefined;
    if (!row) return notFound;
    if (row.code_redeemed_at) return { ok: false, status: 410, error: "this connect code was already used; generate a new command in the console" };
    if (row.revoked_at) return { ok: false, status: 410, error: "this device was removed; generate a new command in the console" };
    if (Date.parse(row.code_expires_at) <= Date.now()) return { ok: false, status: 410, error: "this connect code expired; generate a new command in the console" };
    // The code stays unspent, so the same command works once an operator resumes (if still unexpired).
    if (row.paused_at) return { ok: false, status: 423, error: "this workspace is paused by an operator; ask them to resume it, then run the same command again" };
    // Connecting a computer is how an agent gets IN -- this is the Claude Code / Codex path -- so a
    // lapsed workspace refuses it here too. Closing the agent-key and MCP paths while leaving this one
    // open would ship a read-only workspace that isn't read-only on the path the product is sold
    // around. The code stays unspent, exactly as with pause: the same command works once a plan is back.
    const billingRefused = readOnlyRefusal(row.org_id, "POST");
    if (billingRefused) return { ok: false, status: 402, error: billingRefused.body.error };
    const now = new Date().toISOString();
    const existing = sameOrgComputer(row.org_id, currentCredential);
    if (existing && existing.id !== row.id) {
      db.prepare(`UPDATE devices SET merged_into_device_id = ?, code_redeemed_at = ? WHERE id = ? AND org_id = ?`).run(existing.id, now, row.id, row.org_id);
      // An older computer was minted for one tool, and a device's own tool names its sessions. A code for a different
      // tool (or for every tool) means it now runs more than one, so it becomes a computer that keeps the tool it had.
      if (existing.client !== "auto" && existing.client !== row.client) {
        db.prepare(`UPDATE devices SET client = 'auto', tools = ? WHERE id = ?`).run(JSON.stringify(deviceTools(existing.tools, existing.client, null)), existing.id);
      }
      emitEvent({
        orgId: row.org_id, type: "device.reconnected", subjectType: "device", subjectId: existing.id,
        payload: { deviceId: existing.id, name: existing.name, mergedDeviceId: row.id },
      });
      return { ok: true, merged: true, deviceCredential: null, deviceId: existing.id, computerName: existing.name, client: row.client, orgName: row.org_name };
    }
    const credential = `dev_${randomBytes(24).toString("hex")}`;
    db.prepare(`UPDATE devices SET credential_hash = ?, code_redeemed_at = ? WHERE id = ?`).run(hashKey(credential), now, row.id);
    return { ok: true, merged: false, deviceCredential: credential, deviceId: row.id, computerName: row.name, client: row.client, orgName: row.org_name };
  })();
}

/** The live computer behind a credential, only if it belongs to `orgId`. The workspace is part of the lookup itself, so a
 * credential from another workspace finds nothing, exactly like an unknown one. */
function sameOrgComputer(orgId: string, credential: unknown): { id: string; name: string; client: string; tools: string | null } | null {
  if (typeof credential !== "string" || !CREDENTIAL_PATTERN.test(credential)) return null;
  const found = db.prepare(
    `SELECT id, name, client, tools FROM devices WHERE credential_hash = ? AND org_id = ? AND revoked_at IS NULL AND merged_into_device_id IS NULL`,
  ).get(hashKey(credential), orgId) as { id: string; name: string; client: string; tools: string | null } | undefined;
  return found ?? null;
}

export type DeviceStatus = "waiting" | "expired" | "connected" | "revoked" | "merged";

export interface DeviceView {
  deviceId: string;
  name: string;
  client: string;
  /** The tools this computer runs: the ones its connect runs set up, plus any its sessions came from. */
  tools: string[];
  status: DeviceStatus;
  /** Set when status is "merged": the computer this row's code reconnected. Its own sessionCount is always 0. */
  mergedIntoDeviceId: string | null;
  sessionCount: number;
  createdAt: string;
  createdByAgentId: string;
  codeExpiresAt: string;
  redeemedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  connector: ReturnType<typeof connectorHealth>;
}

/** GET /v1/org/devices. Named columns only, so no credential hash can ever reach the response. A merged row stays listed (the
 * console polls for the row it created) as status "merged", but it is never a computer of its own: it counts no sessions. */
export function listDevices(orgId: string, nowMs = Date.now()): DeviceView[] {
  const rows = db.prepare(
    `SELECT d.id, d.name, d.client, d.tools, d.created_at, d.created_by_agent_id, d.code_expires_at, d.code_redeemed_at, d.last_seen_at, d.revoked_at, d.merged_into_device_id, d.connector_reports, d.connector_refusals,
       (SELECT COUNT(*) FROM agents a WHERE a.org_id = d.org_id AND a.device_id = d.id AND a.kind = 'session' AND a.ended_at IS NULL AND d.merged_into_device_id IS NULL) AS session_count,
       (SELECT group_concat(DISTINCT a.client) FROM agents a WHERE a.org_id = d.org_id AND a.device_id = d.id AND a.kind = 'session' AND a.client IS NOT NULL) AS session_clients
     FROM devices d WHERE d.org_id = ? ORDER BY d.created_at, d.id`,
  ).all(orgId) as Array<{
    id: string; name: string; client: string; tools: string | null; created_at: string; created_by_agent_id: string; code_expires_at: string;
    code_redeemed_at: string | null; last_seen_at: string | null; revoked_at: string | null; merged_into_device_id: string | null; session_count: number; session_clients: string | null; connector_reports: string; connector_refusals: string;
  }>;
  const pkg = currentCliPackage();
  const build = pkg?.build();
  const target = build?.ok ? build.build.helpers : null;
  const compat = pkg?.compat() ?? null;
  return rows.map((r) => ({
    connector: connectorHealth(r.connector_reports, target, nowMs, { lastSeenAt: r.last_seen_at, refusals: r.connector_refusals, compat }),
    deviceId: r.id,
    name: r.name,
    client: r.client,
    tools: r.merged_into_device_id ? [] : deviceTools(r.tools, r.client, r.session_clients),
    status: r.merged_into_device_id ? "merged" : r.revoked_at ? "revoked" : r.code_redeemed_at ? "connected" : Date.parse(r.code_expires_at) <= nowMs ? "expired" : "waiting",
    mergedIntoDeviceId: r.merged_into_device_id,
    sessionCount: r.session_count,
    createdAt: r.created_at,
    createdByAgentId: r.created_by_agent_id,
    codeExpiresAt: r.code_expires_at,
    redeemedAt: r.code_redeemed_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  }));
}

/** DELETE /v1/org/devices/:deviceId. Null when the device isn't in this workspace. The credential stops working at
 * once (its hash is cleared too), the device's sessions end, and everything they hold open is cut off. */
export function revokeDevice(orgId: string, actor: Actor, deviceId: string): { deviceId: string; alreadyRevoked: boolean; endedSessions: number } | null {
  const outcome = db.transaction(() => {
    const row = db.prepare(`SELECT id, name, revoked_at FROM devices WHERE id = ? AND org_id = ?`).get(deviceId, orgId) as
      | { id: string; name: string; revoked_at: string | null }
      | undefined;
    if (!row) return null;
    const sessions = db.prepare(`SELECT id, name, ended_at FROM agents WHERE org_id = ? AND device_id = ? AND kind = 'session'`)
      .all(orgId, deviceId) as Array<{ id: string; name: string; ended_at: string | null }>;
    if (row.revoked_at) {
      db.prepare(`UPDATE devices SET connector_reports = '[]', connector_refusals = '{}' WHERE id = ?`).run(deviceId);
      return { alreadyRevoked: true, live: [] as typeof sessions, all: sessions };
    }
    const now = Date.now();
    db.prepare(`UPDATE devices SET revoked_at = ?, credential_hash = NULL, connector_reports = '[]', connector_refusals = '{}' WHERE id = ?`).run(new Date(now).toISOString(), deviceId);
    const live = sessions.filter((s) => !s.ended_at);
    const end = db.prepare(`UPDATE agents SET ended_at = ? WHERE id = ? AND org_id = ?`);
    for (const s of live) {
      end.run(sqliteTime(now), s.id, orgId);
      emitEvent({ orgId, type: "session.ended", actor, subjectType: "agent", subjectId: s.id, payload: { agentName: s.name, reason: "device_revoked", deviceId } });
    }
    emitEvent({ orgId, type: "device.revoked", actor, subjectType: "device", subjectId: deviceId, payload: { name: row.name, endedSessions: live.length } });
    return { alreadyRevoked: false, live, all: sessions };
  })();
  if (!outcome) return null;
  // Every session the device ever had, ended or not: a request an ended session still holds must not outlive the device.
  for (const s of outcome.all) {
    disconnectAgent(s.id, "device removed by an operator");
    endHeldRequests(s.id, 401, "This device was removed by an operator.");
  }
  return { deviceId, alreadyRevoked: outcome.alreadyRevoked, endedSessions: outcome.live.length };
}

// --- Session naming ---------------------------------------------------------------------------

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "ClaudeCode",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
  gemini: "Gemini",
  // DeepSeek Harness. Without this entry the label falls through to "Agent", which is how a DSH chat
  // came to be named `Agent-OpenCadre-e4f2` instead of `DSH-OpenCadre-e4f2` — measured against the live
  // hub from inside a DSH session. The same map decides `sessionTool`, so its absence also recorded the
  // session with no tool at all, which kept DSH chats out of the computer's tool list.
  dsh: "DSH",
  // Same gap, found the same way (2026-09-23): a live OpenCode chat joined as `Agent-OpenCadre-efc1`, tool null.
  opencode: "OpenCode",
  // Qwen Code (a computer tool since 2026-09-24, docs/research/HARNESS-ADAPTERS.md §3): its sessions are `Qwen-…`.
  qwen: "Qwen",
  // Amp (a computer tool since 2026-09-24): one agent per Amp thread, `Amp-…`.
  amp: "Amp",
  // Goose (a computer tool since 2026-09-24): one agent per Goose session, `Goose-…`.
  goose: "Goose",
  // GitHub Copilot CLI (a computer tool since 2026-09-24): one agent per session, `Copilot-…`.
  copilot: "Copilot",
  // Devin CLI / Devin Local (a computer tool since 2026-09-24): one agent per Devin session, `Devin-…`.
  devin: "Devin",
  // Factory Droid (a computer tool since 2026-09-24): one agent per Droid session, `Droid-…`.
  droid: "Droid",
  // Crush (a computer tool since 2026-09-24): one agent per Crush session, `Crush-…`.
  crush: "Crush",
  // Mistral Vibe (a computer tool since 2026-09-24): one agent per Vibe session, `Vibe-…`.
  vibe: "Vibe",
  // Grok Build (a computer tool since 2026-09-24): one agent per Grok session, `Grok-…`.
  grok: "Grok",
  // Cline's CLI (a computer tool since 2026-09-24): one agent per Cline session, `Cline-…`.
  cline: "Cline",
  // Kilo Code's CLI (a computer tool since 2026-09-24): one agent per Kilo session, `Kilo-…`.
  kilo: "Kilo",
  // Windsurf (a computer tool since 2026-09-24, clearance only): a Cascade conversation that runs a risky command.
  windsurf: "Windsurf",
};

/** The tool ids a computer can run, in display order (CONNECT_CLIENTS without "auto"). */
export const TOOLS = CONNECT_CLIENTS.filter((c) => c !== "auto");

/** The device's own tool wins; the client header only names the tool for a device minted as "auto". */
export function clientLabel(deviceClient: string, headerClient?: string): string {
  return CLIENT_LABELS[deviceClient] ?? (headerClient ? CLIENT_LABELS[headerClient.toLowerCase()] : undefined) ?? "Agent";
}

/** The session's tool id, decided the same way as its label; null when neither names a known tool. */
export function sessionTool(deviceClient: string, headerClient?: string): string | null {
  if (CLIENT_LABELS[deviceClient]) return deviceClient;
  const fromHeader = headerClient?.toLowerCase();
  return fromHeader && CLIENT_LABELS[fromHeader] ? fromHeader : null;
}

/** The union of the stored tools, an old single-tool device's own client and its sessions' tools, in TOOLS order. */
function deviceTools(stored: string | null, client: string, sessionClients: string | null): string[] {
  const found = new Set<string>();
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) for (const t of parsed) if (typeof t === "string") found.add(t);
  } catch { /* an unreadable value lists nothing */ }
  if (client !== "auto") found.add(client);
  for (const t of (sessionClients ?? "").split(",")) found.add(t);
  return TOOLS.filter((t) => found.has(t));
}

/** A name for a session nobody has named yet: one pronounceable word ("Birch"), unique in the workspace, with no hex
 * suffix (sessions PR1). The client and project are on the row itself (client, project_name), not in the name. A taken
 * word (an agent's name now or before a rename, or a profile's name) is retried; then two words ("Birch Wren"); then a
 * word and a number. `word` is injectable in tests. */
export function buildSessionName(orgId: string, word: () => string = randomWord): string {
  const candidates = function* () {
    for (let i = 0; i < 20; i++) yield word();
    for (let i = 0; i < 20; i++) {
      const [a, b] = [word(), word()];
      if (a !== b) yield `${a} ${b}`;
    }
    for (let n = 2; n < 1000; n++) yield `${word()} ${n}`;
  };
  for (const candidate of candidates()) {
    try {
      return checkAgentName(orgId, candidate);
    } catch (err) {
      if (err instanceof AgentNameError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error("could not allocate a unique session name");
}

// --- Session resolution -----------------------------------------------------------------------

export interface SessionHints {
  toolSessionId: string;
  hostSessionId?: string;
  client?: string;
  /** The project key (X-OpenCadre-Project): a remote key, local:<folder>, or an old client's bare folder name. */
  project?: string;
  /** The project's display name (X-OpenCadre-Project-Name). Clients that send remote keys always send it too, so its
   * absence marks a client from before remote keys. */
  projectName?: string;
  /** The proxy has seen a `tools/call` for this session, so a chat is behind it. Promotes `liveness`
   * from 'process' to 'chat'. Only the proxy can assert this: /mcp sees headers, never the JSON-RPC
   * method. See migration 38 and src/timestamps.ts's sibling comment for the phantom measurement. */
  chatProven?: boolean;
  /** Find a live session agent only; never create or revive one. */
  resolveOnly?: boolean;
  /** A resolve-only caller that may take the one live session this device has in this project (ADOPT_LIVE_HEADER). */
  adoptLive?: boolean;
}

// Printable ASCII without spaces: every tool's session ids are UUID-like, and this keeps them out of log injection.
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;

function headerValue(headers: IncomingHttpHeaders | Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

/** Null when the tool session id is missing or malformed. A malformed host session id is refused too, rather than
 * silently ignored, since ignoring it would move the caller to a different seat. */
export function readSessionHints(headers: IncomingHttpHeaders | Record<string, unknown>): SessionHints | null {
  const toolSessionId = headerValue(headers, SESSION_HEADER);
  if (!toolSessionId || !SESSION_ID_PATTERN.test(toolSessionId)) return null;
  const hostSessionId = headerValue(headers, HOST_SESSION_HEADER);
  if (hostSessionId !== undefined && !SESSION_ID_PATTERN.test(hostSessionId)) return null;
  return {
    toolSessionId, hostSessionId, client: headerValue(headers, CLIENT_HEADER), project: headerValue(headers, PROJECT_HEADER),
    projectName: headerValue(headers, PROJECT_NAME_HEADER),
    resolveOnly: /^(1|true)$/i.test(headerValue(headers, RESOLVE_ONLY_HEADER) ?? ""),
    adoptLive: /^(1|true)$/i.test(headerValue(headers, ADOPT_LIVE_HEADER) ?? ""),
    chatProven: /^(1|true)$/i.test(headerValue(headers, CHAT_PROVEN_HEADER) ?? ""),
  };
}

export interface SessionDevice {
  id: string;
  orgId: string;
  client: string;
}

export type SessionResolution =
  | { ok: true; agentId: string; agentName: string; created: boolean }
  | { ok: false; reason: "too_many_sessions" | "no_session" | "removed" | "ambiguous_session" }
  /** The workspace is read-only, so no NEW session agent row may be created (src/billing.ts). Carries the whole billing
   * body, so a device client is refused in exactly the words every other surface refuses it in. */
  | { ok: false; reason: "read_only"; billing: ReadOnlyRefusal }
  /** The workspace is at its plan's live-agent limit, so no NEW session may start. A device client gets the whole
   * refusal body -- `code: "PLAN_LIMIT"`, the unit, the numbers and the remedy -- for the same reason read_only does:
   * one vocabulary for one refusal, whichever surface the caller came in through. Note this NEVER fires for an agent
   * that is already live: adoption returns before the gate, and revival is gated only because a revival IS a create. */
  | { ok: false; reason: "plan_limit"; limit: PlanLimitRefusal["body"] }
  | { ok: false; reason: "project_not_enabled"; project: string | null; legacyClient: boolean; resolveOnly: boolean };

/** A seat holds one agent per project the chat has worked in (PROJECT_ISOLATION.md §3.2). The first keeps the plain seat
 * id, so an older build (after a rollback) still finds it. Each further project's agent takes `<seat> <project key>`: the
 * unique (device_id, seat_id) index still converges concurrent first requests, and no client seat can collide with it,
 * since seat ids never contain a space. */
const projectSeatId = (seat: string, home: string) => `${seat} ${home}`;

type SeatRow = { id: string; name: string; ended_at: string | null; home_project: string | null; seat_id: string; removed_at: string | null; liveness: string | null };
/** Every agent of one chat on this device, removed ones included: its plain seat and its per-project seats. */
const selectSeatRows = db.prepare(
  `SELECT id, name, ended_at, home_project, seat_id, removed_at, liveness FROM agents
   WHERE org_id = ? AND device_id = ? AND kind = 'session' AND (seat_id = ? OR substr(seat_id, 1, ?) = ?) ORDER BY created_at, rowid`,
);
const seatRowsOf = (orgId: string, deviceId: string, seat: string) =>
  selectSeatRows.all(orgId, deviceId, seat, seat.length + 1, `${seat} `) as SeatRow[];
const selectSeatTaken = db.prepare(`SELECT 1 FROM agents WHERE device_id = ? AND seat_id = ? AND kind = 'session'`);
const selectLiveByToolSession = db.prepare(
  `SELECT id, name, home_project FROM agents WHERE org_id = ? AND device_id = ? AND tool_session_id = ? AND kind = 'session' AND ended_at IS NULL AND removed_at IS NULL`,
);

/** The row among a seat's agents whose home is `home`, comparing resolved keys, so a row whose home was recorded with a
 * legacy key before its alias existed still matches the remote key. With no project to match (undefined: only a `leave`
 * that names none), the seat's live row, else its first. */
function forProject(orgId: string, allRows: SeatRow[], home: string | undefined): SeatRow | undefined {
  const rows = allRows.filter((r) => r.removed_at === null);
  if (home === undefined) return rows.find((r) => !r.ended_at) ?? rows[0];
  return rows.find((r) => r.home_project !== null && resolveProjectKey(orgId, r.home_project) === home);
}
/** A session an operator removed keeps its seat, so the same chat can't come straight back in that project as a new
 * agent under a new name. The seat is (chat, project): the same chat's agent in another project is another identity
 * (operator decision 3) and isn't refused, unless the removed row predates project seats (no home), which blocks the whole
 * chat as before. A new chat (a new seat) on the same device works as usual; removing the device stops them all. */
const selectRemovedByToolSession = db.prepare(
  `SELECT home_project FROM agents WHERE org_id = ? AND device_id = ? AND kind = 'session' AND removed_at IS NOT NULL AND tool_session_id = ?`,
);
function removedInProject(orgId: string, deviceId: string, seatRows: SeatRow[], toolSessionId: string, home: string): boolean {
  const removed = [...seatRows.filter((r) => r.removed_at !== null), ...(selectRemovedByToolSession.all(orgId, deviceId, toolSessionId) as Array<{ home_project: string | null }>)];
  return removed.some((r) => r.home_project === null || resolveProjectKey(orgId, r.home_project) === home);
}

/** A caller that sends no host session id (a hook process may lack it) but whose tool session id is already live on this
 * device, under whatever seat (usually the host session id its chat's MCP proxy sent), is that agent: the one in the
 * request's project, when it names one. Exactly one match only: an ambiguous id is never guessed between. */
function liveByToolSession(orgId: string, deviceId: string, hints: SessionHints, home: string | undefined): { id: string; name: string } | null {
  if (hints.hostSessionId) return null;
  const all = selectLiveByToolSession.all(orgId, deviceId, hints.toolSessionId) as Array<{ id: string; name: string; home_project: string | null }>;
  const matches = home === undefined ? all : all.filter((r) => r.home_project !== null && resolveProjectKey(orgId, r.home_project) === home);
  return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null;
}
const countLiveSessions = db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND device_id = ? AND kind = 'session' AND ended_at IS NULL`);

// Scoped by CLIENT, not only by device and project. One computer runs several tools at once -- that is
// what a device is -- so "the live session on this device in this project" is not one row but one row
// PER TOOL, and matching without the tool lets a Codex hook adopt a live Claude Code chat's agent.
// `client = ?` is exact equality and the column is nullable, so a row from before it existed never
// matches: an unattributable row is not adoptable, which is the fail-closed direction.
const selectLiveInProject = db.prepare(
  `SELECT id, name, home_project FROM agents WHERE org_id = ? AND device_id = ? AND kind = 'session' AND ended_at IS NULL AND removed_at IS NULL AND client = ?`,
);

/** THE RULING (508d, decision #13378): "adoption a deduction rather than a guess".
 *
 * A tool that hands its MCP child no per-chat id (Codex) leaves the hook holding an id the hub has never seen, while
 * the proxy holds the seat it minted. The two halves cannot converge from the hook's side (docs/design/HARNESS-CODEX.md
 * §5.4.1: Codex exposes no per-chat value to the child anywhere). So the hub converges them here, under six limits --
 * every one of them a case where the honest answer is "I cannot tell", never a guess:
 *   - `adoptLive` only. The caller opted in, so no client that knows its own seat can take another chat's.
 *   - `resolveOnly` only (the caller of this function decides). Adoption replaces the "no session" refusal; the create
 *     path is untouched, so two chats can never collapse onto one agent.
 *   - no host session id. A caller that names its seat knows which agent it is; adopting past that is a guess.
 *   - the SAME TOOL. A device serves Claude Code and Codex side by side, so without the tool a Codex hook whose own
 *     proxy has not registered yet finds the live Claude Code chat as its single candidate and wears its name, inbox
 *     and digest. That is the silent wrong identity this area exists to prevent, arriving through the fix for it.
 *   - the SAME PROJECT, and only that. With no project to match on the candidate set would be the whole device, so an
 *     absent home declines instead of widening. Project isolation defaults to denial; adoption is not its exception.
 *   - exactly one candidate. Two is the loud refusal below, not a choice.
 *
 * "ambiguous" is its own answer so the caller can refuse LOUDLY: a chat that silently stays nameless is the inert-hook
 * defect this fixes, and a chat that silently borrows a sibling's name is worse. Never "the first one", never "the newest".
 * The seat is NOT re-pointed at the adopting caller: tool_session_id stays with the row that owns it, so the proxy's
 * next call still finds it (an overwrite here would revoke the identity it just handed over).
 *
 * Exported for its own boundary test: the tool, home and host refusals are the ones no HTTP fixture can reach
 * (a project-less request never gets this far -- isProjectEnabled refuses it first), so a test that drove them only
 * through /v1/sessions/join would pass for the wrong reason and certify nothing. */
export function adoptableLiveSession(
  orgId: string,
  deviceId: string,
  hints: SessionHints,
  home: string | undefined,
  tool: string | null,
): { id: string; name: string } | "none" | "ambiguous" {
  if (hints.hostSessionId) return "none";
  if (!home) return "none";
  if (!tool) return "none";
  const candidates = selectLiveInProject.all(orgId, deviceId, tool) as Array<{ id: string; name: string; home_project: string | null }>;
  const matches = candidates.filter((r) => r.home_project !== null && resolveProjectKey(orgId, r.home_project) === home);
  if (matches.length === 0) return "none";
  return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : "ambiguous";
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code?.startsWith("SQLITE_CONSTRAINT") ?? false;

/** Finds or creates the agent for (device, seat, project). The seat is the host session id when given (it survives /clear,
 * compact and crash), else the tool session id. The project is the request's key resolved through project_aliases, so a
 * legacy folder-name key and its remote key are one project (PROJECT_ISOLATION.md §3.1).
 *
 * A seat is bound to its project (§3.2): the same chat in another repository is a separate agent for (seat, that project),
 * named after that project, and coming back to the first repository finds the first agent again. A request never moves an
 * agent to another project.
 * - With no host session id, a live agent already holding this tool session id in this project is that agent (liveByToolSession).
 * - A live row for the seat in this project is the same agent: only its latest tool session id is updated.
 * - resolveOnly stops here: nothing is revived or created, and the answer is "no_session".
 * - A row that ended less than the TTL ago comes back to life with the same name and inbox, on a workspace that
 *   may still write: a revival is a create, so a lapsed workspace refuses it rather than performing it.
 * - A row that ended longer ago gives up the seat (its history stays) and a new agent takes it.
 * Runs in an immediate transaction; if a concurrent first request wins the unique (device_id, seat_id) index,
 * this one re-reads and gets that same agent (or, for another project, takes that project's seat id). */
export function resolveSessionAgent(
  device: SessionDevice,
  hints: SessionHints,
  { now = Date.now(), word, refuseCreate }: { now?: number; word?: () => string; refuseCreate?: ReadOnlyRefusal | null } = {},
): SessionResolution {
  const seat = hints.hostSessionId || hints.toolSessionId;
  const projectKey = projectKeyOf(hints.project);
  const legacyClient = hints.projectName === undefined;
  const attempt = db.transaction((): SessionResolution => {
    // Before anything else, so a project the workspace hasn't enabled learns nothing, gets nothing and is recorded
    // nowhere. Checked on every request, so disabling a project cuts off its live sessions too.
    if (!isProjectEnabled(device.orgId, projectKey, now)) {
      return { ok: false, reason: "project_not_enabled", project: projectKey, legacyClient, resolveOnly: Boolean(hints.resolveOnly) };
    }
    const home = resolveIncomingProjectKey(device.orgId, projectKey!);
    const projectName = projectNameFor(projectKey!, hints.projectName);
    const tool = sessionTool(device.client, hints.client);
    // Within its own project, a live session keeps up with its chat's spelling of the key (an old folder-name key becomes
    // the remote key once the computer reconnects; both resolve to the same home), and an older row learns its tool. The
    // home project itself never changes here: another project is another agent.
    const follow = (agentId: string) =>
      db.prepare(`UPDATE agents SET project = ?, project_name = ?, client = COALESCE(client, ?) WHERE id = ? AND (project IS NOT ? OR project_name IS NOT ? OR (client IS NULL AND ? IS NOT NULL))`)
        .run(projectKey, projectName, tool, agentId, projectKey, projectName, tool);
    /** One-way: 'process' -> 'chat', never back, and never a no-op UPDATE on an already-chat row.
     *
     * Called on every resolve path below when the proxy reports a `tools/call`, because a chat's later
     * call can arrive by any of them (by tool session id, by seat, or by adoption) and the promotion
     * must not depend on which. The WHERE clause is what makes it one-way: a row already promoted keeps
     * its 'chat' label even if a later request loses the header, and a NULL (pre-migration) row is
     * promoted too -- NULL means "not measured", and this IS the measurement. */
    const promoteToChat = (agentId: string) => {
      if (!hints.chatProven) return;
      db.prepare(`UPDATE agents SET liveness = 'chat' WHERE id = ? AND (liveness IS NULL OR liveness = 'process')`).run(agentId);
    };
    const seatRows = seatRowsOf(device.orgId, device.id, seat);
    if (removedInProject(device.orgId, device.id, seatRows, hints.toolSessionId, home)) return { ok: false, reason: "removed" };
    const byTool = liveByToolSession(device.orgId, device.id, hints, home);
    if (byTool) {
      follow(byTool.id);
      promoteToChat(byTool.id);
      return { ok: true, agentId: byTool.id, agentName: byTool.name, created: false };
    }
    // A row from before seats were bound to projects that never recorded one takes this project as its home.
    const unhomed = seatRows.find((r) => r.home_project === null && r.removed_at === null);
    if (unhomed && !forProject(device.orgId, seatRows, home)) {
      db.prepare(`UPDATE agents SET home_project = ? WHERE id = ? AND home_project IS NULL`).run(home, unhomed.id);
      unhomed.home_project = home;
    }
    const row = forProject(device.orgId, seatRows, home);
    if (row && !row.ended_at) {
      db.prepare(`UPDATE agents SET tool_session_id = ? WHERE id = ? AND tool_session_id IS NOT ?`).run(hints.toolSessionId, row.id, hints.toolSessionId);
      follow(row.id);
      promoteToChat(row.id);
      return { ok: true, agentId: row.id, agentName: row.name, created: false };
    }
    if (hints.resolveOnly) {
      // Adoption replaces this refusal, never the creation path below it (508d, decision #13378).
      if (!hints.adoptLive) return { ok: false, reason: "no_session" };
      const adopted = adoptableLiveSession(device.orgId, device.id, hints, home, tool);
      if (adopted === "ambiguous") return { ok: false, reason: "ambiguous_session" };
      if (adopted === "none") return { ok: false, reason: "no_session" };
      follow(adopted.id);
      // NO PROMOTION HERE, deliberately, and this is the one place it matters most to say why.
      //
      // This is the HOOK's path: resolve-only, carrying the chat's own id. A hook is NOT proof that a
      // chat exists in the sense this label means — the proof is a `tools/call`, and only the MCP proxy
      // ever sets `x-opencadre-chat-proven`, because only the proxy sees the JSON-RPC method. So
      // `promoteToChat` would return immediately here without the guard ever mattering: the call would
      // be DEAD CODE THAT READS AS LIVE, and a future maintainer would eventually "fix" a bug by making
      // it fire.
      //
      // The consequence is a named blind spot, not an oversight: a Codex chat whose ONLY traffic is hook
      // traffic stays 'process' for the whole session, and the console groups it as a background
      // process. Measured 2026-09-20: 1 of 13 chat-shaped processes in this machine's Codex log had zero
      // tool-call rows (the other four with none were thread/start probes with 5-9s spans). This is an
      // UNDER-claim and it fails safe — a chat labelled 'process' is wrong in the direction that costs a
      // grouping, whereas admitting a hook as proof would widen 'chat' to mean "something happened"
      // everywhere. A precise label with a named blind spot beats a vague label with none.
      return { ok: true, agentId: adopted.id, agentName: adopted.name, created: false };
    }
    const atCap = () => (countLiveSessions.get(device.orgId, device.id) as { n: number }).n >= maxSessionsPerDevice();
    const endedMs = row ? parseTime(row.ended_at) : null;
    // A CHAT-PROVEN row comes back as the same agent however long ago it ended: its seat is the chat's own id (a Codex
    // thread's stamp, Claude Code's host session id), which names exactly one chat, so a chat reopened after a weekend
    // keeps its name, its inbox and every thread addressed to it (measured: one Codex chat, same thread UUID and
    // credential, was renamed 8160 -> 049a after a ~3-day idle gap). A 'process' row keeps the TTL: its seat may be a
    // proxy's app-start seat that no chat ever proved, and reviving one would resurrect a phantom. A REMOVED row never
    // reaches here (forProject filters it), and every refusal below still applies, because a revival is a create.
    const revivable = row && endedMs !== null && (row.liveness === "chat" || now - endedMs < sessionTtlMs());
    if (row && endedMs !== null && revivable) {
      // A revival is a create, not a read, so it is refused before it performs one -- same order as the
      // creation path below, where the refusal also precedes the cap check. Without this line a lapsed
      // workspace answers 200, clears ended_at and emits session.joined{revived:true}.
      if (refuseCreate) return { ok: false, reason: "read_only", billing: refuseCreate };
      if (atCap()) return { ok: false, reason: "too_many_sessions" };
      // ...and the PLAN's live-agent limit, for the same reason and in the same position: a revival is a
      // create (see above), so it must be refused before it performs one. An ADOPTED agent never reaches
      // here -- it returns above with created:false -- which is what keeps a reconnect of an agent that is
      // already counted from being refused. That is the whole reason the gate is here and not earlier.
      const revivalLimit = agentLimitRefusal(device.orgId, undefined, "device");
      if (revivalLimit) return { ok: false, reason: "plan_limit", limit: revivalLimit.body };
      db.prepare(`UPDATE agents SET ended_at = NULL, tool_session_id = ?, last_heartbeat_at = ? WHERE id = ?`).run(hints.toolSessionId, sqliteTime(now), row.id);
      follow(row.id);
      // A fresh Codex PROCESS-FALLBACK id cannot match an ended row: resolveSessionId mints a new
      // random id for each process. This is not a claim about every Codex call. A verified hook stamp
      // can select a recurring chat-proven seat, and a keeper-seat client can also recur; revival is
      // reachable on those paths and this call may fire. Keep the call for those matching seats.
      // Source-level recurrence is not proof of identity continuity through a real app restart.
      promoteToChat(row.id);
      emitEvent({
        orgId: device.orgId, type: "session.joined", actor: { id: row.id, name: row.name }, subjectType: "agent", subjectId: row.id,
        payload: { agentName: row.name, deviceId: device.id, revived: true },
      });
      return { ok: true, agentId: row.id, agentName: row.name, created: false };
    }
    // A read-only workspace creates no NEW session agent row (src/billing.ts). One act above this line
    // is in that class, and it is refused where it stands rather than here: the REVIVE branch brings an
    // ended session back to life -- it clears ended_at, retakes the seat and emits
    // session.joined{revived:true} -- which is the same kind of act as creating one, so it carries its
    // own `refuseCreate` check as its first statement. Everything ELSE above this line only RESOLVES a
    // session that is already live -- a read, which a lapsed workspace keeps serving, so a read-capable
    // client does not lose the session it is already using. Everything below creates one: it gives up a
    // seat and inserts a row, the same kind of act as posting a task or a message. The refusal is
    // checked here rather than at the top of this function so that "reads keep working" stays true on
    // this path too, and it is checked before the seat is released so the refusal does not perform half
    // the write it is refusing.
    if (refuseCreate) return { ok: false, reason: "read_only", billing: refuseCreate };
    if (row) db.prepare(`UPDATE agents SET seat_id = NULL WHERE id = ?`).run(row.id);
    if (atCap()) return { ok: false, reason: "too_many_sessions" };
    // The PLAN's live-agent limit, in the same position: after adoption has been ruled out (an adopted
    // agent returned above with created:false, and it is already counted), before any write, and before
    // the seat is released -- so a refusal performs no half-write.
    const planLimit = agentLimitRefusal(device.orgId, undefined, "device");
    if (planLimit) return { ok: false, reason: "plan_limit", limit: planLimit.body };
    const seatId = selectSeatTaken.get(device.id, seat) ? projectSeatId(seat, home) : seat;

    const name = buildSessionName(device.orgId, word);
    const agentId = newId();
    // Nobody is ever given a key for a session agent. This placeholder isn't a SHA-256 hex digest, so no key hashes to it.
    const unusableKeyHash = `session:${randomBytes(32).toString("hex")}`;
    db.prepare(
      // `liveness = 'process'` at mint: the row exists because a proxy started, and nothing more. A
      // phantom is indistinguishable from an idle chat AT THIS MOMENT, so the label claims only what is
      // known -- and the first `tools/call` promotes it (see promoteToChat below). Migration 38.
      `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, kind, device_id, seat_id, tool_session_id, project, project_name, client, last_heartbeat_at, home_project, scope, liveness)
       VALUES (?, ?, ?, ?, ?, 'agent', 'agent', 'session', ?, ?, ?, ?, ?, ?, ?, ?, 'project', ?)`,
    ).run(agentId, device.orgId, name, `session-${agentId.slice(0, 8)}`, unusableKeyHash, device.id, seatId, hints.toolSessionId, projectKey, projectName, tool, sqliteTime(now), home, hints.chatProven ? "chat" : "process");
    emitEvent({
      orgId: device.orgId, type: "session.joined", actor: { id: agentId, name }, subjectType: "agent", subjectId: agentId,
      payload: { agentName: name, deviceId: device.id, project: projectName, projectKey, tool, revived: false },
    });
    return { ok: true, agentId, agentName: name, created: true };
  });
  for (let tries = 0; ; tries++) {
    try {
      return attempt.immediate();
    } catch (err) {
      if (!isUniqueViolation(err) || tries >= 2) throw err;
    }
  }
}

// --- Authentication ---------------------------------------------------------------------------

export type DeviceAuthFailure = "invalid" | "session_required" | "paused" | "read_only" | "plan_limit" | "too_many_sessions" | "no_session" | "removed" | "project_not_enabled" | "ambiguous_session";

/** Why a device request was refused. `project`, `legacyClient` and `resolveOnly` are set for project_not_enabled only;
 * `billing` is set for read_only only, and carries the refusal body the caller is answered with. */
export type DeviceRefusal = { ok: false; reason: DeviceAuthFailure; project?: string | null; legacyClient?: boolean; resolveOnly?: boolean; billing?: ReadOnlyRefusal; limit?: PlanLimitRefusal["body"] };

/** A hook from before opt-in projects (no X-OpenCadre-Project-Name) treats any 401/403 but "no session" as a broken key:
 * it says so in the chat, or, for the approval gate, blocks the command. Its resolve-only requests in a project that
 * isn't enabled are therefore answered with "no session", which those hooks already keep quiet on. */
export const isQuietLegacyRefusal = (refusal: DeviceRefusal) =>
  refusal.reason === "project_not_enabled" && Boolean(refusal.legacyClient) && Boolean(refusal.resolveOnly);

export interface DeviceSessionAuth extends AuthedAgent {
  keyClass: "agent";
  role: "agent";
  deviceId: string;
  sessionAgent: true;
  /** True when this request created the session agent. */
  created: boolean;
}

type DeviceRow = { id: string; org_id: string; client: string; paused_at: string | null };

const findDevice = db.prepare(
  `SELECT d.id, d.org_id, d.client, o.paused_at FROM devices d JOIN organizations o ON o.id = d.org_id
   WHERE d.credential_hash = ? AND d.revoked_at IS NULL`,
);

function findDeviceByCredential(bearer: string): DeviceRow | null {
  if (!CREDENTIAL_PATTERN.test(bearer)) return null;
  return (findDevice.get(hashKey(bearer)) as DeviceRow | undefined) ?? null;
}

/** THE resolver for a `dev_` bearer, used by REST, MCP and /live. The session header is checked before the credential
 * is looked up, so a caller without one learns nothing about whether the credential is real. */
export function checkDeviceSession(
  bearer: string | undefined,
  headers: IncomingHttpHeaders | Record<string, unknown>,
  { now = Date.now() }: { now?: number } = {},
): { ok: true; auth: DeviceSessionAuth } | DeviceRefusal {
  if (!isDeviceCredential(bearer)) return { ok: false, reason: "invalid" };
  const hints = readSessionHints(headers);
  if (!hints) return { ok: false, reason: "session_required" };
  const device = findDeviceByCredential(bearer);
  if (!device) return { ok: false, reason: "invalid" };
  if (device.paused_at) return { ok: false, reason: "paused" };
  // The billing guard every other surface gets from `admitAgent` (src/rest.ts:167). It has to be computed
  // HERE rather than only on the three routes that call this function directly: `requireAgentAuth` calls
  // this function FIRST and `admitAgent` second (src/rest.ts:140 then :152), so on a lapsed workspace the
  // general middleware used to create a session agent and then refuse the request -- the guard performed
  // the write it was refusing. Passing the refusal into the resolver refuses only the CREATION, so an
  // existing session still resolves and a device-authenticated READ still works.
  const refuseCreate = readOnlyRefusal(device.org_id, "POST");
  const resolved = resolveSessionAgent({ id: device.id, orgId: device.org_id, client: device.client }, hints, { now, refuseCreate });
  if (!resolved.ok) {
    if (resolved.reason === "no_session" || resolved.reason === "ambiguous_session") countRefusal(device.id, resolved.reason, now);
    return resolved;
  }
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(new Date(now).toISOString(), device.id);
  return {
    ok: true,
    auth: {
      orgId: device.org_id, agentId: resolved.agentId, agentName: resolved.agentName, keyClass: "agent", role: "agent",
      deviceId: device.id, sessionAgent: true, created: resolved.created,
    },
  };
}

/**
 * A device request that must NOT create a seat: a Codex proxy's startup traffic (initialize, tools/list, ping,
 * notifications) once its chats name themselves by stamp. Every Codex process used to join the roster as a
 * "process seat" at launch, before any chat called, so two chats listed as four agents (HARNESS-CODEX.md §6.2
 * run I2). That traffic answers the same for every agent, so it needs no agent at all.
 *
 * The same gates as checkDeviceSession up to the seat: a real, unpaused credential, a session header, and an
 * enabled project. The device's last_seen_at is refreshed here, because this is now the only request a connected
 * computer may make until a chat calls a tool, and the console reads it as "online". Nothing is resolved, revived,
 * created or heartbeated.
 */
export const DEFER_SEAT_HEADER = "x-opencadre-defer-seat";
/** Sent with seatless traffic by a proxy whose one process serves sessions in several folders (Devin): its own folder
 * is wherever the app was launched, so it names no session's project and is not checked. Only a seatless request (no
 * tool call, no agent) skips the check; every tool call is checked against its session's own project. Mirrors
 * scripts/opencadre-config.mjs. */
export const SHARED_PROCESS_HEADER = "x-opencadre-shared-process";
export function checkDeviceWithoutSeat(
  bearer: string | undefined,
  headers: IncomingHttpHeaders | Record<string, unknown>,
  { now = Date.now() }: { now?: number } = {},
): { ok: true; orgId: string; deviceId: string } | DeviceRefusal {
  if (!isDeviceCredential(bearer)) return { ok: false, reason: "invalid" };
  const hints = readSessionHints(headers);
  if (!hints) return { ok: false, reason: "session_required" };
  const device = findDeviceByCredential(bearer);
  if (!device) return { ok: false, reason: "invalid" };
  if (device.paused_at) return { ok: false, reason: "paused" };
  const sharedProcess = /^(1|true)$/i.test(String((headers as Record<string, unknown>)[SHARED_PROCESS_HEADER] ?? ""));
  const projectKey = projectKeyOf(hints.project);
  if (!sharedProcess && !isProjectEnabled(device.org_id, projectKey, now)) {
    return { ok: false, reason: "project_not_enabled", project: projectKey, legacyClient: hints.projectName === undefined, resolveOnly: Boolean(hints.resolveOnly) };
  }
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(new Date(now).toISOString(), device.id);
  return { ok: true, orgId: device.org_id, deviceId: device.id };
}

/** Same shape as authenticateAgentKey plus the device fields, or null. Use checkDeviceSession to tell why. */
export function authenticateDeviceSession(bearer: string | undefined, headers: IncomingHttpHeaders | Record<string, unknown>): DeviceSessionAuth | null {
  const checked = checkDeviceSession(bearer, headers);
  return checked.ok ? checked.auth : null;
}

/** True for a real, unrevoked device credential refused only because its workspace is paused. */
export function isPausedDeviceCredential(bearer: string | undefined): boolean {
  if (!isDeviceCredential(bearer)) return false;
  return Boolean(findDeviceByCredential(bearer)?.paused_at);
}

/** The status a refused device request is answered with. 409 is its own code, not 401, so a caller can tell
 * "I will not choose between your live sessions" from "you have no session yet" without matching prose. */
export type DeviceRefusalStatus = 401 | 402 | 403 | 409 | 423 | 429;

export function deviceAuthError(reason: DeviceAuthFailure): { status: DeviceRefusalStatus; error: string } {
  switch (reason) {
    case "project_not_enabled":
      return { status: 403, error: PROJECT_NOT_ENABLED };
    case "session_required":
      return { status: 401, error: "session header required: send X-OpenCadre-Session with the tool's session id" };
    case "paused":
      return { status: 423, error: PAUSED_ERROR };
    // Unreachable in practice -- deviceRefusalResponse answers a read_only refusal with the whole
    // billing body, which this function only carries an error string for. Kept so the switch stays
    // exhaustive and a future case cannot fall through to "invalid credential".
    case "read_only":
      return { status: 402, error: READ_ONLY_ERROR };
    // Unreachable in practice -- deviceRefusalResponse answers a plan_limit refusal with the whole body above (see
    // the read_only case, which is kept for the same reason: the switch stays exhaustive so a future case cannot
    // fall through to "invalid credential", which would report a full plan as a bad key).
    case "plan_limit":
      return { status: 402, error: "this workspace is at its plan's limit for live agents" };
    case "too_many_sessions":
      return { status: 429, error: "this device has too many live sessions; idle ones end on their own, or an operator can remove the device" };
    case "no_session":
      return { status: 401, error: NO_SESSION_ERROR };
    case "removed":
      return { status: 401, error: REMOVED_SESSION_ERROR };
    case "ambiguous_session":
      return { status: 409, error: AMBIGUOUS_SESSION_ERROR };
    default:
      return { status: 401, error: "invalid device credential or session" };
  }
}

/** The HTTP status and JSON body for a refused device request: project_not_enabled also names the project key, and a
 * read_only refusal carries the whole billing body so a device client branches on `code` exactly as an agent key does. */
export function deviceRefusalResponse(refusal: DeviceRefusal): {
  status: DeviceRefusalStatus;
  body: { error: string; project?: string | null } | ReadOnlyRefusal["body"] | PlanLimitRefusal["body"];
} {
  // Intercepted before the switch: deviceAuthError carries one sentence, and a lapsed workspace owes the
  // caller the same body every other surface sends -- the code, the plan, and the date it lapsed.
  if (refusal.reason === "read_only" && refusal.billing) return { status: 402, body: refusal.billing.body };
  // The same intercept for the plan limit, and for the same reason: a device client branches on `code`,
  // so it needs PLAN_LIMIT and the remedy rather than a sentence. The `status` comes from the refusal
  // itself (402 in the union) so the two cannot disagree here.
  if (refusal.reason === "plan_limit" && refusal.limit) return { status: 402, body: refusal.limit };
  if (isQuietLegacyRefusal(refusal)) return { status: 401, body: { error: NO_SESSION_ERROR } };
  const { status, error } = deviceAuthError(refusal.reason);
  return { status, body: refusal.reason === "project_not_enabled" ? { error, project: refusal.project ?? null } : { error } };
}

// --- Computer-level requests (no session) -------------------------------------------------------

/** The device behind a credential, for the few routes a computer calls as itself rather than as one of its sessions. */
function computerFor(bearer: string | undefined): { ok: true; device: DeviceRow & { name: string } } | DeviceRefusal {
  if (!isDeviceCredential(bearer) || !CREDENTIAL_PATTERN.test(bearer)) return { ok: false, reason: "invalid" };
  const device = db.prepare(
    `SELECT d.id, d.org_id, d.client, d.name, o.paused_at FROM devices d JOIN organizations o ON o.id = d.org_id WHERE d.credential_hash = ? AND d.revoked_at IS NULL`,
  ).get(hashKey(bearer)) as (DeviceRow & { name: string }) | undefined;
  if (!device) return { ok: false, reason: "invalid" };
  if (device.paused_at) return { ok: false, reason: "paused" };
  return { ok: true, device };
}

/** GET /v1/devices/me: `opencadre connect` with no code checks its stored credential and learns the computer's name and
 * tool before setting anything up again. Creates nothing and refreshes nothing. */
export function describeComputer(bearer: string | undefined): { ok: true; deviceId: string; name: string; client: string; tools: string[] } | DeviceRefusal {
  const found = computerFor(bearer);
  if (!found.ok) return found;
  const { device } = found;
  const row = db.prepare(`SELECT tools FROM devices WHERE id = ?`).get(device.id) as { tools: string | null };
  return { ok: true, deviceId: device.id, name: device.name, client: device.client, tools: deviceTools(row.tools, device.client, null) };
}

/** GET /v1/devices/projects: the workspace's enabled project keys, for the computer's local allowlist. Asked with the
 * device credential ALONE -- no session or project headers -- so refreshing the list never tells the hub which folder
 * the computer is in. Creates nothing and refreshes nothing, and is a read, so a lapsed workspace still answers. */
export function listDeviceProjects(bearer: string | undefined): { ok: true; projects: string[] } | DeviceRefusal {
  const found = computerFor(bearer);
  if (!found.ok) return found;
  return { ok: true, projects: enabledProjectKeys(found.device.org_id) };
}

/** POST /v1/devices/tools: a connect run records the tools it set up on this computer, added to the ones already known. */
export function recordDeviceTools(bearer: string | undefined, rawTools: unknown): { ok: true; tools: string[] } | DeviceRefusal | { ok: false; reason: "bad_request"; error: string } {
  const listed = Array.isArray(rawTools) ? rawTools : null;
  const valid = listed && listed.length <= TOOLS.length * 2 && listed.every((t) => (TOOLS as readonly unknown[]).includes(t));
  const found = computerFor(bearer);
  if (!found.ok) return found;
  if (!valid) return { ok: false, reason: "bad_request", error: `tools must be a list of ${TOOLS.join(", ")}` };
  const { device } = found;
  // These two routes call `computerFor` and never `admitAgent` (src/rest.ts), so the read/write rule has to
  // be applied here or not at all. Checked before the transaction opens: a refusal must not rewrite the row.
  const billingRefused = readOnlyRefusal(device.org_id, "POST");
  if (billingRefused) return { ok: false, reason: "read_only", billing: billingRefused };
  return db.transaction(() => {
    const current = db.prepare(`SELECT tools FROM devices WHERE id = ?`).get(device.id) as { tools: string | null };
    const tools = deviceTools(current.tools, "auto", (listed as string[]).join(","));
    db.prepare(`UPDATE devices SET tools = ?, last_seen_at = ? WHERE id = ?`).run(JSON.stringify(tools), new Date().toISOString(), device.id);
    return { ok: true as const, tools };
  })();
}

/** One more hub-side refusal of `reason` on this computer's credential, in its bounded 24 h counts (PR-E1b; amendment 2
 * §4.1). Telemetry for the console only: it is written after the refusal is decided, never read by any auth path, and
 * holds no path, chat, session, project or credential. A failure to count never changes the refusal. */
function countRefusal(deviceId: string, reason: RefusalReason, now: number): void {
  try {
    db.transaction(() => {
      const row = db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(deviceId) as { connector_refusals: string } | undefined;
      if (!row) return;
      db.prepare(`UPDATE devices SET connector_refusals = ? WHERE id = ?`).run(bumpRefusal(row.connector_refusals, reason, now), deviceId);
    })();
  } catch { /* counting is best effort; the caller's refusal stands either way */ }
}

/** Optional computer inventory. The bearer alone selects the row; this never joins or resolves a chat. */
export function recordDeviceConnectorReport(bearer: string | undefined, raw: unknown): { ok: true } | DeviceRefusal | { ok: false; reason: "bad_request"; error: string } {
  const found = computerFor(bearer);
  if (!found.ok) return found;
  const report = validateConnectorReport(raw);
  if (!report) return { ok: false, reason: "bad_request", error: "invalid connector build report" };
  const refused = readOnlyRefusal(found.device.org_id, "POST");
  if (refused) return { ok: false, reason: "read_only", billing: refused };
  return db.transaction(() => {
    const current = db.prepare(`SELECT connector_reports FROM devices WHERE id = ?`).get(found.device.id) as { connector_reports: string };
    const reports = mergeConnectorReports(current.connector_reports, report, Date.now());
    db.prepare(`UPDATE devices SET connector_reports = ? WHERE id = ?`).run(JSON.stringify(reports), found.device.id);
    return { ok: true as const };
  })();
}

/** PUT /v1/devices/projects/enable-current: `opencadre connect` run from a chat enables that chat's own project, and
 * only that one (named by the project headers). The operator ran connect there on purpose. */
export function enableCurrentProject(
  bearer: string | undefined,
  headers: IncomingHttpHeaders | Record<string, unknown>,
): { ok: true; project: ProjectView } | DeviceRefusal | { ok: false; reason: "bad_request"; error: string } {
  const found = computerFor(bearer);
  if (!found.ok) return found;
  const rawKey = headerValue(headers, PROJECT_HEADER);
  if (!projectKeyOf(rawKey)) return { ok: false, reason: "bad_request", error: "send X-OpenCadre-Project with this chat's project key" };
  const { device } = found;
  // Same corridor as recordDeviceTools: this route never reaches admitAgent, and enabling a project CREATES a
  // projects row, so a lapsed workspace must refuse it before setProjectEnabled gets the chance to write one.
  const billingRefused = readOnlyRefusal(device.org_id, "PUT");
  if (billingRefused) return { ok: false, reason: "read_only", billing: billingRefused };
  const project = setProjectEnabled(device.org_id, { actor: null, name: device.name, via: "connect", deviceId: device.id }, rawKey, true, headerValue(headers, PROJECT_NAME_HEADER));
  return { ok: true, project };
}

/** POST /v1/sessions/leave: ends the caller's own seat, if it is live. Never creates a session. */
export function leaveDeviceSession(
  bearer: string | undefined,
  headers: IncomingHttpHeaders | Record<string, unknown>,
): { ok: true; ended: boolean; agentId: string | null } | { ok: false; reason: DeviceAuthFailure } {
  if (!isDeviceCredential(bearer)) return { ok: false, reason: "invalid" };
  const hints = readSessionHints(headers);
  if (!hints) return { ok: false, reason: "session_required" };
  const device = findDeviceByCredential(bearer);
  if (!device) return { ok: false, reason: "invalid" };
  if (device.paused_at) return { ok: false, reason: "paused" };
  const seat = hints.hostSessionId || hints.toolSessionId;
  // A seat holds one agent per project: leave the one for the caller's project when it names one.
  const rawKey = projectKeyOf(hints.project);
  const home = rawKey ? resolveProjectKey(device.org_id, rawKey) ?? undefined : undefined;
  const ended = db.transaction(() => {
    // Resolved exactly as a request is, so a caller without its host session id leaves the agent it would act as.
    const row = liveByToolSession(device.org_id, device.id, hints, home) ?? forProject(device.org_id, seatRowsOf(device.org_id, device.id, seat), home);
    if (!row || ("ended_at" in row && row.ended_at)) return null;
    db.prepare(`UPDATE agents SET ended_at = ? WHERE id = ?`).run(sqliteTime(Date.now()), row.id);
    emitEvent({
      orgId: device.org_id, type: "session.ended", actor: { id: row.id, name: row.name }, subjectType: "agent", subjectId: row.id,
      payload: { agentName: row.name, reason: "leave", deviceId: device.id },
    });
    return row.id;
  })();
  if (ended) disconnectAgent(ended, "session ended");
  return { ok: true, ended: ended !== null, agentId: ended };
}

// --- Idle sweep -------------------------------------------------------------------------------

/** Ends every live session whose last heartbeat is older than OPENCADRE_SESSION_TTL_HOURS (default 12). It runs next
 * to sweepStaleAgents, which skips sessions, so the two never touch the same row. */
export function sweepIdleSessions(nowMs: number = Date.now()): { ended: string[] } {
  const ttl = sessionTtlMs();
  const cutoffMs = nowMs - ttl;
  const candidates = db.prepare(`SELECT id, org_id, name, last_heartbeat_at, created_at FROM agents WHERE kind = 'session' AND ended_at IS NULL`)
    .all() as Array<{ id: string; org_id: string; name: string; last_heartbeat_at: string | null; created_at: string }>;
  const ended: string[] = [];
  for (const s of candidates) {
    const lastMs = parseTime(s.last_heartbeat_at) ?? parseTime(s.created_at);
    if (lastMs !== null && lastMs >= cutoffMs) continue;
    const changed = db.transaction(() => {
      const current = db.prepare(`SELECT last_heartbeat_at, ended_at FROM agents WHERE id = ?`).get(s.id) as { last_heartbeat_at: string | null; ended_at: string | null } | undefined;
      // Idempotent, and a heartbeat that landed since the scan keeps the session.
      if (!current || current.ended_at !== null || current.last_heartbeat_at !== s.last_heartbeat_at) return false;
      db.prepare(`UPDATE agents SET ended_at = ? WHERE id = ?`).run(sqliteTime(nowMs), s.id);
      emitEvent({
        orgId: s.org_id, type: "session.ended", subjectType: "agent", subjectId: s.id,
        payload: { agentName: s.name, reason: "idle_ttl", lastHeartbeatAt: s.last_heartbeat_at, ttlHours: ttl / 3_600_000 },
      });
      return true;
    })();
    if (changed) {
      disconnectAgent(s.id, "session ended after being idle");
      ended.push(s.id);
    }
  }
  return { ended };
}

// --- Console: sessions ------------------------------------------------------------------------

export interface SessionView {
  agentId: string;
  agentName: string;
  /** The operator-owned profile a person named this session into (src/agent-names.ts), or null. */
  profileId: string | null;
  profileName: string | null;
  /** True for a session still carrying an unchosen <Client>-<Project>-<4hex> name that nobody has answered the one-time
   * naming prompt for. Never true for a keyed agent (ruling Q5). */
  namePromptDue: boolean;
  /** The project's display name (what the console shows). */
  project: string | null;
  /** The project key sessions are grouped by: a remote key (host/owner/repo), local:<folder>, or an old folder name. */
  projectKey: string | null;
  projectName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** The device's own client (an old single-tool device's tool, or "auto"). */
  client: string | null;
  /** The session's tool: claude-code, codex, cursor, antigravity or gemini. */
  tool: string | null;
  online: boolean;
  currentTask: string | null;
  /** Whether a CHAT is behind this row, or only a process that started. `'chat'` once the session has
   * served a tool call, `'process'` before that, and `null` for rows written before migration 38
   * (unknown — deliberately not back-filled, since inventing either label would be fiction).
   *
   * This is #16116's label: the field that lets the console show chats as agents and group the rest as
   * background processes, so a phantom stops cluttering the roster WITHOUT being suppressed. Never read
   * `'process'` as "dead" — an idle chat that has not called a tool yet is `'process'` too, which is
   * exactly why the label means "not proven" rather than "gone". */
  liveness: string | null;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** GET /v1/org/sessions. Seat and tool session ids stay server-side. */
/** `endedSince` (an ISO time) limits ended sessions to those that ended at or after it. The console asks for the last
 * day on every poll, and without it every ended session the workspace ever had was sent each time (bug B2). */
export function listSessions(orgId: string, status: "live" | "ended", { endedSince }: { endedSince?: string } = {}): SessionView[] {
  const since = status === "ended" && endedSince ? new Date(endedSince).toISOString().replace("T", " ").slice(0, 19) : null;
  const rows = db.prepare(
    `SELECT a.id, a.name, a.project, a.project_name, a.client AS tool, a.device_id, d.name AS device_name, d.client, a.current_task, a.liveness, a.last_heartbeat_at, a.ended_at, a.created_at,
            a.profile_id, p.name AS profile_name, a.name_prompt_done_at
     FROM agents a LEFT JOIN devices d ON d.id = a.device_id AND d.org_id = a.org_id
       LEFT JOIN agent_profiles p ON p.id = a.profile_id AND p.org_id = a.org_id
     WHERE a.org_id = ? AND a.kind = 'session' AND a.removed_at IS NULL AND a.ended_at IS ${status === "live" ? "NULL" : "NOT NULL"}
       ${since ? "AND a.ended_at >= ?" : ""}
     ORDER BY a.name`,
  ).all(...(since ? [orgId, since] : [orgId])) as Array<{
    id: string; name: string; project: string | null; project_name: string | null; tool: string | null; device_id: string | null; device_name: string | null;
    client: string | null; current_task: string | null; liveness: string | null; last_heartbeat_at: string | null; ended_at: string | null; created_at: string;
    profile_id: string | null; profile_name: string | null; name_prompt_done_at: string | null;
  }>;
  return rows.map((r) => {
    const projectName = r.project_name ?? (r.project ? projectNameFor(r.project) : null);
    return {
      agentId: r.id, agentName: r.name, profileId: r.profile_id, profileName: r.profile_name,
      namePromptDue: !r.profile_id && !r.name_prompt_done_at && LEGACY_SESSION_NAME.test(r.name),
      project: projectName, projectKey: r.project, projectName, deviceId: r.device_id, deviceName: r.device_name,
      client: r.client, tool: r.tool ?? (r.client ? sessionTool(r.client) : null),
      online: !r.ended_at && isOnline(r.last_heartbeat_at), currentTask: r.current_task, liveness: r.liveness,
      lastHeartbeatAt: r.last_heartbeat_at, endedAt: r.ended_at, createdAt: r.created_at,
    };
  });
}

/** Who names a session: always a signed-in person (profiles are operator-owned), acting through their member agent. */
export interface NamingPerson { personId: string; actor: { id: string; name: string } }

export interface NamedSession { agentId: string; agentName: string; previousName: string; profile: { id: string; name: string }; note: string }

/** A naming the hub refuses on purpose: naming a session into the profile it is already in. */
export class SessionNameRefusal extends Error {
  constructor(message: string, readonly status: 409) {
    super(message);
  }
}

/** PATCH /v1/org/sessions/:agentId {name}: a person names a session into a profile. The profile is found by name
 * (ignoring case) or created; the session's address becomes "<profile> #<n>", n drawn from the profile's counter, so it
 * is never a name any agent held before. Naming metadata only (ruling Q1): the session's id, key, mailbox, claims, seat,
 * permissions and lifecycle are untouched, and no other session is created, joined or changed. The old address stays
 * this agent's for good (agent_addresses, released_at set) and now answers to nobody: mail or a client config still
 * naming it fails closed rather than reaching anyone else. An agent.renamed event records the lineage. Null when there's no such session; throws
 * ProfileNameError (400), AgentNameError (409) or SessionNameRefusal. */
export function nameSession(orgId: string, agentId: string, rawProfileName: unknown, person: NamingPerson): NamedSession | null {
  const profileName = checkProfileNameShape(rawProfileName);
  // IMMEDIATE: the profile lookup, its counter and the address are read and written under one write lock.
  return db.transaction(() => {
    const row = db.prepare(`SELECT id, name, profile_id FROM agents WHERE id = ? AND org_id = ? AND kind = 'session' AND removed_at IS NULL`)
      .get(agentId, orgId) as { id: string; name: string; profile_id: string | null } | undefined;
    if (!row) return null;

    let profile = db.prepare(`SELECT id, name, next_ordinal FROM agent_profiles WHERE org_id = ? AND name_key = ?`)
      .get(orgId, nameKey(profileName)) as { id: string; name: string; next_ordinal: number } | undefined;
    if (profile && profile.id === row.profile_id) throw new SessionNameRefusal(`${row.name} is already a chat of ${profile.name}`, 409);
    if (!profile) {
      // A profile's name is not an address, and must not be one another agent answers to (or answered to).
      if (addressHeld(orgId, profileName, row.id)) throw new AgentNameError(`an agent is already called ${profileName}; choose another name`, 409);
      // Nor look like one, or like another profile's name, or a reserved one (fold or UTS #39 skeleton; src/agent-names.ts).
      const clash = nameClash(orgId, profileName, { selfId: row.id });
      if (clash) throw new AgentNameError(`${describeClash(profileName, clash)}; choose another name`, 409);
      const id = newId();
      db.prepare(`INSERT INTO agent_profiles (id, org_id, name, name_key, next_ordinal, created_by_person_id) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(id, orgId, profileName, nameKey(profileName), person.personId);
      profile = { id, name: profileName, next_ordinal: 1 };
    }

    // The next number whose address nobody holds or held. A number skipped here (someone typed "Atlas #3" as a keyed
    // agent's name) is consumed anyway: the counter only grows.
    let ordinal = profile.next_ordinal;
    let address = profileAddress(profile.name, ordinal);
    for (;; ordinal++) {
      address = profileAddress(profile.name, ordinal);
      try {
        checkAgentName(orgId, address, row.id);
        break;
      } catch (err) {
        if (!(err instanceof AgentNameError && err.status === 409) || ordinal - profile.next_ordinal > 1000) throw err;
      }
    }
    db.prepare(`UPDATE agent_profiles SET next_ordinal = ? WHERE id = ?`).run(ordinal + 1, profile.id);
    db.prepare(`UPDATE agents SET name = ?, profile_id = ?, name_prompt_done_at = COALESCE(name_prompt_done_at, datetime('now')) WHERE id = ? AND org_id = ?`)
      .run(address, profile.id, row.id, orgId);
    emitEvent({
      orgId, type: "agent.renamed", actor: person.actor, subjectType: "agent", subjectId: row.id, targetAgentId: row.id,
      payload: { from: row.name, to: address, profileId: profile.id, profile: profile.name, byPerson: true },
    });
    return {
      agentId: row.id, agentName: address, previousName: row.name, profile: { id: profile.id, name: profile.name },
      note: `Messages and replies on existing threads keep reaching this agent. Anything that addresses it by its old name ${row.name} (an approval-gate approver, OPENCADRE_HIERARCHY, a script) now reaches nobody: update it to ${address}.`,
    };
  }).immediate();
}

/** POST /v1/org/sessions/:agentId/keep-name: a person answered the one-time naming prompt by keeping the name. Null when
 * there's no such session. Changes nothing but the prompt's flag. */
export function keepSessionName(orgId: string, agentId: string): { agentId: string; agentName: string } | null {
  const row = db.prepare(`SELECT id, name FROM agents WHERE id = ? AND org_id = ? AND kind = 'session' AND removed_at IS NULL`)
    .get(agentId, orgId) as { id: string; name: string } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE agents SET name_prompt_done_at = COALESCE(name_prompt_done_at, datetime('now')) WHERE id = ?`).run(row.id);
  return { agentId: row.id, agentName: row.name };
}

export { ProfileNameError };
