import { currentCliPackage, type CliBuild } from "./cli-package.js";
import { log } from "./log.js";

/**
 * OPENCADRE_REQUIRE_CLI_PROVENANCE=1: the hub refuses to call itself healthy while the CLI package it serves cannot tell
 * an official old helper from an unknown one.
 *
 * WHY (2026-10-06). Production 480c850e served /cli/manifest.json with provenance "none", commit null and all 22
 * officialHistory lists empty, because the deploy ran a stale scripts/deploy-vps.sh that has no deploy-archive.sh step:
 * the image was built from a plain `git archive` with no cli-provenance.json, and pack-cli packed provenance "none", as it
 * is designed to for a plain-checkout build. `connect --upgrade` then classifies every unrecorded official old helper as
 * "unknown" and refuses it (cli/lib/generations.mjs classify). Nothing failed, so nothing rolled back.
 *
 * This check travels WITH the deployed commit, so it holds whichever deploy script built the image: every deploy script
 * since 600ff708 keeps a new image only if GET /health answers ok within ~30 s, and restores opencadre:rollback otherwise.
 * With the flag set in /opt/opencadre/.env, a package without deploy provenance makes /health 503 with the reason, and
 * the deploy rolls itself back. Unset (or anything but exactly "1"), nothing changes: self-hosters build from plain
 * checkouts with provenance "none" and must keep working (the Dockerfile tolerates that on purpose).
 *
 * WHAT IT REQUIRES, of the package's build.json (scripts/cli-build-info.mjs):
 *   - provenance "deploy-archive" (the production path) or "git" (a build from a checkout, which also has real history);
 *   - commit: a full 40-hex sha;
 *   - helpers names at least one helper, and officialHistory is a non-empty list for every helper (and for every name
 *     officialHistory lists);
 *   - when OPENCADRE_VERSION is a hex sha (deploy-vps.sh sets the `git rev-parse --short` of the deployed ref), the commit
 *     starts with it: the package describes the commit this container says it is. Any other OPENCADRE_VERSION skips only
 *     this comparison, because `deploy-vps.sh --rollback` and the health-failure rollback re-run the previous image with
 *     VERSION=rollback, and that image passed this guard when it was deployed; failing it there would turn a rollback
 *     into an outage.
 *
 * NO PACKAGE FAILS CLOSED. Without the flag, a missing package leaves /health ok and /cli/manifest.json 503, as before.
 * With it, a missing or unreadable package is a failure: production always builds one (`npm run build` packs it in the
 * image's build stage), and a hub without it cannot serve `connect --upgrade` at all, so "no package" is never a state
 * an operator who set this flag wants to keep.
 */
export const REQUIRE_CLI_PROVENANCE_ENV = "OPENCADRE_REQUIRE_CLI_PROVENANCE";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{4,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACCEPTED = new Set(["deploy-archive", "git"]);

/** Why `build` cannot vouch for the helpers it ships, or null when it can. `version` is the container's
 * OPENCADRE_VERSION, compared only when it is a hex sha. */
export function buildProvenanceProblem(build: CliBuild, version: string | undefined): string | null {
  const provenance = build.provenance;
  if (typeof provenance !== "string" || !ACCEPTED.has(provenance)) {
    return `provenance is ${JSON.stringify(provenance ?? null)}, not "deploy-archive" or "git": the image was built without the helpers' git history (deploy with scripts/deploy-vps.sh from a clean worktree at the deployed commit)`;
  }
  const commit = build.commit;
  if (typeof commit !== "string" || !FULL_SHA.test(commit)) return `commit is not a full 40-hex sha (${JSON.stringify(commit ?? null)})`;
  const helpers = build.helpers && typeof build.helpers === "object" && !Array.isArray(build.helpers) ? Object.keys(build.helpers) : [];
  if (helpers.length === 0) return "build.json names no helpers";
  const history = build.officialHistory && typeof build.officialHistory === "object" && !Array.isArray(build.officialHistory)
    ? (build.officialHistory as Record<string, unknown>)
    : {};
  const names = [...new Set([...helpers, ...Object.keys(history)])];
  const empty = names.filter((name) => !Array.isArray(history[name]) || (history[name] as unknown[]).length === 0).sort();
  if (empty.length > 0) return `officialHistory is empty for ${empty.join(", ")}`;
  // Every entry must be a sha256 the CLI can compare a helper's bytes with (review of #718, 049a): a non-empty list of
  // nulls or non-hashes matches no helper either, which is the 2026-10-06 regression with a passing check.
  const malformed = names.filter((name) => !(history[name] as unknown[]).every((h) => typeof h === "string" && SHA256.test(h))).sort();
  if (malformed.length > 0) return `officialHistory has entries that are not sha256 hex for ${malformed.join(", ")}`;
  if (version && SHORT_SHA.test(version) && !commit.startsWith(version)) return `commit ${commit} is not the deployed version ${version}`;
  return null;
}

/** Null when the flag is off or the served package passes; otherwise the reason, for /health and the startup log. */
export function cliProvenanceProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[REQUIRE_CLI_PROVENANCE_ENV] !== "1") return null;
  const pkg = currentCliPackage();
  if (!pkg) return `${REQUIRE_CLI_PROVENANCE_ENV}=1 but this hub has no CLI package to check (npm run build packs it)`;
  const read = pkg.build();
  if (!read.ok) return read.error;
  return buildProvenanceProblem(read.build, env.OPENCADRE_VERSION);
}

/** Once at startup (src/index.ts): with the flag on, say what /health will say, so `docker logs` names the reason a
 * deploy rolled back. Silent with the flag off. Returns the problem, or null. */
export function reportCliProvenanceAtStartup(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[REQUIRE_CLI_PROVENANCE_ENV] !== "1") return null;
  const problem = cliProvenanceProblem(env);
  if (problem) log.error(`/health will answer 503: CLI package provenance: ${problem}`);
  else {
    const read = currentCliPackage()?.build();
    log.info("CLI package provenance verified", { commit: read?.ok ? read.build.commit ?? null : null, provenance: read?.ok ? read.build.provenance ?? null : null });
  }
  return problem;
}
