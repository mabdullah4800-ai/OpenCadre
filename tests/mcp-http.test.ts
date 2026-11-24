import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_MCP_BODY_BYTES, readMcpBody } from "../src/mcp-http.js";

let server: http.Server;
let url: string;
let handled = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => readMcpBody(req, res, async (body) => {
    handled++;
    if (body === "fail") throw new Error("private internal details");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ received: body }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

it("refuses oversized bytes and malformed JSON before dispatch, and accepts a valid request afterward", async () => {
  const before = handled;
  expect((await fetch(url, { method: "POST", body: JSON.stringify("x".repeat(MAX_MCP_BODY_BYTES)) })).status).toBe(413);
  expect((await fetch(url, { method: "POST", body: "{" })).status).toBe(400);
  expect(handled).toBe(before);
  const healthy = await fetch(url, { method: "POST", body: '{"jsonrpc":"2.0"}' });
  expect(healthy.status).toBe(200);
  expect(await healthy.json()).toEqual({ received: { jsonrpc: "2.0" } });
});

it("contains asynchronous handler errors without exposing internal details", async () => {
  const failed = await fetch(url, { method: "POST", body: '"fail"' });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private internal details");
});
