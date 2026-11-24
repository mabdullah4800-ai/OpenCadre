import { toSqliteTime } from "../src/timestamps.js";
import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import {
  createOrganization,
  registerAgent,
  heartbeat,
  listActiveAgents,
  sweepStaleAgents,
  staleAfterMs,
} from "../src/service.js";
import { authenticateAgentKey } from "../src/auth.js";

function backdateHeartbeat(agentId: string, orgId: string, ageMs: number): void {
  // SQLite datetime('now') format: UTC space-separated, second precision.
  const when = toSqliteTime(Date.now() - ageMs);
  db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ? AND org_id = ?`).run(when, agentId, orgId);
}

describe("staleAfterMs", () => {
  it("defaults to 30 minutes when unset", () => {
    const prev = process.env.OPENCADRE_STALE_AFTER_MS;
    delete process.env.OPENCADRE_STALE_AFTER_MS;
    expect(staleAfterMs()).toBe(30 * 60 * 1000);
    if (prev !== undefined) process.env.OPENCADRE_STALE_AFTER_MS = prev;
  });
});

describe("sweepStaleAgents", () => {
  it("suspends active agents with null last_heartbeat_at", () => {
    const { orgId } = createOrganization("Sweep Null Beat");
    const { agentId } = registerAgent(orgId, "Never Beat");

    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("active");

    const result = sweepStaleAgents();
    expect(result.suspended).toContain(agentId);

    const agent = listActiveAgents(orgId).find((a) => a.id === agentId);
    expect(agent?.status).toBe("paused");

    const types = listEvents(orgId).map((e) => e.type);
    expect(types).toEqual(["agent.stale", "agent.suspended"]);
    expect(listEvents(orgId).every((e) => e.actor_agent_id === null)).toBe(true);
  });

  it("suspends active agents older than the stale threshold", () => {
    const prev = process.env.OPENCADRE_STALE_AFTER_MS;
    process.env.OPENCADRE_STALE_AFTER_MS = String(5 * 60 * 1000); // 5 min
    try {
      const { orgId } = createOrganization("Sweep Old Beat");
      const fresh = registerAgent(orgId, "Fresh Agent");
      const stale = registerAgent(orgId, "Stale Agent");
      heartbeat(orgId, fresh.agentId);
      heartbeat(orgId, stale.agentId);
      backdateHeartbeat(stale.agentId, orgId, 10 * 60 * 1000); // 10 min ago

      const result = sweepStaleAgents();
      expect(result.suspended).toContain(stale.agentId);
      expect(result.suspended).not.toContain(fresh.agentId);

      expect(listActiveAgents(orgId).find((a) => a.id === stale.agentId)?.status).toBe("paused");
      expect(listActiveAgents(orgId).find((a) => a.id === fresh.agentId)?.status).toBe("active");
    } finally {
      if (prev === undefined) delete process.env.OPENCADRE_STALE_AFTER_MS;
      else process.env.OPENCADRE_STALE_AFTER_MS = prev;
    }
  });

  it("is idempotent: already-paused agents do not get re-emitted", () => {
    const { orgId } = createOrganization("Sweep Idempotent");
    const { agentId } = registerAgent(orgId, "Once Only");

    const first = sweepStaleAgents();
    expect(first.suspended).toContain(agentId);
    const afterFirst = listEvents(orgId).map((e) => e.type);
    expect(afterFirst).toEqual(["agent.stale", "agent.suspended"]);

    const second = sweepStaleAgents();
    expect(second.suspended).not.toContain(agentId);
    expect(listEvents(orgId).map((e) => e.type)).toEqual(afterFirst);
  });

  it("does not suspend agents inside the threshold", () => {
    const prev = process.env.OPENCADRE_STALE_AFTER_MS;
    process.env.OPENCADRE_STALE_AFTER_MS = String(30 * 60 * 1000);
    try {
      const { orgId } = createOrganization("Sweep Fresh");
      const { agentId } = registerAgent(orgId, "Just Beat");
      heartbeat(orgId, agentId);
      backdateHeartbeat(agentId, orgId, 5 * 60 * 1000); // 5 min < 30 min

      const result = sweepStaleAgents();
      expect(result.suspended).not.toContain(agentId);
      expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("active");
      expect(listEvents(orgId)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.OPENCADRE_STALE_AFTER_MS;
      else process.env.OPENCADRE_STALE_AFTER_MS = prev;
    }
  });
});

describe("heartbeat resumes a paused agent", () => {
  it("sets status back to active and emits agent.resumed", () => {
    const { orgId } = createOrganization("Resume Org");
    const { agentId } = registerAgent(orgId, "Resume Me");
    sweepStaleAgents();
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("paused");

    heartbeat(orgId, agentId);

    const agent = listActiveAgents(orgId).find((a) => a.id === agentId);
    expect(agent?.status).toBe("active");
    expect(agent?.online).toBe(true);

    const types = listEvents(orgId).map((e) => e.type);
    expect(types).toEqual(["agent.stale", "agent.suspended", "agent.resumed"]);
  });

  it("a second heartbeat while active does not emit another resumed", () => {
    const { orgId } = createOrganization("Resume Once");
    const { agentId } = registerAgent(orgId, "Active Agent");
    sweepStaleAgents();
    heartbeat(orgId, agentId);
    heartbeat(orgId, agentId);
    const resumed = listEvents(orgId).filter((e) => e.type === "agent.resumed");
    expect(resumed).toHaveLength(1);
  });
});

describe("paused agents still authenticate", () => {
  it("does not block auth for a suspended agent", () => {
    const { orgId } = createOrganization("Auth Still Works");
    const { agentId, apiKey } = registerAgent(orgId, "Paused But Valid");
    sweepStaleAgents();
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("paused");

    const authed = authenticateAgentKey(apiKey);
    expect(authed).not.toBeNull();
    expect(authed?.agentId).toBe(agentId);
    expect(authed?.orgId).toBe(orgId);
  });
});

describe("listActiveAgents exposes status", () => {
  it("includes status so callers can see paused", () => {
    const { orgId } = createOrganization("Status Exposed");
    const { agentId } = registerAgent(orgId, "Status Agent");
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("active");
    sweepStaleAgents();
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.status).toBe("paused");
  });
});
