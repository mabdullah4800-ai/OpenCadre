// The OpenCadre plugin for OpenCode: new mail wakes an idle chat through OpenCode's documented session.synthetic.
//
// MEASURED LIVE 2026-09-23 on OpenCode 2.0.10 (fleet PC): a finished chat went `idle` at 22:46:21; the plugin
// admitted a `synthetic` "You have 1 unread OpenCadre message(s)…" at 22:46:36, and the chat replied with the marker.
// These tests pin the behaviour that run depended on, against a stand-in hub and a fake OpenCode context built the way
// OpenCode really runs the plugin: ONE process, SEVERAL setups (one per project location).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_SESSION_TRIES, nextStep, sessionIdOf, wakeText } from "../scripts/opencode-plugin/mail.js";
import { tmpDir } from "./helpers/tmp.js";

describe("mail.js: one step of the wait loop", () => {
  it("unread mail wakes the chat once, and the loop waits after the newest id", () => {
    expect(nextStep({ status: 200, body: { messages: [{ id: "m1" }, { id: "m2" }] } })).toEqual({ action: "wake", count: 2, afterId: "m2" });
  });
  it("nothing new: wait again", () => expect(nextStep({ status: 200, body: { messages: [] } })).toEqual({ action: "wait" }));
  it("no session for this chat yet (401), or the hub unreachable (0): back off quietly", () => {
    expect(nextStep({ status: 401, body: {} })).toEqual({ action: "backoff" });
    expect(nextStep({ status: 0, body: null })).toEqual({ action: "backoff" });
  });
  it("a chat that never gets a session: NO_SESSION_TRIES no-session answers in a row end the watch", () => {
    expect(NO_SESSION_TRIES).toBe(3);
    expect(nextStep({ status: 401, body: {}, misses: 1 })).toEqual({ action: "backoff" });
    expect(nextStep({ status: 401, body: {}, misses: 2 })).toEqual({ action: "ended" });
    // An unreachable hub is not evidence the chat has no session: it never ends the watch.
    expect(nextStep({ status: 0, body: null, misses: 2 })).toEqual({ action: "backoff" });
  });
  it("401 after the hub has answered for the chat (known): its session ended, so the watch ends", () => {
    expect(nextStep({ status: 401, body: {}, known: true })).toEqual({ action: "ended" });
    expect(nextStep({ status: 0, body: null, known: true })).toEqual({ action: "backoff" });
  });
  it("project not enabled (403) or a lapsed bill (402): stay out of the way", () => {
    expect(nextStep({ status: 403, body: {} })).toEqual({ action: "stop" });
    expect(nextStep({ status: 402, body: { code: "TRIAL_EXPIRED" } })).toEqual({ action: "stop" });
  });
  it("reads the documented and the measured event shapes, and nothing that is not a session id", () => {
    expect(sessionIdOf({ properties: { sessionID: "ses_A" } })).toBe("ses_A");
    expect(sessionIdOf({ data: { sessionID: "ses_B" } })).toBe("ses_B");
    expect(sessionIdOf({ data: { sessionID: "msg_X" } })).toBeNull();
    expect(sessionIdOf({})).toBeNull();
  });
  it("the notice is the same words the Claude Code and Codex watchers use", () => {
    expect(wakeText(1)).toBe('You have 1 unread OpenCadre message(s). Use "get_messages" to read them and answer each on its thread.');
  });
});

// --- the plugin itself, loaded the way OpenCode loads it ---------------------------------------------------------

/** A stand-in hub answering /v1/messages/wait with PEEK semantics: `mailFor[session]` stays unread and is served to every
 * request not already past it (`afterId`), as the real hub does; `statusFor` overrides the status for a session. */
async function standInHub({ mailFor = {} as Record<string, Array<{ id: string }>>, statusFor = {} as Record<string, number> } = {}) {
  const seen: Array<{ session: string; project: string | undefined; resolveOnly: string | undefined; probe: string | undefined; query: string }> = [];
  const server = http.createServer((req, res) => {
    const session = String(req.headers["x-opencadre-session"]);
    const url = new URL(req.url!, "http://x");
    seen.push({ session, project: req.headers["x-opencadre-project"] as string | undefined, resolveOnly: req.headers["x-opencadre-resolve-only"] as string | undefined, probe: req.headers["x-opencadre-probe"] as string | undefined, query: url.search });
    const status = statusFor[session] ?? 200;
    // PEEK semantics, like the real hub: unread mail stays unread, so every request that is not already past a message
    // (afterId) gets it again. A stand-in that handed mail out once would hide a second watcher waking the chat twice.
    const afterId = url.searchParams.get("afterId");
    const all = mailFor[session] ?? [];
    const from = afterId ? all.findIndex((m) => m.id === afterId) + 1 : 0;
    const messages = status === 200 ? all.slice(from) : [];
    // A real long-poll holds; here an empty answer is delayed a little so the loop does not spin.
    setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { messages } : { error: "x" })), messages.length ? 0 : 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** A home with this computer's credential and the real helpers the plugin imports (opencadre-config.mjs & co). */
async function homeWith(hub: string) {
  const home = tmpDir("oc-plugin-home-");
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential: `dev_${"c".repeat(48)}`, deviceId: "dev-test" } }));
  const { installHelpers } = await import("../cli/lib/generations.mjs");
  installHelpers(path.join(home, ".opencadre", "bin"));
  return home;
}

/** A fake OpenCode context for one project location: an event stream we push into, session.get, session.synthetic. */
function fakeContext(location: { directory: string; projectId: string }, sessions: Record<string, string>) {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const ctx = {
    location: { directory: location.directory, project: { id: location.projectId } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: sessions[sessionID] }),
      synthetic: async (input: { sessionID: string; text: string }) => { synthetic.push(input); return {}; },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise<void>((r) => { wake = r; signal.addEventListener("abort", () => r(), { once: true }); });
        }
      },
    },
  };
  return { ctx, synthetic, push: (e: unknown) => { queue.push(e); wake?.(); } };
}

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

describe("the plugin: waits on the hub and wakes the chat, once, from the right project's instance", () => {
  let hub: Awaited<ReturnType<typeof standInHub>>;
  const cleanups: Array<() => void> = [];
  const PROJECT = "proj-opencadre";
  beforeEach(() => { delete (globalThis as any).__opencadreOpencode; });
  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
    delete process.env.OPENCADRE_HOOK_HOME;
    delete process.env.OPENCADRE_OPENCODE_BACKOFF_MS;
    await hub?.close();
  });

  async function loadPlugin(home: string) {
    process.env.OPENCADRE_HOOK_HOME = home;
    // A fresh module instance per test: the real plugin reads OPENCADRE_HOOK_HOME at import time.
    const url = `${pathToFileURL(path.join(process.cwd(), "scripts", "opencode-plugin", "index.js")).href}?t=${Date.now()}${Math.random()}`;
    return (await import(url)).default as { id: string; setup: (ctx: unknown) => Promise<(() => void) | undefined> };
  }

  it("two instances in one process (same project, two folders): mail wakes the chat exactly once, resolve-only", async () => {
    hub = await standInHub({ mailFor: { ses_A: [{ id: "m1" }] } });
    const plugin = await loadPlugin(await homeWith(hub.url));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    const b = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    for (const f of [a, b]) cleanups.push((await plugin.setup(f.ctx))!);
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    b.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => a.synthetic.length + b.synthetic.length >= 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const all = [...a.synthetic, ...b.synthetic];
    expect(all).toEqual([{ sessionID: "ses_A", text: wakeText(1) }]);
    expect(hub.seen.every((s) => s.resolveOnly === "1")).toBe(true);
    // After the wake it waits past the announced message, so the same mail is not announced twice.
    expect(await until(() => hub.seen.some((s) => s.query.includes("afterId=m1")))).toBe(true);
  });

  it("every wait says it is not the chat's own activity (no-heartbeat), so waiting never keeps an agent online", async () => {
    hub = await standInHub();
    const plugin = await loadPlugin(await homeWith(hub.url));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    cleanups.push((await plugin.setup(a.ctx))!);
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length >= 2)).toBe(true);
    expect(hub.seen.every((s) => s.probe === "no-heartbeat")).toBe(true);
  });

  // #585 (Codex-OpenCadre-8160): a watch must not outlive its chat. When the hub has answered for a chat and then says
  // 401, the chat's session was ended (idle past its TTL): the watch ends and releases its process-wide claim, and the
  // chat's next event claims it again.
  it("a chat whose hub session ends (200 then 401): the watch releases its claim, and a later event re-claims it", async () => {
    const statusFor: Record<string, number> = {};
    hub = await standInHub({ statusFor });
    const plugin = await loadPlugin(await homeWith(hub.url));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    cleanups.push((await plugin.setup(a.ctx))!);
    const watching = () => (globalThis as any).__opencadreOpencode?.watching as Set<string> | undefined;
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length >= 1 && !!watching()?.has("ses_A"))).toBe(true);
    statusFor.ses_A = 401;
    expect(await until(() => !watching()?.has("ses_A"))).toBe(true);
    const asked = hub.seen.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.seen.length).toBe(asked); // ended, not backing off: no further polls
    delete statusFor.ses_A;
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length > asked && !!watching()?.has("ses_A"))).toBe(true);
  });

  // #585 re-review (Codex-OpenCadre-8160): most chats never use OpenCadre, so a 401-forever chat must not hold a claim
  // and a poll for the service's lifetime. One no-session answer keeps waiting (the chat may be about to call its first
  // tool); NO_SESSION_TRIES in a row release the claim; the chat's next event claims it again.
  it("a chat with no session: one 401 keeps the claim, three in a row release it, and new activity re-claims", async () => {
    process.env.OPENCADRE_OPENCODE_BACKOFF_MS = "150,150,150";
    hub = await standInHub({ statusFor: { ses_A: 401 } });
    const plugin = await loadPlugin(await homeWith(hub.url));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    cleanups.push((await plugin.setup(a.ctx))!);
    const watching = () => (globalThis as any).__opencadreOpencode?.watching as Set<string> | undefined;
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length === 1)).toBe(true);
    expect(watching()!.has("ses_A")).toBe(true);
    expect(await until(() => !watching()!.has("ses_A"))).toBe(true);
    expect(hub.seen.length).toBe(NO_SESSION_TRIES);
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.seen.length).toBe(NO_SESSION_TRIES); // released, not polling on
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length > NO_SESSION_TRIES)).toBe(true);
  });

  it("an instance for a different project never handles the chat", async () => {
    hub = await standInHub({ mailFor: { ses_A: [{ id: "m1" }] } });
    const plugin = await loadPlugin(await homeWith(hub.url));
    const other = fakeContext({ directory: process.cwd(), projectId: "proj-other" }, { ses_A: PROJECT });
    cleanups.push((await plugin.setup(other.ctx))!);
    other.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(other.synthetic).toEqual([]);
    expect(hub.seen).toEqual([]);
  });

  it("a project that is not enabled (403): no wake, and the loop stops asking", async () => {
    hub = await standInHub({ statusFor: { ses_A: 403 } });
    const plugin = await loadPlugin(await homeWith(hub.url));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    cleanups.push((await plugin.setup(a.ctx))!);
    a.push({ type: "session.idle", properties: { sessionID: "ses_A" } });
    expect(await until(() => hub.seen.length >= 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.seen.length).toBe(1);
    expect(a.synthetic).toEqual([]);
  });

  it("a clearance module that fails to register is reported on stderr, and mail still sets up", async () => {
    hub = await standInHub();
    const home = await homeWith(hub.url);
    process.env.OPENCADRE_HOOK_HOME = home;
    // The installed layout: a copy of the installed generation (the plugin folder, with the config it imports one level
    // up, cli/lib/generations.mjs), whose clearance.js beside the entry throws.
    const { generationPath, readPointer } = await import("../cli/lib/generations.mjs");
    const bin = path.join(home, ".opencadre", "bin");
    const root = tmpDir("oc-plugin-with-clearance-");
    cpSync(generationPath(bin, readPointer(bin).id), root, { recursive: true });
    const dir = path.join(root, "opencode-plugin");
    writeFileSync(path.join(dir, "clearance.js"), `export async function registerClearance() { throw new Error("evaluate hook refused") }\n`);
    const plugin = (await import(`${pathToFileURL(path.join(dir, "index.js")).href}?t=${Date.now()}`)).default;
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
      const cleanup = await plugin.setup(a.ctx);
      expect(typeof cleanup).toBe("function");
      cleanups.push(cleanup);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toMatch(/clearance did not register, so risky commands are NOT held .*evaluate hook refused/);
  });

  it("no OpenCadre credential on this computer: the plugin does nothing at all", async () => {
    hub = await standInHub();
    const plugin = await loadPlugin(tmpDir("oc-plugin-empty-home-"));
    const a = fakeContext({ directory: process.cwd(), projectId: PROJECT }, { ses_A: PROJECT });
    const cleanup = await plugin.setup(a.ctx);
    expect(cleanup).toBeUndefined();
    expect(hub.seen).toEqual([]);
  });
});
