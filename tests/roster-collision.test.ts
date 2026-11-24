/** Live collision state on the roster.
 *
 * WHY THIS EXISTS: collision was already detected, but ONLY at the moment an agent wrote its status --
 * setAgentStatus compares the writer's files against every other online agent and returns a warning to
 * THAT writer. Nobody else could see it, and it vanished from every later read. The console therefore had
 * no way to show that two agents were on the same file: NUNT built the Fleet row's collision stripe and
 * had to leave it defined-but-unapplied because the payload carried nothing to trigger it.
 *
 * WHAT THIS PINS: the roster now derives `collision_files`/`collision_agents` on read, using the same
 * online + same-project rule the writer's warning uses. The property that matters most is that the two
 * cannot disagree -- a console that says "no collision" while the writer was just warned about one is
 * worse than no signal at all.
 */
import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent, setAgentStatus, listActiveAgents, heartbeat } from "../src/service.js";
import { db } from "../src/db.js";

const roster = (orgId: string, viewer?: string) => listActiveAgents(orgId, viewer);
const rowFor = (orgId: string, agentId: string) => roster(orgId).find((a) => a.id === agentId)!;

describe("roster collision state", () => {
  it("reports no collision when a single agent edits alone", () => {
    const { orgId } = createOrganization("Collision Solo Org");
    const a = registerAgent(orgId, "Solo-A");
    setAgentStatus(orgId, a.agentId, "editing alone", ["src/only.ts"]);

    const row = rowFor(orgId, a.agentId);
    expect(row.collision_files).toEqual([]);
    expect(row.collision_agents).toEqual([]);
  });

  it("reports the shared file and the other agent on BOTH rows, symmetrically", () => {
    const { orgId } = createOrganization("Collision Pair Org");
    const a = registerAgent(orgId, "Pair-A");
    const b = registerAgent(orgId, "Pair-B");
    heartbeat(orgId, a.agentId);
    heartbeat(orgId, b.agentId);
    setAgentStatus(orgId, a.agentId, "editing a", ["src/shared.ts", "src/a-only.ts"]);
    setAgentStatus(orgId, b.agentId, "editing b", ["src/shared.ts", "src/b-only.ts"]);

    const rowA = rowFor(orgId, a.agentId);
    const rowB = rowFor(orgId, b.agentId);

    // Only the OVERLAPPING path is reported. a-only/b-only are not collisions and must not appear, or the
    // signal degrades into "this agent is editing something", which is already visible elsewhere.
    expect(rowA.collision_files).toEqual(["src/shared.ts"]);
    expect(rowB.collision_files).toEqual(["src/shared.ts"]);
    expect(rowA.collision_agents).toEqual(["Pair-B"]);
    expect(rowB.collision_agents).toEqual(["Pair-A"]);
  });

  it("does not collide with an agent that has gone offline", () => {
    const { orgId } = createOrganization("Collision Offline Org");
    const a = registerAgent(orgId, "Off-A");
    const b = registerAgent(orgId, "Off-B");
    heartbeat(orgId, a.agentId);
    // b never heartbeats: it registered a status but is not online, so it is not editing right now.
    setAgentStatus(orgId, a.agentId, "editing", ["src/same.ts"]);
    setAgentStatus(orgId, b.agentId, "editing", ["src/same.ts"]);

    const rowA = rowFor(orgId, a.agentId);
    expect(rowA.collision_files).toEqual([]);
    expect(rowA.collision_agents).toEqual([]);
  });

  it("agrees with the writer's own collision warning for the same pair", () => {
    // The load-bearing invariant: the payloade signal and the writer's warning are one rule, not two.
    const { orgId } = createOrganization("Collision Agreement Org");
    const a = registerAgent(orgId, "Agree-A");
    const b = registerAgent(orgId, "Agree-B");
    heartbeat(orgId, a.agentId);
    heartbeat(orgId, b.agentId);
    setAgentStatus(orgId, a.agentId, "editing", ["src/agree.ts"]);

    // b writes second and is warned by the writer path.
    const { collisions } = setAgentStatus(orgId, b.agentId, "editing", ["src/agree.ts"]);
    expect(collisions).toEqual([{ agentName: "Agree-A", files: ["src/agree.ts"] }]);

    // The roster must tell the same story, from both directions.
    const rowB = rowFor(orgId, b.agentId);
    const rowA = rowFor(orgId, a.agentId);
    expect(rowB.collision_agents).toEqual(["Agree-A"]);
    expect(rowA.collision_agents).toEqual(["Agree-B"]);
    expect(rowB.collision_files).toEqual(collisions[0].files);
  });

  it("clears the collision once one side stops editing the shared file", () => {
    const { orgId } = createOrganization("Collision Clears Org");
    const a = registerAgent(orgId, "Clear-A");
    const b = registerAgent(orgId, "Clear-B");
    heartbeat(orgId, a.agentId);
    heartbeat(orgId, b.agentId);
    setAgentStatus(orgId, a.agentId, "editing", ["src/x.ts"]);
    setAgentStatus(orgId, b.agentId, "editing", ["src/x.ts"]);
    expect(rowFor(orgId, a.agentId).collision_files).toEqual(["src/x.ts"]);

    setAgentStatus(orgId, b.agentId, "done", []);
    // Derived state, so it must self-heal without anything rewriting A's row.
    expect(rowFor(orgId, a.agentId).collision_files).toEqual([]);
    expect(rowFor(orgId, a.agentId).collision_agents).toEqual([]);
  });

  it("names every partner and sorts them, so the render is stable", () => {
    const { orgId } = createOrganization("Collision Many Org");
    const a = registerAgent(orgId, "Many-A");
    const z = registerAgent(orgId, "Zeta");
    const m = registerAgent(orgId, "Mu");
    for (const id of [a.agentId, z.agentId, m.agentId]) heartbeat(orgId, id);
    setAgentStatus(orgId, a.agentId, "editing", ["src/many.ts"]);
    setAgentStatus(orgId, z.agentId, "editing", ["src/many.ts"]);
    setAgentStatus(orgId, m.agentId, "editing", ["src/many.ts"]);

    const row = rowFor(orgId, a.agentId);
    expect(row.collision_agents).toEqual(["Mu", "Zeta"]);
    // One shared path, not one entry per partner.
    expect(row.collision_files).toEqual(["src/many.ts"]);
  });

  it("does not collide across two different known projects on the same path", () => {
    // Found by mutation testing: with only workspace-wide agents in the suite, DELETING the project guard
    // left every test green. Two repos both have src/index.ts, so the guard is load-bearing and needs its
    // own case. Agents are bound the way project-isolation.test.ts does it: scope + home_project.
    const { orgId } = createOrganization("Collision Projects Org");
    const a = registerAgent(orgId, "Proj-A");
    const b = registerAgent(orgId, "Proj-B");
    heartbeat(orgId, a.agentId);
    heartbeat(orgId, b.agentId);
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run("github.com/c/alpha", a.agentId);
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run("github.com/c/beta", b.agentId);

    setAgentStatus(orgId, a.agentId, "editing", ["src/index.ts"]);
    setAgentStatus(orgId, b.agentId, "editing", ["src/index.ts"]);

    expect(rowFor(orgId, a.agentId).collision_files).toEqual([]);
    expect(rowFor(orgId, b.agentId).collision_files).toEqual([]);
  });

  it("still collides when one side is workspace-wide (unknown project)", () => {
    // The other half of the same rule: a named agent has no project and is compared with everyone
    // (docs/design/PROJECT_ISOLATION.md §7 item 1). Tightening the guard must not lose this case.
    const { orgId } = createOrganization("Collision Unknown Org");
    const a = registerAgent(orgId, "Unk-A");
    const b = registerAgent(orgId, "Unk-B");
    heartbeat(orgId, a.agentId);
    heartbeat(orgId, b.agentId);
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run("github.com/c/alpha", a.agentId);
    // b stays workspace-wide (home_project NULL).

    setAgentStatus(orgId, a.agentId, "editing", ["src/index.ts"]);
    setAgentStatus(orgId, b.agentId, "editing", ["src/index.ts"]);

    expect(rowFor(orgId, a.agentId).collision_agents).toEqual(["Unk-B"]);
    expect(rowFor(orgId, b.agentId).collision_agents).toEqual(["Unk-A"]);
  });

  it("carries the fields on every roster row, including agents with no files", () => {
    // The console reads a fixed shape; a missing key would render as undefined rather than empty.
    const { orgId } = createOrganization("Collision Shape Org");
    const a = registerAgent(orgId, "Shape-A");
    for (const row of roster(orgId, a.agentId)) {
      expect(Array.isArray(row.collision_files)).toBe(true);
      expect(Array.isArray(row.collision_agents)).toBe(true);
    }
  });
});