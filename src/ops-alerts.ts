import { db } from "./db.js";
import { parseStamp } from "./timestamps.js";
import { SYSTEM_SENDER } from "./escalation.js";
import { log } from "./log.js";
import { windowStats } from "./metrics.js";
import { sendMessage } from "./service.js";

/** Hub health alerts (reliability sprint R0). Metrics cover every org's traffic, so alerts go only to
 * the operators of the platform's own org (OPENCADRE_OPS_ORG_ID), never to customers. One message when
 * the hub turns unhealthy and one when it recovers; nothing repeats while the state is unchanged.
 * A hub that is down can't send this, so an outside check (scripts/ops/) covers that case. */

type Stats = ReturnType<typeof windowStats>;

let unhealthySince: number | null = null;
let restored = false;

// The alert state lives in memory, and deploys restart the process. Before the first sweep, pick the
// state back up from the last hub alert message, so an incident that a deploy fixes still gets its
// "recovered" notice.
const lastHubNotice = db.prepare(
  `SELECT body, created_at FROM messages
   WHERE org_id = ? AND from_agent_id = ? AND (body LIKE 'HUB ALERT%' OR body LIKE 'HUB RECOVERED%')
   ORDER BY created_at DESC, rowid DESC LIMIT 1`,
);
function restoreState(orgId: string): void {
  if (restored) return;
  restored = true;
  const last = lastHubNotice.get(orgId, SYSTEM_SENDER.id) as { body: string; created_at: string } | undefined;
  if (last?.body.startsWith("HUB ALERT")) unhealthySince = parseStamp(last.created_at);
}

export function describeProblems(stats: Stats): string[] {
  const { window, inFlight, alerts } = stats;
  const problems: string[] = [];
  if (alerts.errorRateHigh) {
    problems.push(`5xx rate ${(window.errorRate * 100).toFixed(1)}% over ${window.minutes} min (limit ${(alerts.thresholds.errorRate * 100).toFixed(0)}%, ${window.errors5xx} of ${window.requests} requests)`);
  }
  if (alerts.p95High) problems.push(`p95 latency ${window.p95Ms} ms (limit ${alerts.thresholds.p95Ms} ms)`);
  if (alerts.stuckRequests) problems.push(`${inFlight.stuck} request(s) in flight for over 5 min (oldest ${inFlight.oldestSeconds} s)`);
  return problems;
}

const operatorsOf = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND role = 'operator' AND removed_at IS NULL ORDER BY name`);

async function notifyOperators(orgId: string, body: string): Promise<number> {
  const ids = operatorsOf.pluck().all(orgId) as string[];
  // skipDuplicateCheck: intentional fan-out of one alert to every operator, not an accidental repeat.
  for (const id of ids) await sendMessage(orgId, SYSTEM_SENDER, id, body, "high", null, { skipDuplicateCheck: true });
  return ids.length;
}

/** Called every minute from the server bootstrap. `stats` is injectable for tests. */
export async function sweepHubHealth(now = Date.now(), stats: Stats = windowStats(now)): Promise<"alerted" | "recovered" | null> {
  const orgId = process.env.OPENCADRE_OPS_ORG_ID;
  if (!orgId) return null;
  restoreState(orgId);
  const version = process.env.OPENCADRE_VERSION ?? "unknown";
  if (!stats.alerts.healthy && unhealthySince === null) {
    unhealthySince = now;
    const problems = describeProblems(stats);
    const sent = await notifyOperators(orgId, `HUB ALERT (${version}): ${problems.join("; ")}. Check /v1/metrics and the hub logs.`);
    log.error("hub health alert", { problems, operatorsNotified: sent });
    return "alerted";
  }
  if (stats.alerts.healthy && unhealthySince !== null) {
    const minutes = Math.max(1, Math.round((now - unhealthySince) / 60_000));
    unhealthySince = null;
    const sent = await notifyOperators(orgId, `HUB RECOVERED (${version}): healthy again after ${minutes} min.`);
    log.info("hub health recovered", { minutes, operatorsNotified: sent });
    return "recovered";
  }
  return null;
}

/** For tests only. */
export function resetHubHealth(): void {
  unhealthySince = null;
  restored = false;
}
