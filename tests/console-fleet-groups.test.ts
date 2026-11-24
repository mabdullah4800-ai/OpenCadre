// @vitest-environment happy-dom
// Fleet: Computer -> Tool -> Project -> Session (Session Model v1, docs/design/SESSION_MODEL.md).
// Built against ClaudeCode-OpenCadre-a347's console-unit spec, mocked ahead of the hub PR:
//   GET /v1/org/sessions rows gain tool/projectKey/projectName/deviceName; GET /v1/org/devices rows
//   gain tools: string[]; POST /v1/org/devices no longer needs a client.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Device = { deviceId: string; name: string; status?: string; tools?: string[]; lastSeenAt?: string | null; sessionCount?: number };
type Session = {
  agentId: string; agentName: string; tool: string; deviceId?: string; deviceName?: string | null;
  projectKey?: string | null; projectName?: string | null; online?: boolean; currentTask?: string | null;
  lastHeartbeatAt?: string | null; endedAt?: string | null; state?: string; phase?: string; editing_files_parsed?: string[];
};
type Chip = { cls: string; text: string };

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn()) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderFleetGroups, renderEndedSessions, sessionChip, removeComputer, selectTab, setAgentsView, beginConsoleGeneration, setSession: (m, k) => { me = m; agentKey = k; } };`,
  )(window, document, window.localStorage, wrapped) as {
    renderFleetGroups: (devicesData: { devices: Device[] } | null, liveData: { sessions: Session[] } | null, agentsData?: Array<Record<string, unknown>>) => void;
    renderEndedSessions: (ended: Session[]) => void;
    sessionChip: (session: Session, isEnded: boolean) => Chip;
    removeComputer: (d: Device, holdBtn?: { resetHold: () => void }) => Promise<void>;
    selectTab: (name: string) => void;
    setAgentsView: (view: string, options?: { record?: boolean }) => void;
    beginConsoleGeneration: () => void;
    setSession: (identity: { agentId: string; agentName: string; role: string }, key: string) => void;
  };
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("sessionChip", () => {
  it("online: true reads as Live", () => {
    const { sessionChip } = loadConsole();
    expect(sessionChip({ agentId: "a", agentName: "S", tool: "codex", online: true }, false)).toMatchObject({ cls: "chip-online", text: "Live" });
  });

  it("online: false reads as Idle -- the hub already applies its own 2-minute heartbeat TTL", () => {
    const { sessionChip } = loadConsole();
    expect(sessionChip({ agentId: "a", agentName: "S", tool: "codex", online: false }, false)).toMatchObject({ cls: "chip-waiting", text: "Idle" });
  });

  it("an ended session always reads as Ended, regardless of online", () => {
    const { sessionChip } = loadConsole();
    expect(sessionChip({ agentId: "a", agentName: "S", tool: "codex", online: true }, true)).toMatchObject({ cls: "chip-limited", text: "Ended" });
  });
});

describe("renderFleetGroups: no operator access / no hub support yet", () => {
  it("falls back quietly when either response is null, no error toast", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(null, null);
    expect($("fleet-groups").textContent).toMatch(/sign in as an operator/i);
    expect($("toast").hidden).toBe(true);
  });
});

describe("renderFleetGroups: empty states", () => {
  it("no computers yet points at Connect", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [] }, { sessions: [] });
    expect($("fleet-groups").textContent).toMatch(/add a computer to start/i);
  });

  it("computers exist but no live sessions -- By project shows 'No live sessions'", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [{ deviceId: "d1", name: "PC-2", status: "connected", tools: ["codex"] }] }, { sessions: [] });
    expect($("fleet-groups").textContent).toMatch(/no live sessions/i);
  });
});

describe("By project (default view)", () => {
  const devices = { devices: [
    { deviceId: "d1", name: "PC-2", status: "connected", tools: ["codex"] },
    { deviceId: "d2", name: "PC-1", status: "connected", tools: ["claude-code", "cursor"] },
  ] };

  it("groups sessions by project, sessions from different computers land in the same card", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [
      { agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "github.com/mabdullah4800-ai/opencadre", projectName: "OpenCadre", online: true },
      { agentId: "s2", agentName: "Claude-OpenCadre-9a1b", tool: "claude-code", deviceId: "d2", deviceName: "PC-1", projectKey: "github.com/mabdullah4800-ai/opencadre", projectName: "OpenCadre", online: true },
      { agentId: "s3", agentName: "Cursor-Sidecar-11cd", tool: "cursor", deviceId: "d2", deviceName: "PC-1", projectKey: "local:Sidecar", projectName: "Sidecar", online: true },
    ] });
    const titles = Array.from(document.querySelectorAll(".project-card-title")).map((n) => n.textContent);
    expect(titles).toEqual(["OpenCadre", "Sidecar"]); // alphabetical
    const openCadreCard = Array.from(document.querySelectorAll(".project-card")).find((c) => c.querySelector(".project-card-title")?.textContent === "OpenCadre")!;
    expect(openCadreCard.querySelectorAll(".strip")).toHaveLength(2);
    expect(openCadreCard.textContent).toContain("PC-2");
    expect(openCadreCard.textContent).toContain("PC-1"); // same project, two computers, one card
  });

  it("the same project on two computers is ONE card, not two", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [
      { agentId: "s1", agentName: "A", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "github.com/x/y", projectName: "Shared", online: true },
      { agentId: "s2", agentName: "B", tool: "claude-code", deviceId: "d2", deviceName: "PC-1", projectKey: "github.com/x/y", projectName: "Shared", online: true },
    ] });
    expect(document.querySelectorAll(".project-card")).toHaveLength(1);
  });

  it("sessions with no projectKey group under one 'No project' card, sorted after real projects", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [
      { agentId: "s1", agentName: "A", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "github.com/x/y", projectName: "Real", online: true },
      { agentId: "s2", agentName: "B", tool: "claude-code", deviceId: "d2", deviceName: "PC-1", online: true },
    ] });
    const titles = Array.from(document.querySelectorAll(".project-card-title")).map((n) => n.textContent);
    expect(titles).toEqual(["Real", "No project"]);
  });

  it("shows current task, or a neutral placeholder when unset", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [
      { agentId: "s1", agentName: "Busy", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "p", projectName: "P", online: true, currentTask: "Fixing the flaky test" },
      { agentId: "s2", agentName: "Idle", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "p", projectName: "P", online: true, currentTask: null },
    ] });
    const strips = Array.from(document.querySelectorAll(".strip"));
    expect(strips.find((s) => s.textContent!.includes("Busy"))!.textContent).toContain("Fixing the flaky test");
    expect(strips.find((s) => s.textContent!.includes("Idle"))!.textContent).toContain("No task announced");
  });

  it("falls back to a generic 'Agent' badge when the hub doesn't send `tool` yet, rather than an empty pill", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [{ agentId: "s1", agentName: "Agent-OpenCadre-4c6e", tool: undefined as unknown as string, deviceId: "d1", deviceName: "PC-2", projectKey: "p", projectName: "P", online: true }] });
    expect(document.querySelector(".strip .vendor-tag")!.textContent).toBe("Agent");
  });
});

describe("By computer (toggle)", () => {
  const devices = { devices: [
    { deviceId: "d1", name: "PC-2", status: "connected", tools: ["codex", "claude-code"], lastSeenAt: minutesAgo(1) },
    { deviceId: "d2", name: "Old-Laptop", status: "revoked", lastSeenAt: minutesAgo(120) },
  ] };
  const sessions = { sessions: [
    { agentId: "s1", agentName: "Codex-A", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectKey: "p", projectName: "OpenCadre", online: true },
    { agentId: "s2", agentName: "Claude-B", tool: "claude-code", deviceId: "d1", deviceName: "PC-2", projectKey: "p", projectName: "OpenCadre", online: true },
  ] };

  function switchToComputerView() {
    (Array.from(document.querySelectorAll(".view-toggle-btn")).find((b) => (b as HTMLElement).dataset.view === "computer") as HTMLButtonElement).click();
  }

  it("groups a computer's sessions by tool, and shows its tool badges", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, sessions);
    switchToComputerView();
    const pc2Card = Array.from(document.querySelectorAll(".project-card")).find((c) => c.querySelector(".project-card-title")?.textContent === "PC-2")!;
    expect(pc2Card.querySelectorAll(".tool-badges .vendor-tag")).toHaveLength(2);
    expect(pc2Card.textContent).toContain("Codex");
    expect(pc2Card.textContent).toContain("Claude Code");
    expect(pc2Card.querySelectorAll(".session-device-group")).toHaveLength(2); // one group per tool
  });

  it("a computer's sessions in one tool group don't repeat the tool name a third time on every strip", () => {
    // Header badge + a per-tool group heading each say the tool name once, which is enough context;
    // the per-session pill inside the group would be a third repeat for no reason.
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, sessions);
    switchToComputerView();
    const pc2Card = Array.from(document.querySelectorAll(".project-card")).find((c) => c.querySelector(".project-card-title")?.textContent === "PC-2")!;
    expect(pc2Card.querySelectorAll(".strip .vendor-tag")).toHaveLength(0);
  });

  it("a single-tool computer doesn't repeat the tool name as a group heading under its own badge", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [{ deviceId: "d1", name: "Solo-PC", status: "connected", tools: ["codex"], lastSeenAt: minutesAgo(1) }] },
      { sessions: [{ agentId: "s1", agentName: "Codex-A", tool: "codex", deviceId: "d1", deviceName: "Solo-PC", projectKey: "p", projectName: "P", online: true }] });
    switchToComputerView();
    const card = Array.from(document.querySelectorAll(".project-card")).find((c) => c.querySelector(".project-card-title")?.textContent === "Solo-PC")!;
    expect(card.querySelectorAll(".session-device-label")).toHaveLength(0);
    expect(card.textContent).toContain("Codex"); // still named once, in the header badge
  });

  it("a computer with two tools historically but only one live now still names that tool in the body (Reviewer's finding on #159)", () => {
    // tools (the header badges) is a historical union that never shrinks; byTool.size only counts
    // currently-live sessions. Using byTool.size to decide whether to suppress the group heading
    // would show 2 badges up top with zero tool label anywhere in the body once one tool's session
    // ends -- singleTool must key off `tools`, what the header actually shows.
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [{ deviceId: "d1", name: "Two-Tool-PC", status: "connected", tools: ["codex", "claude-code"], lastSeenAt: minutesAgo(1) }] },
      { sessions: [{ agentId: "s1", agentName: "Codex-A", tool: "codex", deviceId: "d1", deviceName: "Two-Tool-PC", projectKey: "p", projectName: "P", online: true }] });
    switchToComputerView();
    const card = Array.from(document.querySelectorAll(".project-card")).find((c) => c.querySelector(".project-card-title")?.textContent === "Two-Tool-PC")!;
    expect(card.querySelectorAll(".tool-badges .vendor-tag")).toHaveLength(2); // Codex and Claude Code, both historical
    expect(card.querySelector(".session-device-label")!.textContent).toBe("Codex"); // still named once in the body, unambiguously
  });

  it("a removed computer that connected at least once is tucked behind a collapsed 'Removed' line, not shown inline", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, sessions);
    switchToComputerView();
    const details = document.querySelector(".fleet-removed") as HTMLDetailsElement;
    expect(details.hasAttribute("open")).toBe(false); // collapsed by default
    expect(details.querySelector("summary")!.textContent).toBe("Removed (1)");
    const oldCard = details.querySelector(".project-card")!;
    expect(oldCard.closest(".fleet-removed")).toBe(details); // nested under Removed, not inline with active cards
    expect(oldCard.querySelector(".project-card-title")!.textContent).toBe("Old-Laptop");
    expect(oldCard.className).toContain("is-revoked");
    expect(oldCard.textContent).toContain("Removed");
    expect(oldCard.querySelector(".hold")).toBeFalsy();
  });

  it("hides merged rows: a code that reconnected a computer is never a computer card of its own", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [...devices.devices, { deviceId: "d3", name: "PC-2 again", status: "merged", mergedIntoDeviceId: "d1", tools: [] } as Device] }, sessions);
    switchToComputerView();
    const titles = Array.from(document.querySelectorAll(".project-card-title")).map((n) => n.textContent);
    expect(titles).toEqual(["PC-2", "Old-Laptop"]);
  });

  it("only merged rows still reads as no computers yet", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [{ deviceId: "d3", name: "Ghost", status: "merged", mergedIntoDeviceId: "gone" } as Device] }, { sessions: [] });
    expect($("fleet-groups").textContent).toMatch(/add a computer to start/i);
  });

  it("a revoked device that never connected doesn't show at all, not even collapsed", () => {
    // Created and removed before its code was ever redeemed: last_seen_at is only ever set by a
    // real device request, so a null value here means it never did anything worth remembering.
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups({ devices: [{ deviceId: "d4", name: "Kiosk", status: "revoked", lastSeenAt: null } as Device] }, { sessions: [] });
    expect($("fleet-groups").textContent).not.toContain("Kiosk");
    expect(document.querySelector(".fleet-removed")).toBeFalsy();
    expect($("fleet-groups").textContent).toMatch(/add a computer to start/i);
  });

  it("toggling back to By project re-renders the project grouping from the same cached data", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, sessions);
    switchToComputerView();
    (Array.from(document.querySelectorAll(".view-toggle-btn")).find((b) => (b as HTMLElement).dataset.view === "project") as HTMLButtonElement).click();
    const titles = Array.from(document.querySelectorAll(".project-card-title")).map((n) => n.textContent);
    expect(titles).toEqual(["OpenCadre"]);
  });

  it("marks the active toggle button with aria-pressed and is-active", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, sessions);
    switchToComputerView();
    const [projectBtn, computerBtn] = Array.from(document.querySelectorAll(".view-toggle-btn")) as HTMLElement[];
    expect(computerBtn.classList.contains("is-active")).toBe(true);
    expect(computerBtn.getAttribute("aria-pressed")).toBe("true");
    expect(projectBtn.classList.contains("is-active")).toBe(false);
    expect(projectBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("removeComputer", () => {
  it("DELETEs the device", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/v1/org/devices/d1" ? json(200, {}) : json(200, { devices: [], sessions: [] })));
    const { removeComputer } = loadConsole(fetchMock);
    await removeComputer({ deviceId: "d1", name: "PC-2" });
    const deleteCall = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/org/devices/d1" && opts?.method === "DELETE");
    expect(deleteCall).toBeTruthy();
  });

  it("resets the hold button and toasts on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500, { error: "hub is down" }));
    const { removeComputer } = loadConsole(fetchMock);
    const resetHold = vi.fn();
    await removeComputer({ deviceId: "d1", name: "PC-2" }, { resetHold });
    expect(resetHold).toHaveBeenCalled();
    expect($("toast").textContent).toMatch(/remove failed/i);
  });
});

describe("Rename (the only session row action in v1)", () => {
  const devices = { devices: [{ deviceId: "d1", name: "PC-2", status: "connected", tools: ["codex"] }] };

  it("Save PATCHes the new name and Cancel reverts without calling the API", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/v1/org/sessions/s1" ? json(200, {}) : json(200, { devices: [], sessions: [] })));
    const { renderFleetGroups } = loadConsole(fetchMock);
    renderFleetGroups(devices, { sessions: [{ agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true }] });

    const strip = document.querySelector(".strip")!;
    (Array.from(strip.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click();
    const input = strip.querySelector("input") as HTMLInputElement;
    // Sessions PR1: the form asks for a lasting name (a profile), not an edit of the automatic one. The chat then answers
    // as "<name> #<n>", which the hub picks.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Atlas");
    input.value = "Supervisor";
    (Array.from(strip.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement).click();
    await flush();
    const patchCall = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/org/sessions/s1" && opts?.method === "PATCH");
    expect(JSON.parse(patchCall![1].body)).toEqual({ name: "Supervisor" });
  });

  it("a chat already named into a profile opens the form on that name", () => {
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [{ agentId: "s1", agentName: "Atlas #2", profileName: "Atlas", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true }] });
    const strip = document.querySelector(".strip")!;
    (Array.from(strip.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click();
    expect((strip.querySelector(".rename-form input") as HTMLInputElement).value).toBe("Atlas");
  });

  it("asks once to name a chat with an automatic name: Keep posts keep-name, Name it opens the form", async () => {
    const fetchMock = vi.fn(async () => json(200, { devices: [], sessions: [] }));
    const { renderFleetGroups } = loadConsole(fetchMock);
    const legacy = { agentId: "s1", agentName: "Codex-OpenCadre-3f2a", namePromptDue: true, tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true };
    renderFleetGroups(devices, { sessions: [legacy, { ...legacy, agentId: "s2", agentName: "Birch", namePromptDue: false }] });
    const byName = (name: string) => Array.from(document.querySelectorAll(".strip")).find((x) => x.querySelector(".callsign")?.textContent === name)!;
    const [first, second] = [byName("Codex-OpenCadre-3f2a"), byName("Birch")];
    expect(first.querySelector(".name-prompt")?.textContent).toContain("This chat has an automatic name");
    expect(second.querySelector(".name-prompt")).toBeNull();

    (Array.from(first.querySelectorAll(".name-prompt button")).find((b) => b.textContent === "Name it") as HTMLButtonElement).click();
    expect(first.querySelector(".rename-form input")).not.toBeNull();
    expect((first.querySelector(".name-prompt") as HTMLElement).hidden).toBe(true);
    (Array.from(first.querySelectorAll(".rename-form button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
    expect((first.querySelector(".name-prompt") as HTMLElement).hidden).toBe(false);

    (Array.from(first.querySelectorAll(".name-prompt button")).find((b) => b.textContent === "Keep this name") as HTMLButtonElement).click();
    await flush();
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/v1/org/sessions/s1/keep-name" && (opts as RequestInit | undefined)?.method === "POST")).toBe(true);
    expect(first.querySelector(".name-prompt")).toBeNull();
  });

  it("a session row's actions sit in one menu: Message and Rename, and no Remove the viewer can't use", () => {
    // Console v2 (docs/design/CONSOLE-V2.md): the actions moved off every row into an Actions menu, and Message was
    // added (F1: the console could only reply, never write first).
    const { renderFleetGroups } = loadConsole();
    renderFleetGroups(devices, { sessions: [{ agentId: "s1", agentName: "S", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "P", online: true }] });
    const strip = document.querySelector(".strip")!;
    const buttons = Array.from(strip.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Message", "Rename"]);
    expect(strip.querySelectorAll(".row-menu button")).toHaveLength(2);
  });

  it("a poll updates every visible row while preserving the open Actions menu and applies new rows when it closes", () => {
    const { renderFleetGroups } = loadConsole();
    const session = { agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true,
      currentTask: "Old task A", state: "waiting", phase: "planning", editing_files_parsed: ["old-a.ts"] };
    const second = { ...session, agentId: "s2", agentName: "Claude-OpenCadre-9a1b", currentTask: "Old task B", state: "online", phase: "review", editing_files_parsed: ["old-b.ts"] };
    renderFleetGroups(devices, { sessions: [session, second] });
    const menu = document.querySelector(".row-menu") as HTMLDetailsElement;
    menu.open = true;
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#fleet-groups .row-fleet"));
    const updatedA = { ...session, currentTask: "Current task A", state: "working", phase: "editing", editing_files_parsed: ["src/a.ts", "src/b.ts"] };
    const updatedB = { ...second, online: false, currentTask: "Current task B", state: "offline", phase: "testing", editing_files_parsed: ["tests/b.test.ts"] };
    const newAgent = { ...session, agentId: "s3", agentName: "New current session", currentTask: "New row task" };
    renderFleetGroups(devices, { sessions: [updatedA, updatedB, newAgent] });
    expect(document.querySelector(".row-menu")).toBe(menu);
    expect(menu.open).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLElement>("#fleet-groups .row-fleet"))).toEqual(rows);
    const rowA = document.querySelector<HTMLElement>('[data-agent-id="s1"]')!;
    const rowB = document.querySelector<HTMLElement>('[data-agent-id="s2"]')!;
    expect(rowA.querySelector(".strip-body")?.textContent).toBe("Current task A");
    expect(rowA.classList.contains("strip--working")).toBe(true);
    expect(rowA.querySelector(".state-word")?.textContent).toBe("working");
    expect(rowA.querySelector(".phase-chip")?.textContent).toBe("editing");
    expect(rowA.querySelector(".files-count summary")?.textContent).toContain("2 files");
    expect(rowA.querySelector(".files-list")?.textContent).toContain("src/b.ts");
    expect(rowB.querySelector(".strip-body")?.textContent).toBe("Current task B");
    expect(rowB.classList.contains("strip--idle")).toBe(true);
    expect(rowB.querySelector(".state-word")?.textContent).toMatch(/^idle/);
    expect(rowB.querySelector(".phase-chip")?.textContent).toBe("testing");
    expect(rowB.querySelector(".files-count summary")?.textContent).toContain("1 file");
    expect($("fleet-groups").textContent).not.toContain("New current session");
    menu.open = false;
    menu.dispatchEvent(new Event("toggle"));
    expect($("fleet-groups").textContent).toContain("New current session");
  });

  it("keeps one Actions menu open and dismisses on outside click, Escape, and navigation", () => {
    const { renderFleetGroups, selectTab } = loadConsole();
    const first = { agentId: "s1", agentName: "First", tool: "codex", projectName: "OpenCadre", online: true };
    const second = { ...first, agentId: "s2", agentName: "Second" };
    renderFleetGroups(devices, { sessions: [first, second] });
    const [menuA, menuB] = Array.from(document.querySelectorAll<HTMLDetailsElement>(".row-menu"));
    const summaryA = menuA.querySelector("summary")!;
    const summaryB = menuB.querySelector("summary")!;
    menuA.open = true;
    menuA.dispatchEvent(new Event("toggle"));
    menuB.open = true;
    menuB.dispatchEvent(new Event("toggle"));
    expect(menuA.open).toBe(false);
    expect(menuB.open).toBe(true);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuB.open).toBe(false);

    menuA.open = true;
    menuA.dispatchEvent(new Event("toggle"));
    summaryA.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menuA.open).toBe(false);
    expect(summaryA.isConnected).toBe(true);
    expect(document.activeElement).toBe(summaryA);

    menuB.open = true;
    menuB.dispatchEvent(new Event("toggle"));
    selectTab("home");
    expect(menuB.open).toBe(false);
    expect(summaryB.isConnected).toBe(true);
  });

  it("Escape restores the owning Actions summary after applying a queued poll", async () => {
    const { renderFleetGroups } = loadConsole();
    const session = { agentId: "s1", agentName: "First", tool: "codex", projectName: "OpenCadre", online: true };
    renderFleetGroups(devices, { sessions: [session] });
    const menu = document.querySelector<HTMLDetailsElement>(".row-menu")!;
    menu.open = true;
    menu.dispatchEvent(new Event("toggle"));
    renderFleetGroups(devices, { sessions: [session, { ...session, agentId: "s2", agentName: "Added while open" }] });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    menu.dispatchEvent(new Event("toggle")); // model the queued native details toggle event
    await flush();

    expect($("fleet-groups").textContent).toContain("Added while open");
    const currentSummary = document.querySelector<HTMLElement>('[data-agent-id="s1"] .row-menu summary')!;
    expect(currentSummary.isConnected).toBe(true);
    expect(document.activeElement).toBe(currentSummary);
  });

  it("ignores a delayed toggle from a menu detached by access refusal", () => {
    const { renderFleetGroups } = loadConsole();
    const old = { agentId: "old", agentName: "Old", tool: "codex", projectName: "Old", online: true };
    renderFleetGroups(devices, { sessions: [old] });
    const detached = document.querySelector<HTMLDetailsElement>(".row-menu")!;
    detached.open = true; // native toggle is queued, but not delivered yet
    renderFleetGroups(null, null);
    const current = { ...old, agentId: "current", agentName: "Current" };
    renderFleetGroups(devices, { sessions: [current] });
    const liveMenu = document.querySelector<HTMLDetailsElement>(".row-menu")!;
    liveMenu.open = true;
    liveMenu.dispatchEvent(new Event("toggle"));

    detached.dispatchEvent(new Event("toggle"));
    expect(liveMenu.isConnected).toBe(true);
    expect(liveMenu.open).toBe(true);
  });

  it("patches named-agent state and task while an Actions menu holds structural updates", () => {
    const { renderFleetGroups, setAgentsView } = loadConsole();
    const session = { agentId: "s1", agentName: "Session", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true };
    const named = { id: "named-1", name: "Named agent", kind: "named", key_class: "agent", online: true, current_task: "Old named task", state: "waiting", role: "agent" };
    renderFleetGroups(devices, { sessions: [session] }, [named]);
    setAgentsView("computer", { record: false });
    const menu = document.querySelector<HTMLDetailsElement>(".row-menu")!;
    menu.open = true;
    menu.dispatchEvent(new Event("toggle"));
    renderFleetGroups(devices, { sessions: [session, { ...session, agentId: "s2", agentName: "Added session" }] },
      [{ ...named, current_task: "Current named task", state: "working", online: true }]);

    const namedRow = document.querySelector<HTMLElement>(".unlinked-agents .row-fleet")!;
    expect(namedRow.querySelector(".strip-body")?.textContent).toBe("Current named task");
    expect(namedRow.classList.contains("strip--working")).toBe(true);
    expect(namedRow.querySelector(".state-word")?.textContent).toBe("working");
    expect($("fleet-groups").textContent).not.toContain("Added session");
  });

  it("closes the Actions menu when Rename starts and keeps its focused draft through a poll", () => {
    const { renderFleetGroups } = loadConsole();
    const session = { agentId: "s1", agentName: "First", tool: "codex", projectName: "OpenCadre", online: true };
    renderFleetGroups(devices, { sessions: [session] });
    const row = document.querySelector<HTMLElement>('[data-agent-id="s1"]')!;
    const menu = row.querySelector<HTMLDetailsElement>(".row-menu")!;
    menu.open = true;
    menu.dispatchEvent(new Event("toggle"));
    const rename = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Rename")!;
    rename.click();

    const input = row.querySelector<HTMLInputElement>(".rename-form input")!;
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = "Typed draft";
    renderFleetGroups(devices, { sessions: [{ ...session, currentTask: "Latest task" }, { ...session, agentId: "s2", agentName: "Added" }] });

    expect(row.querySelector(".rename-form input")).toBe(input);
    expect(input.value).toBe("Typed draft");
    expect(document.activeElement).toBe(input);
    expect(row.querySelector(".strip-body")?.textContent).toBe("Latest task");
  });

  it("Message keeps its in-flight controls while a poll updates existing row status (F1)", async () => {
    let resolveSend!: (response: ReturnType<typeof json>) => void;
    const fetchMock = vi.fn((url: string) => url === "/v1/messages"
      ? new Promise<ReturnType<typeof json>>((resolve) => { resolveSend = resolve; })
      : Promise.resolve(json(200, {})));
    const { renderFleetGroups } = loadConsole(fetchMock);
    const session = { agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true,
      currentTask: "Old task", state: "waiting", phase: "planning" };
    const other = { ...session, agentId: "s2", agentName: "Claude-OpenCadre-9a1b", currentTask: "Old second task", state: "online", phase: "review" };
    renderFleetGroups(devices, { sessions: [session, other] });
    (Array.from(document.querySelector('[data-agent-id="s1"]')!.querySelectorAll("button")).find((b) => b.textContent === "Message") as HTMLButtonElement).click();
    const text = document.querySelector(".message-form textarea") as HTMLTextAreaElement;
    text.value = "Please rebase onto main";
    const send = Array.from(document.querySelectorAll<HTMLButtonElement>(".message-form button")).find((b) => b.textContent === "Send")!;
    send.click();
    expect(send.disabled).toBe(true);

    const updatedA = { ...session, currentTask: "Current task", state: "working", phase: "editing" };
    const updatedB = { ...other, currentTask: "Current second task", state: "waiting", phase: "testing" };
    const newRow = { ...session, agentId: "s3", agentName: "Added during send" };
    renderFleetGroups(devices, { sessions: [updatedA, updatedB, newRow] });
    expect(document.querySelector(".message-form textarea")).toBe(text);
    expect(text.value).toBe("Please rebase onto main");
    expect(send.disabled).toBe(true);
    const rowA = document.querySelector<HTMLElement>('[data-agent-id="s1"]')!;
    const rowB = document.querySelector<HTMLElement>('[data-agent-id="s2"]')!;
    expect(rowA.querySelector(".strip-body")?.textContent).toBe("Current task");
    expect(rowA.querySelector(".state-word")?.textContent).toBe("working");
    expect(rowA.querySelector(".phase-chip")?.textContent).toBe("editing");
    expect(rowB.querySelector(".strip-body")?.textContent).toBe("Current second task");
    expect(rowB.querySelector(".state-word")?.textContent).toBe("waiting");
    expect(rowB.querySelector(".phase-chip")?.textContent).toBe("testing");
    expect($("fleet-groups").textContent).not.toContain("Added during send");

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/v1/messages")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/v1/messages")! as unknown as [string, { method: string; body: string }];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ toAgent: "Codex-OpenCadre-3f2a", body: "Please rebase onto main" });
    resolveSend(json(201, { ok: true }));
    await vi.waitFor(() => expect(document.querySelector(".message-form")).toBeNull());
    expect($("fleet-groups").textContent).toContain("Added during send");
  });

  it("a message callback from an old console generation cannot apply the new generation's held rows", async () => {
    let resolveSend!: (response: ReturnType<typeof json>) => void;
    const fetchMock = vi.fn((url: string) => url === "/v1/messages"
      ? new Promise<ReturnType<typeof json>>((resolve) => { resolveSend = resolve; })
      : Promise.resolve(json(200, {})));
    const { renderFleetGroups, beginConsoleGeneration } = loadConsole(fetchMock);
    const oldSession = { agentId: "old", agentName: "Old workspace agent", tool: "codex", projectName: "Old", online: true };
    renderFleetGroups(devices, { sessions: [oldSession] });
    (Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Message") as HTMLButtonElement).click();
    (document.querySelector(".message-form textarea") as HTMLTextAreaElement).value = "old workspace draft";
    (Array.from(document.querySelectorAll<HTMLButtonElement>(".message-form button")).find((button) => button.textContent === "Send")!).click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/v1/messages")).toBe(true));

    beginConsoleGeneration();
    const current = { agentId: "new", agentName: "Current workspace agent", tool: "codex", projectName: "Current", online: true };
    renderFleetGroups(devices, { sessions: [current] });
    const currentMenu = document.querySelector<HTMLDetailsElement>(".row-menu")!;
    currentMenu.open = true;
    currentMenu.dispatchEvent(new Event("toggle"));
    const added = { ...current, agentId: "newer", agentName: "Current pending row" };
    renderFleetGroups(devices, { sessions: [current, added] });

    resolveSend(json(201, { ok: true }));
    await flush();
    expect(currentMenu.isConnected).toBe(true);
    expect(currentMenu.open).toBe(true);
    expect($("fleet-groups").textContent).not.toContain("Current pending row");
    expect($("toast").textContent).not.toContain("Old workspace agent");

    currentMenu.open = false;
    currentMenu.dispatchEvent(new Event("toggle"));
    expect($("fleet-groups").textContent).toContain("Current pending row");
  });

  it("a poll updates other rows while preserving the typed rename form (bug #153)", () => {
    const { renderFleetGroups } = loadConsole();
    const session = { agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true };
    const otherSession = { agentId: "s2", agentName: "Claude-OpenCadre-9a1b", tool: "claude-code", deviceId: "d1", deviceName: "PC-2", projectName: "OpenCadre", online: true,
      currentTask: "Before rename", state: "online", phase: "review", editing_files_parsed: ["old.ts"] };
    renderFleetGroups(devices, { sessions: [session, otherSession] });

    (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click();
    const input = document.querySelector(".rename-form input") as HTMLInputElement;
    input.value = "Supervisor (typing...)";

    // A poll tick lands mid-edit, updates an existing row, and adds a new session.
    const updatedOtherSession = { ...otherSession, currentTask: "Updated during rename", state: "blocked", phase: "waiting", editing_files_parsed: ["src/blocked.ts"] };
    const newSession = { ...updatedOtherSession, agentId: "s3", agentName: "Added during rename" };
    renderFleetGroups(devices, { sessions: [session, updatedOtherSession, newSession] });

    // The open rename form -- and what the user already typed into it -- must survive untouched.
    const stillOpen = document.querySelector(".rename-form input") as HTMLInputElement;
    expect(stillOpen).toBe(input);
    expect(stillOpen.value).toBe("Supervisor (typing...)");
    expect($("fleet-groups").textContent).not.toContain("Added during rename");
    const otherRow = document.querySelector<HTMLElement>('[data-agent-id="s2"]')!;
    expect(otherRow.querySelector(".strip-body")?.textContent).toBe("Updated during rename");
    expect(otherRow.querySelector(".state-word")?.textContent).toBe("blocked");
    expect(otherRow.querySelector(".phase-chip")?.textContent).toBe("waiting");
    expect(otherRow.querySelector(".files-list")?.textContent).toContain("src/blocked.ts");

    // Cancelling flushes the update the poll queued, same as remove-confirm's cancel does.
    (Array.from(document.querySelectorAll(".rename-form button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
    expect(document.querySelector(".rename-form")).toBeNull();
    expect($("fleet-groups").textContent).toContain("Added during rename");
  });
});

describe("renderEndedSessions", () => {
  it("collapses into 'N ended today', hidden when there are none", () => {
    const { renderEndedSessions } = loadConsole();
    renderEndedSessions([]);
    expect(($("sessions-ended") as HTMLDetailsElement).hidden).toBe(true);

    renderEndedSessions([
      { agentId: "s1", agentName: "Gone-One", tool: "codex", projectName: "OpenCadre", deviceName: "PC-2", endedAt: minutesAgo(30) },
      { agentId: "s2", agentName: "Gone-Two", tool: "cursor", projectName: "Sidecar", deviceName: "PC-1", endedAt: minutesAgo(90) },
    ]);
    expect(($("sessions-ended") as HTMLDetailsElement).hidden).toBe(false);
    expect($("sessions-ended-summary").textContent).toBe("2 ended in the last 24 hours");
    expect($("sessions-ended-list").textContent).toContain("Gone-One");
    expect($("sessions-ended-list").textContent).toContain("Gone-Two");
  });
});

// Plan 2026-09-30-console-refresh-tasks.md §2 item 5 (Codex-OpenCadre-049a's ruling): an agent that connects with its
// own key has no computer the hub knows of. It is listed as such, under "Agents without a linked computer", without
// inventing a computer for it; every row says when it was last seen; and ended or offline rows stay apart from live.
describe("Agents without a linked computer", () => {
  type RosterAgent = { id: string; name: string; kind?: string; key_class?: string; role?: string; online: boolean; state?: string; state_reason?: string;
    last_heartbeat_at: string | null; current_task?: string | null; editing_files_parsed: string[] };
  const named = (id: string, name: string, over: Partial<RosterAgent> = {}): RosterAgent =>
    ({ id, name, kind: "named", key_class: "agent", role: "agent", online: true, state: "online", last_heartbeat_at: minutesAgo(1), editing_files_parsed: [], ...over });
  const devices = { devices: [{ deviceId: "d1", name: "PC-1", status: "connected", tools: ["codex"] }] };
  const live = { sessions: [{ agentId: "s1", agentName: "Codex-OpenCadre-3f2a", tool: "codex", deviceId: "d1", deviceName: "PC-1", projectKey: "p", projectName: "P", online: true }] };
  const roster = [
    named("c1", "Cursor-Cloud"),
    named("w1", "Windsurf-Lane", { state: "idle", state_reason: "no status update in the last 30 minutes" }),
    named("r1", "Reasonix-Old", { online: false, state: "offline", last_heartbeat_at: minutesAgo(3 * 24 * 60) }),
    named("s1", "Codex-OpenCadre-3f2a", { kind: "session" }),
    named("m1", "Ada", { key_class: "human" }),
  ];
  const renderWith = (d: unknown, l: unknown, a: unknown) =>
    (loadConsole().renderFleetGroups as unknown as (d: unknown, l: unknown, a: unknown) => void)(d, l, a);
  const byComputer = () => document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="computer"]')!.click();
  const card = (title: string) => [...document.querySelectorAll("#fleet-groups .project-card")]
    .find((c) => c.querySelector(".project-card-title")?.textContent === title) as HTMLElement | undefined;
  const group = () => card("Agents without a linked computer");

  it("By computer lists keyed agents in their own group, and never under a computer", () => {
    renderWith(devices, live, roster);
    byComputer();
    expect(group()).toBeTruthy();
    const names = [...group()!.querySelectorAll(".callsign")].map((n) => n.textContent);
    expect(names).toEqual(["Cursor-Cloud", "Windsurf-Lane", "Reasonix-Old"]);
    // No tool guessed from a name: the hub reports none for these agents.
    expect(group()!.querySelector(".vendor-tag")).toBeNull();
    expect(group()!.querySelector(".strip[data-vendor]")).toBeNull();
    // The computer's own card holds only its session: no keyed agent is placed on a computer.
    expect([...card("PC-1")!.querySelectorAll(".callsign")].map((n) => n.textContent)).toEqual(["Codex-OpenCadre-3f2a"]);
    // It says why, without claiming they are not on a computer.
    // In sight beside the key icon, not in a tooltip or for screen readers only.
    expect(group()!.querySelector(".unlinked-note")?.textContent).toBe("Own key · computer unknown");
    expect(group()!.querySelector(".unlinked-note .visually-hidden")).toBeNull();
    expect(group()!.querySelector(".unlinked-note")?.hasAttribute("title")).toBe(false);
  });

  it("every row says when it was last seen, an idle row says idle, and offline rows sit apart under Offline", () => {
    renderWith(devices, live, roster);
    byComputer();
    const row = (name: string) => [...group()!.querySelectorAll(".strip")].find((s) => s.querySelector(".callsign")?.textContent === name)!;
    expect(row("Windsurf-Lane").querySelector(".state-word")?.textContent).toBe("idle");
    expect(row("Windsurf-Lane").querySelector(".strip-meta")?.textContent).toContain("last seen 1m ago");
    expect(row("Cursor-Cloud").querySelector(".strip-meta")?.textContent).toContain("last seen 1m ago");
    expect(row("Reasonix-Old").querySelector(".strip-meta")?.textContent).toContain("last seen 3d ago");
    expect(row("Reasonix-Old").querySelector(".strip-body")?.textContent).toBe("Not connected");
    const offlineLabel = [...group()!.querySelectorAll(".session-device-label")].find((l) => l.textContent === "Offline")!;
    expect(offlineLabel).toBeTruthy();
    // The offline row comes after the label; the live ones before it.
    expect(offlineLabel.compareDocumentPosition(row("Reasonix-Old")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(offlineLabel.compareDocumentPosition(row("Cursor-Cloud")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("no keyed agents, no group", () => {
    renderWith(devices, live, [named("s1", "Codex-OpenCadre-3f2a", { kind: "session" })]);
    byComputer();
    expect(group()).toBeUndefined();
  });

  it("an ended session is never shown among live ones, even if the live list carries it", () => {
    const { renderFleetGroups, renderEndedSessions } = loadConsole();
    const gone = { agentId: "s9", agentName: "Gone-Nine", tool: "codex", deviceId: "d1", deviceName: "PC-1", projectKey: "p", projectName: "P", online: false, endedAt: minutesAgo(5) };
    renderFleetGroups(devices, { sessions: [...live.sessions, gone] });
    renderEndedSessions([gone]);
    expect($("fleet-groups").textContent).not.toContain("Gone-Nine");
    expect($("sessions-ended-list").textContent).toContain("Gone-Nine");
    byComputer();
    expect($("fleet-groups").textContent).not.toContain("Gone-Nine");
  });

  it("the Agents page names the group the same way in its view switch", () => {
    const labels = [...document.querySelectorAll(".view-toggle-btn")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels).toEqual(["By project", "By computer", "Agents without a linked computer"]);
    expect(document.body.textContent).not.toMatch(/named agents/i);
  });
});

// Coordinator on item 5 (2026-09-30): idle and offline agree on every page. A LIVE session with no heartbeat for a while
// is "idle Nm" on Home, By computer and By project; "offline" / "Not connected" is only for what is not live.
describe("a quiet live session reads idle on every Agents view", () => {
  const devices = { devices: [{ deviceId: "d1", name: "PC-1", status: "connected", tools: ["cursor"] }] };
  const quiet = { agentId: "q1", agentName: "Cursor-api-11cd", tool: "cursor", deviceId: "d1", deviceName: "PC-1", projectKey: "p", projectName: "P",
    online: false, lastHeartbeatAt: minutesAgo(12) };
  const rowText = () => document.querySelector("#fleet-groups .strip")!.textContent ?? "";
  const word = () => document.querySelector("#fleet-groups .state-word")!.textContent;

  it("By project", () => {
    const { renderFleetGroups } = loadConsole();
    (renderFleetGroups as unknown as (d: unknown, l: unknown, a: unknown) => void)(devices, { sessions: [quiet] }, [{ id: "q1", state: "offline" }]);
    expect(word()).toBe("idle 12m");
    expect(rowText()).not.toMatch(/offline|Idle|seen /);
  });

  it("By computer", () => {
    const { renderFleetGroups } = loadConsole();
    (renderFleetGroups as unknown as (d: unknown, l: unknown, a: unknown) => void)(devices, { sessions: [quiet] }, [{ id: "q1", state: "offline" }]);
    document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="computer"]')!.click();
    expect(word()).toBe("idle 12m");
    expect(rowText()).toContain("No task announced");
  });
});
