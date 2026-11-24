// WHO MAY SEE THE WORKSPACE'S LIVE-AGENT COUNT: one predicate, every surface.
//
// The number is `countLiveAgents(orgId)` (src/billing.ts), the set the plan's live-agent limit counts. It leaves the hub
// on exactly these surfaces, and each of them asks THIS function, never a rule of its own:
//
//   GET /v1/me              billing.used.agents (src/rest.ts)
//   402 PLAN_LIMIT (agents) `used` and the count in the message, through agentLimitRefusal (src/billing.ts), from
//                           POST /v1/agents (bootstrap key), POST /v1/org/agents (agents.create), a device session's
//                           create and revival (src/devices.ts), connect-code redemption (src/connect.ts, message only)
//                           and OAuth consent (src/oauth-authorize.ts, message only)
//   get_capabilities        carries NO count under any policy: it lists the caller's own declared capability strings
//                           (src/mcp.ts), so it has nothing to withhold and nothing to disclose.
//
// Withheld means `null` on every one of them (and a refusal message without the number), never a number on one surface
// and null on another.
//
// POLICY M (Codex-OpenCadre-049a, dashboard phase 2 ruling Q2, 2026-10-01): every principal of the workspace sees it.
// It is a workspace AGGREGATE only -- one integer, no names, no ids, no projects -- and the 402 bodies already carried
// it to every one of these principals at the limit, so M changes no existing contract. The predicate is therefore
// true for every viewer today; the viewer is still named at every call site so a later ruling changes one function.
// tests/live-agent-count.test.ts flips this function and proves every surface follows it.

/** Who is asking, by the principal class each surface serves. */
export type LiveCountViewer = "member" | "agent" | "bootstrap" | "device" | "connect_code" | "oauth";

export function liveCountVisibleTo(_viewer: LiveCountViewer | undefined): boolean {
  return true;
}
