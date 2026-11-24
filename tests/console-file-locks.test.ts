// @vitest-environment happy-dom
// F4 (docs/design/CONSOLE-V2.md §5b): Agents shows which agent holds which file. GET /v1/resources had no screen, so only
// the agents themselves could see those claims. Red on the console before it (no section, no fetch).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
function loadConsole(fetchMock = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderFileLocks, refreshFileLocks, selectTab,
      setIdentity: (identity, signedIn = true) => { authMode = "session"; currentWorkspace = signedIn ? "test-workspace" : null; me = identity; } };`,
  )(window, document, window.localStorage, fetchMock) as { renderFileLocks: (l: unknown[] | null) => void; refreshFileLocks: () => Promise<void>; selectTab: (n: string, options?: object) => void; setIdentity: (identity: unknown, signedIn?: boolean) => void };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe("Files agents are holding", () => {
  it("lists each claim: the file, the note, who holds it and since when, and how long the lease has left", () => {
    const c = loadConsole();
    c.renderFileLocks([{ resource_key: "src/billing.ts", holder_agent_name: "Codex-api-5a12", note: "adding annual prices", acquired_at: inMinutes(-5), lease_expires_at: inMinutes(25) }]);
    expect($("fleet-locks").hidden).toBe(false);
    const row = $("fleet-locks-list").querySelector(".strip")!;
    expect(row.querySelector(".row-command")?.textContent).toBe("src/billing.ts");
    expect(row.querySelector(".row-main")?.textContent).toBe("adding annual prices");
    expect(row.querySelector(".row-who")?.textContent).toBe("Codex-api-5a12 · since 5m ago");
    expect(row.querySelector(".row-seen")?.textContent).toMatch(/^2[45] min left$/);
  });

  it("no claims, or a hub that won't say: no section", () => {
    const c = loadConsole();
    c.renderFileLocks([]);
    expect($("fleet-locks").hidden).toBe(true);
    c.renderFileLocks(null);
    expect($("fleet-locks").hidden).toBe(true);
  });

  it.each([[], null])("erases retained lock rows and summary on withdrawal %#, then recovers", (withdrawn) => {
    const ui = loadConsole();
    const locks = [{ resource_key: "private.txt", holder_agent_name: "Worker", acquired_at: inMinutes(-1), lease_expires_at: inMinutes(5) }];
    ui.renderFileLocks(locks);
    expect($("fleet-locks-list").textContent).toContain("private.txt");
    expect($("fleet-locks-summary").textContent).toBe("1 held");
    ui.renderFileLocks(withdrawn);
    expect($("fleet-locks").hidden).toBe(true);
    expect($("fleet-locks-list").children).toHaveLength(0);
    expect($("fleet-locks-list").textContent).toBe("");
    expect($("fleet-locks-summary").textContent).toBe("");
    ui.renderFileLocks(locks);
    expect($("fleet-locks").hidden).toBe(false);
    expect($("fleet-locks-list").textContent).toContain("private.txt");
    expect($("fleet-locks-summary").textContent).toBe("1 held");
  });

  it("is fetched when Agents opens, from /v1/resources", async () => {
    const fetchMock = vi.fn(async (url: string) => json(200, url === "/v1/resources" ? { locks: [] } : {}));
    const ui = loadConsole(fetchMock as never);
    ui.setIdentity({ role: "operator", orgId: "test-workspace" });
    ui.selectTab("fleet", { refreshReaders: false });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/v1/resources")).toBe(true));
  });

  it.each(["unsigned", "missing identity"])("does not fetch file locks with %s setup", async (setup) => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const ui = loadConsole(fetchMock);
    ui.setIdentity(setup === "missing identity" ? null : { role: "operator", orgId: "test-workspace" }, setup !== "unsigned");
    ui.selectTab("fleet", { refreshReaders: false });
    await ui.refreshFileLocks();
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/resources")).toBe(false);
  });

  it("withdraws previously shown locks when the authenticated resource read is refused", async () => {
    const fetchMock = vi.fn(async (url: string) => json(url === "/v1/resources" ? 403 : 200, {}));
    const ui = loadConsole(fetchMock as never);
    ui.setIdentity({ role: "operator", orgId: "test-workspace" });
    ui.renderFileLocks([{ resource_key: "private.txt", holder_agent_name: "Worker", acquired_at: inMinutes(-1), lease_expires_at: inMinutes(5) }]);
    ui.selectTab("fleet", { refreshReaders: false });
    await ui.refreshFileLocks();
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/resources")).toBe(true);
    expect($("fleet-locks").hidden).toBe(true);
    expect($("fleet-locks-list").children).toHaveLength(0);
    expect($("fleet-locks-list").textContent).toBe("");
    expect($("fleet-locks-summary").textContent).toBe("");
  });

  it("retains accepted lock rows on a transient failure with truthful freshness, then recovers", async () => {
    const locks = [{ resource_key: "current.txt", holder_agent_name: "Worker", acquired_at: inMinutes(-1), lease_expires_at: inMinutes(5) }];
    let status = 200;
    const fetchMock = vi.fn(async (url: string) => json(url === "/v1/resources" ? status : 200, url === "/v1/resources" ? { locks } : {}));
    const ui = loadConsole(fetchMock as never);
    ui.setIdentity({ role: "operator", orgId: "test-workspace" });
    ui.selectTab("fleet", { refreshReaders: false });
    await ui.refreshFileLocks();
    const row = $("fleet-locks-list").firstElementChild;
    expect(row).not.toBeNull();
    expect($("fleet-locks-summary").textContent).toBe("1 held");
    status = 500;
    await ui.refreshFileLocks();
    expect($("fleet-locks").hidden).toBe(false);
    expect($("fleet-locks-list").firstElementChild).toBe(row);
    expect($("fleet-locks-list").textContent).toContain("current.txt");
    expect($("fleet-locks-summary").textContent).toMatch(/^Couldn't refresh · showing locks from /);
    status = 200;
    await ui.refreshFileLocks();
    expect($("fleet-locks-summary").textContent).toBe("1 held");
    expect($("fleet-locks-list").textContent).toContain("current.txt");
  });
});
