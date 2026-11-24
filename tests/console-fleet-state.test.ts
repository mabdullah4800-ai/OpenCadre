// @vitest-environment happy-dom
// Fleet state model on the console's EXISTING grouped session rows.
//
// THE HUB HAS SIX STATES, NOT FIVE. src/agent-state.ts on main:
//   export const AGENT_STATES = ["working", "waiting", "blocked", "idle", "online", "offline"] as const;
// `blocked` is returned when an agent is out of usage (computeAgentState: usageLimited -> "blocked").
// An earlier port shipped only five and silently dropped `blocked` back to the binary chip, so an
// out-of-usage agent rendered as "Live". These tests pin all six, including that one specifically.
//
// The console's sessions route (GET /v1/org/sessions) carries no `state`; the roster (GET /v1/agents)
// does and refresh() already fetches it, so state is joined by agentId with no extra network call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Device = { deviceId: string; name: string; status?: string; tools?: string[]; lastSeenAt?: string | null };
type Session = {
  agentId: string; agentName: string; tool: string; deviceId?: string; deviceName?: string | null;
  projectKey?: string | null; projectName?: string | null; online?: boolean; currentTask?: string | null;
  lastHeartbeatAt?: string | null; endedAt?: string | null; state?: string; state_reason?: string;
};
type RosterAgent = { id: string; state?: string; state_reason?: string; phase?: string | null; role?: string };

// The hub's canonical list. If this ever changes, this test should fail loudly.
const HUB_STATES = ["working", "waiting", "blocked", "idle", "online", "offline"] as const;

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : vi.fn()(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderFleetGroups, agentState };`,
  )(window, document, window.localStorage, wrapped) as {
    renderFleetGroups: (
      devicesData: { devices: Device[] } | null,
      liveData: { sessions: Session[] } | null,
      agentsData?: RosterAgent[] | null,
    ) => void;
    agentState: (a: { state?: string; online?: boolean }) => string;
  };
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const devices = { devices: [{ deviceId: "d1", name: "PC-1", status: "connected", tools: ["codex"], lastSeenAt: minutesAgo(1) }] };
const session = (id: string, name: string): Session => ({
  agentId: id, agentName: name, tool: "codex", deviceId: "d1", deviceName: "PC-1",
  projectKey: "p", projectName: "P", online: true,
});

const render = (sessions: Session[], roster: RosterAgent[] | undefined) => {
  const { renderFleetGroups } = loadConsole();
  renderFleetGroups(devices, { sessions }, roster);
};

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("all SIX hub states render, including blocked", () => {
  it("renders each of the six canonical states as its own dot class plus the state word", () => {
    render(
      HUB_STATES.map((s, i) => session(`s${i}`, `Agent-${s}`)),
      HUB_STATES.map((s, i) => ({ id: `s${i}`, state: s, state_reason: `${s} because X` })),
    );
    for (const s of HUB_STATES) {
      expect(document.querySelector(`.state-dot--${s}`), `dot for ${s}`).not.toBeNull();
    }
    const words = Array.from(document.querySelectorAll(".state-word")).map((n) => n.textContent);
    expect(words.sort()).toEqual([...HUB_STATES].sort());
  });

  it("REGRESSION: `blocked` (out of usage) renders as blocked, not as Live", () => {
    // The five-state port dropped this: an out-of-usage agent showed as "Live".
    render([session("s1", "A")], [{ id: "s1", state: "blocked", state_reason: "out of usage" }]);
    expect(document.querySelector(".state-dot--blocked")).not.toBeNull();
    expect(document.querySelector(".state-word")!.textContent).toBe("blocked");
    // Scoped to the rendered row: .status-chip exists elsewhere in index.html (e.g. the connect card),
    // so a document-wide query would pass or fail for reasons unrelated to the fleet row.
    const row = document.querySelector(".strip")!;
    expect(row.querySelector(".status-chip")).toBeNull();
    expect(row.textContent).toContain("blocked");
  });

  it("the six dots are mutually distinct classes", () => {
    render(
      HUB_STATES.map((s, i) => session(`s${i}`, `A${i}`)),
      HUB_STATES.map((s, i) => ({ id: `s${i}`, state: s })),
    );
    const dots = Array.from(document.querySelectorAll(".state-dot")).map((n) => n.className);
    expect(dots).toHaveLength(6);
    expect(new Set(dots).size).toBe(6);
  });

  it("the state word is ALWAYS in the DOM -- it is the channel that survives greyscale and a screen reader", () => {
    render([session("s1", "A")], [{ id: "s1", state: "working" }]);
    expect(document.querySelector(".state-word")!.textContent).toBe("working");
  });

  it("carries the row-level state modifier so the left edge tint can key off it", () => {
    render([session("s1", "A")], [{ id: "s1", state: "blocked" }]);
    expect(document.querySelector(".strip")!.className).toContain("strip--blocked");
  });

  it("uses state_reason as the disclosure title and in the accessible name", () => {
    render([session("s1", "A")], [{ id: "s1", state: "waiting", state_reason: "Blocked on an approval" }]);
    const chip = document.querySelector(".state-chip")!;
    expect(chip.getAttribute("title")).toBe("Blocked on an approval");
    expect(chip.getAttribute("aria-label")).toBe("waiting: Blocked on an approval");
  });

  it("falls back to the bare label for the accessible name when there is no reason", () => {
    render([session("s1", "A")], [{ id: "s1", state: "idle" }]);
    expect(document.querySelector(".state-chip")!.getAttribute("aria-label")).toBe("idle");
  });

  it("distinguishes the states the old binary lamp collapsed: working vs waiting vs blocked", () => {
    render(
      [session("s1", "A"), session("s2", "B"), session("s3", "C")],
      [{ id: "s1", state: "working" }, { id: "s2", state: "waiting" }, { id: "s3", state: "blocked" }],
    );
    const dots = Array.from(document.querySelectorAll(".state-dot")).map((n) => n.className);
    expect(new Set(dots).size).toBe(3);
  });
});

describe("fallbacks -- a state is always derivable", () => {
  it("no roster at all still renders a state dot from the heartbeat", () => {
    render([{ ...session("s1", "A"), online: true }], undefined);
    expect(document.querySelector(".state-dot--online")).not.toBeNull();
  });

  // Changed 2026-09-30 (plan 2026-09-30-console-refresh-tasks.md, coordinator on item 5): this used to pin "offline" for
  // a LIVE session with no recent heartbeat. The chat is still open, so it reads "idle 12m" on every page; offline is
  // only for what is not live (Codex-OpenCadre-049a's ruling: keep ended/offline apart from live).
  it("a live session with no recent heartbeat reads idle, for how long, even when the roster says offline", () => {
    render([{ ...session("s1", "A"), online: false, lastHeartbeatAt: minutesAgo(12) }], [{ id: "s1", state: "offline" }]);
    expect(document.querySelector(".state-dot--idle")).not.toBeNull();
    expect(document.querySelector(".state-dot--offline")).toBeNull();
    expect(document.querySelector(".state-word")!.textContent).toBe("idle 12m");
    expect(document.querySelector(".strip")!.className).toContain("strip--idle");
  });

  it("a session missing from the roster falls back by heartbeat", () => {
    render([session("s1", "A")], [{ id: "other", state: "working" }]);
    expect(document.querySelector(".state-dot--online")).not.toBeNull();
  });

  it("an unrecognised state value falls back rather than rendering an unstyled dot", () => {
    render([session("s1", "A")], [{ id: "s1", state: "teleporting" }]);
    expect(document.querySelector(".state-dot--teleporting")).toBeNull();
    expect(document.querySelector(".state-dot--online")).not.toBeNull();
  });

  it("the roster state WINS over the heartbeat when both are present", () => {
    render([{ ...session("s1", "A"), online: true }], [{ id: "s1", state: "blocked" }]);
    expect(document.querySelector(".state-dot--blocked")).not.toBeNull();
    expect(document.querySelector(".state-dot--online")).toBeNull();
  });

  it("agentState maps every canonical state and never returns undefined", () => {
    const { agentState } = loadConsole();
    for (const s of HUB_STATES) expect(agentState({ state: s, online: true })).toBe(s);
    expect(agentState({ online: true })).toBe("online");
    expect(agentState({ online: false })).toBe("offline");
    expect(agentState({ state: "nonsense", online: true })).toBe("online");
  });
});
