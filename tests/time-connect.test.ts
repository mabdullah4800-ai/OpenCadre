import { toSqliteTime } from "../src/timestamps.js";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// Both tests start the script as a child process, so the describe uses the spawn timeout.

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const { app } = await import("../src/rest.js");
const { db } = await import("../src/db.js");
const { createOrganization, registerAgent } = await import("../src/service.js");

const SCRIPT = path.join(process.cwd(), "scripts", "time-connect.mjs");
let server: http.Server;
let hub: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sqliteTime = (ms: number) => toSqliteTime(ms);

describe("scripts/time-connect.mjs", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("shows the command, stamps installed and online as the client connects, and records a row without printing the operator key", async () => {
    const { orgId } = createOrganization("Timing Org");
    const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
    const out = path.join(mkdtempSync(path.join(tmpdir(), "timing-")), "CONNECT_TIMING.md");

    const child = spawn(process.execPath, [SCRIPT, "--client", "cursor", "--hub", hub, "--poll-ms", "250", "--out", out, "--name", "Cursor-Timed", "--note", "test run"], {
      env: { ...process.env, OPENCADRE_OPERATOR_KEY: operatorKey },
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no command printed: ${stdout}${stderr}`)), 10_000);
      child.stdout.on("data", (d) => {
        stdout += d;
        const match = stdout.match(/--code (oc_[A-Za-z0-9]{10})/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    // The user runs the command: the CLI redeems the code.
    const redeemed = await (await fetch(`${hub}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json();
    await new Promise((r) => setTimeout(r, 800));
    expect(stdout).toMatch(/installed\s+CLI finished/);

    // Then the client itself starts and checks in (more than a minute after the redeem, as the hub requires).
    db.prepare(`UPDATE connect_codes SET redeemed_at = ? WHERE agent_id = ?`).run(new Date(Date.now() - 2 * 60_000).toISOString(), redeemed.agentId);
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(sqliteTime(Date.now()), redeemed.agentId);

    expect(await exited).toBe(0);
    expect(stdout).toMatch(/online\s+Client connected/);
    expect(stdout).toMatch(/cursor: under 5 min/);
    expect(stdout + stderr).not.toContain(operatorKey);

    const table = readFileSync(out, "utf8");
    expect(table).toContain("| Date | Client | Command → CLI done | CLI done → client online | Total | Result | Notes |");
    expect(table).toMatch(/\| cursor \| 0:\d\d \| 0:\d\d \| 0:\d\d \| under 5 min \| test run \|/);
  }, 30_000);

  it("refuses to run without an operator key or with an unknown client", async () => {
    const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, OPENCADRE_OPERATOR_KEY: "", ...env } });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    });
    expect(await run(["--client", "codex", "--hub", hub], {})).toMatchObject({ code: 2, err: expect.stringContaining("OPENCADRE_OPERATOR_KEY") });
    expect(await run(["--client", "vim", "--hub", hub], { OPENCADRE_OPERATOR_KEY: "agt_x" })).toMatchObject({ code: 2, err: expect.stringContaining("--client must be one of") });
  });
});
