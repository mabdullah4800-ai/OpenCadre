// @vitest-environment happy-dom
// Connect tab's one primary action: "Add a computer" (Session Model v1, docs/design/SESSION_MODEL.md).
// It replaces the old per-tool connect-code flow -- POST /v1/org/devices no longer takes a client,
// since a computer auto-detects every supported tool it finds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn()) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { agentPasteInstructions, setSession: (m, k) => { me = m; agentKey = k; } };`,
  )(window, document, window.localStorage, wrapped) as {
    agentPasteInstructions: (command: string) => string;
    setSession: (identity: { agentId: string; agentName: string; role: string }, key: string) => void;
  };
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("agentPasteInstructions", () => {
  const CMD = "npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz connect --device --hub https://hub.opencadre.example --code ocd_abc123";

  it("embeds the exact command (not 'run the command above' -- the agent it's pasted into can't see the page)", () => {
    const { agentPasteInstructions } = loadConsole();
    const prompt = agentPasteInstructions(CMD);
    expect(prompt).toContain(CMD);
    expect(prompt).not.toMatch(/above/i);
  });

  it("tells the agent to run the command, show next steps verbatim, and tell the user to open a new session", () => {
    const { agentPasteInstructions } = loadConsole();
    const prompt = agentPasteInstructions(CMD);
    expect(prompt).toMatch(/run this command in this folder/i);
    expect(prompt).toMatch(/next steps.*word for word/i);
    expect(prompt).toMatch(/do not summarize/i);
    expect(prompt).toMatch(/tell me to open a new session or chat in this folder/i);
  });

  it("stays generic about the tool -- a computer can set up more than one, so there's no single client to name", () => {
    const { agentPasteInstructions } = loadConsole();
    const prompt = agentPasteInstructions(CMD);
    expect(prompt).not.toMatch(/claude code session|codex|paste that setup message/i);
  });

  it("never mentions a key", () => {
    const { agentPasteInstructions } = loadConsole();
    expect(agentPasteInstructions(CMD)).not.toMatch(/agt_|dev_|\bkey\b/i);
  });
});

describe("Add a computer", () => {
  it("posts only the name (no client -- the computer auto-detects), then shows the command with a working copy button", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(201, { deviceId: "d1", code: "ocd_dev123", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ... connect --device --code ocd_dev123" }),
    );
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");

    ($("computer-name") as HTMLInputElement).value = "PC-2";
    $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    const postCall = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/org/devices" && opts?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall![1].body)).toEqual({ name: "PC-2" });
    expect(($("computer-output") as HTMLElement).hidden).toBe(false);
    expect($("computer-cmd-text").textContent).toBe("npx ... connect --device --code ocd_dev123");
    expect($("computer-agent-prompt-text").textContent).toContain("npx ... connect --device --code ocd_dev123");

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    $("computer-copy-btn").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("npx ... connect --device --code ocd_dev123");
    vi.unstubAllGlobals();
  });

  it("the paste-in prompt's own copy button copies the prompt text, not the bare command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(201, { deviceId: "d1", code: "ocd_x", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ..." }),
    );
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ($("computer-name") as HTMLInputElement).value = "PC-2";
    $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    $("computer-agent-prompt-copy-btn").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/tell me to open a new session or chat/i));
    vi.unstubAllGlobals();
  });

  it("the waiting chip flips to Connected once the device list shows status: connected", async () => {
    vi.useFakeTimers();
    try {
      const devicesByPoll = [
        { devices: [{ deviceId: "d1", name: "PC-2", status: "waiting" }] },
        { devices: [{ deviceId: "d1", name: "PC-2", status: "connected", tools: ["claude-code"], sessionCount: 1 }] },
      ];
      const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          return json(200, devicesByPoll.length > 1 ? devicesByPoll.shift() : devicesByPoll[0]);
        }
        if (url.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
        const read = (opts?.method ?? "GET") === "GET" ? hubReadBody(url) : undefined;
        if (read !== undefined) return json(200, read);
        return json(201, { deviceId: "d1", code: "ocd_x", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ..." });
      });
      const ui = loadConsole(fetchMock);
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      ($("computer-name") as HTMLInputElement).value = "PC-2";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect($("computer-status-chip").textContent).toMatch(/waiting/i);
      await vi.advanceTimersByTimeAsync(3000); // poll #1: still "waiting"
      expect($("computer-status-chip").textContent).toMatch(/waiting/i);
      await vi.advanceTimersByTimeAsync(3000); // poll #2: status flips to "connected"
      expect($("computer-status-chip").textContent).toMatch(/connected/i);
      expect($("computer-status-chip").className).toContain("chip-online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a merged device (the command ran on a computer already connected) says which computer it updated, and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          return json(200, { devices: [
            { deviceId: "d0", name: "Office PC", status: "connected", tools: ["claude-code", "codex"] },
            { deviceId: "d1", name: "PC-2", status: "merged", mergedIntoDeviceId: "d0", tools: [] },
          ] });
        }
        if (url.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
        const read = (opts?.method ?? "GET") === "GET" ? hubReadBody(url) : undefined;
        if (read !== undefined) return json(200, read);
        return json(201, { deviceId: "d1", code: "ocd_x", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ..." });
      });
      const ui = loadConsole(fetchMock);
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      ($("computer-name") as HTMLInputElement).value = "PC-2";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect($("computer-status-chip").textContent).toBe("Connected: updated Office PC");
      expect($("computer-status-chip").className).toContain("chip-online");
      await vi.advanceTimersByTimeAsync(1000); // the one refresh() a terminal state asks for is coalesced (app.js REFRESH_SETTLE_MS); let it land
      const polls = () => fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET").length;
      const afterMerge = polls();
      await vi.advanceTimersByTimeAsync(9000); // polling should have stopped
      expect(polls()).toBe(afterMerge);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a removed computer stops polling and says so, rather than waiting forever", async () => {
    // `revoked` is what the hub reports for a device removed from the workspace. It is terminal at
    // the hub and everywhere else in the console, and this poller's chain had no branch for it, so
    // the command card kept asking /v1/org/devices every 3s for the life of the page load. The
    // assertion is on the POLLING, not on the chip text: a wrong fix can get the words right and
    // still leave the interval running.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          return json(200, { devices: [{ deviceId: "d1", name: "PC-2", status: "revoked" }] });
        }
        if (url.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
        const read = (opts?.method ?? "GET") === "GET" ? hubReadBody(url) : undefined;
        if (read !== undefined) return json(200, read);
        return json(201, { deviceId: "d1", code: "ocd_x", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ..." });
      });
      const ui = loadConsole(fetchMock);
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      ($("computer-name") as HTMLInputElement).value = "PC-2";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect($("computer-status-chip").textContent).toMatch(/removed/i);
      await vi.advanceTimersByTimeAsync(1000); // the one refresh() a terminal state asks for is coalesced (app.js REFRESH_SETTLE_MS); let it land
      const polls = () => fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET").length;
      const afterRevoked = polls();

      const timerText = $("computer-timer").textContent;

      await vi.advanceTimersByTimeAsync(9000); // polling AND the countdown should have stopped
      expect(polls()).toBe(afterRevoked);
      // The countdown is the same defect one interval over: it belongs to a code that can no longer
      // work, so it must stop with the poller instead of ticking "Expires in 14:44" beside "removed"
      // for the next 15 minutes. A live 1s interval decrements the text every second, so an unchanged
      // text across 9000ms is the assertion that the interval is gone.
      expect($("computer-timer").textContent).toBe(timerText);

      // The spent command comes off screen too -- the same thing the first-run card does with its own
      // (app.js :2512) -- leaving the status bar as the only thing on the card saying why.
      const box = () => $("computer-cmd-text").closest(".connect-cmd-box") as HTMLElement;
      expect(box().hidden).toBe(true);
      expect(($("computer-agent-prompt-text").closest(".connect-agent-prompt") as HTMLElement).hidden).toBe(true);
      expect(($("computer-timer").closest(".connect-card-head") as HTMLElement).hidden).toBe(true);
      // The point is to say what happened, not to go blank. Since the three-step guide, that is step 2's own message
      // (#wizard-dead): the status chip lives in step 3, which is still upcoming and so hidden (f46c on 60948ee).
      const said = $("wizard-dead");
      expect(said.hidden).toBe(false);
      expect($("wizard-dead-text").textContent).toMatch(/removed/i);
      // ...and nothing it lives inside is hidden, or "say why" would go dark with it.
      // (up to the Connect panel: this test never signs in, so #console itself stays hidden)
      for (let n: HTMLElement | null = said; n && !n.matches(".panel"); n = n.parentElement) expect(n.hidden, n.id || n.className).toBe(false);
      expect((said.closest(".wizard-step") as HTMLElement).dataset.state).toBe("current");
      expect(box().contains(said)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a command issued after a removed one puts the command back on screen", async () => {
    // The dead-command state above hides nodes INSIDE #computer-output, and showComputerOutput is the
    // only thing that re-opens that card. If it did not un-hide them, the second command a person got
    // would render as a card with no command in it at all -- a regression that first run never shows,
    // and that a person hits immediately after being told "add the computer again".
    vi.useFakeTimers();
    try {
      let created = 0;
      const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          return json(200, { devices: [{ deviceId: "d1", name: "PC-2", status: "revoked" }] });
        }
        if (url.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
        const read = (opts?.method ?? "GET") === "GET" ? hubReadBody(url) : undefined;
        if (read !== undefined) return json(200, read);
        // Count only the command-creating POSTs. The fallback catches every other path the console
        // calls (refresh() alone makes several), so an unconditional counter hands the second device
        // whatever number the rest of the page ran it up to -- the same confounded count the poll
        // assertions above had to avoid, one layer up.
        if (!(url === "/v1/org/devices" && opts?.method === "POST")) return json(200, {});
        created += 1;
        return json(201, { deviceId: "d1", code: `ocd_${created}`, expiresAt: new Date(Date.now() + 900_000).toISOString(), command: `npx ... connect --device --code ocd_${created}` });
      });
      const ui = loadConsole(fetchMock);
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      ($("computer-name") as HTMLInputElement).value = "PC-2";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      const box = () => $("computer-cmd-text").closest(".connect-cmd-box") as HTMLElement;
      const head = () => $("computer-timer").closest(".connect-card-head") as HTMLElement;
      expect(box().hidden).toBe(true);

      // Which is exactly what the person does next.
      ($("computer-name") as HTMLInputElement).value = "PC-3";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(box().hidden).toBe(false);
      expect(head().hidden).toBe(false);
      expect($("computer-cmd-text").textContent).toBe("npx ... connect --device --code ocd_2");
      expect($("computer-status-chip").textContent).toMatch(/waiting/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an expired code stops polling and says so, rather than waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          return json(200, { devices: [{ deviceId: "d1", name: "PC-2", status: "expired" }] });
        }
        if (url.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
        const read = (opts?.method ?? "GET") === "GET" ? hubReadBody(url) : undefined;
        if (read !== undefined) return json(200, read);
        return json(201, { deviceId: "d1", code: "ocd_x", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx ..." });
      });
      const ui = loadConsole(fetchMock);
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      ($("computer-name") as HTMLInputElement).value = "PC-2";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect($("computer-status-chip").textContent).toMatch(/expired/i);
      await vi.advanceTimersByTimeAsync(1000); // the one refresh() a terminal state asks for is coalesced (app.js REFRESH_SETTLE_MS); let it land
      const callsAfterExpiry = fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET").length;

      await vi.advanceTimersByTimeAsync(9000); // polling should have stopped
      expect(fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET").length).toBe(callsAfterExpiry);
    } finally {
      vi.useRealTimers();
    }
  });
});
