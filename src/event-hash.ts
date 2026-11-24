import { createHash } from "node:crypto";

/** The canonical, order-fixed serialization hashed for an event row: its own real columns plus the previous row's hash
 * (the tamper-evident chain, src/events.ts). The one definition of "this row's hash", shared by emitEvent (computing),
 * verifyEventChain (recomputing) and a migration that must write an event itself (src/migrations.ts 53), which cannot
 * import src/events.ts: that module opens the database, and the database runs the migrations. null fields serialize as
 * the JSON literal null, not "" -- an empty string and an absent value must not collide. */
export function computeEventHash(
  row: {
    id: string; org_id: string; type: string; actor_agent_id: string | null; subject_type: string; subject_id: string;
    target_agent_id: string | null; payload: string; created_at: string;
  },
  prevHash: string | null,
): string {
  const canonical = JSON.stringify([
    row.id, row.org_id, row.type, row.actor_agent_id, row.subject_type,
    row.subject_id, row.target_agent_id, row.payload, row.created_at, prevHash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
