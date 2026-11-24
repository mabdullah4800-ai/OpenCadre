// Local opt-in, client side (scripts/opencadre-config.mjs: syncProjectAllowlist, folderAccess, resolveHub). A folder's
// project key reaches the hub only when that project is on this computer's copy of the workspace's enabled list.
//
// The zero-request claim is measured with a RECORDING hub that sees every request the helpers send, and it is only
// evidence because the same recorder is shown SEEING folder-bearing requests when the folder is listed (the known
// positive), and when the hub is too old to list (the fallback that keeps the gate asking).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allowlistFile, folderAccess, projectIdentity, readProjectAllowlist, resolveHub, syncProjectAllowlist,
} from "../scripts/opencadre-config.mjs";
import { childEnv, gitProject, ProxyProcess, tempDir } from "./helpers/device-hub.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

const CREDENTIAL = `dev_${"a".repeat(48)}`;
const OTHER_CREDENTIAL = `dev_${"b".repeat(48)}`;
const PROXY = path.join(process.cwd(), "scripts", "opencadre-mcp.mjs");
const GATE = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
const AWARENESS = path.join(process.cwd(), "examples", "hooks", "opencadre-awareness.mjs");

const json = (status: number, body: unknown) => ({ status, json: async () => body }) as unknown as Response;
const stubFetch = (answer: () => Response | Promise<Response>) => (async () => answer()) as unknown as typeof fetch;

function homeWith(hub: string, credential = CREDENTIAL) {
  const home = tempDir("oc-allow-");
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential, deviceId: "dev-test" } }));
  return home;
}

describe("the snapshot", () => {
  const HUB = "https://hub.example";

  it("a 200 writes it, per hub AND credential; folderAccess reads it", async () => {
    const home = homeWith(HUB);
    const listed = gitProject("Listed");
    const other = gitProject("Other", "git@github.com:acme/other.git");
    expect(folderAccess({ cwd: listed, hub: HUB, credential: CREDENTIAL, home })).toBe("unknown");
    const synced = await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: [projectIdentity(listed)!.key] })) });
    expect(synced).toEqual({ ok: true, projects: ["local:listed"] });
    expect(folderAccess({ cwd: listed, hub: HUB, credential: CREDENTIAL, home })).toBe("listed");
    expect(folderAccess({ cwd: other, hub: HUB, credential: CREDENTIAL, home })).toBe("unlisted");
    // Another credential (a reconnect into another workspace) or another hub has no snapshot of its own yet.
    expect(folderAccess({ cwd: listed, hub: HUB, credential: OTHER_CREDENTIAL, home })).toBe("unknown");
    expect(folderAccess({ cwd: listed, hub: "https://other.example", credential: CREDENTIAL, home })).toBe("unknown");
    // The file never holds the credential.
    expect(readFileSync(allowlistFile(home), "utf8")).not.toContain(CREDENTIAL);
  });

  it("never expires to empty: an outage, an error or a malformed answer keeps the last list", async () => {
    const home = homeWith(HUB);
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: ["github.com/acme/kept"] })) });
    const failures: Array<[() => Response | Promise<Response>, string]> = [
      [() => { throw new TypeError("fetch failed"); }, "unreachable"],
      [() => json(500, { error: "boom" }), "http_500"],
      [() => json(401, { error: "invalid" }), "http_401"],
      [() => json(200, { projects: "github.com/acme/kept" }), "bad_response"],
      [() => json(200, { projects: [1, 2] }), "bad_response"],
      [() => json(404, {}), "hub_cannot_list"],
    ];
    for (const [answer, reason] of failures) {
      expect(await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(answer) }), reason).toEqual({ ok: false, reason });
      expect([...readProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home })!.projects!], reason).toEqual(["github.com/acme/kept"]);
    }
    // Only a successful sync replaces it, and an empty list is a real answer then (every project switched off).
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: [] })) });
    expect([...readProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home })!.projects!]).toEqual([]);
  });

  it("a hub too old to list (404) is recorded only when there is no snapshot, and then asked per request", async () => {
    const home = homeWith(HUB);
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(404, {})) });
    expect(folderAccess({ cwd: gitProject("Any"), hub: HUB, credential: CREDENTIAL, home })).toBe("hub_cannot_list");
    // The hub is upgraded: the next sync replaces the marker with the real list.
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: [] })) });
    expect(folderAccess({ cwd: gitProject("Any2"), hub: HUB, credential: CREDENTIAL, home })).toBe("unlisted");
  });

  it("resolveHub: an unlisted folder gets no key (notEnabled); a listed one, no snapshot, or connect's allowUnlisted get the device", async () => {
    const home = homeWith(HUB);
    const folder = gitProject("Resolve");
    const env = { OPENCADRE_HOOK_HOME: home } as NodeJS.ProcessEnv;
    const resolve = (extra = {}) => resolveHub({ client: "claude-code", cwd: folder, home, env, sessionId: "chat-1", ...extra });
    expect(resolve().key).toBe(CREDENTIAL); // no snapshot yet: asked as before
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: [] })) });
    expect(resolve()).toEqual({ source: "device", notEnabled: true, allowlist: "unlisted" });
    expect(resolve({ allowUnlisted: true }).key).toBe(CREDENTIAL);
    await syncProjectAllowlist({ hub: HUB, credential: CREDENTIAL, home, fetchImpl: stubFetch(() => json(200, { projects: ["local:resolve"] })) });
    expect(resolve()).toMatchObject({ key: CREDENTIAL, source: "device", headers: { "x-opencadre-project": "local:resolve" } });
  });
});

// --- A recording hub --------------------------------------------------------------------------

type Seen = { method: string; url: string; project: string | undefined };
let recorder: Awaited<ReturnType<typeof startFetchRecorder>> | undefined;
let hubUrl = "";
const seen: Seen[] = [];
/** What GET /v1/devices/projects answers: a list, or 404 (a hub from before the route). */
let listing: string[] | "old" = [];

beforeAll(async () => {
  recorder = await startFetchRecorder((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", project: req.headers["x-opencadre-project"] as string | undefined });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/v1/devices/projects") {
        if (listing === "old") return void res.writeHead(404).end(JSON.stringify({ error: "not found" }));
        return void res.writeHead(200).end(JSON.stringify({ projects: listing }));
      }
      // Everything folder-bearing is refused the way a real hub refuses an unenabled project, so a helper that DID send
      // one would behave exactly as it does in production and the only difference is what this recorder saw.
      res.writeHead(403).end(JSON.stringify({ error: "project_not_enabled", project: req.headers["x-opencadre-project"] ?? null }));
    });
  });
  hubUrl = recorder.url;
  console.info(`[allowlist recorder] Fetch-ready ${hubUrl}; readiness traffic excluded`);
});
afterAll(async () => { await recorder?.close(); });

function run(script: string, stdin: object, env: Record<string, string>, cwd: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

/** Everything a chat in `folder` does: the MCP server's whole startup and a tool call, the awareness hook, and a risky
 * command through the approval gate in LOCAL ask mode. Returns what the gate answered. */
async function chatIn(folder: string, home: string) {
  const env = childEnv(home, { CLAUDE_CODE_SESSION_ID: "chat-1", CLAUDE_CODE_HOST_SESSION_ID: "host-1", OPENCADRE_GATE_MODE: "ask", OPENCADRE_POLICY_TIMEOUT_MS: "5000" });
  const proxy = new ProxyProcess(PROXY, env, folder);
  await proxy.initialize();
  proxy.notify("notifications/initialized");
  await proxy.request("tools/list");
  await proxy.request("tools/call", { name: "get_messages", arguments: {} });
  proxy.child.stdin.end();
  await proxy.exited;
  await run(AWARENESS, { hook_event_name: "UserPromptSubmit", session_id: "chat-1", cwd: folder }, env, folder);
  return run(GATE, { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, session_id: "chat-1", cwd: folder }, env, folder);
}

const folderBearing = () => seen.filter((s) => s.url !== "/v1/devices/projects");

describe("what the hub sees from a chat", () => {
  it("an UNLISTED folder sends zero folder-bearing requests: only the header-free list refresh reaches the hub", async () => {
    const home = homeWith(hubUrl);
    const folder = gitProject("Private");
    listing = ["github.com/acme/elsewhere"];
    seen.length = 0;
    const gate = await chatIn(folder, home);
    expect(folderBearing()).toEqual([]);
    expect(seen.length).toBeGreaterThan(0); // the proxy's start-up refresh did happen, so the recorder was listening
    expect(seen.every((s) => s.project === undefined)).toBe(true);
    // As if OpenCadre weren't installed: the gate passes even with a LOCAL ask policy, and prints nothing.
    expect(gate).toEqual({ code: 0, out: "" });
    // The proxy's refresh wrote the snapshot, from nothing.
    expect(readProjectAllowlist({ hub: hubUrl, credential: CREDENTIAL, home })).toMatchObject({ projects: new Set(["github.com/acme/elsewhere"]) });
  }, 60_000);

  it("KNOWN POSITIVE: the same chat in a LISTED folder is seen by the same recorder, naming its project", async () => {
    const home = homeWith(hubUrl);
    const folder = gitProject("Public");
    listing = ["local:public"];
    seen.length = 0;
    await chatIn(folder, home);
    expect(folderBearing().length).toBeGreaterThan(0);
    expect(folderBearing().every((s) => s.project === "local:public")).toBe(true);
  }, 60_000);

  it("a hub too old to list (404): the gate still asks it, so clearance is not switched off by the upgrade", async () => {
    const home = homeWith(hubUrl);
    const folder = gitProject("OldHub");
    listing = "old";
    seen.length = 0;
    await chatIn(folder, home);
    expect(seen.some((s) => s.url.startsWith("/v1/clearance-policy") && s.project === "local:oldhub")).toBe(true);
    expect(folderAccess({ cwd: folder, hub: hubUrl, credential: CREDENTIAL, home })).toBe("hub_cannot_list");
    listing = [];
  }, 60_000);

  it("the snapshot file is written atomically in place: no temp file is left behind", async () => {
    const home = homeWith(hubUrl);
    listing = ["local:x"];
    await syncProjectAllowlist({ hub: hubUrl, credential: CREDENTIAL, home });
    const dir = path.dirname(allowlistFile(home));
    expect(existsSync(allowlistFile(home))).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    listing = [];
  });
});
