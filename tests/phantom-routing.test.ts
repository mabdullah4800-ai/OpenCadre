import { toSqliteTime } from "../src/timestamps.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyRecipient, phantomWarning, graceMinutes } from "../scripts/phantom-identity.mjs";

// A "phantom" is a roster row that no process is behind: a client's proxy create path mints one
// with no chat open, it never acts, and anything routed to it is silently dropped. The sender
// cannot see "has acted" on the roster, so the durable signal is never-set-a-status plus a grace
// window -- never presence, because both measured phantoms read `offline`.
const row = (o: Record<string, unknown> = {}) => ({
  name: "Agent", status_updated_at: null, created_at: null, key_class: "agent", ...o,
});

// SQLite's "YYYY-MM-DD HH:MM:SS" UTC, the format agents.created_at is written in.
const ago = (minutes: number) =>
  toSqliteTime(Date.now() - minutes * 60000);

describe("phantom identity classifier", () => {
  it("flags a long-lived row that never set a status", () => {
    const info = classifyRecipient(row({ name: "Phantom-Agent", created_at: ago(180) }));
    expect(info).not.toBeNull();
    expect(info!.name).toBe("Phantom-Agent");
    expect(info!.tier).toBe("stale");
    expect(info!.ageMinutes).toBeGreaterThanOrEqual(179);
  });

  it("flags an OFFLINE phantom too -- both measured instances read offline, not online", () => {
    // This is the case that made the original brief wrong: a predicate of "online and no status"
    // would have caught neither Codex-OpenCadre-7ed0 nor -f2e2.
    const offline = row({ name: "Codex-OpenCadre-7ed0", created_at: ago(300), online: false, state: "offline" });
    expect(classifyRecipient(offline)?.tier).toBe("stale");
  });

  it("flags a paused phantom -- auto-suspended for staleness is the same case", () => {
    const paused = row({ name: "Paused-Phantom", created_at: ago(300), status: "paused" });
    expect(classifyRecipient(paused)?.tier).toBe("stale");
  });

  it("treats a row inside the grace window as fresh, not stale", () => {
    const info = classifyRecipient(row({ name: "New-Agent", created_at: ago(2) }));
    expect(info?.tier).toBe("fresh");
  });

  it("never flags an agent that has set a status, regardless of age", () => {
    const real = row({ name: "Real-Agent", created_at: ago(9999), status_updated_at: ago(1) });
    expect(classifyRecipient(real)).toBeNull();
  });

  it("never flags a person", () => {
    expect(classifyRecipient(row({ name: "Someone", created_at: ago(9999), key_class: "human" }))).toBeNull();
  });

  it("stays silent when created_at is missing, rather than guessing an age", () => {
    expect(classifyRecipient(row({ name: "No-Clock", created_at: null }))).toBeNull();
  });

  it("stays silent for a missing or unparseable row", () => {
    expect(classifyRecipient(undefined)).toBeNull();
    expect(classifyRecipient(row({ created_at: "not a date" }))).toBeNull();
  });

  it("honours OPENCADRE_PHANTOM_GRACE_MINUTES and defaults to 10", () => {
    expect(graceMinutes({})).toBe(10);
    expect(graceMinutes({ OPENCADRE_PHANTOM_GRACE_MINUTES: "30" })).toBe(30);
    expect(graceMinutes({ OPENCADRE_PHANTOM_GRACE_MINUTES: "0" })).toBe(0);
    // Garbage must not silently become "flag everything" or "flag nothing".
    expect(graceMinutes({ OPENCADRE_PHANTOM_GRACE_MINUTES: "soon" })).toBe(10);
    expect(graceMinutes({ OPENCADRE_PHANTOM_GRACE_MINUTES: "-5" })).toBe(10);
  });

  it("the warning states the consequence, not just the condition", () => {
    const stale = phantomWarning({ name: "Phantom-Agent", ageMinutes: 180, tier: "stale" })!;
    // A warning that only says "this looks odd" trains people to ignore it.
    expect(stale).toMatch(/silently dropped/);
    expect(stale).toMatch(/never set a status/);
    expect(stale).toMatch(/180m/);
    const fresh = phantomWarning({ name: "New-Agent", ageMinutes: 1, tier: "fresh" })!;
    expect(fresh).toMatch(/Sending anyway/);
  });
});

// created_at reaches the client only via listActiveAgents' `...rest` spread -- it is NOT in the
// AgentRecord type. If someone later tightens that spread the field vanishes, the grace window
// degrades to "flag everyone forever", and nothing else would notice. This test is load-bearing.
describe("created_at survives to the roster response", () => {
  it("listActiveAgents still spreads created_at onto each row", () => {
    const src = readFileSync("src/service.ts", "utf8");
    const fn = src.slice(src.indexOf("export function listActiveAgents"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // The spread is what carries created_at; pin it, and pin that the row is returned as-is.
    expect(body).toMatch(/\.\.\.rest|\.\.\.placed/);
    expect(body).toMatch(/status_updated_at/);
  });
});

// The classifier is only useful if the senders actually call it. A pure unit test would pass
// even if nothing imported it.
//
// Grepping for the import is NOT enough: it cannot see a *duplicate* call site. An earlier
// version called warnIfPhantom once before the mode branch and again inside it, so every send
// fetched the roster twice and printed the warning twice -- invisible to an import grep, and it
// shipped green. Counting the fetches against a stub hub is what catches that.
describe("mcp-send.mjs calls the phantom check exactly once per send", () => {
  it("fetches the roster once, not twice, on a send", async () => {
    const http = await import("node:http");
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/v1/agents") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ agents: [{ name: "Phantom-Agent", status_updated_at: null, created_at: ago(180), key_class: "agent" }] }));
        return;
      }
      // The MCP call: a minimal SSE-shaped reply the client accepts.
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } })}\n`);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const home = mkdtempSync(path.join(tmpdir(), "cadence-"));
    const envFile = path.join(home, "w.env");
    writeFileSync(envFile, `OPENCADRE_MCP_URL=http://127.0.0.1:${port}/mcp\nOPENCADRE_API_KEY=fake\n`);
    // OPENCADRE_SUPERVISOR matters: a duplicate call placed before the mode branch
    // sees the pre-reassignment `toAgent`, and warnIfPhantom returns early on an
    // empty recipient. Without a supervisor set, that early call fetches nothing and
    // a duplicate is invisible -- which is how this defect shipped green once already.
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["scripts/mcp-send.mjs", "send", "Phantom-Agent", "hello"], {
        env: {
          ...process.env, OPENCADRE_ENV_FILE: envFile, HOME: home,
          OPENCADRE_PHANTOM_GRACE_MINUTES: "0", OPENCADRE_SUPERVISOR: "Phantom-Agent",
        },
      });
      let o = "";
      child.stdout.on("data", (d) => { o += d; });
      child.stderr.on("data", (d) => { o += d; });
      setTimeout(() => child.kill(), 8000);
      child.on("close", () => resolve(o));
    });
    await new Promise<void>((r) => server.close(() => r()));

    const rosterFetches = hits.filter((u) => u === "/v1/agents").length;
    expect(rosterFetches).toBe(1);
    // And the warning itself appears once, not twice.
    expect(out.match(/has been on the roster/g) ?? []).toHaveLength(1);
  }, 20000);

  for (const file of ["scripts/mcp-send.mjs", "scripts/inbox-watcher.mjs"]) {
    it(`${file} imports and uses the phantom check`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/from "\.\/phantom-identity\.mjs"/);
      expect(src).toMatch(/classifyRecipient|phantomWarning/);
    });
  }

  it("neither sender hardcodes a phantom name", () => {
    for (const file of ["scripts/mcp-send.mjs", "scripts/inbox-watcher.mjs", "scripts/phantom-identity.mjs"]) {
      const src = readFileSync(file, "utf8");
      // The next app start mints new phantoms; the check must be on shape, never on names.
      expect(src).not.toMatch(/7ed0|f2e2/);
    }
  });
});