// GET /v1/me carries the session's membership role, read fresh on every request (console dashboard phase 1, Codex ruling
// 2026-10-01 item 2). Owner and admin share the agent role "operator", so `role` alone cannot show a change between
// them; the console compares `memberRole` on every refresh and clears what the old role could see.
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.OPENCADRE_SIGNUP = "open";

let base: string;
let server: http.Server;
let accounts: typeof import("../src/accounts.js");
let service: typeof import("../src/service.js");

beforeAll(async () => {
  const { app } = await import("../src/rest.js");
  accounts = await import("../src/accounts.js");
  service = await import("../src/service.js");
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const person = (id: string, name: string) =>
  accounts.upsertPerson({ id, email: `${id}@example.com`, emailVerified: true, name, avatarUrl: null });

async function meAs(cookie: string, orgId: string) {
  const res = await fetch(`${base}/v1/me`, { headers: { cookie: `oc_session=${cookie}`, "X-OpenCadre-Workspace": orgId } });
  expect(res.status).toBe(200);
  return (await res.json()) as { role: string; memberRole: string | null };
}

describe("GET /v1/me memberRole", () => {
  it("names the membership role, and follows owner <-> admin and admin <-> member changes on the next read", async () => {
    const owner = person("me-role-owner", "Olive Owner");
    const { orgId } = accounts.createWorkspace(owner, "Member Role Co");
    const ownerCookie = accounts.createSession(owner.id).token;
    expect(await meAs(ownerCookie, orgId)).toMatchObject({ role: "operator", memberRole: "owner" });

    const second = person("me-role-second", "Sam Second");
    const invite = accounts.createInvite(orgId, { id: "hub", name: "hub" }, "admin", "me-role-second@example.com");
    accounts.acceptInvite(invite.token, second);
    const secondCookie = accounts.createSession(second.id).token;
    expect(await meAs(secondCookie, orgId)).toMatchObject({ role: "operator", memberRole: "admin" });

    // admin -> owner: the agent role does not move, memberRole does.
    accounts.changeRole(orgId, { id: "hub", name: "hub", memberRole: null }, second.id, "owner");
    expect(await meAs(secondCookie, orgId)).toMatchObject({ role: "operator", memberRole: "owner" });
    // owner -> admin: the same agent role again, and memberRole says which.
    accounts.changeRole(orgId, { id: "hub", name: "hub", memberRole: null }, second.id, "admin");
    expect(await meAs(secondCookie, orgId)).toMatchObject({ role: "operator", memberRole: "admin" });
    // admin -> member: both move.
    accounts.changeRole(orgId, { id: "hub", name: "hub", memberRole: null }, second.id, "member");
    expect(await meAs(secondCookie, orgId)).toMatchObject({ role: "agent", memberRole: "member" });
  });

  it("is null for an agent-key sign-in, which has no membership", async () => {
    const { orgId } = service.createOrganization("Key Only Co");
    const agent = service.registerAgent(orgId, "Key-Bot");
    const res = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${agent.apiKey}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "agent", memberRole: null });
  });
});
