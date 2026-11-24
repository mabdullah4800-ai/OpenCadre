// Shared by tests/mcp-proxy.test.ts and tests/session-commands.test.ts: a real hub (REST + /mcp on one server, as
// src/index.ts wires them), a way to add a machine, and child processes that can never see this machine's real home,
// real client configs or the Claude Code session this test run may itself be running inside.
import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFetchRecorder } from "./fetch-recorder.js";

export const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-dev-path-"));

export const tempDir = (prefix = "oc-dev-") => mkdtempSync(path.join(tmpdir(), prefix));

/** A folder inside its own git checkout named `name`, so session names read ClaudeCode-<name>-xxxx. With no remote its
 * project key is local:<name>; with `remote` it is that remote's host/owner/repo. */
export function gitProject(name: string, remote?: string) {
  const root = path.join(tempDir("oc-dev-proj-"), name);
  mkdirSync(path.join(root, ".git"), { recursive: true });
  if (remote) writeFileSync(path.join(root, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n`);
  return root;
}

/** An operator enables a project for the workspace (projects are opt-in). */
export async function enableProject(hub: string, operatorKey: string, projectKey: string, enabled = true) {
  const res = await fetch(`${hub}/v1/org/projects`, {
    method: "PUT",
    headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ projectKey, enabled }),
  });
  if (!res.ok) throw new Error(`enabling ${projectKey} failed: HTTP ${res.status}`);
}

/** The credential `opencadre connect --code ocd_…` wrote into a home. Tests only; never printed. */
export const computerCredential = (home: string) => JSON.parse(readFileSync(path.join(home, ".opencadre", "credentials.json"), "utf8")).computer.credential as string;

/** Test-only seams for tests/device-hub-fetch-ready.test.ts; every other caller passes nothing. */
type StartHubOptions = {
  fetchImpl?: typeof fetch;
  serverFactory?: (listener: http.RequestListener) => http.Server;
};

/** Starts the hub in this process. The app is imported here, after the caller has set any env it needs.
 * The port is OS-assigned and can be one Fetch refuses ("bad port"; this PC's dynamic range starts at 1024), which
 * failed suite runs in enableProject/mintDevice. startFetchRecorder probes it with Fetch, rebinds only on that
 * explicit refusal (at most three attempts, each rejected server closed) and lets every other error through. */
export async function startHub(options: StartHubOptions = {}) {
  const { app } = await import("../../src/rest.js");
  const { handleMcpRequest } = await import("../../src/mcp.js");
  const { server, url } = await startFetchRecorder((req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req, res);
      });
      return;
    }
    app(req, res);
  }, options);
  return {
    url,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The child's environment: no OPENCADRE_* or CLAUDE_CODE_* from this run, an empty PATH (no real claude CLI), and
 * HOME/USERPROFILE and platform config roots pointed at the test home so no client can find the developer's files. */
export function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (v === undefined || upper === "PATH" || upper.startsWith("OPENCADRE_") || upper.startsWith("CLAUDE_CODE_") || upper === "HOME" || upper === "USERPROFILE" || upper === "APPDATA" || upper === "LOCALAPPDATA") continue;
    env[k] = v;
  }
  return {
    ...env,
    PATH: EMPTY_PATH, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    GOOSE_PATH_ROOT: "", OPENCADRE_HOOK_HOME: home,
    ...extra,
  };
}

/** Runs a script to completion, asynchronously: the hub lives in this process, so a sync spawn would deadlock it. */
export function runNode(script: string, args: string[], env: Record<string, string>, cwd?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, ...(cwd ? { cwd } : {}) });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

export async function operatorWorkspace(name: string) {
  const { createOrganization, registerAgent } = await import("../../src/service.js");
  const { assignPlan } = await import("../../src/billing.js");
  const { orgId } = createOrganization(name);
  // UNCAPPED PLAN FOR TEST FIXTURES (9d1f's ruling, applied at the shared helper so every suite that
  // builds a workspace this way is covered at once). A fresh org is on the TRIAL plan, which now carries
  // real caps -- so a suite opening more than 10 sessions, or enabling more than 3 projects, would be
  // refused part-way through by a limit that is working CORRECTLY. That is the fixture exhausting a plan,
  // not the code being wrong; the tests that measure the refusal build a CAPPED org deliberately, on
  // purpose, in tests/billing.test.ts.
  //
  // `internal` is the right plan for a fixture: uncapped and non-expiring by design (migration 29), so a
  // fixture can never hit a limit or lapse mid-run. One helper, one fix, rather than a promotion per suite
  // that happens to trip the cap today and will be missed when someone adds the next one.
  assignPlan(orgId, "internal");
  return { orgId, operatorKey: registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey };
}

export async function mintDevice(hub: string, operatorKey: string, client = "claude-code") {
  const res = await fetch(`${hub}/v1/org/devices`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `Test machine ${Math.random().toString(36).slice(2, 8)}`, client }),
  });
  return (await res.json()) as { deviceId: string; code: string };
}

export type SessionView = { agentId: string; agentName: string; deviceId: string; project: string | null; projectKey: string | null; projectName: string | null; tool: string | null };

export async function liveSessions(hub: string, operatorKey: string, deviceId?: string): Promise<SessionView[]> {
  const res = await fetch(`${hub}/v1/org/sessions`, { headers: { authorization: `Bearer ${operatorKey}` } });
  const { sessions } = (await res.json()) as { sessions: SessionView[] };
  return deviceId ? sessions.filter((s) => s.deviceId === deviceId) : sessions;
}

/** A new session's auto name (sessions PR1): one word from NAME_WORDS (src/agent-names.ts), or on collision two words
 * or a word and a number. It no longer spells out the client and project ("Codex-Proj-1a2b"): those are the session's
 * `tool` and `projectName`, which sessionNamed reads. */
export const WORD_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/;

/** The live session with this name, as GET /v1/org/sessions lists it: where a test finds the tool and project a name
 * used to carry. */
export async function sessionNamed(hub: string, operatorKey: string, name: string): Promise<SessionView | undefined> {
  return (await liveSessions(hub, operatorKey)).find((s) => s.agentName === name);
}

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; result?: any; error?: { code: number; message: string }; method?: string };

/** One scripts/opencadre-mcp.mjs process, driven over stdio like Claude Code drives it. */
export class ProxyProcess {
  readonly child: ChildProcessWithoutNullStreams;
  out = "";
  err = "";
  readonly messages: RpcMessage[] = [];
  private listeners: Array<() => void> = [];
  private nextId = 1;
  readonly exited: Promise<number | null>;

  constructor(script: string, env: Record<string, string>, cwd: string, client = "claude-code", args: string[] = []) {
    this.child = spawn(process.execPath, [script, ...args, "--client", client], { env, cwd });
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      this.out += chunk;
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim()) this.messages.push(JSON.parse(line));
        for (const l of this.listeners) l();
      }
    });
    this.child.stderr.on("data", (chunk) => (this.err += chunk));
    this.exited = new Promise((resolve) => this.child.on("close", resolve));
  }

  write(message: object) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params?: object) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** Sends a request and resolves with its response (matched by id). */
  request(method: string, params?: object, timeoutMs = 15_000): Promise<RpcMessage> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return this.response(id, timeoutMs);
  }

  response(id: number | string, timeoutMs = 15_000): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.find((m) => m.id === id);
        if (!found) return false;
        this.listeners = this.listeners.filter((l) => l !== listener);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const listener = () => void check();
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`no response to ${id} within ${timeoutMs} ms; stderr: ${this.err}`));
      }, timeoutMs);
      if (!check()) this.listeners.push(listener);
    });
  }

  initialize() {
    return this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } });
  }

  /** tools/call, returning the text content. */
  async callTool(name: string, args: object = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    return (res.result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  }

  async close() {
    this.child.stdin.end();
    return this.exited;
  }
}
