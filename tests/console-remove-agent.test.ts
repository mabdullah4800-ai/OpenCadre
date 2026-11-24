// @vitest-environment happy-dom
// Remove an agent from the console (PR #147): Fleet's Other agents and live session rows in the
// project/computer views, both via DELETE /v1/org/agents/:agentId.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

type Agent = { id: string; name: string; role?: string; key_class?: string; kind?: string; online: boolean; editing_files_parsed: string[]; last_heartbeat_at: string | null };
type Device = { deviceId: string; name: string; status?: string; tools?: string[] };
type Session = { agentId: string; agentName: string; projectKey?: string | null; projectName?: string | null; deviceId?: string; deviceName?: string | null; tool: string; online?: boolean; endedAt?: string | null };
type Console = {
  renderOtherAgents: (agents: Agent[]) => void;
  renderFleetGroups: (devicesData: { devices: Device[] } | null, liveData: { sessions: Session[] } | null) => void;
  renderEndedSessions: (ended: Session[]) => void;
  setSession: (identity: { agentId: string; agentName: string; role: string }, key: string) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  // boot() probes /v1/auth/* at load; answer it the way a hub with no session cookie would.
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderOtherAgents, renderFleetGroups, renderEndedSessions, setSession: (m, k) => { me = m; agentKey = k; } };`,
  )(window, document, window.localStorage, wrapped) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const HOLD = 1000; // a little over the console's 900 ms hold

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name, role: "agent", key_class: "agent", kind: "named", online: true, editing_files_parsed: [], last_heartbeat_at: null, ...extra });
const fleet = [
  agent("op", "Operator", { role: "operator" }),
  agent("c1", "Coder"),
  agent("s1", "ClaudeCode-OpenCadre-3f2a", { kind: "session" }), // excluded from Other agents either way
  agent("m1", "Ada", { key_class: "human" }),
];
const operator = { agentId: "op", agentName: "Operator", role: "operator" };

const removeButtons = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLButtonElement>("[data-remove]")).map((b) => b.dataset.remove);
const hold = async (button: Element) => {
  button.dispatchEvent(new Event("pointerdown"));
  await new Promise((r) => setTimeout(r, HOLD));
};
const deletes = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === "DELETE").map(([url]) => url);

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Other agents: Remove", () => {
  it("is shown to operators, never on yourself or a person's member agent -- and never on a session-kind row (it has its own Remove in the project/computer views)", () => {
    const ui = loadConsole();
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    expect(removeButtons()).toEqual(["c1"]); // s1 is session-kind, excluded from this list entirely; op/m1 never render at all (see below)

    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    ui.renderOtherAgents(fleet);
    expect(removeButtons()).toEqual([]);
  });

  // docs/design/HUB_REDESIGN.md 1.8.2 (operator feedback: people do not belong in Fleet)
  // A signed-in person's member agent (key_class human) and the
  // legacy waitlist Operator key (role operator, key_class agent) don't belong in Fleet at all --
  // people already have a page at Settings -> Members, and the legacy key is unused, hidden
  // entirely per the spec's own explicit carve-out. This supersedes #159's labeling fix (below),
  // which correctly spotted the mislabel but kept both rows in Fleet, just relabeled.
  it("excludes a legacy operator-role key and a person's member agent entirely, keeping only real named tool agents", () => {
    const ui = loadConsole();
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    const names = Array.from(document.querySelectorAll("#fleet-other-agents .callsign")).map((n) => n.textContent);
    expect(names).toEqual(["Coder"]); // op (legacy operator key) and m1 (human) never render; s1 is session-kind
    expect(document.querySelector("#fleet-other-agents")!.textContent).not.toContain("Person");
    expect(document.querySelector("#fleet-other-agents")!.textContent).not.toContain("Workspace key (legacy)");
  });

  it("opens a warning with a hold-to-remove button; the hold DELETEs the agent, toasts and refreshes", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) =>
      (url === "/v1/org/agents/c1" && opts?.method === "DELETE" ? json(200, { ok: true, agentId: "c1", agentName: "Coder" }) : json(200, hubReadBody(url) ?? {})));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);

    const open = document.querySelector<HTMLButtonElement>('[data-remove="c1"]')!;
    open.click();
    const row = open.closest(".strip")!.querySelector(".remove-confirm")!;
    expect(row.querySelector(".remove-warning")!.textContent).toBe("Its key stops working now and it leaves Fleet. Its history stays.");
    const holdBtn = row.querySelector(".hold")!;
    expect(holdBtn.textContent).toBe("Hold to remove");
    expect(open.hidden).toBe(true);
    expect(deletes(fetchMock)).toEqual([]);

    const callsBefore = fetchMock.mock.calls.length;
    await hold(holdBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect(deletes(fetchMock)).toEqual(["/v1/org/agents/c1"]);
    expect(fetchMock.mock.calls[callsBefore][1]).toMatchObject({ method: "DELETE", headers: expect.objectContaining({ authorization: "Bearer agt_op" }) });
    expect($("toast").textContent).toBe("Removed Coder");
    // refresh() reloads the roster (coalesced, so a moment later: app.js REFRESH_SETTLE_MS).
    await vi.waitFor(() => expect(fetchMock.mock.calls.slice(callsBefore).some(([url]) => url === "/v1/agents")).toBe(true));
    expect(document.querySelector(".remove-confirm")).toBeNull();
  });

  it("does nothing when released early or cancelled, and a poll never replaces a card mid-removal", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-remove="c1"]')!.click();
    const holdBtn = document.querySelector(".remove-confirm .hold")!;

    holdBtn.dispatchEvent(new Event("pointerdown"));
    await new Promise((r) => setTimeout(r, 300));
    holdBtn.dispatchEvent(new Event("pointerup"));
    await new Promise((r) => setTimeout(r, HOLD));
    expect(deletes(fetchMock)).toEqual([]);

    // Wedge A supersedes whole-list defer: the protected card/hold stays while other rows apply.
    ui.renderOtherAgents([agent("op", "Operator", { role: "operator" }), agent("c1", "Coder"), agent("n1", "Newcomer")]);
    expect(document.querySelector(".remove-confirm .hold")).toBe(holdBtn);
    expect($("fleet-other-agents").textContent).toContain("Newcomer");

    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>(".remove-confirm button")).find((b) => b.textContent === "Cancel")!;
    cancel.click();
    expect(document.querySelector(".remove-confirm")).toBeNull();
    expect($("fleet-other-agents").textContent).toContain("Newcomer");
    expect(deletes(fetchMock)).toEqual([]);
  });

  it("puts the hold back and says why when the hub refuses", async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) =>
      (opts?.method === "DELETE" ? json(400, { error: "remove the person under Settings → Members instead" }) : json(200, {})));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderOtherAgents(fleet);
    document.querySelector<HTMLButtonElement>('[data-remove="c1"]')!.click();
    const holdBtn = document.querySelector(".remove-confirm .hold")!;
    await hold(holdBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect($("toast").textContent).toBe("Remove failed: remove the person under Settings → Members instead");
    expect(holdBtn.textContent).toBe("Hold to remove");
    expect(holdBtn.classList.contains("is-done")).toBe(false);
  });
});

describe("Fleet groups: Remove on a live session row", () => {
  const devices = { devices: [{ deviceId: "d1", name: "PC-2", status: "connected", tools: ["claude-code"] }] };
  const live: Session[] = [{ agentId: "s1", agentName: "ClaudeCode-OpenCadre-3f2a", projectKey: "p", projectName: "OpenCadre", deviceId: "d1", deviceName: "PC-2", tool: "claude-code", online: true }];
  const ended: Session[] = [{ agentId: "s2", agentName: "Codex-OpenCadre-11cd", projectKey: "p", projectName: "OpenCadre", deviceName: "PC-2", tool: "codex", endedAt: new Date().toISOString() }];

  it("live session rows get Remove for operators, never on ended rows", () => {
    const ui = loadConsole();
    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    ui.renderFleetGroups(devices, { sessions: live });
    expect(removeButtons($("fleet-groups"))).toEqual([]);

    ui.setSession(operator, "agt_op");
    ui.renderFleetGroups(devices, { sessions: live });
    ui.renderEndedSessions(ended);
    expect(removeButtons($("fleet-groups"))).toEqual(["s1"]);
    expect(removeButtons($("sessions-ended"))).toEqual([]);
  });

  it("the hold DELETEs the session agent and refresh() picks it back up (live sessions included)", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) =>
      (opts?.method === "DELETE" ? json(200, { ok: true, agentId: "s1", agentName: "ClaudeCode-OpenCadre-3f2a" }) : json(200, hubReadBody(url) ?? {})));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    ui.renderFleetGroups(devices, { sessions: live });

    document.querySelector<HTMLButtonElement>('[data-remove="s1"]')!.click();
    const callsBefore = fetchMock.mock.calls.length;
    await hold($("fleet-groups").querySelector(".remove-confirm .hold")!);
    await new Promise((r) => setTimeout(r, 0));
    expect(deletes(fetchMock)).toEqual(["/v1/org/agents/s1"]);
    expect($("toast").textContent).toBe("Removed ClaudeCode-OpenCadre-3f2a");
    // refresh() re-fetches Fleet's session-scoped data, not a bespoke reload path (coalesced: app.js REFRESH_SETTLE_MS).
    const after = () => fetchMock.mock.calls.slice(callsBefore).map(([url]) => url);
    await vi.waitFor(() => expect(after()).toContain("/v1/org/sessions?status=live"));
    expect(after()).toContain("/v1/agents");
  });

  it("a poll never replaces a session card mid-removal either", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const ui = loadConsole(fetchMock);
    ui.setSession(operator, "agt_op");
    const otherExisting = { ...live[0], agentId: "s2", agentName: "Other session" };
    ui.renderFleetGroups(devices, { sessions: [...live, otherExisting] });
    document.querySelector<HTMLButtonElement>('[data-remove="s1"]')!.click();
    const holdBtn = $("fleet-groups").querySelector(".hold")!;

    const otherSession = { agentId: "s3", agentName: "Codex-OpenCadre-99zz", projectKey: "p", projectName: "OpenCadre", deviceId: "d1", deviceName: "PC-2", tool: "codex", online: true };
    const refreshedS2 = { ...otherExisting, currentTask: "Latest task while holding", state: "working", phase: "editing" };
    ui.renderFleetGroups(devices, { sessions: [live[0], refreshedS2, otherSession] });
    expect($("fleet-groups").querySelector(".remove-confirm .hold")).toBe(holdBtn);
    expect($("fleet-groups").textContent).not.toContain("Codex-OpenCadre-99zz");
    const refreshedRow = $("fleet-groups").querySelectorAll<HTMLElement>(".row-fleet")[1];
    expect(refreshedRow.querySelector(".strip-body")?.textContent).toBe("Latest task while holding");
    expect(refreshedRow.querySelector(".state-word")?.textContent).toBe("working");
    expect(refreshedRow.querySelector(".phase-chip")?.textContent).toBe("editing");

    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>(".remove-confirm button")).find((b) => b.textContent === "Cancel")!;
    cancel.click();
    expect(document.querySelector(".remove-confirm")).toBeNull();
    expect($("fleet-groups").textContent).toContain("Codex-OpenCadre-99zz");
  });
});
