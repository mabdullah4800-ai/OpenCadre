import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));

describe("web app hosting", () => {
  it("serves the console at /app with security headers", async () => {
    const res = await fetch(`${baseUrl}/app/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toContain("OpenCadre");
  });

  it("serves the app's script and stylesheet", async () => {
    expect((await fetch(`${baseUrl}/app/app.js`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/app/app.css`)).status).toBe(200);
  });

  it("serves shared tokens at /shared/tokens.css with security headers", async () => {
    const res = await fetch(`${baseUrl}/shared/tokens.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const body = await res.text();
    expect(body).toContain("--chip: #16B8CE;");
  });

  const BRAND_PAGES = ["/app/"];

  it("serves every brand asset a page links, in its head or its markup", async () => {
    const linked = new Set<string>();
    for (const page of BRAND_PAGES) {
      const html = await (await fetch(`${baseUrl}${page}`)).text();
      for (const [, href] of html.matchAll(/<(?:link|meta|img)[^>]+(?:href|content|src)="((?:https?:\/\/[a-z0-9.:-]+)?\/(?:shared|app)\/(?:brand|icons)\/[^"?]+)/g)) {
        linked.add(href.replace(/^https?:\/\/[a-z0-9.:-]+/, ""));
      }
      expect(html, page).toMatch(/<link rel="icon" href="\/shared\/brand\/favicon\.svg" type="image\/svg\+xml">/);
      expect(html, page).toMatch(/<link rel="icon" href="\/shared\/brand\/favicon\.ico" sizes="16x16 24x24 32x32">/);
      expect(html, page).toMatch(/<link rel="apple-touch-icon" href="\/(shared\/brand|app\/icons)\/apple-touch-icon\.png/);
    }
    for (const href of linked) {
      const res = await fetch(`${baseUrl}${href}`);
      expect(res.status, href).toBe(200);
      expect(res.headers.get("content-type"), href).toMatch(/^image\//);
    }
  });

  it("the console head declares the dedicated 24px masters with sizes=\"24x24\"", async () => {
    // A 24px use (zoomed tab strips, the bookmarks bar) gets a dedicated 24px icon rather than a scaled 16 or 32.
    for (const page of BRAND_PAGES) {
      const head = (await (await fetch(`${baseUrl}${page}`)).text()).split("</head>")[0];
      expect(head, page).toMatch(/<link rel="icon" href="\/shared\/brand\/favicon-24\.svg" type="image\/svg\+xml" sizes="24x24">/);
      expect(head, page).toMatch(/<link rel="icon" href="\/shared\/brand\/icon-24\.png" type="image\/png" sizes="24x24">/);
    }
  });

  it("answers /favicon.ico on every host with the brand icon", async () => {
    for (const host of ["opencadre.example", "app.opencadre.example"]) {
      const res = await fetch(`${baseUrl}/favicon.ico`, { headers: { "x-forwarded-host": host } });
      expect(res.status, host).toBe(200);
      expect(res.headers.get("content-type"), host).toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/);
    }
  });

  it("lists a maskable icon in the PWA manifest, and every manifest icon exists", async () => {
    const manifest = await (await fetch(`${baseUrl}/app/manifest.webmanifest`)).json() as { icons: { src: string; purpose: string }[] };
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === "monochrome")).toBe(true);
    expect(manifest).toMatchObject({ theme_color: "#15161A", background_color: "#15161A" }); // mono: carbon
    for (const icon of manifest.icons) expect((await fetch(`${baseUrl}${icon.src}`)).status, icon.src).toBe(200);
  });

  it("every icon the pages and the manifest link exists on disk at the size it declares", () => {
    const png = (rel: string) => {
      const b = readFileSync(resolve(process.cwd(), rel));
      expect(b.subarray(0, 8).toString("hex"), rel).toBe("89504e470d0a1a0a");
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    for (const [rel, size] of [
      ["public/app/icons/icon-192.png", 192], ["public/app/icons/icon-512.png", 512], ["public/app/icons/icon-maskable-512.png", 512],
      ["public/app/icons/apple-touch-icon.png", 180], ["public/app/icons/badge-96.png", 96], ["public/shared/brand/icon-24.png", 24],
    ] as const) expect(png(rel), rel).toEqual({ w: size, h: size });
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/app/manifest.webmanifest"), "utf8")) as { icons: { src: string; sizes: string }[] };
    for (const icon of manifest.icons) {
      const [w] = icon.sizes.split("x").map(Number);
      expect(png(`public${icon.src}`), icon.src).toEqual({ w, h: w });
    }
    const ico = readFileSync(resolve(process.cwd(), "public/shared/brand/favicon.ico"));
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 3]); // an icon with three frames
    expect([0, 1, 2].map((i) => ico[6 + 16 * i])).toEqual([16, 24, 32]);
    for (const svg of ["favicon.svg", "favicon-24.svg"]) {
      expect(readFileSync(resolve(process.cwd(), "public/shared/brand", svg), "utf8"), svg).toMatch(/^<svg [^>]*viewBox="0 0 (16|24) (16|24)"/);
    }
  });

  it("denies directory listing for /shared/", async () => {
    const res = await fetch(`${baseUrl}/shared/`);
    expect(res.status).toBe(404);
  });

  it("redirects the app subdomain root to the console", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { "x-forwarded-host": "app.opencadre.example" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
  });
});

describe("GET /v1/me", () => {
  it("returns the signed-in agent and its organization", async () => {
    const { orgId } = createOrganization("Console Org");
    const { apiKey, agentId } = registerAgent(orgId, "Operator", { system: true });
    const res = await fetch(`${baseUrl}/v1/me`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    // `billing` (#387) is asserted separately so this identity/workspace shape stays exact while billing grows.
    const { billing, ...rest } = await res.json();
    expect(rest).toEqual({
      agentId, agentName: "Operator", role: "agent", orgId, orgName: "Console Org", memberRole: null, webhook_url: null, webhook_auth_set: false,
      workspace: { paused: false, pausedAt: null, pausedBy: null }, hubUrl: "https://hub.opencadre.example",
    });
    expect(billing).toMatchObject({ plan: "trial", readOnly: false, reason: null });
  });

  it("rejects a missing or wrong key", async () => {
    expect((await fetch(`${baseUrl}/v1/me`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/me`, { headers: { authorization: "Bearer agt_nope" } })).status).toBe(401);
  });
});
