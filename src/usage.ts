import { db } from "./db.js";
import { emitEvent } from "./events.js";

/** Subscription usage per agent. An agent that ran out of usage goes quiet exactly like a
 * crashed one, so the fleet needs the difference spelled out: reporters in scripts/ and
 * examples/hooks/ post what their client exposes, and the hub only stores the latest report. */

export const USAGE_SOURCES = ["codex", "claude-code", "antigravity", "manual"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface AgentUsage {
  usedPct: number | null;
  window: string | null;
  resetsAt: string | null;
  limited: boolean;
  plan: string | null;
  source: UsageSource;
  reportedAt: string;
}

const MAX_LABEL_CHARS = 40;

// Labels land inside one-line MCP output, so a newline could forge another agent's line.
const label = (raw: unknown): string | null | undefined =>
  raw == null ? null : typeof raw === "string" && raw.length <= MAX_LABEL_CHARS && !/\p{Cc}/u.test(raw) ? raw : undefined;

export function parseUsageReport(body: unknown): { ok: true; report: Omit<AgentUsage, "reportedAt"> } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.limited !== "boolean") return { ok: false, error: "limited must be a boolean" };
  const usedPct = b.usedPct ?? null;
  if (usedPct !== null && (typeof usedPct !== "number" || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100)) {
    return { ok: false, error: "usedPct must be a number from 0 to 100, or null" };
  }
  const resetsAt = b.resetsAt ?? null;
  if (resetsAt !== null && (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt)))) {
    return { ok: false, error: "resetsAt must be a date string, or null" };
  }
  const window = label(b.window);
  const plan = label(b.plan);
  if (window === undefined || plan === undefined) return { ok: false, error: `window and plan must be strings of at most ${MAX_LABEL_CHARS} characters, or null` };
  const source = b.source ?? "manual";
  if (!(USAGE_SOURCES as readonly unknown[]).includes(source)) return { ok: false, error: `source must be one of ${USAGE_SOURCES.join(", ")}` };
  return {
    ok: true,
    report: {
      usedPct, window, plan, limited: b.limited, source: source as UsageSource,
      resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    },
  };
}

function parseStored(raw: string | null): AgentUsage | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentUsage;
  } catch {
    return null;
  }
}

/** Stores the latest report and emits an event only when the limited flag flips. */
export function setAgentUsage(orgId: string, actor: { id: string; name: string }, report: Omit<AgentUsage, "reportedAt">): AgentUsage {
  const usage: AgentUsage = { ...report, reportedAt: new Date().toISOString() };
  db.transaction(() => {
    const raw = db.prepare(`SELECT usage FROM agents WHERE id = ? AND org_id = ?`).pluck().get(actor.id, orgId) as string | null;
    const wasLimited = parseStored(raw)?.limited === true;
    db.prepare(`UPDATE agents SET usage = ? WHERE id = ? AND org_id = ?`).run(JSON.stringify(usage), actor.id, orgId);
    if (usage.limited === wasLimited) return;
    emitEvent({
      orgId, type: usage.limited ? "agent.usage_limited" : "agent.usage_restored", actor, subjectType: "agent", subjectId: actor.id,
      payload: { source: usage.source, usedPct: usage.usedPct, window: usage.window, resetsAt: usage.resetsAt },
    });
  })();
  return usage;
}

/** A limit whose reset time has passed is over, even before the agent says so; the stored
 * report is left alone and only what readers see changes. */
export function currentUsage(raw: string | null, nowMs: number = Date.now()): AgentUsage | null {
  const usage = parseStored(raw);
  if (usage?.limited && usage.resetsAt && Date.parse(usage.resetsAt) <= nowMs) return { ...usage, limited: false };
  return usage;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "Sep 20 18:20 UTC": the hub has no idea of the reader's time zone. */
export function shortTime(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** The get_active_agents suffix, or null when there is nothing to show. */
export function usageSummary(usage: AgentUsage | null): string | null {
  if (!usage) return null;
  if (usage.limited) return `OUT OF USAGE until ${shortTime(usage.resetsAt)}`;
  if (usage.usedPct === null) return null;
  return [`usage ${Math.round(usage.usedPct)}%`, usage.window && `(${usage.window})`, usage.resetsAt && `resets ${shortTime(usage.resetsAt)}`]
    .filter(Boolean).join(" ");
}
