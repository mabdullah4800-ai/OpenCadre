import { describe, expect, it } from "vitest";
import { can, roleFor, type Action } from "../src/permissions.js";

// docs/design/rbac-permission-model.md, migration steps 1 (pure refactor), 2 (tighten
// agentKeys.rotate/delete and members.changeRole/remove to owner-only), and 3 (MCP parity).
const AGENT_ACTIONS: Action[] = ["approval.decide", "approvalGrant.revoke"];
const ADMIN_ACTIONS: Action[] = [
  "agents.create", "agents.webhook", "orgUsage.read", "connectCodes.manage",
  "devices.manage", "projects.manage", "projectLinks.manage", "projectIsolation.manage",
  "sessions.manage", "clearancePolicy.write", "clearancePolicy.list",
  "members.list", "members.invite", "members.inviteRevoke",
];
const OWNER_ACTIONS: Action[] = ["org.pause", "org.resume", "agents.rotateKey", "agents.delete", "members.changeRole", "members.remove"];

describe("roleFor", () => {
  it("a member session's real memberRole wins, regardless of agentRole", () => {
    expect(roleFor("agent", "member")).toBe("member");
    expect(roleFor("operator", "admin")).toBe("admin");
    expect(roleFor("operator", "owner")).toBe("owner");
  });

  it("a bare API-key operator (no memberRole) is owner-equivalent -- the bootstrap exception", () => {
    expect(roleFor("operator", null)).toBe("owner");
    expect(roleFor("operator", undefined)).toBe("owner");
  });

  it("a plain agent key (no memberRole, agentRole 'agent') is just an agent", () => {
    expect(roleFor("agent", null)).toBe("agent");
    expect(roleFor(undefined, null)).toBe("agent");
  });
});

describe("can", () => {
  it("every agent-tier action (MCP parity: approval.decide, approvalGrant.revoke): every role passes, including a plain agent -- no restriction beyond authentication", () => {
    for (const action of AGENT_ACTIONS) {
      expect(can("agent", action), action).toBe(true);
      expect(can("member", action), action).toBe(true);
      expect(can("admin", action), action).toBe(true);
      expect(can("owner", action), action).toBe(true);
    }
  });

  it("every admin-tier action: member is denied, admin and owner pass", () => {
    for (const action of ADMIN_ACTIONS) {
      expect(can("member", action), action).toBe(false);
      expect(can("agent", action), action).toBe(false);
      expect(can("admin", action), action).toBe(true);
      expect(can("owner", action), action).toBe(true);
    }
  });

  it("every owner-tier action: member and admin are denied, only owner passes", () => {
    for (const action of OWNER_ACTIONS) {
      expect(can("agent", action), action).toBe(false);
      expect(can("member", action), action).toBe(false);
      expect(can("admin", action), action).toBe(false);
      expect(can("owner", action), action).toBe(true);
    }
  });

  it("a bare API-key operator (roleFor -> owner) passes every action in the table today, matching the old requireOperator/requireOwner behavior", () => {
    const role = roleFor("operator", null);
    for (const action of [...AGENT_ACTIONS, ...ADMIN_ACTIONS, ...OWNER_ACTIONS]) expect(can(role, action), action).toBe(true);
  });
});
