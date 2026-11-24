// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const js = readFileSync("public/app/app.js", "utf8");
beforeEach(() => { document.documentElement.innerHTML = readFileSync("public/app/index.html", "utf8").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ""); });
function load() { return new Function("window", "document", "localStorage", "fetch", js + "\nreturn {renderConnectComputers, computerCard};")(window, document, window.localStorage, async () => new Response("{}", { status: 503 })); }
describe("automatic connector inventory labels", () => {
  it.each([[undefined, "version unknown"], ["reported-current", "reported current"], ["update-available", "optional update available"], ["check-installation", "check installation"]])("renders %s on connected computer and fleet card without a new request", (status, label) => {
    const ui = load();
    const device = { deviceId: "test", name: "Laptop", status: "connected", tools: ["codex"], connector: status ? { status } : undefined };
    ui.renderConnectComputers([device], []);
    const list = document.getElementById("connect-computers-list")!;
    expect(list.textContent).toContain(label);
    expect(list.querySelector(".computer-row-name")?.textContent).toBe("Laptop");
    // Existing mobile CSS hides tools and chat-count columns; the warning must be outside those.
    const recovery = list.querySelector('a[href="#add-computer"]')!;
    expect(recovery.closest(".computer-row-tools, .computer-row-chats")).toBeNull();
    expect(recovery.closest(".computer-row-primary")).not.toBeNull();
    const card = ui.computerCard(device, []);
    expect(card.textContent).toContain(label);
    expect(card.querySelector('a[href="#add-computer"]')?.title).toContain("does not verify every running process");
    card.querySelector("a")?.click();
    expect(document.querySelector('[data-panel="connect"]')?.hidden).toBe(false);
  });
});
