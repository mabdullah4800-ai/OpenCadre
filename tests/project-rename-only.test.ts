import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createOrganization } from "../src/service.js";
import { listProjects, ProjectError, setProjectEnabled } from "../src/projects.js";

// A rename changes the name and nothing else (Codex-OpenCadre-f46c on 5511d8f). Before this a rename had to restate
// `enabled`, so a console form opened before another operator switched the project sent the old value back: it
// reversed their switch, and a stale false also cut the project's live sessions off.
const KEY = "github.com/acme/api";
const by = (name: string) => ({ actor: null, name, via: "operator" as const });
const project = (orgId: string) => listProjects(orgId).find((p) => p.projectKey === KEY)!;
const disabledEvents = (orgId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'project.disabled'`).get(orgId) as { n: number }).n;

describe("renaming a project is a rename only", () => {
  it("a rename after another operator ENABLED the project leaves it enabled, with no disable event", () => {
    const { orgId } = createOrganization("Rename Race Enable");
    setProjectEnabled(orgId, by("A"), KEY, true);
    setProjectEnabled(orgId, by("B"), KEY, false); // A opens the rename form while it is off...
    setProjectEnabled(orgId, by("B"), KEY, true); // ...then B switches it back on
    const before = disabledEvents(orgId);
    setProjectEnabled(orgId, by("A"), KEY, undefined, "Billing-API"); // A saves the name only
    expect(project(orgId)).toMatchObject({ name: "Billing-API", enabled: true });
    expect(disabledEvents(orgId), "no disable, so no sessions cut off").toBe(before);
  });

  it("a rename after another operator DISABLED the project leaves it disabled", () => {
    const { orgId } = createOrganization("Rename Race Disable");
    setProjectEnabled(orgId, by("A"), KEY, true);
    setProjectEnabled(orgId, by("B"), KEY, false);
    setProjectEnabled(orgId, by("A"), KEY, undefined, "Billing-API");
    expect(project(orgId)).toMatchObject({ name: "Billing-API", enabled: false });
  });

  it("a rename of an unknown project is 404, and neither a name nor enabled is still 400", () => {
    const { orgId } = createOrganization("Rename Unknown");
    expect(() => setProjectEnabled(orgId, by("A"), KEY, undefined, "X")).toThrow(ProjectError);
    try { setProjectEnabled(orgId, by("A"), KEY, undefined, "X"); } catch (err) { expect((err as ProjectError).status).toBe(404); }
    try { setProjectEnabled(orgId, by("A"), KEY, undefined); } catch (err) { expect((err as ProjectError).status).toBe(400); }
    expect(() => setProjectEnabled(orgId, by("A"), KEY, undefined)).toThrow("enabled must be true or false");
  });
});
