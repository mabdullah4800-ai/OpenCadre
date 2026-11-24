// PR-E1: this computer's update policy (scripts/opencadre-update-check.mjs) and what `off` really turns off.
//
// Plan PR-E §4 (5e136886) with Olive's ruling: off < notify < auto, the most restrictive input wins and nothing widens;
// no file means notify; an unreadable file means off; `auto` cannot be chosen in this release. `off` stops the advisory
// manifest check (zero fetches, zero writes) and NOT the separate credentialed build report (PR-E amendment 2). A check
// the user asks for (`update --check`, doctor's reader) still reads the manifest under `off`.
//
// Every home here is a temp folder; the policy reader is always given that home and an explicit env, so neither the real
// ~/.opencadre nor this run's OPENCADRE_UPDATE_POLICY can leak in. CLI children get isolatedCliEnv.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { AUTO_UNAVAILABLE, POLICIES, effectivePolicy, readUpdatePolicy, updatePolicyPath, writeUpdatePolicy } from "../scripts/opencadre-update-check.mjs";
import { connectorUpdateNotice, reportConnectorBuild } from "../scripts/opencadre-update-notice.mjs";
import { fetchCliManifest, runDoctor } from "../cli/lib/doctor.mjs";

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const RANK: Record<string, number> = { off: 0, notify: 1, auto: 2 };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const stamp = "abcdef012345";
const manifestBody = (hub: string) => ({
  inputsDigest: "d".repeat(64), imports: {}, helpers: { "opencadre-awareness.mjs": hash("new") },
  tarball: { stamp, sha256: stamp + "a".repeat(52), bytes: 4096, url: `${hub}/cli/${stamp}/opencadre-cli.tgz` },
  command: `npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`,
});
const home = () => tmpDir("oc-policy-home-");
const writePolicyFile = (h: string, text: string) => {
  mkdirSync(path.join(h, ".opencadre"), { recursive: true });
  writeFileSync(updatePolicyPath(h), text);
};

/** Every path under `dir`, recursively, with its size and mtime: a snapshot two runs can be compared by. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      out.push(`${path.relative(dir, p)}:${st.isDirectory() ? "dir" : st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function runCli(args: string[], h: string, extra: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...isolatedCliEnv(h), ...extra }, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("effectivePolicy: the most restrictive input wins, nothing widens", () => {
  const values = [...POLICIES, null, "bogus"] as const;
  it("every computer x workspace x env combination", () => {
    const rows: string[] = [];
    for (const computer of [...POLICIES, "bogus"]) {
      for (const workspaceCeiling of values) {
        for (const envCeiling of values) {
          const got = effectivePolicy(computer, { workspaceCeiling, envCeiling });
          const inputs = [computer, workspaceCeiling ?? "auto", envCeiling ?? "auto"].map((p) => (p in RANK ? p : "off"));
          const want = inputs.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
          if (got !== want) rows.push(`${computer}/${workspaceCeiling}/${envCeiling}: ${got}, want ${want}`);
          // Nothing widens: the answer is never less restrictive than any input.
          for (const input of inputs) if (RANK[got] > RANK[input]) rows.push(`${computer}/${workspaceCeiling}/${envCeiling} widened ${input} to ${got}`);
        }
      }
    }
    expect(rows).toEqual([]);
  });
  it("names the falsifier: a max() in place of min() would make notify+off read notify", () => {
    expect(effectivePolicy("notify", { envCeiling: "off" })).toBe("off");
    expect(effectivePolicy("off", { envCeiling: "auto", workspaceCeiling: "auto" })).toBe("off");
    expect(effectivePolicy("notify", { workspaceCeiling: "off" })).toBe("off");
  });
});

describe("readUpdatePolicy: absent is notify, unreadable is off, auto is never effective", () => {
  it("no file: notify, the default every existing install keeps", () => {
    expect(readUpdatePolicy({ home: home(), env: {} })).toEqual({ policy: "notify", stored: null, source: "default", reasons: [] });
  });
  it.each(["notify", "off"])("a stored %s is the policy", (policy) => {
    const h = home();
    writeUpdatePolicy({ home: h, policy });
    expect(readUpdatePolicy({ home: h, env: {} })).toMatchObject({ policy, stored: policy, source: "file", reasons: [] });
  });
  it.each([
    ["not JSON", "{ policy: off"],
    ["not an object", "[\"off\"]"],
    ["the wrong schema", JSON.stringify({ schema: 2, policy: "notify" })],
    ["an unknown policy", JSON.stringify({ schema: 1, policy: "sometimes" })],
    ["too large", JSON.stringify({ schema: 1, policy: "notify", pad: "x".repeat(70 * 1024) })],
  ])("a file that is %s reads as off, with the reason", (_, text) => {
    const h = home();
    writePolicyFile(h, text);
    const read = readUpdatePolicy({ home: h, env: {} });
    expect(read.policy).toBe("off");
    expect(read.source).toBe("unreadable");
    expect(read.reasons[0]).toMatch(/update policy file/);
  });
  it("a folder where the file should be reads as off", () => {
    const h = home();
    mkdirSync(updatePolicyPath(h), { recursive: true });
    expect(readUpdatePolicy({ home: h, env: {} })).toMatchObject({ policy: "off", source: "unreadable" });
  });
  it("a stored auto only notifies, and says why (no consent mechanism exists in this release)", () => {
    const h = home();
    writePolicyFile(h, JSON.stringify({ schema: 1, policy: "auto", setAt: "2026-10-01T00:00:00.000Z" }));
    const read = readUpdatePolicy({ home: h, env: {} });
    expect(read.policy).toBe("notify");
    expect(read.stored).toBe("auto");
    expect(read.reasons.join(" ")).toMatch(/not available/);
  });
  it("OPENCADRE_UPDATE_POLICY narrows and never widens; an unrecognised value is off and is not echoed", () => {
    const h = home();
    expect(readUpdatePolicy({ home: h, env: { OPENCADRE_UPDATE_POLICY: "off" } })).toMatchObject({ policy: "off", reasons: ["OPENCADRE_UPDATE_POLICY limits this computer to off"] });
    writeUpdatePolicy({ home: h, policy: "off" });
    expect(readUpdatePolicy({ home: h, env: { OPENCADRE_UPDATE_POLICY: "auto" } }).policy).toBe("off");
    expect(readUpdatePolicy({ home: h, env: { OPENCADRE_UPDATE_POLICY: "notify" } }).policy).toBe("off");
    const junk = readUpdatePolicy({ home: home(), env: { OPENCADRE_UPDATE_POLICY: "yes-please" } });
    expect(junk.policy).toBe("off");
    expect(junk.reasons.join(" ")).not.toContain("yes-please");
    // An env auto on a default home is still only notify.
    expect(readUpdatePolicy({ home: home(), env: { OPENCADRE_UPDATE_POLICY: "auto" } }).policy).toBe("notify");
  });
});

describe("writeUpdatePolicy: notify and off only", () => {
  it("auto is refused with the not-available message and nothing is written", () => {
    const h = home();
    expect(() => writeUpdatePolicy({ home: h, policy: "auto" })).toThrow(AUTO_UNAVAILABLE);
    expect(existsSync(updatePolicyPath(h))).toBe(false);
    expect(() => writeUpdatePolicy({ home: h, policy: "always" })).toThrow(/Unknown update policy/);
    expect(existsSync(updatePolicyPath(h))).toBe(false);
  });
  it("writes schema 1 beside credentials.json, never into it", () => {
    const h = home();
    mkdirSync(path.join(h, ".opencadre"), { recursive: true });
    const creds = path.join(h, ".opencadre", "credentials.json");
    writeFileSync(creds, "{\"computer\":{}}");
    const before = readFileSync(creds, "utf8");
    const record = writeUpdatePolicy({ home: h, policy: "off", now: new Date("2026-10-01T12:00:00Z") });
    expect(record).toEqual({ schema: 1, policy: "off", setAt: "2026-10-01T12:00:00.000Z" });
    expect(JSON.parse(readFileSync(updatePolicyPath(h), "utf8"))).toEqual(record);
    expect(readFileSync(creds, "utf8")).toBe(before);
    // No temp file left behind.
    expect(readdirSync(path.join(h, ".opencadre")).sort()).toEqual(["credentials.json", "update-policy.json"]);
  });
});

/** A generation install whose one helper differs from the hub's, so a notify-policy check WOULD announce. */
function noticeFixture() {
  const root = tmpDir("oc-policy-notice-");
  const dir = path.join(root, ".gen", "123456789abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".generation.json"), JSON.stringify({ id: "123456789abc", helpers: { "opencadre-awareness.mjs": hash("old") } }));
  writeFileSync(path.join(dir, "opencadre-awareness.mjs"), "old");
  return { root, home: root, env: {}, entryUrl: pathToFileURL(path.join(dir, "opencadre-awareness.mjs")), stateDir: path.join(root, "state"), base: "https://hub.example.test", now: 10_000_000 };
}

describe("off: the advisory check makes no fetch and no write; the build report is not governed by it", () => {
  it("off: zero fetches and zero writes, at every checkpoint, under every ceiling", async () => {
    const f = noticeFixture();
    writeUpdatePolicy({ home: f.home, policy: "off" });
    const before = snapshot(f.root);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifestBody(f.base))));
    for (let i = 0; i < 3; i++) expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + i * 7 * 3600_000 })).toBe("");
    expect(await connectorUpdateNotice({ ...f, fetcher, env: { OPENCADRE_UPDATE_POLICY: "auto" } })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(f.stateDir)).toBe(false);
    expect(snapshot(f.root)).toEqual(before);
  });
  it("an unreadable policy file is off too", async () => {
    const f = noticeFixture();
    writePolicyFile(f.home, "garbage");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifestBody(f.base))));
    expect(await connectorUpdateNotice({ ...f, fetcher })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("the known positive: the same fixture under notify (file or default) fetches once and announces", async () => {
    for (const set of [null, "notify"] as const) {
      const f = noticeFixture();
      if (set) writeUpdatePolicy({ home: f.home, policy: set });
      const fetcher = vi.fn(async () => new Response(JSON.stringify(manifestBody(f.base))));
      expect(await connectorUpdateNotice({ ...f, fetcher })).toContain("connector update available (optional)");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("an env ceiling of off silences a notify computer", async () => {
    const f = noticeFixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifestBody(f.base))));
    expect(await connectorUpdateNotice({ ...f, fetcher, env: { OPENCADRE_UPDATE_POLICY: "off" } })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("under off the credentialed build report behaves exactly as under notify (separate telemetry, amendment 2)", async () => {
    // The credential is made up per run and never leaves this process: the fetcher is a spy.
    const credential = ["dev", createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 48)].join("_");
    const calls: Record<string, { url: string; body: unknown }[]> = {};
    for (const policy of ["notify", "off"] as const) {
      const f = noticeFixture();
      writeUpdatePolicy({ home: f.home, policy });
      const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
      await reportConnectorBuild({ base: f.base, credential, client: "codex", stateDir: f.stateDir, entryUrl: f.entryUrl, now: f.now, fetcher });
      await reportConnectorBuild({ base: f.base, credential, client: "codex", stateDir: f.stateDir, entryUrl: f.entryUrl, now: f.now + 60_000, fetcher });
      calls[policy] = fetcher.mock.calls.map((c) => ({ url: String((c as unknown[])[0]), body: JSON.parse(String(((c as unknown[])[1] as { body: string }).body)) }));
    }
    expect(calls.off).toHaveLength(1);
    expect(calls.off[0].url).toBe("https://hub.example.test/v1/devices/connector-build");
    // Same body under both policies, apart from the installation id (an HMAC of each fixture's own root).
    const strip = (b: unknown) => ({ ...(b as Record<string, unknown>), installationId: "x" });
    expect(strip(calls.off[0].body)).toEqual(strip(calls.notify[0].body));
    expect(calls.notify).toHaveLength(1);
  });
});

describe("a check the user asks for still reads the manifest under off", () => {
  let server: http.Server;
  let hub: string;
  let reads = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/cli/manifest.json") {
        reads++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(manifestBody(hub)));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

  it("update --check under off: one read, the policy reported, nothing installed", async () => {
    const h = home();
    writeUpdatePolicy({ home: h, policy: "off" });
    const before = reads;
    const r = await runCli(["update", "--check", "--hub", hub, "--home", h], h);
    expect(r.code, r.err).toBe(0);
    expect(reads - before).toBe(1);
    expect(r.out).toContain(`CLI package ${stamp}`);
    expect(r.out).toContain("Update policy: off.");
    expect(r.out).toContain("No OpenCadre helpers are installed");
    expect(existsSync(path.join(h, ".opencadre", "bin"))).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);
  it("doctor's reader (fetchCliManifest, shared with connect --upgrade) has no policy gate", async () => {
    const before = reads;
    const read = await fetchCliManifest(hub);
    expect(read).toMatchObject({ ok: true, stamp, command: `npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade` });
    expect(reads - before).toBe(1);
  });
  it("doctor reports the policy on its summary line, and the fix for an unreadable file", async () => {
    const h = home();
    writeUpdatePolicy({ home: h, policy: "off" });
    let text = (await runDoctor({ client: "claude-code", home: h })).lines.join("\n");
    expect(text).toMatch(/update_policy=off/);
    expect(text).toMatch(/Update policy: off\. No background update check runs/);
    writePolicyFile(h, "garbage");
    text = (await runDoctor({ client: "claude-code", home: h })).lines.join("\n");
    expect(text).toMatch(/update_policy=off/);
    expect(text).toMatch(/Update policy unreadable .*update --policy notify/);
    // The default adds only the summary key, no line.
    text = (await runDoctor({ client: "claude-code", home: home() })).lines.join("\n");
    expect(text).toMatch(/update_policy=notify/);
    expect(text).not.toMatch(/Update policy/);
  });
});

describe("opencadre update: the command", () => {
  it("--policy auto is refused (exit 2) with the not-available message, and writes nothing", async () => {
    const h = home();
    const r = await runCli(["update", "--policy", "auto", "--home", h], h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Automatic updates are not available yet");
    expect(existsSync(path.join(h, ".opencadre"))).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);
  it("--policy off, then --status, then --policy notify", async () => {
    const h = home();
    let r = await runCli(["update", "--policy", "off", "--home", h], h);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Update policy set to off");
    expect(r.out).toContain("connector build report");
    expect(JSON.parse(readFileSync(updatePolicyPath(h), "utf8"))).toMatchObject({ schema: 1, policy: "off" });
    r = await runCli(["update", "--status", "--home", h], h);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Update policy: off.");
    r = await runCli(["update", "--policy", "notify", "--home", h], h);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(updatePolicyPath(h), "utf8")).policy).toBe("notify");
    // The environment ceiling is honoured by --status (isolatedCliEnv drops this run's own OPENCADRE_*).
    r = await runCli(["update", "--home", h], h, { OPENCADRE_UPDATE_POLICY: "off" });
    expect(r.out).toContain("Update policy: off.");
    expect(r.out).toContain("OPENCADRE_UPDATE_POLICY limits this computer to off");
  }, SPAWN_TEST_TIMEOUT_MS);
  it("its flags are refused elsewhere, and two modes at once are refused", async () => {
    const h = home();
    for (const args of [["connect", "--policy", "off"], ["doctor", "--check"], ["update", "--status", "--check"], ["update", "--policy", "off", "--upgrade"]]) {
      const r = await runCli([...args, "--home", h], h);
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(existsSync(path.join(h, ".opencadre"))).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);
});
