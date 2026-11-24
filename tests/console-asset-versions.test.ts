import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";
import { app, versionedConsoleIndex } from "../src/rest.js";

// After a deploy, a CDN in front of the hub (Cloudflare caches static files for 4 hours) served the OLD console-v2.css
// against the NEW index.html: new markup, old styles, a broken sidebar on the live site. The page now names every one of
// its own assets with the running version, so each deploy is a new cache key, and the page itself is never cached.
let recorder: Awaited<ReturnType<typeof startFetchRecorder>> | undefined;
let base: string;
beforeAll(async () => {
  recorder = await startFetchRecorder(app);
  base = recorder.url;
});
afterAll(async () => { await recorder?.close(); });

describe("the console page carries versioned asset URLs", () => {
  it("every local stylesheet, script, manifest and icon is versioned; the page itself is not cached", async () => {
    for (const path of ["/app/", "/app/index.html"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(res.headers.get("content-security-policy"), "the console's CSP still applies").toContain("default-src 'self'");
      const html = await res.text();
      const local = [...html.matchAll(/(?:href|src)="(\/app\/[^"]+)"/g)].map((m) => m[1]);
      expect(local.length).toBeGreaterThanOrEqual(4);
      for (const url of local) expect(url, url).toMatch(/\?v=[A-Za-z0-9._-]+$/);
      expect(html).toContain('/app/console-v2.css?v=');
      expect(html).toContain('/app/app.js?v=');
    }
  });

  // Codex on 280adc8e: express.static decodes the path and the disk is case-insensitive on Windows, so an encoded or
  // re-cased index name used to reach the raw console file: no noindex, no X-Robots-Tag, unversioned assets. Every
  // spelling of the entry is now the rendered index, with the plain paths as controls.
  it("every spelling of the console's entry gets the rendered index: noindex (meta and header), versioned assets, no cache", async () => {
    // Codex on ff873e49: send() normalises with the native path module, which on Windows treats a backslash as a
    // separator, so %5c aliases (/app/%5cindex.html, /app/foo%5c..%5cindex.html) are spellings of the entry too.
    const spellings = ["/app", "/app/", "/app/index.html", "/app/%69ndex.html", "/app/INDEX.HTML", "/app/Index.Html", "/app/index%2Ehtml", "/app/%2e/index.html", "/app//index.html",
      "/app/%5cindex.html", "/app/foo%5c..%5cindex.html", "/app/%5CINDEX.HTML"];
    for (const path of spellings) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      const html = await res.text();
      expect(html, path).toContain('<meta name="robots" content="noindex">');
      expect(html, path).toMatch(/\/app\/app\.js\?v=[A-Za-z0-9._-]+"/);
      expect(html, path).not.toMatch(/(?:href|src)="\/app\/[^"?]+\.(?:css|js)"/);
      // HEAD answers with the same headers, so a HEAD probe can't tell a raw file apart either.
      const head = await fetch(`${base}${path}`, { method: "HEAD", redirect: "manual" });
      expect(head.status, `HEAD ${path}`).toBe(200);
      expect(head.headers.get("x-robots-tag"), `HEAD ${path}`).toBe("noindex");
      expect(head.headers.get("cache-control"), `HEAD ${path}`).toBe("no-cache");
    }
  });

  it("a different version yields different URLs (a deploy is a new cache key)", () => {
    expect(versionedConsoleIndex("aaa1111")).toContain("/app/app.js?v=aaa1111");
    expect(versionedConsoleIndex("bbb2222")).toContain("/app/app.js?v=bbb2222");
  });

  it("a versioned asset URL still serves the file, with its normal cache lifetime", async () => {
    const res = await fetch(`${base}/app/console-v2.css?v=anything`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toContain(".find-btn");
  });
});

// Design-token plan s7: the console's roles are var() references to /shared/tokens.css, so a stale cached shared file
// would leave every role unresolved after a deploy. The console names it with the version like its own assets, and the
// hub serves the shared stylesheets revalidate-always, which also covers the site's unversioned links to it.
describe("the shared stylesheets cannot be served stale", () => {
  it("the console page links /shared/tokens.css with the running version", async () => {
    const html = await (await fetch(`${base}/app/`)).text();
    const shared = [...html.matchAll(/href="(\/shared\/[^"]+\.css[^"]*)"/g)].map((m) => m[1]);
    expect(shared).toEqual([expect.stringMatching(/^\/shared\/tokens\.css\?v=[A-Za-z0-9._-]+$/)]);
    expect(versionedConsoleIndex("ccc3333")).toContain('href="/shared/tokens.css?v=ccc3333"');
  });

  it("GET /shared/tokens.css answers no-cache, versioned or not; a shared image keeps its lifetime", async () => {
    for (const path of ["/shared/tokens.css", "/shared/tokens.css?v=anything"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(res.headers.get("etag"), path).toBeTruthy();
    }
    const icon = await fetch(`${base}/shared/brand/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
