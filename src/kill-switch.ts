import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { disconnectAgent } from "./live.js";
import { endHeldRequests } from "./revocation.js";

/** Workspace kill switch (R3). One operator action stops every agent in the workspace at once: their
 * keys are refused (423), live sockets close and waiting requests end. Operators keep access so they
 * can see what happened and resume. Resuming restores the same keys; nothing has to be reconnected. */

export const PAUSED_ERROR = "This workspace is paused by an operator. Nothing runs until an operator resumes it.";
export const PAUSED_SOCKET_CODE = 4003;

type Actor = { id: string; name: string };

export interface PauseState {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
}

export function workspacePauseState(orgId: string): PauseState {
  const row = db.prepare(`SELECT paused_at, paused_by_agent_name FROM organizations WHERE id = ?`).get(orgId) as
    { paused_at: string | null; paused_by_agent_name: string | null } | undefined;
  return { paused: Boolean(row?.paused_at), pausedAt: row?.paused_at ?? null, pausedBy: row?.paused_by_agent_name ?? null };
}

export function pauseWorkspace(orgId: string, actor: Actor): PauseState & { changed: boolean; agentsCutOff: number; requestsEnded: number } {
  const agentIds = db.transaction(() => {
    if (workspacePauseState(orgId).paused) return null;
    db.prepare(`UPDATE organizations SET paused_at = datetime('now'), paused_by_agent_name = ? WHERE id = ?`).run(actor.name, orgId);
    const ids = (db.prepare(`SELECT id FROM agents WHERE org_id = ? AND role != 'operator' AND removed_at IS NULL`).all(orgId) as Array<{ id: string }>).map((r) => r.id);
    emitEvent({ orgId, type: "workspace.paused", actor, subjectType: "workspace", subjectId: orgId, payload: { agents: ids.length } });
    return ids;
  })();
  if (!agentIds) return { ...workspacePauseState(orgId), changed: false, agentsCutOff: 0, requestsEnded: 0 };

  let requestsEnded = 0;
  for (const id of agentIds) {
    disconnectAgent(id, "workspace paused by an operator", PAUSED_SOCKET_CODE);
    requestsEnded += endHeldRequests(id, 423, PAUSED_ERROR);
  }
  return { ...workspacePauseState(orgId), changed: true, agentsCutOff: agentIds.length, requestsEnded };
}

export function resumeWorkspace(orgId: string, actor: Actor): PauseState & { changed: boolean } {
  const changed = db.transaction(() => {
    const state = workspacePauseState(orgId);
    if (!state.paused) return false;
    db.prepare(`UPDATE organizations SET paused_at = NULL, paused_by_agent_name = NULL WHERE id = ?`).run(orgId);
    emitEvent({ orgId, type: "workspace.resumed", actor, subjectType: "workspace", subjectId: orgId, payload: { pausedAt: state.pausedAt, pausedBy: state.pausedBy } });
    return true;
  })();
  return { ...workspacePauseState(orgId), changed };
}
