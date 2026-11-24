// @vitest-environment happy-dom
// Codex-049a's independent-review controls on PR #704 (469fe5ac, receipt name-metadata-controls.json): red there, where
// the console read a vendor out of an agent's display name. The harness and the three controls are the reviewer's,
// verbatim. Its file also carried a copy of console-vendor-logos.test.ts; those suites live, updated, in that file
// (their one name-fed assertion, a lock and an approval with no agent id, is what this fix retires), so they are not
// duplicated here.
// The console shows an agent's tool by its company's logo, never a coloured dot (the operator, 2026-10-01: "EVERYWHERE").
// One source: index.html's #vl-* sprite, drawn by vendorLogo() in app.js. Guards: every vendor-tagged element on Home,
// Agents, Inbox and Activity, rendered by a real refresh, carries the logo of its own vendor; no ::before dot or
// per-vendor stripe rule remains; the marks are the site's real paths; and the logo is named only where no text names it.
// Red on the console before it (no logos, the ::before dot rule, the per-vendor stripes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const APP_JS = read("public/app/app.js");
const INDEX_HTML = read("public/app/index.html");
const CSS = { "app.css": read("public/app/app.css"), "console-v2.css": read("public/app/console-v2.css") };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const VENDORS = ["claude", "codex", "cursor", "gemini", "grok", "other"];
const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 900_000).toISOString();

const ME = {
  agentId: "me", agentName: "Pat", role: "operator", memberRole: "owner", orgId: "ws-a", orgName: "ws-a Co",
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false },
  billing: { plan: "pro", planName: "Pro", subscriptionStatus: "active", readOnly: false, awaitingPlan: false, seats: 1,
    limits: { key: "pro", name: "Pro", maxAgents: 10, maxMachines: 3, maxProjects: 5, maxWorkspaces: 1, maxWebhooks: 2, retentionDays: 90, trialDays: null } },
};
// One live chat per tool the console knows a logo for, plus one it does not (OpenCode: the generic mark).
const TOOLS = ["claude-code", "codex", "cursor", "gemini", "grok", "opencode"];
const SESSIONS = TOOLS.map((tool, i) => ({
  agentId: `s${i}`, agentName: `Chat-${tool}`, tool, project: "api", deviceId: i < 3 ? "d1" : "d2", deviceName: i < 3 ? "PC-1" : "PC-2",
  online: true, liveness: "chat", lastHeartbeatAt: now(),
}));
const WORLD: Record<string, unknown> = {
  "/v1/me": ME,
  "/v1/agents": { agents: [] },
  "/v1/org/sessions": { sessions: SESSIONS },
  "/v1/org/devices": { devices: [
    { deviceId: "d1", name: "PC-1", status: "connected", tools: ["claude-code", "codex", "cursor"] },
    { deviceId: "d2", name: "PC-2", status: "connected", tools: ["gemini", "grok", "opencode"] },
  ] },
  "/v1/approvals": { approvals: [{ id: "a1", requested_by_agent_name: "Claude-api-1a2b", requested_by_agent_id: "x1", category: "deploy",
    risk: "high", action: "npm run deploy", created_at: now(), expires_at: later() }] },
  "/v1/messages": { messages: [{ id: "m1", thread_id: "t1", from_agent_name: "Cursor-web-9f9f", body: "Done.", priority: "medium",
    kind: "message", created_at: now(), read_at: null }] },
  "/v1/awareness": { items: [{ seq: 7, type: "conflict.detected", actor: "Grok-build-3c3c", summary: "Both edit src/a.ts", priority: 1, directed: true }],
    background: {}, cursor: 7 },
  "/v1/events": { events: [{ seq: 1, type: "task.created", actor_agent_name: "Gemini-cli-4d4d", payload: "{}", created_at: now() }] },
};

type Ui = Record<string, (...a: any[]) => any>;
async function rendered(): Promise<Ui> {
  let authed = false;
  const fetchMock = vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    if (path === "/v1/auth/me") return authed ? json(200, { person: { id: "p1", name: "Pat" }, workspaces: [{ orgId: "ws-a", name: "ws-a", role: "owner" }] }) : json(401, {});
    if (path === "/v1/org/sessions" && url.includes("ended")) return json(200, { sessions: [] });
    return json(200, WORLD[path] ?? hubReadBody(url, ME) ?? {});
  });
  const location = new Proxy(window.location, {
    get(target, key) {
      if (key === "replace") return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ui = new Function("window", "document", "localStorage", "fetch", "location", `${APP_JS}; return {
    loadAndRender, renderFileLocks, focusedApprovalCard, beginConsoleGeneration, indexAgentTools, vendorOfAgent,
    byComputer: () => { fleetViewMode = "computer"; renderCachedFleetGroups(); },
    enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; me = identity; },
  };`)(window, document, window.localStorage, fetchMock, location) as Ui;
  await flush();
  authed = true;
  ui.enter("ws-a", ME);
  await ui.loadAndRender();
  ui.renderFileLocks([{ resource_key: "src/a.ts", holder_agent_name: "Codex-api-5a12", note: "x", acquired_at: now(), lease_expires_at: later() }]);
  return ui;
}

const logoOf = (node: Element) => node.querySelector("svg.vendor-logo use")?.getAttribute("href") ?? null;
const tagged = (panel: string) => [...document.querySelectorAll(`[data-panel="${panel}"] [data-vendor]`)];

beforeEach(() => {
  document.documentElement.innerHTML = INDEX_HTML.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("WebSocket", class { readyState = 0; close() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('independent review: stable identity outranks an agent display name', () => {
  it('a Codex sender renamed Claude-reviewer keeps the OpenAI logo in Inbox', async () => {
    const prior = WORLD['/v1/messages'];
    try {
      WORLD['/v1/messages'] = { messages: [{ id:'review-m1', thread_id:'review-t1', from_agent_id:'s1', from_agent_name:'Claude-reviewer', body:'Review done.', priority:'medium', kind:'message', created_at:now(), read_at:null }] };
      await rendered();
      expect(logoOf(document.querySelector('#inbox-messages [data-inbox-id="review-m1"]') ?? document.querySelector('[data-inbox-id="review-m1"]')!)).toBe('#vl-codex');
    } finally { WORLD['/v1/messages'] = prior; }
  });
  it('a known Codex approval requester renamed Atlas keeps the OpenAI logo', async () => {
    const prior = WORLD['/v1/approvals'];
    try {
      WORLD['/v1/approvals'] = { approvals: [{ id:'review-a1', requested_by_agent_name:'Atlas', requested_by_agent_id:'s1', category:'deploy', risk:'high', action:'npm run deploy', created_at:now(), expires_at:later() }] };
      await rendered();
      expect(logoOf(document.querySelector('[data-inbox-id="review-a1"]')!)).toBe('#vl-codex');
    } finally { WORLD['/v1/approvals'] = prior; }
  });
  it('an unknown sender called Claude-reviewer receives the generic mark', async () => {
    const prior = WORLD['/v1/messages'];
    try {
      WORLD['/v1/messages'] = { messages: [{ id:'review-m2', thread_id:'review-t2', from_agent_id:'no-known-session', from_agent_name:'Claude-reviewer', body:'Hello.', priority:'medium', kind:'message', created_at:now(), read_at:null }] };
      await rendered();
      expect(logoOf(document.querySelector('[data-inbox-id="review-m2"]')!)).toBe('#vl-other');
    } finally { WORLD['/v1/messages'] = prior; }
  });
});

describe('reviewer lifecycle controls for the agent tool index', () => {
  it('a workspace/person generation reset discards the previous tool lookup before the first new refresh', async () => {
    const ui = await rendered();
    const approval = { id:'generation-approval', requested_by_agent_id:'s1', requested_by_agent_name:'Atlas', category:'deploy', risk:'low', action:'ls', created_at:now(), expires_at:later() };
    expect(logoOf(ui.focusedApprovalCard(approval) as HTMLElement)).toBe('#vl-codex');
    ui.beginConsoleGeneration();
    expect(logoOf(ui.focusedApprovalCard(approval) as HTMLElement)).toBe('#vl-other');
  });
  it('a successful replacement index drops agents absent from the new reads and uses roster client metadata', async () => {
    const ui = await rendered();
    expect(ui.vendorOfAgent('s1')).toBe('codex');
    ui.indexAgentTools([{id:'roster-only',client:'cursor'}], [], []);
    expect(ui.vendorOfAgent('s1')).toBe('other');
    expect(ui.vendorOfAgent('roster-only')).toBe('cursor');
  });
});
