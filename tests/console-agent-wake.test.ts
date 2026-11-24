// @vitest-environment happy-dom
// Agents -> Agents without a linked computer: a person sets an agent's wake webhook (PUT /v1/org/agents/:agentId/webhook)
// from its row, so an app that can't see its own trigger's key (a Grok Bot routine) never handles it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Agent = { id: string; name: string; role?: string; key_class?: string; kind?: string; online: boolean; editing_files_parsed: string[]; last_heartbeat_at: string | null };
type Identity = { agentId: string; agentName: string; role: string };
type Console = {
  renderOtherAgents: (agents: Agent[]) => void;
  setSession: (identity: Identity, key: string) => void;
  setWorkspaceSession: (identity: Identity, role: string) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  // boot() probes /v1/auth/* at load; answer it the way a hub with no session cookie would.
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      renderOtherAgents,
      setSession: (m, k) => { me = m; agentKey = k; },
      setWorkspaceSession: (m, role) => { me = m; agentKey = "agt_member"; authMode = "session"; currentWorkspaceRole = role; person = { id: "p1", name: m.agentName, email: "p@example.com", email_verified: 1 }; },
    };`,
  )(window, document, window.localStorage, wrapped) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name, role: "agent", key_class: "agent", kind: "named", online: false, editing_files_parsed: [], last_heartbeat_at: null, ...extra });
// "First Agent" is an operator-role tool agent (a self-serve workspace's first key): only an owner may set its wake.
const fleet = [agent("op", "Operator", { role: "operator" }), agent("f1", "First Agent", { role: "operator" }), agent("g1", "Grok Bot")];
const operator = { agentId: "op", agentName: "Operator", role: "operator" };
const ada = { agentId: "a1", agentName: "Ada", role: "operator" };

// A made-up value: the test only checks it is sent once and then gone from the page.
const SECRET = "Bearer routine-test-secret-7f3e";
const HOOK = "https://hooks.example.com/routines/abc/run";

/** A hub that holds one agent's webhook the way the real route does: the header is stored, only whether it is set comes
 * back, and an omitted header is kept only while the address doesn't change (no url, or the same URL once parsed). */
type LastWake = { at: string; outcome: string; status: number | null } | null;
function hub(initial: { url: string | null; auth: string | null } = { url: null, auth: null }, wake: { last?: LastWake; test?: LastWake } = {}) {
  const state = { ...initial };
  let lastWake: LastWake = wake.last ?? null;
  const view = () => ({ webhook_host: state.url ? new URL(state.url).host : null, webhook_url_set: state.url !== null, webhook_auth_set: state.auth !== null, last_wake: lastWake });
  const href = (u: string | null) => (u ? new URL(u).href : null);
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    // The test wake: one POST, its outcome recorded and returned like the real route (sendTestWake).
    if (url === "/v1/org/agents/g1/webhook/test" && opts?.method === "POST") {
      if (!state.url) return json(400, { error: "this agent has no wake webhook to test" });
      lastWake = wake.test ?? null;
      return json(200, { ok: true, ...view() });
    }
    if (url !== "/v1/org/agents/g1/webhook") return json(200, {});
    if (opts?.method === "PUT") {
      const body = JSON.parse(opts.body ?? "{}");
      const next = body.url === undefined ? state.url : body.url;
      if (next === null && body.url === undefined) return json(400, { error: "url is required: this agent has no wake webhook yet" });
      const kept = body.url === undefined || href(state.url) === href(next) ? state.auth : null;
      const auth = next === null ? null : body.authHeader === undefined ? kept : body.authHeader || null;
      if (next !== state.url || auth !== state.auth) lastWake = null;
      state.url = next;
      state.auth = auth;
      return json(200, { ok: true, ...view() });
    }
    return json(200, view());
  });
  return { state, fetchMock };
}
const puts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === "PUT").map(([url, opts]) => [url, JSON.parse((opts as { body: string }).body)]);
const wakeButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-wake]")).map((b) => b.dataset.wake);
const form = () => document.querySelector<HTMLFormElement>("#fleet-other-agents .wake-form")!;
const field = (name: string) => form().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const button = (text: string) => Array.from(form().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Agents without a linked computer: Wake", () => {
  it("is offered to an owner, an admin and an operator key; never to a member or a plain agent", () => {
    const ui = loadConsole(vi.fn(async () => json(200, {})));
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    expect(wakeButtons()).toEqual(["f1", "g1"]);
    ui.setWorkspaceSession(ada, "owner");
    ui.renderOtherAgents(fleet);
    expect(wakeButtons()).toEqual(["f1", "g1"]);
    // An admin can't set an operator-role agent's wake (the hub refuses it: src/service.ts wakeTarget), so isn't offered it.
    ui.setWorkspaceSession(ada, "admin");
    ui.renderOtherAgents(fleet);
    expect(wakeButtons()).toEqual(["g1"]);
    ui.setWorkspaceSession({ ...ada, role: "agent" }, "member");
    ui.renderOtherAgents(fleet);
    expect(wakeButtons()).toEqual([]);
    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    ui.renderOtherAgents(fleet);
    expect(wakeButtons()).toEqual([]);
  });

  it("opens a form with the current state: the host only, an empty URL field, an empty password field with its format, Save and Clear", async () => {
    const { fetchMock } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setWorkspaceSession(ada, "admin");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    expect(form().querySelector(".wake-auth-status")!.textContent).toBe("Authorization header: set");
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/v1/org/agents/g1/webhook" && ((opts as { method?: string })?.method ?? "GET") === "GET")).toBe(true);
    // The path and query can carry a token, so the hub never sends them back and the field starts empty.
    expect(field("wake-url").value).toBe("");
    expect(field("wake-url").placeholder).toBe("Paste the routine's POST-to URL to change it");
    expect(document.documentElement.outerHTML).not.toContain("/routines/");
    expect(field("wake-auth").type).toBe("password");
    expect(form().querySelector(".wake-hint")!.textContent).toBe('Bearer <key> (paste the whole value, including "Bearer ")');
    expect(field("wake-auth").getAttribute("aria-describedby")).toBe(form().querySelector(".wake-hint")!.id);
    expect(field("wake-auth").value).toBe("");
    expect(button("Save")).toBeTruthy();
    expect(button("Clear")).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain("routine-test-secret");
  });

  it("Save sends the URL and header once; afterwards the header is gone from the page and the status says on", async () => {
    const { fetchMock, state } = hub();
    const ui = loadConsole(fetchMock);
    ui.setWorkspaceSession(ada, "admin");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: off"));
    field("wake-url").value = HOOK;
    field("wake-auth").value = SECRET;
    button("Save").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    expect(puts(fetchMock)).toEqual([["/v1/org/agents/g1/webhook", { url: HOOK, authHeader: SECRET }]]);
    expect(field("wake-url").value).toBe("");
    expect(state).toEqual({ url: HOOK, auth: SECRET });
    expect(field("wake-auth").value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain("routine-test-secret");
    expect($("toast").textContent).toBe("Wake on mail is on for Grok Bot.");
  });

  it("Clear turns it off and empties both fields", async () => {
    const { fetchMock, state } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    button("Clear").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: off"));
    expect(puts(fetchMock)).toEqual([["/v1/org/agents/g1/webhook", { url: null }]]);
    expect(state).toEqual({ url: null, auth: null });
    expect(field("wake-url").value).toBe("");
    expect($("toast").textContent).toBe("Wake on mail is off for Grok Bot.");
  });

  it("says why in the status line when the hub refuses, keeps the URL typed, and empties the header field", async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) =>
      (opts?.method === "PUT" ? json(400, { error: "webhook url must use https" }) : json(200, { webhook_host: null, webhook_url_set: false, webhook_auth_set: false, last_wake: null })));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: off"));
    field("wake-url").value = "http://hooks.example.com/x";
    field("wake-auth").value = SECRET;
    button("Save").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake failed: webhook url must use https"));
    expect(field("wake-url").value).toBe("http://hooks.example.com/x");
    expect(field("wake-auth").value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain("routine-test-secret");
  });

  it("says when no header is set", async () => {
    const { fetchMock } = hub({ url: HOOK, auth: null });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-auth-status")!.textContent).toBe("Authorization header: not set"));
    expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)");
  });

  it("with both fields empty, Save sends neither url nor authHeader, and the saved header stays", async () => {
    const { fetchMock, state } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    expect(form().querySelector<HTMLElement>(".wake-note")!.hidden).toBe(true);
    button("Save").click();
    await vi.waitFor(() => expect(puts(fetchMock)).toEqual([["/v1/org/agents/g1/webhook", {}]]));
    expect(state).toEqual({ url: HOOK, auth: SECRET });
    await vi.waitFor(() => expect(form().querySelector(".wake-auth-status")!.textContent).toBe("Authorization header: set"));
  });

  it("Remove header sends null and the status says not set", async () => {
    const { fetchMock, state } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-auth-status")!.textContent).toBe("Authorization header: set"));
    const remove = field("wake-remove-auth");
    expect(remove.type).toBe("checkbox");
    expect(remove.closest("label")!.textContent).toBe("Remove header");
    remove.checked = true;
    button("Save").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-auth-status")!.textContent).toBe("Authorization header: not set"));
    // An empty URL field keeps the stored address: only the header changed.
    expect(puts(fetchMock)).toEqual([["/v1/org/agents/g1/webhook", { authHeader: null }]]);
    expect(state).toEqual({ url: HOOK, auth: null });
    expect(remove.checked).toBe(false);
  });

  it("with the URL field empty, a new header replaces the saved one at the same address", async () => {
    const { fetchMock, state } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    field("wake-auth").value = "Bearer routine-test-secret-new";
    button("Save").click();
    await vi.waitFor(() => expect(puts(fetchMock)).toEqual([["/v1/org/agents/g1/webhook", { authHeader: "Bearer routine-test-secret-new" }]]));
    expect(state).toEqual({ url: HOOK, auth: "Bearer routine-test-secret-new" });
    await vi.waitFor(() => expect(field("wake-auth").value).toBe(""));
  });

  it("warns before saving whenever a new address is typed over a saved header, even at the same host, until the header is pasted again", async () => {
    const { fetchMock } = hub({ url: HOOK, auth: SECRET });
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    const note = form().querySelector<HTMLElement>(".wake-note")!;
    expect(note.hidden).toBe(true);
    // Another path on the same host is another routine: the hub drops the header for it too.
    for (const typed of ["https://hooks.example.com/routines/xyz/run", "https://collector.example.net/x", "not a url yet"]) {
      field("wake-url").value = typed;
      field("wake-url").dispatchEvent(new Event("input"));
      expect(note.hidden, typed).toBe(false);
    }
    expect(note.textContent).toBe("Changing the address removes the saved header; paste it again.");
    field("wake-auth").value = SECRET;
    field("wake-auth").dispatchEvent(new Event("input"));
    expect(note.hidden).toBe(true);
  });

  it("shows how the last wake went, and what to check after a refusal", async () => {
    const cases: Array<[LastWake, string | null]> = [
      [{ at: "2026-10-31 09:00:00", outcome: "rejected", status: 401 }, "Last wake: rejected (401). Check the Authorization header."],
      [{ at: "2026-10-31 09:00:00", outcome: "rejected", status: 404 }, "Last wake: rejected (404)."],
      [{ at: "2026-10-31 09:00:00", outcome: "delivered", status: 200 }, "Last wake: delivered."],
      [{ at: "2026-10-31 09:00:00", outcome: "failed", status: null }, "Last wake: failed (network)."],
      [{ at: "2026-10-31 09:00:00", outcome: "gave_up", status: 503 }, "Last wake: gave up after retries."],
      [null, null],
    ];
    for (const [last, words] of cases) {
      document.querySelector(".wake-form")?.remove();
      const { fetchMock } = hub({ url: HOOK, auth: SECRET }, { last });
      const ui = loadConsole(fetchMock);
      ui.setSession(operator, "agt_op");
      ui.renderOtherAgents(fleet);
      document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
      await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
      const line = form().querySelector<HTMLElement>(".wake-last")!;
      expect(line.hidden, String(words)).toBe(words === null);
      if (words) expect(line.textContent).toBe(words);
      document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    }
  });

  it("Send test wake posts once and shows the outcome inline", async () => {
    const { fetchMock } = hub({ url: HOOK, auth: SECRET }, { test: { at: "2026-10-31 09:00:00", outcome: "rejected", status: 401 } });
    const ui = loadConsole(fetchMock);
    ui.setWorkspaceSession(ada, "admin");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    expect(form().querySelector<HTMLElement>(".wake-last")!.hidden).toBe(true);
    button("Send test wake").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-last")!.textContent).toBe("Last wake: rejected (401). Check the Authorization header."));
    const posts = fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/agents/g1/webhook/test" && (opts as { method?: string }).method === "POST");
    expect(posts).toHaveLength(1);
    expect(puts(fetchMock)).toEqual([]);
  });

  it("a refused test wake says why in the status line", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) =>
      (url.endsWith("/webhook/test") && opts?.method === "POST"
        ? json(429, { error: "At most 6 test wakes a minute for one agent. Wait a moment and try again." })
        : json(200, { webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: true, last_wake: null })));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!.click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent).toBe("Wake on mail: on (hooks.example.com)"));
    button("Send test wake").click();
    await vi.waitFor(() => expect(form().querySelector(".wake-status")!.textContent)
      .toBe("Test wake failed: At most 6 test wakes a minute for one agent. Wait a moment and try again."));
  });

  it("a poll keeps the open form; pressing Wake again closes it", async () => {
    const { fetchMock } = hub();
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    const open = document.querySelector<HTMLButtonElement>('[data-wake="g1"]')!;
    open.click();
    await flush();
    const before = form();
    field("wake-url").value = HOOK;
    ui.renderOtherAgents([...fleet, agent("n1", "Newcomer")]);
    expect(form()).toBe(before);
    expect(field("wake-url").value).toBe(HOOK);
    expect($("fleet-other-agents").textContent).toContain("Newcomer");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    open.click();
    expect(document.querySelector(".wake-form")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });
});
