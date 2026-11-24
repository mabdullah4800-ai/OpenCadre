import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("retired waitlist routes", () => {
  it.each([
    ["POST", "/v1/waitlist"],
    ["GET", "/v1/admin/waitlist"],
    ["POST", "/v1/admin/waitlist/old/approve"],
  ])("%s %s is unavailable", async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    expect(res.status).toBe(404);
  });
});

describe("the root", () => {
  it("sends every host's root to the console, with no marketing site in front of it", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
    expect((await fetch(`${baseUrl}/site.css`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/pricing`)).status).toBe(404);
  });

  it("sends the app subdomain's root to the console", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { "x-forwarded-host": "app.opencadre.example" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
  });
});