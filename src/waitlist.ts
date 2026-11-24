import { createHash } from "node:crypto";
import { db, newId } from "./db.js";
import { createOrganization, registerAgent } from "./service.js";

/** Early-access waitlist (issue #21). The operator chose waitlist-first: the
 * public site collects interest, and an admin approves entries, which creates
 * the workspace and its first Operator key. No emails are sent yet. */

export const TEAM_SIZES = ["solo", "2-5", "6-20", "21-100", "100+"] as const;
export const TOOLS = ["claude-code", "codex", "cursor", "gemini-cli", "grok", "copilot", "other"] as const;

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  team_size: string | null;
  tools: string; // JSON array
  note: string | null;
  ip_hash: string | null;
  status: "pending" | "approved";
  org_id: string | null;
  created_at: string;
  approved_at: string | null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function hashIp(ip: string | undefined): string | null {
  return ip ? createHash("sha256").update(`opencadre-waitlist:${ip}`).digest("hex").slice(0, 32) : null;
}

export function joinWaitlist(
  input: { email: unknown; name?: unknown; teamSize?: unknown; tools?: unknown; note?: unknown },
  ipHash: string | null,
): { ok: true } | { ok: false; error: string } {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const teamSize = TEAM_SIZES.find((s) => s === input.teamSize) ?? null;
  const tools = Array.isArray(input.tools) ? TOOLS.filter((t) => (input.tools as unknown[]).includes(t)) : [];

  // Duplicates are ignored silently so the endpoint can't be used to check who signed up.
  db.prepare(
    `INSERT INTO waitlist (id, email, name, team_size, tools, note, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO NOTHING`,
  ).run(newId(), email, text(input.name, 120), teamSize, JSON.stringify(tools), text(input.note, 1000), ipHash);
  return { ok: true };
}

export function listWaitlist(): WaitlistEntry[] {
  return db.prepare(`SELECT * FROM waitlist ORDER BY created_at DESC, rowid DESC`).all() as WaitlistEntry[];
}

/** Creates the workspace and its Operator key. Keys are returned once and
 * never stored in plaintext; the admin hands them to the person. */
export function approveWaitlist(id: string):
  | { ok: true; email: string; orgId: string; orgName: string; bootstrapKey: string; operatorKey: string }
  | { ok: false; status: 404 | 409; error: string } {
  const entry = db.prepare(`SELECT * FROM waitlist WHERE id = ?`).get(id) as WaitlistEntry | undefined;
  if (!entry) return { ok: false, status: 404, error: "No waitlist entry with that id." };
  if (entry.status === "approved") return { ok: false, status: 409, error: `${entry.email} is already approved.` };

  const orgName = entry.name || entry.email.split("@")[0];
  const approve = db.transaction(() => {
    const { orgId, bootstrapKey } = createOrganization(orgName);
    const { apiKey } = registerAgent(orgId, "Operator", { role: "operator", system: true });
    db.prepare(`UPDATE waitlist SET status = 'approved', org_id = ?, approved_at = datetime('now') WHERE id = ?`).run(orgId, id);
    return { orgId, bootstrapKey, operatorKey: apiKey };
  });
  return { ok: true, email: entry.email, orgName, ...approve() };
}
