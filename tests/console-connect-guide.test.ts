// @vitest-environment happy-dom
// Add a computer as a three-step guide (the operator: "connect is so confusing"). The connect code is shown on its
// own instead of buried at the end of a command, the steps move name → run → chat as the computer connects, and
// the manual key setup shows one tool at a time. Every arm is red on the page before it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const state = (step: string) => $(`wizard-step-${step}`)?.dataset.state;

function loadConsole(fetchMock: (url: string, opts?: { method?: string }) => unknown) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, opts?: { method?: string }) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, opts);
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { showSnippets, setWizardStep, setSession: (m, k) => { me = m; agentKey = k; } };`,
  )(window, document, window.localStorage, wrapped) as {
    showSnippets: (name: string, key: string) => void;
    setWizardStep: (step: string, name: string, device: { name: string; tools?: string[] }) => void;
    setSession: (identity: unknown, key: string) => void;
  };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Add a computer walks through three steps", () => {
  it("shows the connect code, then explains the client steps still owed after registration", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const ui = loadConsole(async (url, opts) => {
        if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") {
          polls++;
          return json(200, { devices: [{ deviceId: "d1", name: "Work laptop", status: polls > 1 ? "connected" : "waiting", tools: ["claude-code", "codex"] }] });
        }
        if (url === "/v1/org/devices") {
          return json(201, { deviceId: "d1", code: "ocd_ABC123", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx -y x connect --hub h --code ocd_ABC123" });
        }
        return json(200, {});
      });
      ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
      expect(state("name")).toBe("current");
      expect(state("run")).toBe("upcoming");

      ($("computer-name") as HTMLInputElement).value = "Work laptop";
      $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect($("computer-code").textContent).toBe("ocd_ABC123");
      expect(state("name")).toBe("done");
      expect(state("run")).toBe("current");
      expect($("wizard-name-done").textContent).toBe("Work laptop");
      expect($("add-computer-form").hidden).toBe(true);
      // A fresh command re-shows the live parts of the card, but only the chosen way of running it.
      expect($("connect-mode-self-panel").hidden).toBe(false);
      expect($("connect-mode-agent-panel").hidden).toBe(true);

      await vi.advanceTimersByTimeAsync(6000);
      expect(state("run")).toBe("done");
      expect(state("chat")).toBe("current");
      expect($("wizard-chat-hint").textContent).toContain("Claude Code and Codex");
      expect($("wizard-chat-hint").textContent).not.toContain("set up");
      expect($("wizard-chat-hint").textContent).toContain("Finish");
      expect($("wizard-client-steps").textContent).toContain("Settings > Hooks");
      expect($("wizard-go-agents").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the command and the agent prompt are two choices, one shown at a time", () => {
    loadConsole(async () => json(200, {}));
    expect($("connect-mode-agent-panel").hidden).toBe(true);
    $("connect-mode-agent").click();
    expect($("connect-mode-agent-panel").hidden).toBe(false);
    expect($("connect-mode-self-panel").hidden).toBe(true);
    expect($("connect-mode-agent").getAttribute("aria-selected")).toBe("true");
  });
});

describe("setting a tool up by hand shows one tool at a time", () => {
  it("a picker over the snippets; every snippet stays in the page", () => {
    const ui = loadConsole(async () => json(200, {}));
    ui.showSnippets("d", "agt_test");
    const tabs = [...document.querySelectorAll("#snippets .snippet-picker [role=tab]")] as HTMLElement[];
    const blocks = [...document.querySelectorAll("#snippets .snippet")] as HTMLElement[];
    expect(tabs.length).toBe(blocks.length);
    expect(blocks.filter((b) => !b.hidden).length).toBe(1);
    tabs[3].click();
    expect(blocks.findIndex((b) => !b.hidden)).toBe(3);
  });
});

// Codex-OpenCadre-f46c on 60948ee: an expired or removed code left no visible explanation. Step 3 (still upcoming, so
// hidden) got the message and step 2 hid the spent command.
describe("a code that can no longer be used says so where you are", () => {
  for (const status of ["expired", "revoked"]) {
    it(`${status}: step 2 stays current, says why, and offers a new code with the name kept`, async () => {
      vi.useFakeTimers();
      try {
        const ui = loadConsole(async (url, opts) => {
          if (url === "/v1/org/devices" && (opts?.method ?? "GET") === "GET") return json(200, { devices: [{ deviceId: "d1", name: "Work laptop", status }] });
          if (url === "/v1/org/devices") return json(201, { deviceId: "d1", code: "ocd_X", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: "npx x --code ocd_X" });
          return json(200, {});
        });
        ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
        ($("computer-name") as HTMLInputElement).value = "Work laptop";
        $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
        await vi.advanceTimersByTimeAsync(3000);
        expect(state("run")).toBe("current");
        expect(state("chat")).toBe("upcoming");
        expect($("wizard-dead").hidden).toBe(false);
        expect($("wizard-dead-text").textContent).toMatch(status === "expired" ? /expired/i : /removed/i);
        $("wizard-dead-retry").click();
        expect(state("name")).toBe("current");
        expect($("add-computer-form").hidden).toBe(false);
        expect(($("computer-name") as HTMLInputElement).value).toBe("Work laptop");
      } finally {
        vi.useRealTimers();
      }
    });
  }
});


describe("connection guidance and keyboard controls", () => {
  it("shows the registered tool's remaining steps without claiming native verification", () => {
    const ui = loadConsole(async () => json(200, {}));
    ui.setWizardStep("chat", "Work laptop", { name: "Work laptop", tools: ["cursor"] });
    const rows = [...document.querySelectorAll<HTMLElement>("[data-connect-client]")];
    expect(rows.filter((row) => !row.hidden).map((row) => row.dataset.connectClient)).toEqual(["cursor"]);
    expect($("wizard-chat-hint").textContent).toContain("Cursor");
    expect($("wizard-chat-hint").textContent).not.toMatch(/set up|verified|ready/i);
    expect($("wizard-chat-check").textContent).toContain("call succeeds");
    expect($("wizard-chat-check").textContent).toContain("does not verify approvals or idle wake");
  });

  it("keeps guidance available when the device has no tool list, and on a later retry", () => {
    const ui = loadConsole(async () => json(200, {}));
    ui.setWizardStep("chat", "Work laptop", { name: "Work laptop", tools: ["cursor"] });
    ui.setWizardStep("chat", "Work laptop", { name: "Work laptop" });
    expect([...document.querySelectorAll<HTMLElement>("[data-connect-client]")].filter((row) => !row.hidden)).toHaveLength(4);
    expect($("wizard-client-steps").textContent).toContain("/hooks");
    expect($("wizard-client-steps").textContent).toContain("same chat");
  });

  it("keeps one tab stop and synchronizes focus, selection and panels for arrows, Home and End", () => {
    loadConsole(async () => json(200, {}));
    const self = $("connect-mode-self");
    const agent = $("connect-mode-agent");
    expect(self.tabIndex).toBe(0);
    expect(agent.tabIndex).toBe(-1);
    self.focus();
    for (const [key, expected] of [["ArrowRight", agent], ["ArrowRight", self], ["ArrowLeft", agent], ["Home", self], ["End", agent]] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(expected);
      expect(expected.getAttribute("aria-selected")).toBe("true");
      expect(expected.tabIndex).toBe(0);
      const other = expected === self ? agent : self;
      expect(other.tabIndex).toBe(-1);
      expect(other.getAttribute("aria-selected")).toBe("false");
      expect($(expected.getAttribute("aria-controls")!).hidden).toBe(false);
      expect($(other.getAttribute("aria-controls")!).hidden).toBe(true);
    }
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    agent.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    self.click();
    expect(self.tabIndex).toBe(0);
    expect(agent.tabIndex).toBe(-1);
  });
});
