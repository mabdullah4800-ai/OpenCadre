// @vitest-environment happy-dom
// Connect an app (easy onboarding, Slice 4a; docs/superpowers/plans/2026-10-30-easy-onboarding.md). Add a computer
// forks into "Computer" (the existing three-step guide) and "App": one card per app, its honest capabilities and one
// way in, built from the hub /v1/me names (the console is on app.opencadre.example, MCP on hub.opencadre.example), else the page's
// origin. Approvals and wake come only from the hooks the connect command installs (cli/lib/session-hooks.mjs,
// device.mjs), so the cards share one link back to the computer guide.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPERATOR_IDENTITY, hubReadBody } from "./helpers/console-hub-reads.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const card = (id: string) => document.querySelector(`#connect-apps [data-app="${id}"]`) as HTMLElement;
const code = (id: string) => [...card(id).querySelectorAll(".connect-cmd")].map((c) => c.textContent);
const href = (id: string) => (card(id).querySelector("a.app-action") as HTMLAnchorElement | null)?.getAttribute("href") ?? null;
const caps = (id: string) => [...card(id).querySelectorAll(".app-caps li")].map((li) => li.textContent);

type Ui = {
  setSession: (identity: Record<string, unknown>, key: string) => void;
  loadAndRender: () => Promise<void>;
  renderOtherAgents: (agents: unknown[]) => void;
  showSnippets: (name: string, key: string) => void;
  renderConnectApps: () => void;
  enterConsole: (identity: Record<string, unknown>) => Promise<void>;
};
/** The console at `origin`, signed in as `identity` (the /v1/me a refresh reads; by default one whose hub is this
 * origin) with the cards built from it, or left signed out with `signedIn: false`. An answer of `{ __status }` fails
 * that read with that status; `answers` is read at each request, so a test can change it between reads. */
function loadConsole(origin: string, identity: Record<string, unknown> = { ...OPERATOR_IDENTITY, hubUrl: origin }, answers: Record<string, unknown> = {}, signedIn = true): Ui {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(`${origin}/app/`);
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  vi.stubGlobal("WebSocket", class { readyState = 0; close() {} });
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const fetchMock = async (url: string) => {
    if (url.startsWith("/v1/auth/")) return json(401, { error: "no session" });
    const answer = answers[url.split("?")[0]] as { __status?: number } | undefined;
    if (answer?.__status) return json(answer.__status, { error: "unavailable" });
    return json(200, answer ?? hubReadBody(url, identity) ?? {});
  };
  const ui = new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { setSession: (m, k) => { me = m; agentKey = k; }, loadAndRender, renderOtherAgents, showSnippets, renderConnectApps, enterConsole };`,
  )(window, document, window.localStorage, fetchMock) as Ui;
  if (signedIn) {
    ui.setSession(identity, "agt_op");
    ui.renderConnectApps();
  }
  return ui;
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const HUB = "https://hub.opencadre.example";
const MCP = `${HUB}/mcp`;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Waits (real time, at most 3 s) for a condition a debounced refresh() settles. */
const until = async (cond: () => boolean) => { for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };
/** The list's status line, a persistent role=status beside the list (never inside it): [] when hidden. While it shows, the
 * list itself is empty. */
const statusLine = () => {
  const line = $("connect-apps-status");
  if (line.hidden) return [];
  expect($("connect-apps").children, "the list is empty while its status shows").toHaveLength(0);
  return [[line.getAttribute("role"), line.textContent]];
};

describe("one card per app, with honest capabilities", () => {
  it("renders the nine apps in order, each with only what it really gets", () => {
    loadConsole(HUB);
    const cards = [...document.querySelectorAll<HTMLElement>("#connect-apps .app-card")];
    expect(cards.map((c) => c.dataset.app)).toEqual(["grok-bot", "claude-ai", "chatgpt", "cursor", "claude-code", "codex", "vscode", "gemini", "devin"]);
    expect(cards.map((c) => c.querySelector("h3")?.textContent)).toEqual(
      ["Grok Bot", "claude.ai", "ChatGPT", "Cursor", "Claude Code", "Codex", "VS Code / Copilot", "Gemini CLI", "Devin CLI"]);
    const expected: Record<string, string[]> = {
      "grok-bot": ["Tools", "Wake"], "claude-ai": ["Tools"], chatgpt: ["Tools"], vscode: ["Tools"],
      // Devin CLI: connect's Devin gate was run live against devin 3000.6.11 (docs/qa/HARNESS-MEASUREMENT.md section 13);
      // mail arrives at turn end only, so no Wake.
      cursor: ["Tools", "Approvals"], gemini: ["Tools", "Approvals"], devin: ["Tools", "Approvals"],
      "claude-code": ["Tools", "Approvals", "Wake"], codex: ["Tools", "Approvals", "Wake"],
    };
    for (const [id, list] of Object.entries(expected)) expect(caps(id), id).toEqual(list);
  });

  it("one way in per card: a link or a copy box, anything else folded away", () => {
    loadConsole(HUB);
    for (const app of document.querySelectorAll<HTMLElement>("#connect-apps .app-card")) {
      const actions = [...app.querySelectorAll("a.app-action, .connect-cmd-box")].filter((n) => !n.closest("details"));
      expect(actions, app.dataset.app).toHaveLength(1);
    }
    // Cursor's deeplink broke in some versions, so its mcp.json is one closed disclosure away.
    const more = card("cursor").querySelector("details")!;
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")!.textContent).toBe("mcp.json");
  });

  it("approvals and wake for local apps: one quiet link under the cards", () => {
    loadConsole(HUB);
    expect($("connect-apps-computer").textContent).toBe("Approvals and wake: add this computer");
    expect($("connect-kind-app-panel").contains($("connect-apps-computer"))).toBe(true);
    // Outside the copy boxes, the only button on any card is Grok Bot's way to Agents, inside its closed wake disclosure.
    const other = [...document.querySelectorAll<HTMLElement>("#connect-apps button")].filter((b) => !b.closest(".connect-cmd-box"));
    expect(other.map((b) => [b.closest<HTMLElement>(".app-card")!.dataset.app, b.textContent, Boolean(b.closest("details"))]))
      .toEqual([["grok-bot", "Paste them in Agents", true]]);
  });
});

// Grok Bot wakes through a routine webhook set on Agents (Slice 1, proven end to end on 2026-10-30). Grok Bot never shows
// the routine's secret in chat, so the prompt asks it to point the person to where they copy it.
describe("Grok Bot's wake: one closed disclosure with the routine prompt and the way to Agents", () => {
  const WAKE = "Create a routine with a webhook trigger that checks OpenCadre for new messages and tasks and acts on them. Don't show its URL or key in this chat; tell me where in the routine's panel to copy them. I'll paste the URL and 'Bearer <key>' into OpenCadre.";
  const pasteIn = () => [...card("grok-bot").querySelectorAll<HTMLButtonElement>("details button")].find((b) => b.textContent === "Paste them in Agents")!;

  it("Set up wake holds the exact wake prompt and Paste them in Agents", () => {
    loadConsole(HUB);
    const wake = card("grok-bot").querySelector("details")!;
    expect(wake.open).toBe(false);
    expect(wake.querySelector("summary")!.textContent).toBe("Set up wake");
    expect([...wake.querySelectorAll(".connect-cmd")].map((c) => c.textContent)).toEqual([WAKE]);
    expect(wake.querySelector(".connect-cmd-box button")!.getAttribute("aria-label")).toBe("Copy Grok Bot wake prompt");
    expect(pasteIn().getAttribute("type")).toBe("button");
    // The routine's URL and key go from its panel straight into OpenCadre, never through the chat.
    expect(WAKE).toContain("Don't show its URL or key in this chat");
    // A bare key in the Authorization field gets a 401 from the routine, so the prompt names the Bearer prefix.
    expect(WAKE.endsWith("I'll paste the URL and 'Bearer <key>' into OpenCadre.")).toBe(true);
    expect(WAKE).not.toMatch(/give me|secret/i);
  });

  it("with no agent to wake yet: Agents without a linked computer, focus on its heading", () => {
    loadConsole(HUB);
    $("connect-kind-app").click();
    pasteIn().click();
    expect(location.hash).toBe("#/agents/named");
    expect(document.querySelector('.panel[data-panel="fleet"]')!.classList.contains("is-active")).toBe(true);
    expect($("fleet-agents-view").hidden).toBe(false);
    expect(document.activeElement).toBe($("h-fleet"));
  });

  const hook = { webhook_host: null, webhook_url_set: false, webhook_auth_set: false, last_wake: null };
  const roster = (id: string, name: string, created_at: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, role: "agent", key_class: "agent", kind: "named", online: false, editing_files_parsed: [], last_heartbeat_at: null, created_at, ...extra });
  const connector = (id: string, name: string, created_at: string, client_name: string) => roster(id, name, created_at, { kind: "connector", client_name });
  const answers = Object.fromEntries(["g1", "g2", "c1", "n1"].map((id) => [`/v1/org/agents/${id}/webhook`, hook]));
  const openedFor = () => (document.activeElement as HTMLInputElement).closest(".strip")!.querySelector(".callsign")!.textContent;

  it("a Grok Bot connection renamed at consent is found by its client, and the newest one wins", () => {
    const ui = loadConsole(HUB, undefined, answers);
    ui.renderOtherAgents([connector("g1", "Research bot", "2026-10-29 09:00:00", "Grok Bot"), connector("g2", "ROBIN", "2026-10-30 09:00:00", "Grok Bot")]);
    $("connect-kind-app").click();
    pasteIn().click();
    const field = document.activeElement as HTMLInputElement;
    expect(field.name).toBe("wake-url");
    expect(field.closest("label")!.firstChild!.textContent).toBe("Wake URL");
    expect(openedFor()).toBe("ROBIN");
    expect(document.querySelectorAll(".wake-form")).toHaveLength(1);
  });

  it("a newer connector of another app is passed over for the older Grok Bot one", () => {
    const ui = loadConsole(HUB, undefined, answers);
    ui.renderOtherAgents([connector("g1", "Research bot", "2026-10-29 09:00:00", "Grok Bot"), connector("c1", "Claude reviewer", "2026-10-31 09:00:00", "Claude")]);
    $("connect-kind-app").click();
    pasteIn().click();
    expect(openedFor()).toBe("Research bot");
    expect(document.querySelectorAll(".wake-form")).toHaveLength(1);
  });

  it("a name is never enough: a keyed agent called grokker and a non-Grok connector get no form; the heading has focus", () => {
    const ui = loadConsole(HUB, undefined, answers);
    ui.renderOtherAgents([roster("n1", "grokker", "2026-10-31 09:00:00"), connector("c1", "Grok Bot", "2026-10-30 09:00:00", "Claude")]);
    expect(document.querySelectorAll("[data-wake]")).toHaveLength(2);
    $("connect-kind-app").click();
    pasteIn().click();
    expect(document.querySelectorAll(".wake-form")).toHaveLength(0);
    expect(document.activeElement).toBe($("h-fleet"));
  });
});

describe("links and commands carry the hub's own address, correctly encoded", () => {
  it("production: the claude.ai prefill link", () => {
    loadConsole(HUB);
    const link = new URL(href("claude-ai")!);
    expect(link.origin + link.pathname).toBe("https://claude.ai/customize/connectors");
    expect(Object.fromEntries(link.searchParams)).toEqual({ modal: "add-custom-connector", connectorName: "OpenCadre", connectorUrl: MCP });
    expect(href("claude-ai")).toBe("https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=OpenCadre&connectorUrl=https%3A%2F%2Fhub.opencadre.example%2Fmcp");
    const a = card("claude-ai").querySelector("a.app-action")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.querySelector(".visually-hidden")!.textContent).toBe(" (opens in a new tab)");
  });

  it("production: the Cursor deeplink's config is base64 JSON of the server, its padding percent-encoded, with the JSON beside it", () => {
    loadConsole(HUB);
    const raw = href("cursor")!;
    expect(raw).toBe("cursor://anysphere.cursor-deeplink/mcp/install?name=opencadre&config=eyJ1cmwiOiJodHRwczovL2h1Yi5vcGVuY2FkcmUuZXhhbXBsZS9tY3AifQ%3D%3D");
    const config = decodeURIComponent(raw.split("config=")[1]);
    expect(JSON.parse(Buffer.from(config, "base64").toString("utf8"))).toEqual({ url: MCP });
    expect(code("cursor")).toEqual([JSON.stringify({ mcpServers: { opencadre: { url: MCP } } })]);
  });

  it("production: the VS Code install link is URL-encoded JSON naming an http server", () => {
    loadConsole(HUB);
    const raw = href("vscode")!;
    expect(raw.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(raw.slice("vscode:mcp/install?".length)))).toEqual({ name: "opencadre", type: "http", url: MCP });
    expect(raw).toBe("vscode:mcp/install?%7B%22name%22%3A%22opencadre%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fhub.opencadre.example%2Fmcp%22%7D");
  });

  it("production: the exact commands, config and prompt", () => {
    loadConsole(HUB);
    expect(code("claude-code")).toEqual([`claude mcp add --transport http --scope user opencadre ${MCP}
claude mcp login opencadre`]);
    expect(code("codex")).toEqual([`codex mcp add opencadre --url ${MCP}\ncodex mcp login opencadre`]);
    expect(code("gemini")).toEqual([`gemini mcp add --transport http -s user opencadre ${MCP}`]);
    expect(code("devin")).toEqual([`devin mcp add -s user opencadre --url ${MCP}
devin mcp login opencadre`]);
    expect(card("devin").textContent).not.toMatch(/serverUrl|mcp_config/);
    expect(code("chatgpt")).toEqual([MCP]);
    expect(code("grok-bot")[0]).toBe(`Add a custom MCP connector named OpenCadre with the URL ${MCP}. It uses OAuth sign-in and needs no key. Start the sign-in so I can approve it, then list its tools to confirm it works. If sign-in fails, tell me the exact error.`);
  });

  it("ChatGPT, which has no install link, gets its click path", () => {
    loadConsole(HUB);
    const steps = [...card("chatgpt").querySelectorAll("ol li")].map((li) => li.textContent);
    expect(steps).toHaveLength(4);
    // The URL comes first: step 2 says to paste it.
    const box = card("chatgpt").querySelector(".connect-cmd-box")!;
    expect(box.compareDocumentPosition(card("chatgpt").querySelector("ol")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(steps).toEqual([
      "Plugins → + → Add custom MCP server.",
      "Name OpenCadre, paste the URL, choose OAuth.",
      "Accept the warning, then Create as a plugin.",
      "Approve in OpenCadre, then install the plugin and pick it with @ in a chat.",
    ]);
  });

  it("production: console on app.opencadre.example, hub on hub.opencadre.example; every link, command, copy and prompt names the hub", async () => {
    const ui = loadConsole("https://app.opencadre.example", { ...OPERATOR_IDENTITY, hubUrl: HUB }, {}, false);
    // Before the first /v1/me there is only the page's host, which on production is the console's: one status line, no card.
    expect(statusLine()).toEqual([["status", "Loading…"]]);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    await ui.loadAndRender();
    const panel = $("connect-kind-app-panel");
    expect(panel.innerHTML).not.toContain("app.opencadre.example");
    const hrefs = [...panel.querySelectorAll("a[href]")].map((a) => decodeURIComponent(a.getAttribute("href")!));
    expect(hrefs).toHaveLength(3);
    for (const h of hrefs.filter((h) => !h.startsWith("cursor:"))) expect(h).toContain(MCP);
    expect(JSON.parse(Buffer.from(decodeURIComponent(href("cursor")!.split("config=")[1]), "base64").toString("utf8"))).toEqual({ url: MCP });
    for (const box of panel.querySelectorAll(".connect-cmd")) {
      if (box.closest("details")?.querySelector("summary")?.textContent === "Set up wake") continue; // the routine prompt names no URL
      expect(box.textContent).toContain(MCP);
    }
    for (const button of panel.querySelectorAll<HTMLButtonElement>(".connect-cmd-box button")) button.click();
    await Promise.resolve();
    expect(writeText.mock.calls.length).toBe(panel.querySelectorAll(".connect-cmd-box").length);
    for (const [text] of writeText.mock.calls) expect(String(text)).not.toContain("app.opencadre.example");
    // The pre-slice places with the same address: the manual snippets and Settings' hub URL.
    ui.showSnippets("Codex-1", "agt_test");
    expect($("snippets").textContent).toContain(MCP);
    expect($("snippets").textContent).toContain(`OPENCADRE_URL = "${HUB}"`);
    expect($("snippets").textContent).not.toContain("app.opencadre.example");
    expect($("settings-hub-url").textContent).toBe(HUB);
    writeText.mockClear();
    $("settings-copy-hub-url").click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(HUB);
  });

  it("a hub address that is not a bare https origin, or http on a loopback host, builds no card", () => {
    const page = "https://staging.opencadre.test";
    for (const hubUrl of ["https://user:pw@hub.example.test", "https://hub.example.test/mcp", "https://hub.example.test?x=1",
      "https://hub.example.test#x", "javascript:alert(1)", "ftp://hub.example.test", "hub.example.test", "", 42,
      "http://hub.example.test", "http://10.0.0.5:8080", "https://hub.opencadre.example.", undefined]) {
      loadConsole(page, { ...OPERATOR_IDENTITY, hubUrl });
      expect(document.querySelectorAll("#connect-apps .app-card"), String(hubUrl)).toHaveLength(0);
      expect(statusLine(), String(hubUrl)).toEqual([["status", "Couldn't load. Try again"]]);
    }
    for (const [hubUrl, hub] of [["HTTPS://HUB.Example.TEST", "https://hub.example.test"], ["https://hub.example.test/", "https://hub.example.test"],
      ["http://localhost:8080", "http://localhost:8080"], ["http://127.0.0.5:3000", "http://127.0.0.5:3000"], ["http://[::1]:4000", "http://[::1]:4000"]]) {
      loadConsole(page, { ...OPERATOR_IDENTITY, hubUrl });
      expect(code("claude-code")[0], hubUrl).toContain(`${hub}/mcp`);
    }
  });

  it("the manual snippets and Settings still fall back to the page's origin", () => {
    const page = "https://staging.opencadre.test";
    const ui = loadConsole(page, OPERATOR_IDENTITY);
    ui.showSnippets("Codex-1", "agt_test");
    expect($("snippets").textContent).toContain(`${page}/mcp`);
  });

  it("an identity read that fails says so, and Try again reads it again", async () => {
    const answers: Record<string, unknown> = { "/v1/me": { __status: 500 } };
    const ui = loadConsole(HUB, undefined, answers, false);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    await ui.loadAndRender();
    await flush();
    expect(statusLine()).toEqual([["status", "Couldn't load. Try again"]]);
    answers["/v1/me"] = { ...OPERATOR_IDENTITY, hubUrl: HUB };
    ($("connect-apps-status").querySelector("button") as HTMLButtonElement).click();
    // The line changes at once, before the read: the button the person pressed is gone, not left looking dead.
    expect(statusLine()).toEqual([["status", "Loading…"]]);
    // Through refresh(), so it coalesces with polling and checks sign-in rather than starting a second load.
    await until(() => document.querySelectorAll("#connect-apps .app-card").length > 0);
    expect(document.querySelectorAll("#connect-apps .app-card")).toHaveLength(9);
    expect(code("claude-code")[0]).toContain(MCP);
    expect(statusLine(), "the status line empties and hides once the cards show").toEqual([]);
    expect($("connect-apps-status").textContent).toBe("");
    expect($("connect-apps-status").parentElement).toBe($("connect-apps").parentElement);
    // Focus follows the retry into the first card, never left on the body.
    expect(card("grok-bot").contains(document.activeElement)).toBe(true);
  });

  it("a retry that fails keeps focus on the new Try again, and a later poll that succeeds does not take focus", async () => {
    const answers: Record<string, unknown> = { "/v1/me": { __status: 500 } };
    const ui = loadConsole(HUB, undefined, answers, false);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    await ui.loadAndRender();
    await flush();
    ($("connect-apps-status").querySelector("button") as HTMLButtonElement).click();
    expect(statusLine()).toEqual([["status", "Loading…"]]);
    await until(() => $("connect-apps-status").textContent === "Couldn't load. Try again");
    expect(statusLine()).toEqual([["status", "Couldn't load. Try again"]]);
    // The button pressed is re-created; focus goes to the new one, not the body.
    expect(document.activeElement).toBe($("connect-apps-status").querySelector("button"));
    // A background poll that succeeds later builds the cards without pulling focus into them.
    answers["/v1/me"] = { ...OPERATOR_IDENTITY, hubUrl: HUB };
    await ui.loadAndRender();
    await flush();
    expect(document.querySelectorAll("#connect-apps .app-card")).toHaveLength(9);
    expect($("connect-apps").contains(document.activeElement)).toBe(false);
  });

  it("a paused workspace's identity read does not leave the list on Loading", async () => {
    const ui = loadConsole(HUB, undefined, { "/v1/me": { __status: 423 } }, false);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    await ui.loadAndRender();
    await flush();
    expect(statusLine()).toEqual([["status", "Couldn't load. Try again"]]);
  });

  it("entering the console with an identity that names the hub builds the cards at once", () => {
    // Fake timers: entering starts polling, and its timers must not outlive this test.
    vi.useFakeTimers();
    try {
      const ui = loadConsole(HUB, undefined, {}, false);
      expect(statusLine()).toEqual([["status", "Loading…"]]);
      void ui.enterConsole({ ...OPERATOR_IDENTITY, hubUrl: HUB });
      expect(document.querySelectorAll("#connect-apps .app-card")).toHaveLength(9);
      expect(code("claude-code")[0]).toContain(MCP);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("copy buttons", () => {
  it("each copies exactly the text shown beside it, and is named for its app", async () => {
    loadConsole(HUB);
    const boxes = [...document.querySelectorAll<HTMLElement>("#connect-apps .connect-cmd-box")];
    expect(boxes).toHaveLength(8);
    for (const box of boxes) {
      const app = box.closest<HTMLElement>(".app-card")!;
      const name = app.querySelector("h3")!.textContent!;
      const button = box.querySelector("button")!;
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toContain(name);
      writeText.mockClear();
      button.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(box.querySelector(".connect-cmd")!.textContent);
    }
  });
});

describe("no key is ever in an app's setup", () => {
  it("nothing rendered, linked or copied carries a key or an auth header", async () => {
    loadConsole(HUB);
    const panel = $("connect-kind-app-panel");
    const texts = [panel.textContent!, ...[...panel.querySelectorAll("a[href]")].map((a) => decodeURIComponent(a.getAttribute("href")!))];
    texts.push(Buffer.from(decodeURIComponent(href("cursor")!.split("config=")[1]), "base64").toString("utf8"));
    for (const button of panel.querySelectorAll<HTMLButtonElement>(".connect-cmd-box button")) button.click();
    await Promise.resolve();
    texts.push(...writeText.mock.calls.map((c) => String(c[0])));
    // The wake prompt names the placeholder 'Bearer <key>' so the person pastes the prefix; no real value ever appears.
    for (const text of texts) expect(text).not.toMatch(/agt_|org_|dev_|ocd_|Bearer (?!<key>')|Authorization|headers/i);
  });
});

describe("Computer or App: one choice at a time, keyboard-usable", () => {
  it("opens on the computer guide; App shows the cards and hides the guide; the page has no subtitle", () => {
    loadConsole(HUB);
    expect($("connect-kind-computer").getAttribute("aria-selected")).toBe("true");
    expect($("connect-kind-computer-panel").hidden).toBe(false);
    expect($("connect-kind-app-panel").hidden).toBe(true);
    $("connect-kind-app").click();
    expect($("connect-kind-app-panel").hidden).toBe(false);
    expect($("connect-kind-computer-panel").hidden).toBe(true);
    expect($("connect-kind-computer-panel").contains($("connect-wizard"))).toBe(true);
    $("connect-kind-computer").click();
    expect($("connect-kind-computer-panel").hidden).toBe(false);
    // #771: no page-heading subtitle (operator rule: no helper text); the guide's intro is the wizard's aria-label.
    expect(document.querySelector('[data-panel="connect"] .panel-head .panel-note')).toBeNull();
  });

  it("arrows, Home and End move selection and focus, with one tab stop", () => {
    loadConsole(HUB);
    const computer = $("connect-kind-computer");
    const app = $("connect-kind-app");
    expect(computer.tabIndex).toBe(0);
    expect(app.tabIndex).toBe(-1);
    computer.focus();
    for (const [key, expected] of [["ArrowRight", app], ["ArrowRight", computer], ["ArrowLeft", app], ["Home", computer], ["End", app]] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(expected);
      expect(expected.getAttribute("aria-selected")).toBe("true");
      expect(expected.tabIndex).toBe(0);
      const other = expected === computer ? app : computer;
      expect(other.tabIndex).toBe(-1);
      expect($(other.getAttribute("aria-controls")!).hidden).toBe(true);
      expect($(expected.getAttribute("aria-controls")!).hidden).toBe(false);
    }
  });

  it("the approvals and wake link goes to the computer guide and puts the cursor in the name field", () => {
    loadConsole(HUB);
    $("connect-kind-app").click();
    $("connect-apps-computer").click();
    expect($("connect-kind-computer").getAttribute("aria-selected")).toBe("true");
    expect($("connect-kind-computer-panel").hidden).toBe(false);
    expect(document.activeElement).toBe($("computer-name"));
  });

  it("both tabpanels take focus, so a keyboard user can reach a panel from its tab", () => {
    loadConsole(HUB);
    expect($("connect-kind-computer-panel").getAttribute("tabindex")).toBe("0");
    expect($("connect-kind-app-panel").getAttribute("tabindex")).toBe("0");
  });

  it("every action is a real link or button", () => {
    loadConsole(HUB);
    for (const node of document.querySelectorAll<HTMLElement>("#connect-apps .app-action, #connect-apps button")) {
      if (node.tagName === "A") expect(node.getAttribute("href"), node.textContent!).toBeTruthy();
      else expect(node.tagName).toBe("BUTTON");
    }
  });
});
