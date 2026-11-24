import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals } from "../src/approvals.js";
import { listEvents } from "../src/events.js";
import { normalizeProject, setClearancePolicy } from "../src/clearance-policy.js";
// @ts-expect-error -- plain ESM helper shared with the hooks, no type declarations
import { normalizeProject as hookNormalizeProject } from "../scripts/opencadre-config.mjs";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { signInPerson } from "./helpers/person.js";

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const scratch = () => mkdtempSync(path.join(tmpdir(), "clearance-"));

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Claude Coder");
  return { orgId, operator: { id: operator.agentId, name: "Operator" }, operatorKey: operator.apiKey, coderKey: coder.apiKey };
}

/** `as` is an agent key, or a signed-in person's headers (cookie + workspace): since #653 only a person changes policy. */
const call = (method: string, route: string, as: string | Record<string, string>, body?: unknown) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: typeof as === "string" ? { authorization: `Bearer ${as}`, "content-type": "application/json" } : { "content-type": "application/json", ...as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ownerOf = async (orgId: string) => (await signInPerson(orgId, "Olive", "owner")).headers;

/** A git repo whose origin is `remote`, so the gate derives a project key from it. */
function repo(remote?: string): string {
  const dir = scratch();
  execFileSync("git", ["init", "-q", "-b", "feature-x"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

function runGate(command: string, env: Record<string, string>, cwd: string, home = cwd): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, OPENCADRE_GATE_MODE: "", OPENCADRE_GATE_CONFIG: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));
  });
}

const decision = (out: string) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision as string : "pass");

/** A stand-in hub that answers every request with `reply` and counts what it was asked. */
async function fakeHub(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: string[] = [];
  const fake = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    reply(req, res);
  });
  await new Promise<void>((resolve) => fake.listen(0, resolve));
  const addr = fake.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, seen, close: (done?: () => void) => fake.close(done) };
}

describe("project keys", () => {
  const cases: Array<[unknown, string | null]> = [
    [undefined, ""],
    ["", ""],
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["https://github.com/acme/app.git", "github.com/acme/app"],
    ["https://x-access-token:ghp_secret@github.com/acme/app.git/", "github.com/acme/app"],
    ["ssh://git@gitlab.com:2222/group/sub/proj.git", "gitlab.com/group/sub/proj"],
    ["github.com/acme/app", "github.com/acme/app"],
    ["C:\\repos\\app", null],
    ["file:///home/me/app", null],
    ["../etc/passwd", null],
    ["https://user:pa/ss@github.com/acme/app", null],
    ["https://user:t@ken@github.com/acme/app.git", "github.com/acme/app"],
    [42, null],
    ["a".repeat(201), null],
  ];

  it.each(cases)("normalizes %j to %j on the hub and in the gate alike", (raw, expected) => {
    expect(normalizeProject(raw)).toBe(expected);
    expect(hookNormalizeProject(raw)).toBe(expected);
  });

  it("never keeps credentials from a remote URL", () => {
    expect(normalizeProject("https://oauth2:glpat-abc123@gitlab.com/acme/app.git")).not.toContain("glpat");
  });
});

describe("clearance policy API", () => {
  it("defaults to off, and a project falls back to the workspace default", async () => {
    const w = workspace("Policy Defaults");
    const owner = await ownerOf(w.orgId);
    const read = async (project?: string) =>
      (await (await call("GET", `/v1/clearance-policy${project === undefined ? "" : `?project=${encodeURIComponent(project)}`}`, w.coderKey)).json()).policy;

    expect(await read("github.com/acme/app")).toMatchObject({ mode: "off", source: "default", updatedBy: null });

    expect((await call("PUT", "/v1/clearance-policy", owner, { mode: "ask" })).status).toBe(200);
    expect(await read("git@github.com:acme/app.git")).toMatchObject({ project: "github.com/acme/app", mode: "ask", source: "workspace", updatedBy: "Olive" });

    const put = await call("PUT", "/v1/clearance-policy", owner, { project: "https://github.com/acme/app.git", mode: "strict" });
    expect((await put.json()).policy).toMatchObject({ project: "github.com/acme/app", mode: "strict", source: "project" });
    expect(await read("github.com/acme/app")).toMatchObject({ mode: "strict", source: "project" });
    expect(await read("github.com/acme/other")).toMatchObject({ mode: "ask", source: "workspace" });

    const list = await (await call("GET", "/v1/clearance-policies", w.operatorKey)).json();
    expect(list.policies.map((p: { project: string; mode: string }) => [p.project, p.mode])).toEqual([["", "ask"], ["github.com/acme/app", "strict"]]);

    const cleared = await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", owner);
    expect((await cleared.json()).policy).toMatchObject({ mode: "ask", source: "workspace" });
    expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", owner)).status).toBe(404);
  });

  it("only a signed-in owner or admin changes policy; operators list it; bad input is rejected", async () => {
    const w = workspace("Policy Roles");
    const owner = await ownerOf(w.orgId);
    expect((await call("PUT", "/v1/clearance-policy", w.coderKey, { mode: "off" })).status).toBe(403);
    expect((await call("DELETE", "/v1/clearance-policy", w.coderKey)).status).toBe(403);
    expect((await call("GET", "/v1/clearance-policies", w.coderKey)).status).toBe(403);
    expect((await call("PUT", "/v1/clearance-policy", owner, { mode: "yolo" })).status).toBe(400);
    expect((await call("PUT", "/v1/clearance-policy", owner, { mode: "ask", project: "../etc" })).status).toBe(400);
    expect((await call("GET", "/v1/clearance-policy?project=C:%5Crepos", w.coderKey)).status).toBe(400);
    expect((await call("GET", "/v1/clearance-policy", "")).status).toBe(401);
  });

  // Security review of #653 (Codex, launch blocker): a key could set Ask to Off, or delete Strict so it fell back to Off,
  // and skip every clearance. Only a signed-in owner or admin PERSON changes policy now; keys keep read access.
  it("keys only READ policy: agent, operator and device callers are refused a write; owner and admin persons may; a member may not", async () => {
    const w = workspace("Policy Person Only");
    const owner = await signInPerson(w.orgId, "Olive", "owner");
    const admin = await signInPerson(w.orgId, "Admin", "admin");
    const member = await signInPerson(w.orgId, "Member", "member");
    expect((await call("PUT", "/v1/clearance-policy", owner.headers, { mode: "ask" })).status).toBe(200);
    expect((await call("PUT", "/v1/clearance-policy", owner.headers, { project: "github.com/acme/app", mode: "strict" })).status).toBe(200);

    const { db } = await import("../src/db.js");
    const { createDevice, redeemDeviceCode } = await import("../src/devices.js");
    db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled, enabled_at) VALUES (?, 'github.com/acme/app', 'app', 1, ?)`).run(w.orgId, new Date().toISOString());
    const redeemed = redeemDeviceCode(createDevice(w.orgId, w.operator, "Policy laptop", "claude-code").code);
    if (!redeemed.ok || !redeemed.deviceCredential) throw new Error("redeem failed");
    const device = {
      authorization: `Bearer ${redeemed.deviceCredential}`, "x-opencadre-session": "policy-chat",
      "x-opencadre-project": "github.com/acme/app", "x-opencadre-project-name": "app",
    };
    const REFUSED = /Only a signed-in owner or admin can change clearance policy/;
    for (const [who, as] of [["agent", w.coderKey], ["operator", w.operatorKey], ["device", device]] as const) {
      const off = await call("PUT", "/v1/clearance-policy", as, { mode: "off" });
      expect(off.status, who).toBe(403);
      expect((await off.json()).error, who).toMatch(REFUSED);
      expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", as)).status, who).toBe(403);
      // Read access stays.
      expect((await call("GET", "/v1/clearance-policy?project=github.com/acme/app", as)).status, who).toBe(200);
    }
    // Bearer beats cookie: an operator key riding with the owner's cookie is still the key; a bad bearer is 401.
    const withKey = { ...owner.headers, authorization: `Bearer ${w.operatorKey}` };
    expect((await call("PUT", "/v1/clearance-policy", withKey, { mode: "off" })).status).toBe(403);
    expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", withKey)).status).toBe(403);
    expect((await call("PUT", "/v1/clearance-policy", { ...owner.headers, authorization: "Bearer not-a-key" }, { mode: "off" })).status).toBe(401);
    // A member person: refused by the existing role rule (clearancePolicy.write is admin).
    expect((await call("PUT", "/v1/clearance-policy", member.headers, { mode: "off" })).status).toBe(403);
    // Nothing a refused caller sent took effect.
    const read = async (project: string) => (await (await call("GET", `/v1/clearance-policy?project=${project}`, w.coderKey)).json()).policy;
    expect(await read("github.com/acme/app")).toMatchObject({ mode: "strict", source: "project" });
    expect(await read("github.com/acme/other")).toMatchObject({ mode: "ask", source: "workspace" });
    // Controls: an admin person changes and deletes.
    expect((await call("PUT", "/v1/clearance-policy", admin.headers, { mode: "notify" })).status).toBe(200);
    expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", admin.headers)).status).toBe(200);
  });

  it("keeps each workspace's policy to itself", async () => {
    const a = workspace("Policy Org A");
    const b = workspace("Policy Org B");
    expect((await call("PUT", "/v1/clearance-policy", await ownerOf(a.orgId), { project: "github.com/acme/app", mode: "strict" })).status).toBe(200);
    expect((await (await call("GET", "/v1/clearance-policy?project=github.com/acme/app", b.coderKey)).json()).policy.mode).toBe("off");
    expect((await (await call("GET", "/v1/clearance-policies", b.operatorKey)).json()).policies).toEqual([]);
    expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", await ownerOf(b.orgId))).status).toBe(404);
  });

  it("records each real change on the timeline once", async () => {
    const w = workspace("Policy Timeline");
    const owner = await ownerOf(w.orgId);
    await call("PUT", "/v1/clearance-policy", owner, { mode: "notify" });
    await call("PUT", "/v1/clearance-policy", owner, { mode: "notify" });
    await call("PUT", "/v1/clearance-policy", owner, { mode: "strict" });
    await call("DELETE", "/v1/clearance-policy", owner);
    const changes = listEvents(w.orgId).filter((e) => e.type === "clearance.policy_changed").map((e) => JSON.parse(e.payload));
    expect(changes).toEqual([
      { project: "", mode: "notify", previous: null },
      { project: "", mode: "strict", previous: "notify" },
      { project: "", mode: null, previous: "strict" },
    ]);
  });
});

// Each test here starts the gate as a child process.
describe("gate enforces the hub policy", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const REMOTE = "git@github.com:acme/app.git";

  it("holds a risky command for approval when the project is strict, even though local mode is notify", async () => {
    const w = workspace("Gate Strict");
    setClearancePolicy(w.orgId, w.operator, "github.com/acme/app", "strict");
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.coderKey, OPENCADRE_GATE_MODE: "notify", OPENCADRE_APPROVAL_WAIT: "1" };
    const r = await runGate("rm -rf ./data", env, repo(REMOTE));
    expect(decision(r.out)).toBe("deny");
    expect(r.out).toContain("no approval received");
    expect(listApprovals(w.orgId).map((a) => a.status)).toEqual(["expired"]);
  });

  it("ignores local settings that would loosen the hub policy", async () => {
    const w = workspace("Gate No Loosening");
    setClearancePolicy(w.orgId, w.operator, "", "ask");
    const cwd = repo(REMOTE);
    const local = path.join(cwd, "loose.json");
    writeFileSync(local, JSON.stringify({
      mode: "off", useDefaultRules: false, disabledCategories: ["rm-rf"], allow: ["rm -rf"], onTimeout: "allow", onHubUnreachable: "allow", protectedBranches: [],
    }));
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.coderKey, OPENCADRE_GATE_CONFIG: local, OPENCADRE_APPROVAL_WAIT: "1" };
    expect(decision((await runGate("rm -rf ./data", env, cwd)).out)).toBe("deny");
    expect(listApprovals(w.orgId)).toHaveLength(1);
    // The hub's own exemptions still apply: routine build output isn't held.
    expect(decision((await runGate("rm -rf dist", env, cwd)).out)).toBe("pass");
  });

  it("lets local config tighten the hub policy", async () => {
    const w = workspace("Gate Tighten");
    setClearancePolicy(w.orgId, w.operator, "", "notify");
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.coderKey, OPENCADRE_GATE_MODE: "ask", OPENCADRE_APPROVAL_WAIT: "1" };
    expect(decision((await runGate("npm publish", env, repo(REMOTE))).out)).toBe("deny");
    expect(listApprovals(w.orgId).map((a) => a.status)).toEqual(["expired"]);
  });

  it("records a notify policy when local mode is off, without blocking", async () => {
    const w = workspace("Gate Notify Over Off");
    setClearancePolicy(w.orgId, w.operator, "github.com/acme/app", "notify");
    const r = await runGate("terraform destroy", { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.coderKey, OPENCADRE_GATE_MODE: "off" }, repo(REMOTE));
    expect(r).toEqual({ code: 0, out: "" });
    expect(listApprovals(w.orgId, { status: "noted" }).map((a) => a.action)).toEqual(["terraform destroy"]);
  });

  it("uses the project's own setting over the workspace default", async () => {
    const w = workspace("Gate Project Override");
    setClearancePolicy(w.orgId, w.operator, "", "strict");
    setClearancePolicy(w.orgId, w.operator, "github.com/acme/sandbox", "off");
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.coderKey, OPENCADRE_GATE_MODE: "off", OPENCADRE_APPROVAL_WAIT: "1" };
    expect(decision((await runGate("rm -rf ./data", env, repo("https://github.com/acme/sandbox.git"))).out)).toBe("pass");
    expect(decision((await runGate("rm -rf ./data", env, repo())).out)).toBe("deny");
  });

  it("enforces the last policy it read when the hub goes down (strict → deny)", async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url?.startsWith("/v1/clearance-policy")) return res.writeHead(200).end('{"policy":{"mode":"strict"}}');
      res.writeHead(201).end('{"approval":{"id":"a1","status":"denied","decided_by_agent_name":"Operator"}}');
    });
    const cwd = repo(REMOTE);
    const home = scratch();
    const lenient = path.join(home, "lenient.json");
    writeFileSync(lenient, JSON.stringify({ mode: "notify", onHubUnreachable: "allow" }));
    const env = { OPENCADRE_URL: hub.url, OPENCADRE_KEY: "agt_x", OPENCADRE_GATE_CONFIG: lenient };

    expect(hub.seen).toEqual([]);
    expect(decision((await runGate("rm -rf ./data", env, cwd, home)).out)).toBe("deny");
    expect(hub.seen[0]).toMatch(/^\/v1\/clearance-policy/);
    await new Promise<void>((resolve) => hub.close(() => resolve()));

    const down = await runGate("rm -rf ./data", env, cwd, home);
    expect(decision(down.out)).toBe("deny");
    expect(down.out).toContain("fail closed");
    // A different workspace home has no cached policy, so the lenient local config decides.
    expect(decision((await runGate("rm -rf ./data", env, cwd, scratch())).out)).toBe("pass");
  });

  it("with no policy ever read, a dead hub leaves the local mode in charge", async () => {
    const r = await runGate("rm -rf ./data", { OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_x", OPENCADRE_GATE_MODE: "notify" }, repo(REMOTE));
    expect(r).toEqual({ code: 0, out: "" });
  });

  it("denies when the policy response is malformed", async () => {
    for (const payload of ['{"policy":{"mode":"yolo"}}', "<html>proxy error</html>", "{}"]) {
      const hub = await fakeHub((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(payload));
      try {
        const r = await runGate("git push --force origin main", { OPENCADRE_URL: hub.url, OPENCADRE_KEY: "agt_x", OPENCADRE_GATE_MODE: "notify" }, repo(REMOTE));
        expect(decision(r.out)).toBe("deny");
        expect(r.out).toContain("malformed");
      } finally {
        hub.close();
      }
    }
  });

  it("denies when the hub rejects the agent's key, instead of falling back to the cache", async () => {
    const r = await runGate("rm -rf ./data", { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: "agt_revoked", OPENCADRE_GATE_MODE: "notify" }, repo(REMOTE));
    expect(decision(r.out)).toBe("deny");
    expect(r.out).toContain("rejected this agent's key (HTTP 401)");
  });

  it("asks the hub only about risky commands, and never sends remote credentials", async () => {
    const hub = await fakeHub((req, res) => {
      if (req.url?.startsWith("/v1/clearance-policy")) return res.writeHead(200).end('{"policy":{"mode":"off"}}');
      res.writeHead(201).end("{}");
    });
    try {
      const cwd = repo("https://x-access-token:ghp_secret123@github.com/acme/app.git");
      const env = { OPENCADRE_URL: hub.url, OPENCADRE_KEY: "agt_x", OPENCADRE_GATE_MODE: "off" };
      expect(await runGate("ls -la && git status", env, cwd)).toEqual({ code: 0, out: "" });
      expect(hub.seen).toEqual([]);
      expect(await runGate("rm -rf ./data", env, cwd)).toEqual({ code: 0, out: "" });
      expect(hub.seen).toEqual(["/v1/clearance-policy?project=github.com%2Facme%2Fapp"]);
    } finally {
      hub.close();
    }
  });
});
