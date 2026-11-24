// @vitest-environment happy-dom
// The console shows an agent's tool by its company's logo, never a coloured dot (the operator, 2026-10-01: "EVERYWHERE").
// One source: index.html's #vl-* sprite, drawn by vendorLogo() in app.js. Guards: every vendor-tagged element on Home,
// Agents, Inbox and Activity, rendered by a real refresh, carries the logo of its own vendor; no ::before dot or
// per-vendor stripe rule remains; the marks retain the reviewed real paths; and the logo is named only where no text names it.
// Red on the console before it (no logos, the ::before dot rule, the per-vendor stripes).
// The tool comes from authoritative metadata only: a session's `tool`, or a stable agent id looked up in the sessions and
// roster the console loads. NEVER from a display name, which is the user's to choose (Codex-049a on 469fe5ac): the
// renamed controls below were red there, where a Codex chat renamed "Claude-reviewer" wore Claude's logo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  // Each row names its agent by stable id (a session above), the way the hub sends it.
  "/v1/approvals": { approvals: [{ id: "a1", requested_by_agent_name: "Chat-claude-code", requested_by_agent_id: "s0", category: "deploy",
    risk: "high", action: "npm run deploy", created_at: now(), expires_at: later() }] },
  "/v1/messages": { messages: [{ id: "m1", thread_id: "t1", from_agent_id: "s2", from_agent_name: "Chat-cursor", body: "Done.", priority: "medium",
    kind: "message", created_at: now(), read_at: null }] },
  "/v1/awareness": { items: [{ seq: 7, type: "conflict.detected", actor: "Grok-build-3c3c", summary: "Both edit src/a.ts", priority: 1, directed: true }],
    background: {}, cursor: 7 },
  "/v1/events": { events: [{ seq: 1, type: "task.created", actor_agent_id: "s3", actor_agent_name: "Chat-gemini", payload: "{}", created_at: now() }] },
};

type Ui = Record<string, (...a: any[]) => any>;
const LOCKS = [{ resource_key: "src/a.ts", holder_agent_id: "s1", holder_agent_name: "Chat-codex", note: "x", acquired_at: now(), lease_expires_at: later() }];
async function rendered(world: Record<string, unknown> = WORLD, locks: unknown[] = LOCKS): Promise<Ui> {
  let authed = false;
  const fetchMock = vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    if (path === "/v1/auth/me") return authed ? json(200, { person: { id: "p1", name: "Pat" }, workspaces: [{ orgId: "ws-a", name: "ws-a", role: "owner" }] }) : json(401, {});
    if (path === "/v1/org/sessions" && url.includes("ended")) return json(200, { sessions: [] });
    return json(200, world[path] ?? hubReadBody(url, ME) ?? {});
  });
  const location = new Proxy(window.location, {
    get(target, key) {
      if (key === "replace") return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ui = new Function("window", "document", "localStorage", "fetch", "location", `${APP_JS}; return {
    loadAndRender, renderFileLocks, focusedApprovalCard,
    byComputer: () => { fleetViewMode = "computer"; renderCachedFleetGroups(); },
    enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; me = identity; },
  };`)(window, document, window.localStorage, fetchMock, location) as Ui;
  await flush();
  authed = true;
  ui.enter("ws-a", ME);
  await ui.loadAndRender();
  ui.renderFileLocks(locks);
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

describe("every vendor-tagged element shows its tool's logo", () => {
  it("on Home, Agents, Inbox and Activity, each logo is its own vendor's mark", async () => {
    await rendered();
    const seen = new Set<string>();
    for (const panel of ["overview", "fleet", "inbox", "timeline"]) {
      const nodes = tagged(panel);
      expect(nodes.length, `${panel} has vendor-tagged rows`).toBeGreaterThan(0);
      for (const node of nodes) {
        const vendor = node.getAttribute("data-vendor")!;
        expect(logoOf(node), `${panel}: ${node.textContent?.slice(0, 40)}`).toBe(`#vl-${vendor}`);
        seen.add(vendor);
      }
    }
    // Every mark was drawn somewhere, and every one exists in the sprite.
    expect([...seen].sort()).toEqual([...VENDORS].sort());
    for (const v of VENDORS) expect(document.getElementById(`vl-${v}`)?.tagName.toLowerCase(), v).toBe("symbol");
  });

  it("the fleet map's slabs, Working now's rows and the computer cards' tool badges carry the logos", async () => {
    const ui = await rendered();
    const slabs = [...document.querySelectorAll("#home-fleet-map .viz-slab")];
    expect(slabs.length).toBe(6);
    for (const s of slabs) expect(logoOf(s)).toBe(`#vl-${s.getAttribute("data-vendor")}`);
    expect([...document.querySelectorAll("#overview-happening .strip")].map(logoOf)).toEqual(
      ["#vl-claude", "#vl-codex", "#vl-cursor", "#vl-gemini", "#vl-grok", "#vl-other"]);
    ui.byComputer();
    for (const node of tagged("fleet")) expect(logoOf(node)).toBe(`#vl-${node.getAttribute("data-vendor")}`);
    const badges = [...document.querySelectorAll("#fleet-groups .tool-badges .vendor-tag")];
    expect(badges.map((b) => [b.textContent, logoOf(b)])).toEqual([
      ["Claude Code", "#vl-claude"], ["Codex", "#vl-codex"], ["Cursor", "#vl-cursor"],
      ["Gemini CLI", "#vl-gemini"], ["Grok Build", "#vl-grok"], ["OpenCode", "#vl-other"]]);
  });

  it("the file locks and the focused approval card carry the logo of the agent id's tool", async () => {
    const ui = await rendered();
    expect(logoOf(document.querySelector("#fleet-locks-list [data-vendor]")!)).toBe("#vl-codex");
    const card = ui.focusedApprovalCard({ id: "a9", requested_by_agent_id: "s2", requested_by_agent_name: "Chat-cursor", category: "deploy", risk: "low",
      action: "ls", created_at: now(), expires_at: later() }) as HTMLElement;
    expect(logoOf(card)).toBe("#vl-cursor");
  });
});

// Renamed controls: each agent's name points at a DIFFERENT vendor than its tool (or at one it has none of).
const RC_SESSION = { project: "api", deviceId: "d1", deviceName: "PC-1", online: true, liveness: "chat", lastHeartbeatAt: now() };
const RC = {
  codex: { id: "rc-codex", name: "Claude-reviewer", logo: "#vl-codex", label: "Codex" },
  claude: { id: "rc-claude", name: "Atlas", logo: "#vl-claude", label: "Claude Code" },
  none: { id: "rc-none", name: "Cursor-thing", logo: "#vl-other", label: "Agent" },
};
const RC_AGENTS = Object.values(RC);
const ROSTER = { role: "agent", key_class: "agent", online: true, last_heartbeat_at: now(), status: "online", editing_files_parsed: [], collision_files: [], collision_agents: [] };
const RENAMED: Record<string, unknown> = {
  "/v1/me": ME,
  "/v1/agents": { agents: [
    { id: RC.codex.id, name: RC.codex.name, kind: "session", client: "codex", ...ROSTER },
    { id: RC.claude.id, name: RC.claude.name, kind: "session", client: "claude-code", ...ROSTER },
    // A named key with no tool on record: nothing authoritative says which tool it runs.
    { id: RC.none.id, name: RC.none.name, kind: "named", client: null, ...ROSTER },
  ] },
  "/v1/org/sessions": { sessions: [
    { ...RC_SESSION, agentId: RC.codex.id, agentName: RC.codex.name, tool: "codex" },
    { ...RC_SESSION, agentId: RC.claude.id, agentName: RC.claude.name, tool: "claude-code" },
  ] },
  // "codex-nightly" is not a tool id the console knows: the map is exact, so it is NOT Codex.
  "/v1/org/devices": { devices: [{ deviceId: "d1", name: "PC-1", status: "connected", tools: ["codex", "claude-code", "codex-nightly"] }] },
  "/v1/approvals": { approvals: RC_AGENTS.map((a, i) => ({ id: `ra-${a.id}`, requested_by_agent_id: a.id, requested_by_agent_name: a.name,
    category: "deploy", risk: "high", action: `npm run deploy-${i}`, created_at: new Date(Date.now() - 60_000 * (i + 1)).toISOString(), expires_at: later() })) },
  // Atlas's message is read, so Home's five-row attention list holds all three approvals and the two unread messages.
  "/v1/messages": { messages: RC_AGENTS.map((a, i) => ({ id: `rm-${a.id}`, thread_id: `rt-${a.id}`, from_agent_id: a.id, from_agent_name: a.name,
    body: `Note ${i}.`, priority: "medium", kind: "message", created_at: now(), read_at: a === RC.claude ? now() : null })) },
  "/v1/events": { events: RC_AGENTS.map((a, i) => ({ seq: i + 1, type: "task.created", actor_agent_id: a.id, actor_agent_name: a.name, payload: "{}", created_at: now() })) },
  // The digest's items carry the actor's NAME only (src/awareness.ts AwarenessItem.actor): no id to look up.
  "/v1/awareness": { items: [{ seq: 9, type: "conflict.detected", actor: RC.codex.name, summary: "Both edit src/a.ts", priority: 1, directed: true }],
    background: {}, cursor: 9 },
};
const RC_LOCKS = RC_AGENTS.map((a) => ({ resource_key: `src/${a.id}.ts`, holder_agent_id: a.id, holder_agent_name: a.name, note: "x", acquired_at: now(), lease_expires_at: later() }));
const rowsWith = (selector: string, name: string, keep: (n: Element) => boolean = () => true) =>
  [...document.querySelectorAll(selector)].filter((n) => n.textContent?.includes(name) && keep(n));
// Every row for that agent (the Inbox draws the selected item twice: in the queue and in the focus pane); at least one.
const rowsOf = (selector: string, name: string, keep?: (n: Element) => boolean) => {
  const rows = rowsWith(selector, name, keep);
  expect(rows.length, `${selector} has a row for ${name}`).toBeGreaterThan(0);
  return rows;
};
const oneRow = (selector: string, name: string) => {
  const rows = rowsOf(selector, name);
  expect(rows.length, `${selector} has one row for ${name}`).toBe(1);
  return rows[0];
};

describe("renamed controls: the tool comes from the agent's id, never its name", () => {
  for (const a of RC_AGENTS) {
    it(`${a.name} (${a.label}) shows ${a.logo} in Working now, Home, Inbox, the focused approval, Activity and locks`, async () => {
      const ui = await rendered(RENAMED, RC_LOCKS);
      const where: Array<[string, Element[]]> = [
        ["Working now", rowsOf("#overview-happening .strip", a.name)],
        ["Home approval", rowsOf("#overview-attention .strip", a.name, (n) => Boolean(n.querySelector(".risk")))],
        ["Inbox approval", rowsOf('[data-panel="inbox"] .strip.clearance', a.name)],
        ["Inbox message", rowsOf('[data-panel="inbox"] .strip.inbox-message', a.name)],
        ["Activity", rowsOf("#timeline .timeline-entry", a.name)],
        ["Lock", rowsOf("#fleet-locks-list .row-lock", a.name)],
      ];
      if (a !== RC.claude) where.push(["Home message", rowsOf("#overview-attention .strip", a.name, (n) => n.querySelector(".row-kind")?.textContent === "Message")]);
      const card = ui.focusedApprovalCard({ id: "rf", requested_by_agent_id: a.id, requested_by_agent_name: a.name, category: "deploy", risk: "low",
        action: "ls", created_at: now(), expires_at: later() }) as HTMLElement;
      where.push(["Focused approval", [card]]);
      for (const [surface, nodes] of where) {
        for (const node of nodes) {
          expect(logoOf(node), `${surface}: ${a.name}`).toBe(a.logo);
          // The row's data-vendor and its logo agree.
          if (node.hasAttribute("data-vendor")) expect(`#vl-${node.getAttribute("data-vendor")}`, surface).toBe(a.logo);
        }
      }
    });
  }

  it("each logo's accessible name and tool word is the TRUE tool, never the one the name suggests", async () => {
    const ui = await rendered(RENAMED, RC_LOCKS);
    for (const a of RC_AGENTS) {
      expect(oneRow("#overview-happening .strip", a.name).querySelector(".vendor-logo")!.getAttribute("aria-label"), a.name).toBe(a.label);
    }
    const reviewer = RC.codex;
    const rows = [...document.querySelectorAll(".strip")].filter((n) => n.textContent?.includes(reviewer.name));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      for (const logo of row.querySelectorAll(".vendor-logo")) expect(logo.getAttribute("aria-label") ?? "", row.textContent!).not.toMatch(/claude/i);
      // The only "Claude" a row may say is the agent's own name.
      expect(row.textContent!.replaceAll(reviewer.name, ""), row.textContent!).not.toMatch(/claude/i);
    }
    const card = ui.focusedApprovalCard({ id: "rf", requested_by_agent_id: reviewer.id, requested_by_agent_name: reviewer.name, category: "deploy",
      risk: "low", action: "ls", created_at: now(), expires_at: later() }) as HTMLElement;
    expect(card.querySelector(".vendor-tag")!.textContent).toBe("Codex · deploy");
  });

  it("the awareness digest names no agent id, so its rows wear the generic mark, never the name's vendor", async () => {
    await rendered(RENAMED, RC_LOCKS);
    const mentions = rowsWith('[data-panel="inbox"] .strip', RC.codex.name, (n) => Boolean(n.querySelector(".p-badge")));
    expect(mentions.length).toBeGreaterThan(0);
    for (const row of mentions) expect(logoOf(row)).toBe("#vl-other");
  });

  it("a device's tool ids map exactly: codex-nightly is not Codex", async () => {
    const ui = await rendered(RENAMED, RC_LOCKS);
    ui.byComputer();
    const badges = [...document.querySelectorAll("#fleet-groups .tool-badges .vendor-tag")];
    expect(badges.map((b) => [b.textContent, logoOf(b)])).toEqual([["Codex", "#vl-codex"], ["Claude Code", "#vl-claude"], ["codex-nightly", "#vl-other"]]);
  });
});

describe("accessibility: named only where no text names the tool", () => {
  it("Working now's row says no tool word, so its logo is an image named for the tool", async () => {
    await rendered();
    const logo = document.querySelector("#overview-happening .strip .vendor-logo")!;
    expect(logo.getAttribute("role")).toBe("img");
    expect(logo.getAttribute("aria-label")).toBe("Claude Code");
    expect(logo.hasAttribute("aria-hidden")).toBe(false);
    // The name is still the row's text: the logo adds no characters.
    expect(document.querySelector("#overview-happening .callsign")!.textContent).toBe("Chat-claude-code");
  });
  it("in a computer card's group, where the row has no tool word, the row's logo is named for the tool", async () => {
    const ui = await rendered();
    ui.byComputer();
    const labels = [...document.querySelectorAll("#fleet-groups .strip .callsign .vendor-logo")].map((l) => l.getAttribute("aria-label"));
    expect(labels).toEqual(["Claude Code", "Codex", "Cursor", "Gemini CLI", "Grok Build", "OpenCode"]);
  });
  it("beside the tool's name it is decorative", async () => {
    await rendered();
    const decorative = [...document.querySelectorAll(".vendor-tag .vendor-logo, .row-who .vendor-logo, .inbox-message .vendor-logo")];
    expect(decorative.length).toBeGreaterThan(5);
    for (const logo of decorative) {
      expect(logo.getAttribute("aria-hidden")).toBe("true");
      expect(logo.hasAttribute("role")).toBe(false);
    }
  });
});

describe("no dot remains", () => {
  const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  it("no ::before vendor mark, no per-vendor stripe, and no per-vendor colour token left unread", () => {
    for (const [name, css] of Object.entries(CSS)) {
      expect(rules(css), name).not.toMatch(/callsign::before/);
      expect(rules(css), name).not.toMatch(/\[data-vendor[^\]]*\][^{]*\{/);
      for (const v of ["claude", "codex", "cursor", "grok"]) expect(rules(css), `${name} --v-${v}`).not.toContain(`--v-${v}`);
    }
  });
  it("the logo is coloured by CSS (currentColor), with no style attribute and no colour in the sprite", () => {
    expect(rules(CSS["console-v2.css"])).toMatch(/\.vendor-logo \{[^}]*fill: currentColor/);
    const sprite = INDEX_HTML.match(/<svg class="oc-sprite"[^>]*><defs><symbol id="vl-[\s\S]*?<\/svg>/)![0];
    expect(sprite).not.toMatch(/\sstyle=|fill="#|stroke="#/);
    expect(APP_JS).not.toMatch(/vendorLogo[\s\S]{0,400}\.style\./);
  });
});

describe("Claude's mark is its company's orange; every other mark stays its text's colour", () => {
  const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  it("the Claude logo carries its vendor class, and only that class is coloured, from the shared token", async () => {
    await rendered();
    const logo = document.querySelector("#overview-happening .strip .vendor-logo")!;
    expect(logo.getAttribute("aria-label")).toBe("Claude Code");
    expect(logo.classList.contains("vendor-logo--claude")).toBe(true);
    const css = rules(CSS["console-v2.css"]);
    expect(css).toMatch(/\.vendor-logo--claude, \.viz-slab \.vendor-logo--claude \{ fill: var\(--vendor-claude\); \}/);
    for (const v of ["codex", "cursor", "gemini", "grok", "other"]) expect(css, v).not.toContain(`.vendor-logo--${v}`);
  });
  it("on a fleet-map slab it is orange too (declared after the slab's surface fill), and forced colours drop it", () => {
    const css = rules(CSS["console-v2.css"]);
    const slab = css.search(/\.viz-slab \.vendor-logo \{[^}]*fill: var\(--surface\)/);
    expect(slab).toBeGreaterThan(-1);
    expect(css.indexOf(".viz-slab .vendor-logo--claude")).toBeGreaterThan(slab);
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.vendor-logo--claude \{ fill: currentColor; \}/);
  });
});

describe("the marks are the real ones", () => {
  const symbolPath = (id: string) => INDEX_HTML.match(new RegExp(`<symbol id="vl-${id}"[^>]*><path[^>]* d="([^"]+)"`))![1];
  it("Claude, Codex (OpenAI) and Cursor retain the reviewed logo geometry", () => {
    // Pinned from the real site hero at 411b3034, verified equal to the console sprite before
    // retiring that hero. Keep the geometry guard independent of the homepage's current layout.
    const reviewed = {
      claude: "0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84",
      codex: "3fae9b38d571a5ab5aa662bc279dcda580855d6ca6b35330e4b4ba171367ffb1",
      cursor: "85eaa79be69a55d712a4843bf8d65a217d0e5b648177c8e5f2ad67fe9a46d9ad",
    };
    for (const [id, hash] of Object.entries(reviewed)) {
      expect(createHash("sha256").update(symbolPath(id)).digest("hex"), id).toBe(hash);
    }
  });
});
