/**
 * Is a roster name a "phantom" — a real row that no process is behind?
 *
 * The Codex app's proxy create path mints roster identities with no chat open. Those rows
 * persist (they are neither removed agents nor ended sessions, so nothing filters them), and
 * anything routed to one is silently dropped: 2xx, recorded delivered, never read.
 *
 * What a sender can see is limited. The roster (GET /v1/agents -> listActiveAgents) exposes no
 * "has acted" signal at all -- the query is `SELECT * FROM agents` with no join to any activity
 * table, and its two aggregates count only *currently open* work. So "never acted" is not a
 * predicate, and the only separator between a phantom and a genuinely new agent is time.
 *
 * Therefore this never refuses. It reports, and the caller warns and delivers anyway: a false
 * refusal would silently drop a real agent's mail, which is the exact bug class this exists to
 * remove. A phantom costs one wasted notification; a wrong refusal costs a message.
 *
 * The durable signal is **never set a status**, not presence. A phantom heartbeats briefly after
 * the app start that minted it and then goes offline forever, so a check that required `online`
 * would catch neither known instance (both read `offline`).
 */

/** Minutes an agent may sit with no status before it looks like a phantom. */
export function graceMinutes(env = process.env) {
  const raw = env.OPENCADRE_PHANTOM_GRACE_MINUTES;
  if (raw == null || raw === "") return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** agents.created_at is SQLite's "YYYY-MM-DD HH:MM:SS" UTC, the format agent-state.ts parses. */
function parseSqliteUtc(s) {
  return Date.parse(`${String(s).replace(" ", "T")}Z`);
}

/**
 * Classify a roster row. Returns null when the row is fine to route to, else
 * { name, ageMinutes, tier } where tier is "fresh" (inside the grace window -- could be a real
 * agent mid-startup) or "stale" (outside it -- shape of the phantoms we have measured).
 *
 * `hasActed` is whether the row has ever set a status. Pass the row's own status_updated_at.
 */
export function classifyRecipient(row, now = Date.now(), env = process.env) {
  if (!row || typeof row !== "object") return null;
  // A status, ever, means a live participant. This is the durable signal; presence is not.
  if (row.status_updated_at != null) return null;
  // A person is not a phantom.
  if (row.key_class === "human") return null;
  // created_at is our only clock. If it is missing the caller cannot judge age, so stay quiet
  // rather than guess -- a warning nobody can act on trains people to ignore warnings.
  if (row.created_at == null) return null;
  const joined = parseSqliteUtc(row.created_at);
  if (!Number.isFinite(joined)) return null;
  const ageMinutes = Math.max(0, Math.round((now - joined) / 60000));
  const tier = ageMinutes >= graceMinutes(env) ? "stale" : "fresh";
  return { name: row.name, ageMinutes, tier };
}

/** The warning line, or null. States the consequence, not just the condition. */
export function phantomWarning(info) {
  if (!info) return null;
  if (info.tier === "fresh") {
    return (
      `warning: "${info.name}" joined ${info.ageMinutes}m ago and has not set a status yet. ` +
      `It may be a real agent still starting up, or a phantom row with nothing behind it. ` +
      `Sending anyway.`
    );
  }
  return (
    `warning: "${info.name}" has been on the roster ${info.ageMinutes}m and has never set a ` +
    `status. Phantom rows look exactly like this (minted by a client's proxy create path with ` +
    `no chat open), and **mail sent to them is silently dropped**. Sending anyway -- if this is ` +
    `a real agent, ask it to call set_status so the warning stops.`
  );
}