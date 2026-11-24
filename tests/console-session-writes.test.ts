// The console's real api() function against the real hub, not a fetch mock. Signed-in routes only accept JSON (the
// CSRF guard in src/rest.ts), and a bodiless POST such as "Accept invite" used to go out with no content type and
// fail on production with "Send JSON". Mocked fetches couldn't catch that, so these requests reach the Express app.
import type { AddressInfo } from "node:net";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.OPENCADRE_SIGNUP = "open";
const { app } = await import("../src/rest.js");
const { upsertPerson, createSession, createWorkspace, createInvite, getMembership } = await import("../src/accounts.js");

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Api = (path: string, opts?: { method?: string; body?: unknown; session?: boolean }) => Promise<Record<string, unknown>>;

/** app.js's own api() source, run with a fetch that sends each request to the real hub as a browser with this cookie would. */
function consoleApi(cookie: string): Api {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const start = appJs.indexOf("async function api(");
  const close = start < 0 ? null : /\r?\n\}\r?\n/.exec(appJs.slice(start));
  if (!close) throw new Error("api() not found in app.js");
  const source = appJs.slice(start, start + close.index + close[0].length);
  const browserFetch = (path: string, opts: RequestInit & { headers?: Record<string, string> }) =>
    fetch(`${base}${path}`, { ...opts, headers: { ...opts.headers, cookie } });
  return new Function(
    "fetch",
    `let agentKey = null, authMode = "session", currentWorkspace = null, consoleGeneration = 0;
     class PausedError extends Error {}
     class AuthError extends Error {}
     ${source}
     return api;`,
  )(browserFetch) as Api;
}

let seq = 0;
function person(label: string) {
  const p = upsertPerson({ id: `writes-${label}-${++seq}`, email: `${label}${seq}@example.com`, emailVerified: true, name: label, avatarUrl: null });
  return { person: p, cookie: `oc_session=${createSession(p.id).token}` };
}

describe("console writes reach signed-in routes as JSON", () => {
  it("accepts an invite with a bodiless POST", async () => {
    const owner = person("owner");
    const { orgId } = createWorkspace(owner.person, "Writes Org");
    const { token } = createInvite(orgId, { id: getMembership(orgId, owner.person.id)!.agent_id, name: "owner" }, "owner", null);

    const invitee = person("invitee");
    const accepted = await consoleApi(invitee.cookie)(`/v1/invites/${encodeURIComponent(token)}/accept`, { method: "POST", session: true });
    expect(accepted.workspace).toMatchObject({ orgId, role: "owner" });
    expect(getMembership(orgId, invitee.person.id)?.role).toBe("owner");
  });

  it("still sends plain GETs without a body", async () => {
    const { cookie } = person("reader");
    const me = await consoleApi(cookie)("/v1/auth/me", { session: true });
    expect(me.person).toBeTruthy();
  });
});
