// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const $ = (id: string) => document.getElementById(id)!;
const js = readFileSync(resolve("public/app/app.js"), "utf8");
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
});
afterEach(() => vi.useRealTimers());
function load(fetcher: unknown) {
  new Function("window", "document", "localStorage", "fetch", js)(window, document, window.localStorage, fetcher);
}
const stamp = "abcdef012345";
const body = () => ({ tarball: { stamp, sha256: stamp + "a".repeat(52), url: `https://hub.example.test/cli/${stamp}/opencadre-cli.tgz` }, command: "untrusted command prose" });
describe("console connector recovery independent of broken chat hooks", () => {
  it("shows a validated immutable command without claiming to know the installed version", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body())));
    load(fetcher);
    $("connector-update-check").click();
    await vi.waitFor(() => expect($("connector-update-result").textContent).toContain(`npx -y https://hub.example.test/cli/${stamp}/opencadre-cli.tgz connect --upgrade`));
    expect($("connector-update-result").textContent).toContain("Installed version: unknown");
    // PR-B (#692): the command brings client config current too, and the copy says so and names its outcomes.
    expect($("connector-update-result").textContent).toContain("the OpenCadre settings of every tool already connected on that computer");
    expect($("connector-update-result").textContent).toMatch(/0 \(up to date\), 3 \(updated, with anything left for you listed per tool[^)]*\) or 2 \(not finished/);
    expect($("connector-update-result").textContent).not.toContain("untrusted command prose");
    expect(fetcher.mock.calls.find(([url]) => url === "/cli/manifest.json")?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
  });
  it.each([null, { ...body(), tarball: { ...body().tarball, url: "https://hub.example.test/x';whoami" } }, { ...body(), tarball: { ...body().tarball, url: `https://x$evil.example/cli/${stamp}/opencadre-cli.tgz` } }])("keeps existing use available when the manifest is missing or unsafe", async (bad) => {
    load(async () => new Response(JSON.stringify(bad), { status: bad ? 200 : 503 }));
    $("connector-update-check").click();
    await vi.waitFor(() => expect($("connector-update-result").textContent).toContain("could not be verified"));
    expect($("connector-update-result").textContent).not.toContain("npx -y");
    expect(($("connector-update-check") as HTMLButtonElement).disabled).toBe(false);
  });
  it("recovers the button when the hub never answers", async () => {
    vi.useFakeTimers();
    load(async (url: string, options: { signal?: AbortSignal }) => {
      if (url !== "/cli/manifest.json") return new Response("{}", { status: 503 });
      return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
    });
    $("connector-update-check").click();
    await vi.advanceTimersByTimeAsync(5001);
    expect($("connector-update-result").textContent).toContain("could not be verified");
    expect(($("connector-update-check") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the same deadline when headers arrive but the response body stalls", async () => {
    vi.useFakeTimers();
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { close = () => controller.close(); } });
    load(async (url: string) => url === "/cli/manifest.json" ? new Response(stream) : new Response("{}", { status: 503 }));
    try {
      $("connector-update-check").click();
      await vi.advanceTimersByTimeAsync(5001);
      expect($("connector-update-result").textContent).toContain("could not be verified");
      expect(($("connector-update-check") as HTMLButtonElement).disabled).toBe(false);
    } finally { close(); await Promise.resolve(); }
  });

});
