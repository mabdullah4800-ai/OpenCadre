/** The hub's read routes, answered the way src/rest.ts shapes them, for console tests whose mock hub only cares about
 * one or two paths and needs the rest of a refresh() to succeed.
 *
 * refresh() reads fifteen endpoints and renders from them, so a mock that answers every path with one unrelated body
 * (a created-device body, `{}`) makes a render step throw on the field that body lacks -- e.g. renderClearances reads
 * `pending.approvals.length`. The console swallowed that, so those tests passed while every refresh in them failed.
 * Each shape below is the route's own `res.json({ ... })` in src/rest.ts:
 *   GET /v1/me              -> the caller's identity (rest.ts, app.get("/v1/me"))
 *   GET /v1/agents          -> { agents }            GET /v1/approvals         -> { approvals }
 *   GET /v1/approval-grants -> { grants }            GET /v1/tasks             -> { tasks }
 *   GET /v1/events          -> { events }            GET /v1/awareness         -> getAwareness(): { items, background, cursor }
 *   GET /v1/messages        -> { messages }          GET /v1/org/devices       -> { devices }
 *   GET /v1/org/sessions    -> { sessions }          GET /v1/org/projects      -> { projects }
 *   GET /v1/reliability/all -> { reliability }       GET /v1/onboarding        -> onboardingProgress(): { steps, completed, total }
 * Returns undefined for any other path, so a test's own answers for the paths it cares about stay in the test. */
export type HubIdentity = Record<string, unknown>;

export const OPERATOR_IDENTITY: HubIdentity = {
  agentId: "op", agentName: "Operator", role: "operator", orgId: "org-1", orgName: "Test Co",
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false },
};

export function hubReadBody(rawPath: string, identity: HubIdentity = OPERATOR_IDENTITY): unknown {
  const path = rawPath.split("?")[0];
  switch (path) {
    case "/v1/me": return identity;
    case "/v1/agents": return { agents: [] };
    case "/v1/approvals": return { approvals: [] };
    case "/v1/approval-grants": return { grants: [] };
    case "/v1/tasks": return { tasks: [] };
    case "/v1/events": return { events: [] };
    case "/v1/awareness": return { items: [], background: {}, cursor: 0 };
    case "/v1/messages": return { messages: [] };
    case "/v1/org/devices": return { devices: [] };
    case "/v1/org/sessions": return { sessions: [] };
    case "/v1/org/projects": return { projects: [] };
    case "/v1/reliability/all": return { reliability: [] };
    case "/v1/onboarding": return { steps: [], completed: 0, total: 0 };
    default: return undefined;
  }
}
