// @vitest-environment happy-dom
// PR1 (urgent usability): one state, one colour. "online" was blue on session rows and green on named agents; Activity
// marked an approval that was GRANTED with the amber "waiting" dot. Now: online is one green everywhere (with a dark
// value), a granted approval is green, a request waiting on a person is amber, a denial is red.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONSOLE_STYLESHEETS, resolve as resolveToken, stylesheetDeclarations } from "./helpers/css-tokens.js";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const tokens = read("public/app/tokens.css");
const v2 = read("public/app/console-v2.css");
const appCss = read("public/app/app.css");

/** The top-level rules of a stylesheet (brace depth 0), comments removed, so a block nested by mistake is not counted. */
function topLevel(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth === 0) start = text.lastIndexOf("}", i) + 1; depth++; }
    else if (text[i] === "}") { depth--; if (depth === 0) blocks.push(text.slice(start, i + 1).trim()); }
  }
  return blocks;
}

describe("online is one colour", () => {
  it("the state token is green in light and has its own dark value, in a top-level dark block", () => {
    // Measured as rendered, through every stylesheet the console loads (tests/helpers/css-tokens.ts): the token is a
    // var() to the shared ok-text primitive now (design-token plan, Task 3), and these are the audit's online values.
    expect(resolveToken("--state-online", stylesheetDeclarations(CONSOLE_STYLESHEETS, "light")).toUpperCase()).toBe("#18794E");
    expect(resolveToken("--state-online", stylesheetDeclarations(CONSOLE_STYLESHEETS, "dark")).toUpperCase()).toBe("#4CC38A");
    const dark = topLevel(tokens).find((b) => b.startsWith("@media (prefers-color-scheme: dark)") && b.includes("--state-online"));
    expect(dark).toMatch(/^@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^{}]*--state-online\s*:[^{}]*\}\s*\}$/);
    // app.css must not redeclare it, or its later :root would win by source order and the token would be decorative.
    expect(appCss).not.toMatch(/--state-online\s*:/);
  });
  it("a named agent's lamp uses the same token and the same word as a session row", () => {
    expect(v2).toMatch(/\.lamp\.on::before \{ background: var\(--state-online\); \}/);
    expect(v2).toMatch(/\.lamp\.on \{ color: var\(--state-online\); \}/);
  });
});

function loadConsole() {
  const appJs = read("public/app/app.js");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderTimeline, renderOtherAgents, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, async () => ({ ok: true, status: 200, json: async () => ({}) })) as {
    renderTimeline: (events: unknown[]) => void;
    renderOtherAgents: (agents: unknown[]) => void;
    setMe: (v: unknown) => void;
  };
}

beforeEach(() => {
  document.documentElement.innerHTML = read("public/app/index.html").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("Activity's dots say the state", () => {
  it("granted is green, waiting is amber, denied is red, expired is neutral", () => {
    const c = loadConsole();
    const at = new Date().toISOString();
    const ev = (seq: number, type: string, payload: object = {}) => ({ seq, type, actor_agent_name: "Ada", payload: JSON.stringify(payload), created_at: at });
    c.renderTimeline([
      ev(5, "approval.requested", { action: "rm -rf build" }),
      ev(4, "approval.decided", { decision: "approve" }),
      ev(3, "approval.decided", { decision: "deny" }),
      ev(2, "approval.grant_created", {}),
      ev(1, "approval.expired", {}),
    ]);
    const dots = [...document.querySelectorAll("#timeline .rail-dot")].map((d) => d.className.replace("rail-dot ", ""));
    expect(dots).toEqual(["dot-amber", "dot-green", "dot-red", "dot-green", "dot-muted"]);
    expect(appCss).toMatch(/\.rail-dot\.dot-green \{\s*background: var\(--state-online\);/);
  });
});

describe("a named agent's status word", () => {
  it("is the console's lowercase state word, as on session rows", () => {
    const c = loadConsole();
    c.setMe({ role: "operator", agentId: "me", orgId: "o" });
    c.renderOtherAgents([{ id: "a1", name: "Reviewer", kind: "named", key_class: "agent", role: "agent", online: true, usage: null, editing_files_parsed: [] }]);
    const lamp = document.querySelector("#fleet-other-agents .lamp");
    expect(lamp?.textContent).toBe("online");
    expect(lamp?.classList.contains("on")).toBe(true);
  });
});
