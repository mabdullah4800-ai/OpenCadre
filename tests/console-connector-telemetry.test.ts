// @vitest-environment happy-dom
// PR-E1b console surface (PLAN-PR-E addendum §4.2, amendment 2 §4.1): each label says what the evidence shows. Missing
// telemetry is "no recent report" on a neutral chip; refusal chips name their source and each reason; nothing is in a tooltip; only a
// reviewed `required` entry may say "required"; the Agents banner names a count and a feature, never a path.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const js = readFileSync("public/app/app.js", "utf8");
beforeEach(() => { document.documentElement.innerHTML = readFileSync("public/app/index.html", "utf8").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ""); });
function load() {
  return new Function("window", "document", "localStorage", "fetch", js + "\nreturn {renderConnectComputers, computerCard, renderConnectorBanner};")(
    window, document, window.localStorage, async () => new Response("{}", { status: 503 }));
}
const device = (connector: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ deviceId: "d1", name: "Laptop", status: "connected", tools: ["codex"], connector, ...over });
const FORBIDDEN = [/too old/i, /broken/i, /refusing/i, /outdated/i, /unsupported/i];

describe("connector telemetry on the computer row and the Agents card", () => {
  it("no recent report: the label, plus a neutral \"No report · 24 h\" chip, with nothing kept in a tooltip", () => {
    const ui = load();
    const d = device({ status: "no-recent-report", refusals: null, cohort: null });
    ui.renderConnectComputers([d], []);
    const row = document.getElementById("connect-computers-list")!;
    const card = ui.computerCard(d, []);
    for (const node of [row, card]) {
      expect(node.textContent).toContain("Connector: no recent report");
      const chip = node.querySelector(".connector-note")!;
      expect(chip.textContent).toBe("No report · 24 h");
      // Missing telemetry is not a warning: the neutral chip, never the waiting or limited colours.
      expect(chip.className).toBe("connector-chip connector-note");
      expect(node.querySelector(".connector-notes [title]")).toBeNull();
      for (const word of FORBIDDEN) expect(node.textContent).not.toMatch(word);
    }
    // The notes sit with the name, not in the columns the phone layout hides.
    expect(row.querySelector(".connector-notes")?.closest(".computer-row-primary")).not.toBeNull();
  });

  it("refusals are observed reasons and counts, with the self-reported count labelled as the computer's", () => {
    const ui = load();
    const card = ui.computerCard(device({ status: "reported-current", cohort: null, refusals: { noSession: 3, ambiguousSession: 1, selfReportedStamp: { count: 2, reason: "undated" } } }), []);
    expect(card.textContent).toContain("Connector: reported current");
    // Each chip names its source and each reason: a duplicate session is the one a person can act on (close it).
    const observed = [...card.querySelectorAll(".connector-refusals")].map((n) => n.textContent);
    expect(observed).toEqual(["Hub refused 4 · 24 h: 3 no session, 1 duplicate session", "Computer reports 2 stamp refusals (undated)"]);
    expect(card.querySelector(".connector-notes [title]")).toBeNull();
    for (const word of FORBIDDEN) expect(card.textContent).not.toMatch(word);
  });

  it("only one reason observed: only that reason is named; none observed: nothing is added", () => {
    const ui = load();
    const one = ui.computerCard(device({ status: "reported-current", cohort: null, refusals: { noSession: 0, ambiguousSession: 4, selfReportedStamp: null } }), []);
    expect(one.querySelector(".connector-refusals")?.textContent).toBe("Hub refused 4 · 24 h: 4 duplicate sessions");
    expect(one.textContent).not.toContain("no session");
    const stampOnly = ui.computerCard(device({ status: "reported-current", cohort: null, refusals: { noSession: 0, ambiguousSession: 0, selfReportedStamp: { count: 1, reason: null } } }), []);
    expect([...stampOnly.querySelectorAll(".connector-refusals")].map((n) => n.textContent)).toEqual(["Computer reports 1 stamp refusal"]);
    const none = ui.computerCard(device({ status: "reported-current", cohort: null, refusals: null }), []);
    expect(none.querySelector(".connector-notes")).toBeNull();
  });

  it("a recognised cohort is named; a required one names its feature, from the hub's checked text", () => {
    const ui = load();
    const supported = ui.computerCard(device({ status: "update-available", cohort: { id: "c-25b6250b", required: false }, refusals: null }), []);
    expect(supported.textContent).toContain("Connector: optional update available");
    expect(supported.textContent).not.toContain("cohort");
    history.replaceState(null, "", "/app/?debug=1");
    const debugged = ui.computerCard(device({ status: "update-available", cohort: { id: "c-25b6250b", required: false }, refusals: null }), []);
    expect(debugged.textContent).toContain("Reported helpers: cohort c-25b6250b");
    expect(supported.textContent).not.toMatch(/required/i);
    const required = ui.computerCard(device({ status: "security-update-required", requiredFeature: "per-chat identity on stamp clients", cohort: { id: "c-old", required: true }, refusals: null }), []);
    expect(required.querySelector("a.connector-build")?.textContent).toBe("Connector: security update required (per-chat identity on stamp clients)");
  });
});

describe("the Agents banner (addendum §4.2)", () => {
  it("appears only for a required entry, with the count and the feature and no machine path", () => {
    const ui = load();
    const banner = document.getElementById("fleet-connector-banner")!;
    expect(banner.hidden).toBe(true);
    ui.renderConnectorBanner([
      device({ status: "security-update-required", requiredFeature: "per-chat identity on stamp clients" }, { name: "C:/Users/someone/laptop" }),
      device({ status: "security-update-required", requiredFeature: "per-chat identity on stamp clients" }, { deviceId: "d2" }),
      device({ status: "update-available" }, { deviceId: "d3" }),
    ]);
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe("2 computers report OpenCadre helpers that need a security update (per-chat identity on stamp clients). See each computer's card for the upgrade command.");
    expect(banner.textContent).not.toContain("C:/Users");
  });
  it("never appears for refusals, missing reports, optional updates or a removed computer", () => {
    const ui = load();
    const banner = document.getElementById("fleet-connector-banner")!;
    ui.renderConnectorBanner([
      device({ status: "no-recent-report", refusals: { noSession: 99, ambiguousSession: 99, selfReportedStamp: null } }),
      device({ status: "update-available" }),
      device({ status: "security-update-required", requiredFeature: "x" }, { status: "revoked" }),
    ]);
    expect(banner.hidden).toBe(true);
    ui.renderConnectorBanner(null);
    expect(banner.hidden).toBe(true);
  });
});
