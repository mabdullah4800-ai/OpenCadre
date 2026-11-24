import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authenticateLiveRequest } from "../src/live-auth.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { createInvite, acceptInvite, createSession, createWorkspace, upsertPerson } from "../src/accounts.js";
import { pauseWorkspace } from "../src/kill-switch.js";
import { createDevice, redeemDeviceCode } from "../src/devices.js";
import { setProjectEnabled } from "../src/projects.js";

const handshake = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers: { host: "app.opencadre.example", ...headers } }) as unknown as IncomingMessage;

function personWithWorkspace(id: string) {
  process.env.OPENCADRE_SIGNUP = "open";
  const person = upsertPerson({ id, email: `${id}@example.com`, emailVerified: true, name: id, avatarUrl: null });
  const { orgId } = createWorkspace(person, `${id} Co`);
  delete process.env.OPENCADRE_SIGNUP;
  return { person, orgId, cookie: `oc_session=${createSession(person.id).token}` };
}

describe("live socket authentication", () => {
  it("refuses malformed percent-encoded cookies without throwing", () => {
    for (const cookie of ["oc_session=%", "oc_session=%E0%A4", "oc_session=%GG"]) {
      expect(authenticateLiveRequest(handshake("/live?workspace=missing", {
        cookie, origin: "https://app.opencadre.example",
      }))).toMatchObject({ ok: false, code: 4001 });
    }
  });
  it("agents still authenticate with ?apiKey=", () => {
    const { orgId } = createOrganization("Live Keys");
    const agent = registerAgent(orgId, "Codex");
    expect(authenticateLiveRequest(handshake(`/live?apiKey=${agent.apiKey}`))).toEqual({ ok: true, orgId, agentId: agent.agentId });
    expect(authenticateLiveRequest(handshake("/live?apiKey=agt_nope"))).toMatchObject({ ok: false, code: 4001 });
  });

  it("a device session authenticates with the Authorization and session headers, never with a credential in the URL", () => {
    const { orgId } = createOrganization("Live Devices");
    const operator = { id: "op", name: "Operator" };
    const { code } = createDevice(orgId, operator, "PC", "claude-code");
    const redeemed = redeemDeviceCode(code);
    if (!redeemed.ok) throw new Error("setup failed");
    const auth = { authorization: `Bearer ${redeemed.deviceCredential}`, "x-opencadre-project": "local:LiveRepo", "x-opencadre-project-name": "LiveRepo" };

    // A project the workspace hasn't enabled: refused.
    expect(authenticateLiveRequest(handshake("/live", { ...auth, "x-opencadre-session": "live-tool" }))).toMatchObject({ ok: false, code: 4001, reason: "OpenCadre isn't enabled for this project" });
    setProjectEnabled(orgId, { actor: null, name: "Operator", via: "operator" }, "local:LiveRepo", true);
    const ok = authenticateLiveRequest(handshake("/live", { ...auth, "x-opencadre-session": "live-tool" }));
    expect(ok).toMatchObject({ ok: true, orgId });
    const agentId = (ok as { agentId: string }).agentId;
    expect(authenticateLiveRequest(handshake("/live", { ...auth, "x-opencadre-session": "live-tool" }))).toEqual({ ok: true, orgId, agentId });

    expect(authenticateLiveRequest(handshake("/live", auth))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake(`/live?apiKey=${redeemed.deviceCredential}`, { "x-opencadre-session": "live-tool" }))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake(`/live?deviceCredential=${redeemed.deviceCredential}`, { "x-opencadre-session": "live-tool" }))).toMatchObject({ ok: false, code: 4001 });

    pauseWorkspace(orgId, operator);
    expect(authenticateLiveRequest(handshake("/live", { ...auth, "x-opencadre-session": "live-tool" }))).toMatchObject({ ok: false, code: 4003 });
  });

  it("a person connects with the session cookie from the console's own origin, as their member agent", () => {
    const { person, orgId, cookie } = personWithWorkspace("live-owner");
    const result = authenticateLiveRequest(handshake(`/live?workspace=${orgId}`, { cookie, origin: "https://app.opencadre.example" }));
    expect(result).toMatchObject({ ok: true, kind: "console", orgId, personId: person.id });
    expect(JSON.stringify(result)).not.toContain(cookie);
  });

  it("refuses a session socket from another site, without a workspace, or for a workspace they aren't in", () => {
    const { orgId, cookie } = personWithWorkspace("live-guard");
    const other = createOrganization("Not Theirs").orgId;
    expect(authenticateLiveRequest(handshake(`/live?workspace=${orgId}`, { cookie, origin: "https://evil.example" }))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake(`/live?workspace=${orgId}`, { cookie }))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake("/live", { cookie, origin: "https://app.opencadre.example" }))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake(`/live?workspace=${other}`, { cookie, origin: "https://app.opencadre.example" }))).toMatchObject({ ok: false, code: 4001 });
    expect(authenticateLiveRequest(handshake(`/live?workspace=${orgId}`, { cookie: "oc_session=forged", origin: "https://app.opencadre.example" }))).toMatchObject({ ok: false, code: 4001 });
  });

  it("a paused workspace refuses members' sockets (4003) but not owners'", () => {
    const owner = personWithWorkspace("live-paused-owner");
    const member = upsertPerson({ id: "live-paused-member", email: "m@example.com", emailVerified: true, name: "Member", avatarUrl: null });
    const invite = createInvite(owner.orgId, { id: "x", name: "live-paused-owner" }, "member", null);
    acceptInvite(invite.token, member);
    pauseWorkspace(owner.orgId, { id: "x", name: "live-paused-owner" });
    const origin = "https://app.opencadre.example";
    expect(authenticateLiveRequest(handshake(`/live?workspace=${owner.orgId}`, { cookie: `oc_session=${createSession(member.id).token}`, origin })))
      .toMatchObject({ ok: false, code: 4003 });
    expect(authenticateLiveRequest(handshake(`/live?workspace=${owner.orgId}`, { cookie: owner.cookie, origin }))).toMatchObject({ ok: true });
  });
});
