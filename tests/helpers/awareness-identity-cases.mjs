// Shared dependency-free cases: run directly with node --test, or through the Vitest wrapper.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../../examples/hooks/opencadre-awareness.mjs", import.meta.url));
const fixtureKey = "fixture-only-not-a-credential";
const capacity = "this device has too many live sessions; idle ones end on their own, or an operator can remove the device";
const context = (result) => result.out ? JSON.parse(result.out).hookSpecificOutput.additionalContext : "";

async function fixture(run) {
  const parent = resolve(process.env.OPENCADRE_TEST_TEMP_ROOT || tmpdir());
  const root = mkdtempSync(join(parent, "aw-identity-"));
  const state = join(root, "state"), home = join(root, "home");
  mkdirSync(state); mkdirSync(home);
  const seen = [];
  let answer = { status: 200, body: { agentName: "Verified-Session", orgName: "Fixture" }, headers: {} };
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const result = req.url === "/v1/me" ? answer : { status: 200, body: {}, headers: {} };
    res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const retryState = () => {
    const name = readdirSync(state).find((n) => n.startsWith("opencadre-identity-retry-"));
    assert.ok(name, "a refused identity must retain a retry marker, not a trusted identity");
    return join(state, name);
  };
  const invoke = (event, { session = "same-chat", key = fixtureKey } = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hook, "--client", "claude-code"], {
      cwd: root, windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
        OPENCADRE_HOOK_HOME: home, OPENCADRE_URL: base, OPENCADRE_KEY: key,
        OPENCADRE_AWARENESS_STATE_DIR: state },
    });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
    child.stdout.on("data", (c) => out += c);
    child.stderr.on("data", (c) => err += c);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("fixture hook timed out"));
      else if (code !== 0) reject(new Error("fixture hook exited " + code + ": " + err));
      else resolveRun({ code, out });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: session, cwd: root }));
  });
  try {
    await run({ invoke, seen, state, root, retryState,
      set: (value) => { answer = value; },
      expire: () => { const p = retryState(); const data = JSON.parse(readFileSync(p)); writeFileSync(p, JSON.stringify({ ...data, retryAt: Date.now() - 1 })); },
    });
  } finally {
    await new Promise((r) => server.close(r));
    // Delete only this freshly allocated direct child of the explicit test temp root.
    if (dirname(resolve(root)) !== parent) throw new Error("fixture cleanup escaped its temp parent");
    rmSync(root, { recursive: true, force: true });
  }
}

export const identityCases = [
  ["device capacity is not bad credentials and causes no secondary HTTP calls", () => fixture(async (f) => {
    f.set({ status: 429, body: { error: capacity }, headers: {} });
    const text = context(await f.invoke("SessionStart"));
    assert.match(text, /device.*session.*capacity/i);
    assert.match(text, /do not send fleet messages/i);
    assert.doesNotMatch(text, /fixes the key/);
    assert.ok(!text.includes(fixtureKey));
    assert.deepEqual(f.seen, ["/v1/me"]);
  })],
  ["capacity is not automatically retried by prompts or tool hooks and does not silence another chat", () => fixture(async (f) => {
    f.set({ status: 429, body: { error: capacity }, headers: {} });
    await f.invoke("SessionStart");
    const before = f.seen.length;
    await f.invoke("UserPromptSubmit"); await f.invoke("PostToolUse");
    assert.equal(f.seen.length, before, "capacity needs supported recovery, not repeated new-seat requests");
    f.set({ status: 200, body: { agentName: "Other-Session", orgName: "Fixture" }, headers: {} });
    assert.match(context(await f.invoke("SessionStart", { session: "other-chat" })), /^You are Other-Session /);
    // An explicit resume can verify the original chat after separately supported capacity recovery.
    assert.match(context(await f.invoke("SessionStart")), /^You are Other-Session /);
  })],
  ["Retry-After seconds suppresses retries then re-verifies this same chat on the next prompt", () => fixture(async (f) => {
    f.set({ status: 429, body: { error: "rate limit exceeded" }, headers: { "retry-after": "120" } });
    const text = context(await f.invoke("SessionStart"));
    assert.match(text, /throttl/i); assert.doesNotMatch(text, /fixes the key|device.*capacity/i);
    const retry = JSON.parse(readFileSync(f.retryState()));
    assert.ok(retry.retryAt > Date.now() + 110000);
    const before = f.seen.length;
    await f.invoke("UserPromptSubmit"); await f.invoke("PostToolUse"); await f.invoke("Stop");
    assert.equal(f.seen.length, before);
    f.expire(); f.set({ status: 200, body: { agentName: "Recovered-Session", orgName: "Fixture" }, headers: {} });
    assert.match(context(await f.invoke("UserPromptSubmit")), /^You are Recovered-Session /);
    assert.equal(f.seen.filter((p) => p === "/v1/me").length, 2);
  })],
  ["Retry-After HTTP date is honored", () => fixture(async (f) => {
    const until = Math.floor(Date.now() / 1000) * 1000 + 120000;
    f.set({ status: 429, body: {}, headers: { "retry-after": new Date(until).toUTCString() } });
    await f.invoke("SessionStart");
    assert.equal(JSON.parse(readFileSync(f.retryState())).retryAt, until);
  })],
  ["malformed retry headers use a bounded fallback without leaking the response body", () => fixture(async (f) => {
    f.set({ status: 429, body: { error: "private diagnostic must not echo", retryAfterSeconds: -3 }, headers: { "retry-after": "garbage" } });
    const text = context(await f.invoke("SessionStart"));
    assert.ok(!text.includes("private diagnostic"));
    const retry = JSON.parse(readFileSync(f.retryState()));
    assert.ok(retry.retryAt >= Date.now() + 50000 && retry.retryAt <= Date.now() + 60000);
  })],
  ["a changed credential cannot inherit another credential's retry marker", () => fixture(async (f) => {
    f.set({ status: 429, body: {}, headers: { "retry-after": "120" } }); await f.invoke("SessionStart");
    f.set({ status: 200, body: { agentName: "Fresh-Credential", orgName: "Fixture" }, headers: {} });
    assert.match(context(await f.invoke("SessionStart", { key: "different-fixture-only-credential" })), /^You are Fresh-Credential /);
  })],
  ["recovery still rejects invalid credentials instead of replaying a successful identity", () => fixture(async (f) => {
    f.set({ status: 429, body: {}, headers: { "retry-after": "1" } }); await f.invoke("SessionStart"); f.expire();
    f.set({ status: 401, body: { error: "invalid credential" }, headers: {} });
    const text = context(await f.invoke("UserPromptSubmit"));
    assert.match(text, /HTTP 401/); assert.match(text, /do not send fleet messages/); assert.ok(!text.includes("You are"));
  })],
  ["ordinary401 startup warning retains the supported legacy contract", () => fixture(async (f) => {
    f.set({ status: 401, body: {}, headers: {} });
    assert.equal(context(await f.invoke("SessionStart")), "OpenCadre: could not verify this session's identity (HTTP 401); do not send fleet messages until the operator fixes the key.");
  })],
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { test } = await import("node:test");
  for (const [name, run] of identityCases) test(name, { timeout: 30000 }, run);
}
