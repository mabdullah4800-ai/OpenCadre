import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";

// The deploy script trusts /health to decide whether to keep a new image or roll back, so a
// hub whose database is unusable must not answer "ok".
let baseUrl: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("GET /health", () => {
  it("answers ok with the deployed version when the database responds", async () => {
    vi.stubEnv("OPENCADRE_VERSION", "abc1234");
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "abc1234" });
    vi.unstubAllEnvs();
  });

  it("answers 503 when the database can't run a query", async () => {
    const spy = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });
    const res = await fetch(`${baseUrl}/health`);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", error: "database unavailable" });
  });
});
