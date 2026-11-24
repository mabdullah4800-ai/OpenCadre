import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { askClarification, createOrganization, getMessages, registerAgent, reply, sendMessage } from "../src/service.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Watcher-Me");
  const peer = registerAgent(orgId, "Peer");
  return { orgId, me, peer: { id: peer.agentId, name: "Peer" } };
}

function run(script: string, args: string[], env: Record<string, string>, untilMs: number, stopWhen?: (out: string) => boolean) {
  return new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let out = "";
    const finish = () => { child.kill(); resolve(out); };
    const timer = setTimeout(finish, untilMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (stopWhen?.(out)) { clearTimeout(timer); finish(); }
    });
    // Refusals are written to stderr, so a test that expects one has to see stderr.
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

// These two start the script as a child process.
describe("opencadre-watch.mjs", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("prints real mail but stays silent on pure acknowledgements", async () => {
    const { orgId, me, peer } = setup("Watch PureAck Org");
    await sendMessage(orgId, peer, "Watcher-Me", "thanks");
    await sendMessage(orgId, peer, "Watcher-Me", "please rebase PR 50");
    const out = await run("scripts/opencadre-watch.mjs", ["--once"], { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: me.apiKey, OPENCADRE_WAIT_SECONDS: "1" }, 8000);
    expect(out).toContain("please rebase PR 50");
    expect(out).not.toMatch(/: thanks$/m);
  });
});

describe("poll-bridge.mjs", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("shows new mail without consuming it, and never repeats a message", async () => {
    const { orgId, me, peer } = setup("Poll Bridge Org");
    await sendMessage(orgId, peer, "Watcher-Me", "visible but still unread", "high");
    const out = await run("scripts/poll-bridge.mjs", [me.apiKey], { OPENCADRE_URL: baseUrl, OPENCADRE_WAIT_SECONDS: "1" }, 4000);
    expect(out.match(/visible but still unread/g)).toHaveLength(1);
    expect(getMessages(orgId, me.agentId, undefined, { peek: true })).toHaveLength(1);
  });
});

describe("inbox-watcher.mjs (zero-token ingest)", () => {
  it("queues every message kind and priority, including senders outside WATCH_PEERS, before marking read", async () => {
    const { orgId, me, peer } = setup("Ingest Org");
    const outsider = registerAgent(orgId, "Outsider");
    const home = mkdtempSync(path.join(tmpdir(), "ingest-"));
    const queue = path.join(home, "queue.jsonl");

    await sendMessage(orgId, peer, "Watcher-Me", "high priority ping", "high");
    await sendMessage(orgId, peer, "Watcher-Me", "low priority note", "low");
    await sendMessage(orgId, { id: outsider.agentId, name: "Outsider" }, "Watcher-Me", "from outside the peer list");
    await askClarification(orgId, peer, "Watcher-Me", "question with reply flag", 0);
    const mine = await sendMessage(orgId, { id: me.agentId, name: "Watcher-Me" }, "Peer", "my outbound");
    if (!mine.ok) throw new Error("send failed");
    reply(orgId, peer, mine.threadId, "a reply to me");

    await run("scripts/inbox-watcher.mjs", [], {
      OPENCADRE_MCP_URL: `${baseUrl}/mcp`, OPENCADRE_API_KEY: me.apiKey, OPENCADRE_AGENT_NAME: "Watcher-Me",
      OPENCADRE_WATCH_PEERS: "Peer", OPENCADRE_POLL_SECONDS: "1", HOME: home,
      OPENCADRE_QUEUE_PATH: queue, OPENCADRE_WATCHER_LOG: path.join(home, "watcher.log"),
    }, 6000, () => existsSync(queue) && readFileSync(queue, "utf8").split("\n").filter(Boolean).length >= 5);

    const bodies = readFileSync(queue, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).body);
    expect(bodies.sort()).toEqual(["a reply to me", "from outside the peer list", "high priority ping", "low priority note", "question with reply flag"]);
    // Consumed only after being durably queued: nothing left unread, nothing lost.
    expect(getMessages(orgId, me.agentId, undefined, { peek: true })).toHaveLength(0);
  }, 15000);
});

// The watcher can only wake agents that exist. Its defaults used to name agents
// that had already been retired, and the log line said nothing about who was
// being watched, so a live fleet could run this for hours watching nobody.
describe("inbox-watcher.mjs identity defaults", () => {
  const IDENTITY_ENV = [
    "OPENCADRE_SUPERVISOR", "OPENCADRE_AGENT_NAME", "OPENCADRE_WATCH_PEERS",
  ];

  function runWatcher(env: Record<string, string>) {
    return run("scripts/inbox-watcher.mjs", [], { ...env }, 3000);
  }

  it("refuses to start on a name that is not in the live fleet", async () => {
    const { orgId, me } = setup("Dead Name Org");
    // "ClaudeCode-Session" is the retired name the old default pointed at.
    const out = await runWatcher({
      OPENCADRE_MCP_URL: `${baseUrl}/mcp`, OPENCADRE_API_KEY: me.apiKey,
      OPENCADRE_AGENT_NAME: "ClaudeCode-Session", OPENCADRE_WATCH_PEERS: "Peer",
      HOME: mkdtempSync(path.join(tmpdir(), "deadname-")), OPENCADRE_POLL_SECONDS: "1",
    });
    expect(out).toMatch(/unknown agent|not a live agent|no such agent/i);
    expect(out).not.toContain("starting watch=");
  }, 15000);

  it("names the agent it is watching in the start line, so watching nobody is visible", async () => {
    const { orgId, me } = setup("Self Name Org");
    const out = await runWatcher({
      OPENCADRE_MCP_URL: `${baseUrl}/mcp`, OPENCADRE_API_KEY: me.apiKey,
      OPENCADRE_AGENT_NAME: "Watcher-Me", OPENCADRE_WATCH_PEERS: "Peer",
      HOME: mkdtempSync(path.join(tmpdir(), "selfname-")), OPENCADRE_POLL_SECONDS: "1",
    });
    expect(out).toMatch(/self=Watcher-Me/);
  }, 15000);

  it("prints who it will answer to, taken from the hub rather than a hardcoded default", async () => {
    const { orgId, me } = setup("Supervisor From Hub Org");
    // No OPENCADRE_SUPERVISOR is set on this run, and the hub's fleet contains no
    // supervisor-looking name, so the start line must not invent one.
    const out = await runWatcher({
      OPENCADRE_MCP_URL: `${baseUrl}/mcp`, OPENCADRE_API_KEY: me.apiKey,
      OPENCADRE_AGENT_NAME: "Watcher-Me", OPENCADRE_WATCH_PEERS: "Peer",
      HOME: mkdtempSync(path.join(tmpdir(), "supname-")), OPENCADRE_POLL_SECONDS: "1",
    });
    expect(out).toMatch(/self=Watcher-Me/);
    expect(out).not.toMatch(/supervisor=/);
  }, 15000);

  it("does not fall back to any retired agent name when the env is absent", () => {
    const src = readFileSync("scripts/inbox-watcher.mjs", "utf8");
    for (const dead of ["ClaudeCode-Session", "ClaudeCode-PC-Beta", "Cursor-Session", "Codex-Session", "Antigravity-Session"]) {
      expect(src).not.toContain(dead);
    }
  });
});

describe("rest-poll-bridge.sh", () => {
  it("long-polls with peek and an afterId cursor, and bounds each request", () => {
    const script = readFileSync("examples/clients/rest-poll-bridge.sh", "utf8");
    expect(script).toContain("peek=true");
    expect(script).toContain("afterId=");
    expect(script).toContain("--max-time");
  });
});

// The wake path ships to every customer, so it must name no specific agent. A
// retracted name in a default misroutes mail with no error, same as the watcher.
describe("shipped wake-path defaults name no retired agent", () => {
  const RETIRED = ["ClaudeCode-Session", "ClaudeCode-PC-Beta", "Cursor-Session", "Codex-Session", "Antigravity-Session"];

  for (const file of ["scripts/mcp-send.mjs", "examples/clients/cursor-cloud.env"]) {
    it(`${file} names no retired agent`, () => {
      const text = readFileSync(file, "utf8");
      for (const dead of RETIRED) expect(text).not.toContain(dead);
    });
  }

  // These two shipped a retired name as a DEFAULT rather than as a comment: the hierarchy
  // ranked three strangers of one fleet ahead of the reader's own agents, and the inbox
  // prompt omitted --to for exactly one of those names. Both surfaces ship to every
  // customer, so both are held to the same rule as the watcher above.
  for (const file of ["scripts/hierarchy.mjs", "scripts/agent-inbox-prompt.mjs"]) {
    it(`${file} names no retired agent`, () => {
      const text = readFileSync(file, "utf8");
      for (const dead of RETIRED) expect(text).not.toContain(dead);
    });
  }

  it("the inbox prompt always routes the reply to the sender it printed", () => {
    // Omitting --to for one hardcoded name made the printed command fall back to
    // OPENCADRE_SUPERVISOR (mcp-send.mjs defaults to it) on every other hub.
    const src = readFileSync("scripts/agent-inbox-prompt.mjs", "utf8");
    expect(src).toMatch(/reply --to \$\{inbound\.from\}/);
  });

  it("the hierarchy has no built-in agent order when OPENCADRE_HIERARCHY is unset", async () => {
    const saved = process.env.OPENCADRE_HIERARCHY;
    delete process.env.OPENCADRE_HIERARCHY;
    try {
      const { hierarchyList, hierarchyRank } = await import("../scripts/hierarchy.mjs?a=" + Date.now());
      expect(hierarchyList()).toEqual([]);
      // Every agent ties, so nothing is ranked ahead of anything else.
      expect(hierarchyRank("anyone")).toBe(hierarchyRank("anyone-else"));
    } finally {
      if (saved === undefined) delete process.env.OPENCADRE_HIERARCHY;
      else process.env.OPENCADRE_HIERARCHY = saved;
    }
  });

  it("the hierarchy still honours an explicit OPENCADRE_HIERARCHY", async () => {
    const saved = process.env.OPENCADRE_HIERARCHY;
    process.env.OPENCADRE_HIERARCHY = "boss,peer";
    try {
      const { hierarchyRank } = await import("../scripts/hierarchy.mjs?b=" + Date.now());
      expect(hierarchyRank("boss")).toBe(0);
      expect(hierarchyRank("peer")).toBe(1);
      expect(hierarchyRank("stranger")).toBeGreaterThan(1);
    } finally {
      if (saved === undefined) delete process.env.OPENCADRE_HIERARCHY;
      else process.env.OPENCADRE_HIERARCHY = saved;
    }
  });

  it("the Cursor Cloud example tells the operator to set the required agent name", () => {
    const text = readFileSync("examples/clients/cursor-cloud.env", "utf8");
    expect(text).toContain("OPENCADRE_AGENT_NAME=");
  });

  it("mcp-send send refuses to guess a recipient rather than mailing a dead name", () => {
    const src = readFileSync("scripts/mcp-send.mjs", "utf8");
    expect(src).toMatch(/send requires a recipient/);
  });
});
