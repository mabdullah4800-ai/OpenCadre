#!/usr/bin/env -S npx tsx
// Reusable local console-screenshot harness (docs/dev/CONSOLE_SHOTS.md).
//
// Boots the hub straight from src (in this same process, via a dynamic import -- no child process,
// no separate build step), seeds a realistic workspace through the hub's own REST API and exported
// functions (no hub code changes), mints a real session cookie for the workspace owner, then drives
// headless Edge over CDP to screenshot every console section at a handful of breakpoints, in light
// and dark. Zero new dependencies: only `ws` (already a dependency, for the CDP WebSocket) and
// Node's own `node:crypto`/`node:http`/`node:fs` etc.
//
// Usage (always via tsx, so the dynamic `../../src/*.js` imports resolve their real .ts source):
//   npx tsx scripts/dev/console-shots.mjs
//   npx tsx scripts/dev/console-shots.mjs --empty                # fresh workspace, no seed data
//   npx tsx scripts/dev/console-shots.mjs --pages clearances,fleet
//   npx tsx scripts/dev/console-shots.mjs --widths 375x812,1440x900
//   npx tsx scripts/dev/console-shots.mjs --themes dark
//   npx tsx scripts/dev/console-shots.mjs --keep-alive            # leave the hub running afterward
//   npx tsx scripts/dev/console-shots.mjs --out my-shots-dir
//   npx tsx scripts/dev/console-shots.mjs --stage-revoked        # a computer the workspace removed
//                                                                # while its command card is up
//   npx tsx scripts/dev/console-shots.mjs --stage-revoked --pre-fix   # the same, un-fixed console:
//                                                                # proves the staged run can fail
//   npx tsx scripts/dev/console-shots.mjs --pages tasks --stage-refresh-error   # the "Couldn't refresh"
//                                                                # line over the board it kept
//   npx tsx scripts/dev/console-shots.mjs --pages tasks --stage-task-paging     # the paged board: "Show more",
//                                                                # the next page, and a search
//
// Prints the hub's base URL and how to reuse its session cookie at the end of every run, so a human
// or another agent can point their own browser at it and click around (see printUsage() below).

import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { scratchRoot, shotsDir } from "./bulk-root.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createECDH, randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------------------------
// Section config: the console's sections, as a plain list QA/Designer edit by hand -- not
// selectors this script derives from the live DOM (a same-document URL change alone doesn't switch
// the SPA's visible panel; see selectPage()'s own comment for why real clicks are used instead).
//
// Each entry is `{ id, label, steps? }`:
//   - `id` is this script's own name for the section (used for CLI --pages filtering and output
//     file names) -- it need not match any DOM attribute.
//   - `label` is cosmetic, for log lines only.
//   - `steps` is the ordered list of CSS selectors to click, from wherever the previous section
//     left the page, to land on this one -- one click for a flat nav item (e.g.
//     `['[data-tab="fleet"]']`), two for anything nested (a "More" drawer item, or a Settings
//     sub-nav row: `['[data-tab="settings"]', '[data-subnav="members"]']`). Omit `steps` entirely
//     and it defaults to a single click on `[data-tab="<id>"]`, today's convention.
//
// The redesign will change the nav shape stage by stage -- when it does, update the affected
// entries' `steps` (and `id`, if this script's own naming should change to match); no code change
// is needed in selectPage() itself for a deeper or reshuffled nav, only for a fundamentally
// different interaction (e.g. hover-to-open instead of click) -- see selectPage()'s own comment.
// ---------------------------------------------------------------------------------------------
// Stage 1 (design/hub-stage1, docs/design/HUB_REDESIGN.md Section 7): the horizontal tab bar is
// gone, replaced by a left sidebar (>=768px, icon-rail 1024-1279px) and, at <=767px, a 4-slot
// bottom bar, everything not in that bottom bar behind a "More" drawer opened via #more-btn. All
// copies of a section's nav button share the same [data-tab] value, so the only entries needing an
// explicit `steps` override are the ones that live behind the drawer at mobile widths --
// selectPage() clicks #more-btn first (a no-op at any width where it isn't visible, i.e. >=768px)
// and then the now-visible drawer copy.
//
// Stage 2 (design/hub-stage2): adds Overview as the new default landing page and takes the bottom
// bar's first slot; Clearances moved out of that direct slot into the drawer to make room.
// Stage 3 (design/hub-stage3): Clearances is retired as its own nav item/panel entirely -- merged
// into Inbox (filter: Approvals). No [data-tab="clearances"] exists anymore, so its PAGES entry is
// removed rather than pointed at a dead selector.
const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "inbox", label: "Inbox" },
  { id: "fleet", label: "Fleet" },
  // Fleet's "Agents" segment: the named (agt_ key) agents, and the only place Rotate key / Remove
  // appear. Not reachable by a nav click alone -- it's a segment of the Fleet view -- so it needs its
  // own entry to be covered at all.
  { id: "fleet-agents", label: "Fleet · Agents", steps: ["#more-btn", '[data-tab="fleet"]', '[data-view="agents"]'] },
  { id: "tasks", label: "Tasks", steps: ["#more-btn", '[data-tab="tasks"]'] },
  // By computer (with the "Agents without a linked computer" group), and Tasks with the replaced
  // card expanded. The last step is the panel heading so the page is found even once the card is already open.
  { id: "fleet-computers", label: "Agents by computer", steps: ["#more-btn", '[data-tab="fleet"]', '[data-view="computer"]'] },
  { id: "tasks-expanded", label: "Tasks, a card expanded", steps: ["#more-btn", '[data-tab="tasks"]', '.task.is-superseded .task-details:not([open]) > summary', "#h-tasks"] },
  { id: "timeline", label: "Activity", steps: ["#more-btn", '[data-tab="timeline"]'] },
  // Add a computer opens on its Computer choice; the last step puts it back there after a pass shot the App choice
  // (one page load serves every pass, so the choice made by the entry below would otherwise carry over).
  { id: "connect", label: "Connect", steps: ["#more-btn", '[data-tab="connect"]', "#connect-kind-computer"] },
  { id: "connect-apps", label: "Connect · App", steps: ["#more-btn", '[data-tab="connect"]', "#connect-kind-app"] },
  { id: "settings", label: "Settings", steps: ["#more-btn", '[data-tab="settings"]'] },
  // The sign-up half of the self-serve first run (--first-run): a signed-in person with NO workspace
  // sees the picker instead of the console. `selfServeOnly` because it cannot exist in any other run
  // -- every other mode (default, --empty, --as-admin) starts from a workspace that already exists,
  // and the nav this entry's `steps` would click does not render at all until one does.
  //
  // Shot by the run's own prologue, NOT by the page loop below: the console creates the workspace
  // between them, so by the time the loop runs the picker is already gone in this browser. See the
  // loop's comment for why that ordering is per-pass rather than once.
  { id: "signup-picker", label: "Sign-up: workspace picker", selfServeOnly: true, steps: [] },
];

const DEFAULT_WIDTHS = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "1024x768", width: 1024, height: 768, mobile: false },
  { name: "768x1024", width: 768, height: 1024, mobile: false },
  { name: "375x812", width: 375, height: 812, mobile: true },
];

const DEFAULT_THEMES = ["light", "dark"];

// The name --stage-revoked gives the computer it adds on the Connect tab, and the name the console
// itself gives the one its first-run card creates (the "Get my command" handler in public/app/app.js
// posts `name: "My computer"`). Both are found in the workspace's device list BY NAME, because the
// device id the console just created lives in its own closure and never reaches the DOM; a rename on
// either side fails loudly at staging time with the device list it did see, rather than shooting the
// wrong card.
const PC2_NAME = "PC-2";
const FIRST_RUN_DEVICE_NAME = "My computer";

// ---------------------------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { empty: false, pages: null, widths: null, themes: null, keepAlive: false, out: null, asAdmin: false, firstRun: false, stageRevoked: false, preFix: false, stageRefreshError: false, stageSourceError: false, stageTaskPaging: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--empty") args.empty = true;
    else if (a === "--as-admin") args.asAdmin = true;
    else if (a === "--first-run") args.firstRun = true;
    else if (a === "--keep-alive") args.keepAlive = true;
    else if (a === "--stage-revoked") args.stageRevoked = true;
    else if (a === "--pre-fix") args.preFix = true;
    else if (a === "--stage-refresh-error") args.stageRefreshError = true;
    else if (a === "--stage-source-error") args.stageSourceError = true;
    else if (a === "--stage-task-paging") args.stageTaskPaging = true;
    else if (a === "--pages") args.pages = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--widths") {
      args.widths = argv[++i].split(",").map((s) => {
        const [w, h] = s.trim().split("x").map(Number);
        return { name: s.trim(), width: w, height: h || w, mobile: w <= 480 };
      });
    } else if (a === "--themes") args.themes = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`console-shots.mjs -- screenshot every console section at a set of breakpoints, in light and dark.

  --empty              seed nothing (fresh workspace, for empty-state coverage)
  --first-run          capture the SELF-SERVE first run: mint a person with no workspace, shoot the
                       sign-up picker they land on, then drive the console's own create form so the
                       hub mints the first key in the browser exactly as a stranger gets it, and shoot
                       the console after. One fresh person per breakpoint/theme pass. Seeds nothing else
                       and ignores --empty/--as-admin (there is no seeded workspace to be an admin of).
  --as-admin           capture as a workspace ADMIN member instead of the owner (same seeded
                       workspace; adds a second person and joins them via the real invite flow).
                       Use it to see what a non-owner sees where RBAC gates an action.
  --pages a,b          only these page ids (see PAGES in this file for the full list)
  --widths WxH,WxH     override the default breakpoints (e.g. 375x812,1440x900)
  --themes light,dark  override the default themes (default: both); "forced" is light under forced colours
  --keep-alive         leave the local hub running after shots so you can click around
  --stage-revoked      extra pass per breakpoint/theme: create a computer through the console's own
                       form, remove it from the workspace through the hub route the Fleet list's
                       Remove button calls, and shoot the section that was waiting on it -- the
                       Connect tab's command card, and (with --first-run) the first-run card. The
                       same wait asserts the claim a screenshot cannot make on its own: that the
                       console's 3-second poller stopped, measured as the poller interval itself
                       (the page's own request count is reported but not asserted on -- the refresh
                       heartbeat GETs the same path, so it cannot tell the two apart). The poller is
                       required to be RUNNING before the removal, so "it stopped" cannot be confused
                       with "it never started". Fails the run if either check fails.
  --pre-fix            run --stage-revoked against the UN-fixed console and assert the opposite
                       (chip still saying it is waiting, requests still arriving). This is that
                       assertion's positive control: without it a green run cannot tell a fixed
                       poller from one that never started. Requires --stage-revoked.
  --stage-refresh-error  extra pass per breakpoint/theme: make this page's GET /v1/tasks answer 500 (the
                       page's own fetch is wrapped; the hub is untouched), wait for the next poll to
                       show the "Couldn't refresh" line over the Tasks board, shoot it, then let the
                       endpoint answer again and fail the run unless the line clears.
  --stage-source-error  extra pass per breakpoint/theme: make Home's GET /v1/events answer 500 (the page's own fetch
                       is wrapped), wait for "Recent activity couldn't refresh" on the notice line, require the hidden
                       announcer (#refresh-announce) to say that same sentence, shoot Home, then let the endpoint answer
                       again and fail the run unless the line and the announcer clear.
  --stage-task-paging  seeds 45 more open tasks (a few about webhooks), then per breakpoint/theme shoots the Tasks
                       board's first page with its "Show more", the Open column after Show more read the next page
                       from the hub, and a search ("webhook") answered by the hub. Fails the run if the board does
                       not page or the search does not narrow it.
  --out DIR           output directory (default: console-shots beside the scratch: B:/ai-work/temp when present,
                       else OPENCADRE_SCRATCH or the system temp dir)
  --help               this message`);
}

// ---------------------------------------------------------------------------------------------
// A free local port: bind to port 0, read back what the OS assigned, close, reuse the number.
// Small race window between close() and the hub's own listen() -- acceptable for a local dev tool.
// ---------------------------------------------------------------------------------------------
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function waitForReady(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/push/config`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`hub never came up on ${baseUrl}: ${lastErr}`);
}

// ---------------------------------------------------------------------------------------------
// Boot the hub in this same process (a dynamic import so env vars set just above it are read at
// the moment src/index.ts's top-level code runs, not before). No child process, no build step.
// ---------------------------------------------------------------------------------------------
async function bootHub({ port, dbPath }) {
  process.env.PORT = String(port);
  process.env.OPENCADRE_DB_PATH = dbPath;
  // Lets createWorkspace() succeed for the owner person we mint below without an approved-waitlist
  // row. Also lets webhook/push endpoints target 127.0.0.1 (both otherwise require a real public
  // https target), and turns push on with a freshly generated, throwaway VAPID keypair.
  process.env.OPENCADRE_SIGNUP = "open";
  process.env.OPENCADRE_WEBHOOK_ALLOW_PRIVATE = "1";
  if (!process.env.OPENCADRE_VAPID_PUBLIC_KEY) {
    const { generateVapidKeys } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "web-push.js")).href);
    const keys = generateVapidKeys();
    process.env.OPENCADRE_VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.OPENCADRE_VAPID_PRIVATE_KEY = keys.privateKey;
  }
  await import(pathToFileURL(path.join(REPO_ROOT, "src", "index.js")).href);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return baseUrl;
}

// ---------------------------------------------------------------------------------------------
// Seeding. Mints the owner's person + session directly through src/accounts.ts (there is no REST
// route for that -- signing in for real needs a real OAuth/magic-link round trip), then does
// everything else purely over REST using that person's own session cookie: requireAgentAuth
// accepts a cookie session exactly like an agent bearer key (src/rest.ts, requireMemberSession),
// and an owner's member-agent role resolves to "operator", so the owner's cookie alone is enough
// for every org-level call below -- no separate agt_ key needed.
// ---------------------------------------------------------------------------------------------
async function mintOwner(orgName) {
  const { upsertPerson, createWorkspace, createSession } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "accounts.js")).href);
  const person = upsertPerson({
    id: `seed-owner-${randomBytes(6).toString("hex")}`,
    email: "owner@example.com",
    emailVerified: true,
    name: "Grace Byte",
    avatarUrl: null,
  });
  const { orgId } = createWorkspace(person, orgName);
  const { token } = createSession(person.id);
  return { person, orgId, cookie: token };
}

/** Puts a seeded workspace on a plan, so the seed's writes are allowed.
 *
 * The hub runs in its production trial mode here ("card", src/billing.ts trialMode): a new workspace has NO plan until
 * its owner starts the card-required trial in checkout, and until then every write is refused with a 402. A seeded
 * workspace stands for one whose owner has been through checkout, so it gets what a checkout's payment webhook gives
 * it (billing.ts assignPlan). The hub is NOT switched to cardless mode: --empty and --first-run must still show a new
 * customer exactly what production shows them, the "choose a plan" state included. A workspace already on a plan
 * (cardless mode set by the caller) is left alone. */
async function startPlanForSeed(orgId) {
  const { assignPlan, DEFAULT_PLAN, PENDING_PLAN } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "billing.js")).href);
  const { db } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "db.js")).href);
  const { plan } = db.prepare(`SELECT plan FROM organizations WHERE id = ?`).get(orgId);
  if (plan === PENDING_PLAN) assignPlan(orgId, DEFAULT_PLAN);
}

/** A signed-in person with NO workspace yet (`--first-run`). The self-serve first run only exists in
 *  this state: the hub mints the first agent key in the POST /v1/workspaces response and hands it
 *  straight to the browser, so seeding the workspace here -- as the default and --empty both do --
 *  would create it out from under the console's own form and that key would never be minted at all. */
async function mintPerson() {
  const { upsertPerson, createSession } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "accounts.js")).href);
  const person = upsertPerson({
    id: `seed-stranger-${randomBytes(6).toString("hex")}`,
    email: "stranger@example.com",
    emailVerified: true,
    name: "Sam Stranger",
    avatarUrl: null,
  });
  const { token } = createSession(person.id);
  return { person, cookie: token };
}

/** A second person in the SAME workspace, as an admin (`--as-admin`). Captures the console as a
 * non-owner member, which is the only way to see the surfaces where the RBAC split bites: an admin's
 * member agent still reports role:"operator" (accounts.ts agentRoleFor maps owner and admin alike),
 * so anything gating on me.role alone renders affordances the API answers with 403.
 * Joins through the real invite flow (owner invites by email, the admin accepts with their own
 * session) rather than reaching into the store, so it exercises the same path a person would. */
async function mintAdmin(baseUrl, ownerCookie, orgId) {
  const { upsertPerson, createSession } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "accounts.js")).href);
  const person = upsertPerson({
    id: `seed-admin-${randomBytes(6).toString("hex")}`,
    email: "admin@example.com",
    emailVerified: true,
    name: "Ada Admin",
    avatarUrl: null,
  });
  const { token } = createSession(person.id);
  const ownerCall = api(baseUrl, ownerCookie, orgId);
  const invite = await ownerCall("POST", `/v1/workspaces/${orgId}/invites`, { role: "admin", email: "admin@example.com" });
  const inviteToken = String(invite.url).split("invite=")[1];
  await api(baseUrl, token, orgId)("POST", `/v1/invites/${inviteToken}/accept`, {});
  return { person, cookie: token };
}

function api(baseUrl, cookie, orgId) {
  return async (method, urlPath, body) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `oc_session=${cookie}`,
        "x-opencadre-workspace": orgId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
    return json;
  };
}

// A device-credential call (session heartbeat, connect redeem): no cookie/org header, the device
// bearer token and the four X-OpenCadre-* session hints resolve everything server-side.
async function deviceCall(baseUrl, deviceCredential, hints, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deviceCredential}`,
      ...(hints
        ? {
            "x-opencadre-session": hints.toolSessionId,
            "x-opencadre-host-session": hints.hostSessionId,
            "x-opencadre-client": hints.client,
            "x-opencadre-project": hints.project,
          }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
  return json;
}

/** Only obviously fake secrets appear anywhere below -- zeros, "fake", or generated-but-throwaway
 * local material (VAPID/push keys), never anything that could be mistaken for a real credential. */
async function seedWorkspace(baseUrl, call, orgId) {
  // -- a second, non-owner agent (used as message/approval/task requester, and as the "removed" one) --
  const bot = await call("POST", "/v1/org/agents", { name: "Release-Bot" });
  const removedAgent = await call("POST", "/v1/org/agents", { name: "Retired-Bot" });
  await call("DELETE", `/v1/org/agents/${removedAgent.agentId}`);

  // -- 2 computers, Claude Code + Codex sessions, crossed over 2 projects --
  const dev1 = await call("POST", "/v1/org/devices", { name: "MacBook-Pro" });
  const dev2 = await call("POST", "/v1/org/devices", { name: "Linux-Workstation" });
  const red1 = await fetch(`${baseUrl}/v1/connect/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: dev1.code }),
  }).then((r) => r.json());
  const red2 = await fetch(`${baseUrl}/v1/connect/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: dev2.code }),
  }).then((r) => r.json());

  const projA = "github.com/acme/api";
  const projB = "github.com/acme/web";
  const sessions = [
    { cred: red1.deviceCredential, client: "claude-code", project: projA, tool: "tool-a1", host: "host-a1" },
    { cred: red1.deviceCredential, client: "codex", project: projB, tool: "tool-a2", host: "host-a2" },
    { cred: red2.deviceCredential, client: "claude-code", project: projB, tool: "tool-b1", host: "host-b1" },
    { cred: red2.deviceCredential, client: "codex", project: projA, tool: "tool-b2", host: "host-b2" },
  ];
  for (const s of sessions) {
    // First heartbeat records the project as "seen, not enabled"; enable it once, below, then the
    // rest of that project's sessions join normally.
    await deviceCall(baseUrl, s.cred, { toolSessionId: s.tool, hostSessionId: s.host, client: s.client, project: s.project }, "POST", "/v1/heartbeat").catch(() => {});
  }
  // listProjects keys a remote project by the raw X-OpenCadre-Project header value it was sent (no
  // "local:" prefix -- that prefix is only for a client with no git remote).
  await call("PUT", "/v1/org/projects", { projectKey: projA, name: "acme/api", enabled: true });
  await call("PUT", "/v1/org/projects", { projectKey: projB, name: "acme/web", enabled: true });
  for (const s of sessions) {
    await deviceCall(baseUrl, s.cred, { toolSessionId: s.tool, hostSessionId: s.host, client: s.client, project: s.project }, "POST", "/v1/heartbeat");
  }

  // -- tasks in each state (open / claimed / done) --
  const openTask = await call("POST", "/v1/tasks", { title: "Write the migration guide", description: "Cover the v13 schema change for self-hosters." });
  const claimedTask = await call("POST", "/v1/tasks", { title: "Investigate flaky connect-cli test" });
  await call("POST", `/v1/tasks/${claimedTask.task.id}/claim`, {});
  const doneTask = await call("POST", "/v1/tasks", { title: "Rotate the staging webhook secret" });
  await call("POST", `/v1/tasks/${doneTask.task.id}/claim`, {});
  await call("POST", `/v1/tasks/${doneTask.task.id}/complete`, { summary: "Rotated; old secret revoked." });
  void openTask;

  // -- messages: an unread one, and a question (awaiting reply) -- both from the bot, to the owner.
  // The owner's own member-agent is named after their person record (mintOwner uses "Grace Byte").
  const bearer = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bot.apiKey}` }, body: JSON.stringify(body),
  }).then((r) => r.json());
  await bearer("/v1/messages", { toAgent: "Grace Byte", body: "Deploy finished: main is now live on staging." });
  // Questions long-poll for a live answer; a short client-side abort keeps this seed step fast -- the
  // message row itself (kind "question", awaiting_reply = 1) is written before that wait begins.
  await Promise.race([
    bearer("/v1/questions", { toAgent: "Grace Byte", body: "Deploy touched the payments service -- OK to also roll it to prod?", timeoutSeconds: 1 }),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);

  // -- pending + decided approvals -- requested by the bot, decided by the owner (an agent can't
  // decide its own request).
  await bearer("/v1/approvals", { action: "rm -rf ./dist", risk: "high", category: "rm-rf" });
  const toApprove = await bearer("/v1/approvals", { action: "git push --force origin main", risk: "medium", category: "force-push" });
  await call("POST", `/v1/approvals/${toApprove.approval.id}/decide`, { decision: "approve", grantMinutes: 30 });
  const toDeny = await bearer("/v1/approvals", { action: "curl -X DELETE https://api.example.com/data", risk: "high", category: "custom" });
  await call("POST", `/v1/approvals/${toDeny.approval.id}/decide`, { decision: "deny" });

  // -- webhook (agent-scoped) --
  await call("POST", "/v1/webhook", { url: "http://127.0.0.1:9/fake-webhook-endpoint", authHeader: "Bearer fake-webhook-secret-000" });

  // -- phone push: a throwaway P-256 subscription for the owner --
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const b64url = (buf) => buf.toString("base64url");
  await call("POST", "/v1/push/devices", {
    endpoint: "http://127.0.0.1:9/fake-push-endpoint",
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) },
    deviceLabel: "Seed Phone",
  });

  // -- task and agent states the console calls out ------------------------------------------------------------------
  const { db } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "db.js")).href);
  const botCall = (method, p, body) => fetch(`${baseUrl}${p}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${bot.apiKey}` }, body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());
  // A replaced task (with a description, so its expanded card has something to show), made the oldest open card.
  const old = await call("POST", "/v1/tasks", { title: "Draft the pricing page copy", description: "Monthly plans only. Keep it under 200 words and link the FAQ." });
  await call("POST", `/v1/tasks/${old.task.id}/supersede`, { title: "Draft the pricing page copy, with annual plans" });
  db.prepare(`UPDATE tasks SET created_at = datetime('now', '-3 days') WHERE id = ?`).run(old.task.id);
  // A task nobody has touched for three weeks.
  const stale = await call("POST", "/v1/tasks", { title: "Audit the webhook retry policy" });
  db.prepare(`UPDATE tasks SET created_at = datetime('now', '-21 days'), updated_at = datetime('now', '-21 days') WHERE id = ?`).run(stale.task.id);
  // Claimed by another agent: the owner sees no Complete or Release on it.
  const theirs = await call("POST", "/v1/tasks", { title: "Update the self-hosting guide" });
  await botCall("POST", `/v1/tasks/${theirs.task.id}/claim`);
  // Done by another agent: the owner can Accept or Reject it (and cannot on the one the owner completed).
  const review = await call("POST", "/v1/tasks", { title: "Fix the flaky login test" });
  await botCall("POST", `/v1/tasks/${review.task.id}/claim`);
  await botCall("POST", `/v1/tasks/${review.task.id}/complete`, { summary: "Retried the socket open; 50 green runs in a row." });
  // Agents without a linked computer: one working, one idle (online, no status for 45 minutes), one offline.
  const cursorCloud = await call("POST", "/v1/org/agents", { name: "Cursor-Cloud" });
  const windsurf = await call("POST", "/v1/org/agents", { name: "Windsurf-Lane" });
  const soon = `datetime('now', '+20 minutes')`; // stays online for the whole run (the hub's window is 2 minutes)
  db.prepare(`UPDATE agents SET last_heartbeat_at = ${soon}, current_task = 'Tagging the v0.9 release notes', phase = 'working', status_updated_at = datetime('now') WHERE id = ?`).run(bot.agentId);
  db.prepare(`UPDATE agents SET last_heartbeat_at = ${soon}, status_updated_at = datetime('now', '-45 minutes') WHERE id = ?`).run(cursorCloud.agentId);
  db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-3 days') WHERE id = ?`).run(windsurf.agentId);
  // Sessions: all live; one has not checked in for 12 minutes (an idle chat), the rest stay online for the run.
  const sessionIds = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND kind = 'session' AND ended_at IS NULL ORDER BY created_at`).pluck().all(orgId);
  for (const id of sessionIds) db.prepare(`UPDATE agents SET last_heartbeat_at = ${soon} WHERE id = ?`).run(id);
  if (sessionIds.length) db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-12 minutes') WHERE id = ?`).run(sessionIds.at(-1));

  return { bot, dev1, dev2 };
}

// Injected into every document before any page script runs. It attributes each device-list request to
// the interval callback that issued it, and exposes the console's two device pollers as a queryable
// list.
//
// This exists because "the poller stopped" CANNOT be read off the network. The console's own refresh
// heartbeat GETs /v1/org/devices on its own schedule (~4s; measured in this harness's own hub log),
// so a leaked 3-second poller and a healthy page produce a similar trickle of requests to that path.
// The first version of --stage-revoked asserted on a raw request count and called a working fix a
// failure. A live-interval count is no better: `showComputerOutput` also owns the 1-second
// "Expires in m:ss" countdown, so "intervals created by that function" is not "poller" either.
//
// What separates them is the one thing that is true of the poller and of nothing else: it is an
// interval, AND its callback fetches the device list. So wrap both, hold the callback's own promise
// open as "in flight" (an async callback returns before its `await fetch` lands, which is why this
// tracks the promise rather than just the synchronous call), and charge each device-list GET to every
// interval in flight when it goes out. `schedulePoll` drives the heartbeat through setTimeout, so its
// requests are charged to no interval and drop out on their own -- no period, no line number, and no
// function name is guessed at.
const INTERVAL_TRACKER_SOURCE = `(() => {
  const POLLED_PATH = "/v1/org/devices";
  // The device pollers, by the function that creates them: showComputerOutput()'s Connect-tab card,
  // and watchFirstRunDevice()'s self-serve card. Matching is only a first pass -- deviceHits, not this
  // name, is what the caller asserts on. WHICH one it is matters when both cards are on the page at
  // once (--first-run): the first-run card's poller is legitimately still asking about its own device
  // while the Connect card's is being removed, so a caller that just asks "is any poller alive" gets
  // the wrong answer. The topmost matching frame names the surface; the countdown timer shares
  // showComputerOutput's frame but never fetches, so deviceHits still separates them.
  const POLLER_FRAME = /showComputerOutput|watchFirstRunDevice/;
  const intervals = new Map();  // real id -> record
  const inFlight = new Set();   // records whose callback has not settled yet
  // Lifecycle of every interval this page creates and clears, for diagnosing a failed assertion.
  const events = [];
  // Monotonic, and deliberately NOT derived from the live set: clearing an interval removes its record
  // and would take its history with it, so "total so far" would fall when the poller stopped -- which
  // is precisely the moment the number is being read.
  let deviceFetches = 0;
  // The same count, split by the surface that issued it, and monotonic for the same reason -- a
  // caller watching one card reads it after that card's poller has already been cleared.
  const surfaceHits = Object.create(null);
  let uncharged = 0;
  const charges = [];

  const realSetInterval = window.setInterval;
  const realClearInterval = window.clearInterval;
  const realFetch = window.fetch;

  window.setInterval = function (fn, ms, ...rest) {
    const record = { ms, stack: String(new Error("interval").stack || ""), deviceHits: 0 };
    const named = POLLER_FRAME.exec(record.stack);
    record.surface = named ? named[0] : null;
    record.isPollerFrame = Boolean(record.surface);
    const wrapped = function (...args) {
      inFlight.add(record);
      const settle = () => inFlight.delete(record);
      let out;
      try {
        out = fn.apply(this, args);
      } catch (err) {
        settle();
        throw err;
      }
      if (out && typeof out.then === "function") return out.then((v) => { settle(); return v; }, (e) => { settle(); throw e; });
      settle();
      return out;
    };
    const realId = realSetInterval.call(this, wrapped, ms, ...rest);
    record.id = realId;
    intervals.set(realId, record);
    events.push({ at: Date.now(), kind: "set", id: realId, ms, pollerFrame: record.isPollerFrame, frame: (record.stack.split(String.fromCharCode(10))[2] || "").trim() });
    return realId;
  };

  window.clearInterval = function (id) {
    if (intervals.has(id)) events.push({ at: Date.now(), kind: "clear", id, ms: intervals.get(id).ms, pollerFrame: intervals.get(id).isPollerFrame });
    intervals.delete(id);
    return realClearInterval.call(this, id);
  };

  window.fetch = function (input, init) {
    try {
      const raw = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const path = raw.indexOf("http") === 0 ? new URL(raw).pathname : raw.split("?")[0].split("#")[0];
      if (method === "GET" && path === POLLED_PATH) {
        // Only requests issued from inside an interval callback count. A request that arrives with
        // nothing in flight is the setTimeout-driven refresh heartbeat, which GETs this same path and
        // must NOT be charged -- counting it is the confound this whole instrument exists to remove.
        if (inFlight.size) {
          deviceFetches++;
          for (const r of inFlight) {
            r.deviceHits++;
            const key = r.surface || "other";
            surfaceHits[key] = (surfaceHits[key] || 0) + 1;
          }
        } else {
          uncharged++;
        }
        // Diagnostic only (--stage-revoked prints it when an assertion fails): which interval callbacks
        // were mid-flight when this request went out. A request charged to an interval whose callback
        // merely CALLS something that fetches -- e.g. the poller's own clearInterval-then-refresh tail
        // -- lands here, and is the reason a raw charge count is not by itself the poller's rate.
        charges.push({ at: Date.now(), from: [...inFlight].map((r) => ({ ms: r.ms, pollerFrame: r.isPollerFrame, at: (r.stack.split(String.fromCharCode(10))[2] || "").trim() })) });
      }
    } catch { /* instrumentation must never break the page it is measuring */ }
    return realFetch.apply(this, arguments);
  };

  // Live intervals whose creation stack names a device poller. The countdown timer shares that frame,
  // so a caller that wants the poller specifically asks for deviceHits > 0.
  window.__ocDevicePollers = () => [...intervals.values()]
    .filter((r) => r.isPollerFrame)
    .map((r) => ({ id: r.id, ms: r.ms, deviceHits: r.deviceHits, surface: r.surface }));
  // Every GET of the device list issued from inside an interval callback, ever -- survives the
  // clearInterval that ends the poller. The refresh heartbeat is a setTimeout, so it contributes
  // nothing here even though it GETs the same path.
  window.__ocDeviceFetchesFromIntervals = () => deviceFetches;
  // Per surface, so a caller reading one card's poller does not read the other card's traffic. Also
  // monotonic: it is read after the poller it describes has been cleared.
  window.__ocDeviceFetchesBySurface = () => Object.assign({}, surfaceHits);
  window.__ocDeviceFetchesUncharged = () => uncharged;
  window.__ocDeviceFetchCharges = () => charges;
  window.__ocIntervalEvents = () => events;
})();`;

// Replaces credentials in the live DOM before a page is photographed.
//
// A screenshot is a FILE, and the fleet rule is that no key (agt_/org_/dev_, even partially) goes into
// a file, a PR or a commit. The self-serve first-run card prints the workspace's first agent key in
// full, and that card is on the Overview panel as well as the staged one, so without this the harness
// writes a key into a PNG that then gets committed. The key is minted by the throwaway hub this
// process boots from src, so it is dead -- which is not the point. The rule is about the artifact; a
// scanner cannot tell a dead key from a live one; and "it was only a test key" is the sentence that
// eventually ships a real one.
//
// The ocd_/oc_ connect codes are deliberately NOT redacted: they are the SUBJECT of the shot (the
// command is the thing being shown), and their provenance is documented in the PR body. Redacting
// them would destroy the evidence the screenshot exists to carry.
//
// Replaced, never hidden: hiding the node would collapse the card and photograph a page other than
// the one the shot claims to show. The prefix goes with the match, so the re-scan cannot match its
// own output. `remaining` is what makes the miss loud -- see the caller.
const REDACT_SOURCE = `(() => {
  const PATTERN = /\\b(agt_|org_|dev_)[A-Za-z0-9_-]+/g;
  const scrub = (s) => s.replace(PATTERN, "(redacted)");
  const hit = (s) => Boolean(s && s.match(PATTERN));
  let cells = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue;   // leaves only: on a branch, textContent covers descendants too
    const text = el.textContent || "";
    if (!hit(text)) continue;
    el.textContent = scrub(text);
    cells++;
  }
  // A key can be a form control's value rather than text, and that is not textContent.
  for (const el of document.querySelectorAll("input, textarea")) {
    const value = el.value || "";
    if (!hit(value)) continue;
    el.value = scrub(value);
    cells++;
  }
  // innerText, not textContent: the claim being checked is about the pixels this run writes, and a
  // hidden node is not photographed. Checking every node's text would also flag hidden prose.
  const remaining = (document.body.innerText.match(PATTERN) || []).length;
  return JSON.stringify({ cells, remaining });
})();`;

// ---------------------------------------------------------------------------------------------
// Minimal CDP driver: headless Edge, one page, driven over its own DevTools WebSocket. No
// puppeteer/playwright (unsupported on Windows ARM64 in this repo) -- just `ws`, already a dep.
// ---------------------------------------------------------------------------------------------
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

async function findEdge() {
  const { existsSync } = await import("node:fs");
  const found = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error(`Microsoft Edge not found in any of: ${EDGE_CANDIDATES.join(", ")}`);
  return found;
}

async function launchEdge({ cdpPort, userDataDir }) {
  const { spawn } = await import("node:child_process");
  const edge = await findEdge();
  const proc = spawn(edge, [
    "--headless=new", "--disable-gpu",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore", detached: true });
  proc.unref();
  const deadline = Date.now() + 10_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) return proc;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Edge DevTools never came up on ${cdpPort}: ${lastErr}`);
}

async function openCdpPage(cdpPort) {
  const { default: WebSocket } = await import("ws");
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" });
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  function send(method, params = {}) {
    const thisId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }
  await send("Page.enable");
  await send("Network.enable");
  // Registered before the first navigation below, so it is in place ahead of app.js on every document
  // this page ever loads (see INTERVAL_TRACKER_SOURCE). about:blank is already loaded, which is fine:
  // nothing has been measured on it.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INTERVAL_TRACKER_SOURCE });
  // Every request the page made, in order. Reported alongside the poller set as a plain traffic number
  // -- useful for a human reading the log, but NOT what --stage-revoked asserts on, because the
  // console's own ~4s refresh heartbeat GETs the same path (see INTERVAL_TRACKER_SOURCE).
  const requests = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "Network.requestWillBeSent") {
      requests.push({ method: msg.params.request.method, url: msg.params.request.url });
    }
  });
  return {
    /** How many requests this page has made to one path, by method. */
    countRequests(method, pathname) {
      return requests.filter((r) => r.method === method && new URL(r.url).pathname === pathname).length;
    },
    /** The device pollers this page still has running, as live intervals that actually fetched the
     *  device list, each tagged with the function that created it. This -- not countRequests -- is what
     *  --stage-revoked asserts on: it excludes the refresh heartbeat (a setTimeout, so charged to no
     *  interval) and the "Expires in" countdown (an interval that never fetches). See
     *  INTERVAL_TRACKER_SOURCE. */
    async devicePollers() {
      return (await this.evaluate("window.__ocDevicePollers ? window.__ocDevicePollers() : null")) ?? [];
    },
    /** Device-list GETs issued from inside an interval callback, cumulatively -- monotonic, so it does
     *  not fall when the poller it is counting is the one that gets cleared. */
    async deviceFetchesFromIntervals() {
      return (await this.evaluate("window.__ocDeviceFetchesFromIntervals ? window.__ocDeviceFetchesFromIntervals() : 0")) ?? 0;
    },
    /** The same cumulative count, split by the creating function -- so a caller reading the Connect
     *  card does not read the first-run card's traffic while both are polling. */
    async deviceFetchesBySurface() {
      return (await this.evaluate("window.__ocDeviceFetchesBySurface ? window.__ocDeviceFetchesBySurface() : null")) ?? {};
    },
    /** Device-list GETs that arrived with no interval callback in flight -- the refresh heartbeat.
     *  Reported alongside the charged count precisely because it is what a raw request count would
     *  have been measuring instead. */
    async deviceFetchesUncharged() {
      return (await this.evaluate("window.__ocDeviceFetchesUncharged ? window.__ocDeviceFetchesUncharged() : 0")) ?? 0;
    },
    /** Per-fetch attribution, for diagnosing a failed assertion. */
    async deviceFetchCharges() {
      return (await this.evaluate("window.__ocDeviceFetchCharges ? window.__ocDeviceFetchCharges() : null")) ?? [];
    },
    /** Every setInterval/clearInterval this page performed, for diagnosing a failed assertion. */
    async intervalEvents() {
      return (await this.evaluate("window.__ocIntervalEvents ? window.__ocIntervalEvents() : null")) ?? [];
    },
    async setCookie({ name, value, url }) {
      await send("Network.setCookie", { name, value, url, path: "/", sameSite: "Lax" });
    },
    async setColorScheme(scheme) {
      // "forced" is the light theme under forced colours (Windows high contrast), for the forced-colours check.
      const features = scheme === "forced"
        ? [{ name: "prefers-color-scheme", value: "light" }, { name: "forced-colors", value: "active" }]
        : [{ name: "prefers-color-scheme", value: scheme }, { name: "forced-colors", value: "none" }];
      await send("Emulation.setEmulatedMedia", { features });
    },
    async setViewport(width, height, { mobile = false, deviceScaleFactor = mobile ? 2 : 1 } = {}) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
    },
    async navigate(url) {
      // A same-document navigation (only the #hash changes, e.g. between two console tabs) fires
      // Page.navigatedWithinDocument, never Page.loadEventFired -- waiting only for the latter hangs
      // forever from the second page shot onward. Race both; either means the navigation landed.
      const landed = new Promise((resolve) => {
        function onEvt(raw) {
          const msg = JSON.parse(raw.toString());
          if (msg.method === "Page.loadEventFired" || msg.method === "Page.navigatedWithinDocument") {
            ws.off("message", onEvt);
            resolve();
          }
        }
        ws.on("message", onEvt);
      });
      await send("Page.navigate", { url });
      await landed;
      await new Promise((r) => setTimeout(r, 350)); // let the SPA's own JS settle
      await this.waitForPageRendered();
    },
    /** Wait until the console has actually rendered its navigation.
     *
     * The load event is NOT the app being ready: app.js boots asynchronously (it resolves
     * /v1/auth/me, picks a workspace, maybe creates one, then /v1/me, then renders), and every
     * top-level page starts `hidden`, so mid-boot the document is genuinely blank. Measured on
     * origin/main: nothing visible at ~270ms, the full sidebar at ~1590ms. The fixed 350ms settle
     * above used to be enough and stopped being so as boot grew; without this, selectPage() clicks a
     * nav item that has no client rects yet and throws "found no visible element -- update PAGES",
     * which reads like a stale-selector problem and is not one. Poll for a rendered page instead of
     * trusting a duration.
     *
     * It must NOT require the sidebar: a visitor with no workspace lands on the picker (and a signed
     * -out one on sign-in), both legitimate ready states that have no [data-tab] at all. Asking for
     * the nav specifically made this throw for the self-serve first run -- a false "app.js may have
     * failed to boot" for a page that had booted perfectly. */
    async waitForPageRendered(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ready = await this.evaluate(
          `['console', 'workspace-picker', 'invite-accept', 'signin'].some((id) => {
             const el = document.getElementById(id);
             return Boolean(el) && !el.hidden && el.getClientRects().length > 0;
           })`,
        );
        if (ready) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no console page rendered within ${timeoutMs}ms -- app.js may have failed to boot (check the page console)`);
    },
    /** Wait for the workspace picker -- the screen a signed-in person with NO workspace lands on.
     *
     *  This is the whole reason --first-run mints its own person, so make the wait explicit and loud
     *  rather than letting the screenshot below capture the sign-in page and call it the picker. A
     *  person who already has a workspace skips the picker and goes straight to the console, and a
     *  session that failed to apply lands on sign-in: both would otherwise produce a plausible-looking
     *  file with the wrong screen in it. */
    async waitForPicker(timeoutMs = 15_000) {
      const expression = `(() => {
        const el = document.getElementById("workspace-picker");
        return Boolean(el) && !el.hidden && el.getClientRects().length > 0;
      })()`;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await this.evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 150));
      }
      const seen = await this.evaluate(`(() => {
        const shown = [...document.querySelectorAll("section[id], .page")].filter((el) => el.getClientRects().length > 0).map((el) => el.id || el.className);
        return JSON.stringify(shown);
      })()`);
      throw new Error(`timed out after ${timeoutMs}ms waiting for the workspace picker (--first-run needs a person with no workspace); visible sections were ${seen}`);
    },
    /** Poll an in-page expression until it is truthy. */
    async waitFor(expression, description, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await this.evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    },
    /** Submits the console's real "create workspace" form and waits for the self-serve first-run card.
     *
     *  requestSubmit() (not a bare submit event, and not .click() on the button) is what a person's
     *  Enter key does, so this exercises the same handler -- including its validation -- rather than
     *  calling the app's own code from the outside. A refusal from the form is reported as itself: it
     *  is the honest failure (e.g. waitlist mode), and silently timing out on it would send the next
     *  reader hunting for a rendering bug that isn't there. */
    async createWorkspaceThroughTheConsole(orgName, timeoutMs = 20_000) {
      await this.evaluate(`(() => {
        document.getElementById("workspace-create-name").value = ${JSON.stringify(orgName)};
        document.getElementById("workspace-create-form").requestSubmit();
        return true;
      })()`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await this.evaluate(`(() => {
          const card = document.getElementById("first-run-card");
          const err = document.getElementById("workspace-create-error");
          return {
            card: Boolean(card) && !card.hidden && card.getClientRects().length > 0,
            error: err && !err.hidden ? err.textContent : null,
          };
        })()`);
        if (state?.card) return;
        if (state?.error) throw new Error(`the console's create form refused: ${state.error}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`the self-serve first-run card never rendered within ${timeoutMs}ms -- is the hub running with OPENCADRE_SIGNUP=open? (src/accounts.ts signupMode)`);
    },
    /** Submits the Connect tab's real "Add a computer" form, the way a person's Enter key does.
     *
     *  Same reasoning as createWorkspaceThroughTheConsole above: requestSubmit() runs the console's
     *  own handler and validation, so the command card on screen afterwards is the one a user gets,
     *  not a fixture this script painted. Returns once the card with the command is up (the state it
     *  waits in, which is what --stage-revoked then interrupts). */
    async addComputerThroughTheConsole(name, timeoutMs = 15_000) {
      await this.evaluate(`(() => {
        document.getElementById("computer-name").value = ${JSON.stringify(name)};
        document.getElementById("add-computer-form").requestSubmit();
        return true;
      })()`);
      await this.waitFor(
        `(() => { const el = document.getElementById("computer-output"); return Boolean(el) && !el.hidden && el.getClientRects().length > 0; })()`,
        "the add-a-computer command card",
        timeoutMs,
      );
    },
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    // Switches the console's active section by clicking through PAGES' own `steps` (config-driven,
    // see PAGES' comment) -- never a second Page.navigate to a different #hash: a same-document URL
    // change alone never reaches the SPA (there's no hashchange listener), so the visible panel
    // would silently never update. A real click, or a short sequence of them (open a drawer/submenu,
    // then click the item inside it), always does. Only the interaction model itself -- click, not
    // e.g. hover-to-open -- is hardcoded here; which selectors and how many is entirely PAGES' call.
    async selectPage(page) {
      // Stage 1 (and likely later stages) keep several copies of the same [data-tab] button alive in
      // the DOM at once -- a sidebar item, a bottom-bar item, a drawer item -- switching which one is
      // actually visible by breakpoint via CSS, not by adding/removing the others. So each step here
      // clicks whichever matching element is currently VISIBLE (getClientRects().length > 0, robust to
      // display:none, the `hidden` attribute, and position:fixed panels where offsetParent alone would
      // be unreliable), and silently skips a step with no visible match at all -- that's not a missing
      // element, it's a step that doesn't apply at the current breakpoint (e.g. clicking a "More" button
      // that only exists on the mobile bottom bar, while shooting a desktop width).
      // An early step (e.g. #more-btn) having no visible match at this breakpoint is expected and
      // fine to skip -- but the LAST step is the actual destination, and it must always find a
      // visible match: skipping it silently would leave the page on the wrong section with no
      // error at all (a real screenshot showing stale content, mistaken for the requested one).
      // Settings swaps the sidebar nav for its own section list; its back button (skipped when not visible) restores the
      // nav. It goes before EVERY page's steps, explicit ones included (f46c: Timeline's own steps missed it).
      const steps = ["#settings-back", ...(page.steps ?? [`[data-tab="${page.id}"]`])];
      for (let i = 0; i < steps.length; i++) {
        const selector = steps[i];
        const clicked = await this.evaluate(`(() => {
          const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
          const visible = els.find((el) => el.getClientRects().length > 0);
          if (!visible) return false;
          visible.click();
          return true;
        })()`);
        const isLastStep = i === steps.length - 1;
        if (!clicked && isLastStep) {
          throw new Error(`the destination step ${JSON.stringify(selector)} (page "${page.id}") found no visible element -- update PAGES in this script to match the current nav`);
        }
        if (clicked) await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 100)); // let the final panel's own render settle
      await this.waitForPanelRendered();
    },
    /** Wait until the panel has stopped showing skeletons.
     *
     * paintSkeleton() draws placeholder strips during the console's FIRST refresh only, and clears
     * them when that pass lands -- so a lingering .skeleton means the data has not arrived yet and the
     * screenshot would capture placeholders instead of the page. The fixed settles above assume the
     * first refresh resolves within a few hundred ms, which holds only on an idle box: measured on
     * origin/main under load, both the owner's and an admin's Fleet panel were still skeletons at
     * capture time. Poll for the real content instead of guessing a duration, and do not fail the run
     * if it never clears -- a skeleton is still a truthful capture of a slow hub, just a less useful
     * one, so warn and shoot anyway rather than losing the whole pass. */
    async waitForPanelRendered(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pending = await this.evaluate(`document.querySelectorAll('.skeleton').length`);
        if (!pending) return;
        await new Promise((r) => setTimeout(r, 150));
      }
      console.warn(`      [warn] a panel still showed skeletons after ${timeoutMs}ms -- capturing it as-is`);
    },
    /** Warn when the page is wider than the viewport it was captured at.
     *
     * A capture that overflows horizontally is not just ugly, it is the wrong layout: the browser
     * widens the LAYOUT viewport (innerWidth grows past the emulated width), and every
     * `@media (max-width: ...)` rule then fails to match -- so the screenshot shows the desktop
     * layout inside a phone-width image. That is exactly how a single unbreakable string (a connect
     * command in a nowrap code box whose flex item kept the default `min-width: auto`) hid the
     * mobile layout on the Overview panel at 375px. Warn rather than fail: this harness is shared
     * and a page with legitimately wide content should still produce its shots. */
    async warnIfOverflowing(label) {
      const m = await this.evaluate(
        `JSON.stringify({ iw: innerWidth, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`,
      );
      const { iw, sw, cw } = JSON.parse(m);
      // Judge on scrollWidth vs clientWidth only: innerWidth is legitimately wider than the visual
      // viewport by the width of a classic scrollbar (15px at 1440), which is not an overflow.
      if (sw > cw + 1) {
        console.warn(
          `      [warn] ${label}: page overflows horizontally -- scrollWidth ${sw} vs clientWidth ${cw} ` +
          `(layout viewport innerWidth ${iw}). The browser widened the layout viewport to fit the ` +
          `overflowing element, so every @media (max-width: ...) rule is being evaluated against that ` +
          `wider width and this shot is NOT the layout it claims to be. Find the element that will not ` +
          `shrink -- a flex/grid item's default min-width is its min-content size -- and give it min-width: 0.`,
        );
      }
    },
    /** Run REDACT_SOURCE over the live page and refuse to continue if anything key-shaped survived.
     *
     * The refusal is the load-bearing half. A redactor that quietly misses is worse than none: it
     * launders the key into an artifact that a reviewer, seeing the step in the source, now has a
     * reason to trust. So the source re-scans what it just changed and reports the count, and a
     * non-zero count throws -- the run dies rather than writes a PNG carrying a credential. */
    async redactCredentials() {
      const result = JSON.parse(await this.evaluate(REDACT_SOURCE));
      if (result.remaining > 0) {
        throw new Error(
          `redactCredentials left ${result.remaining} key-shaped string(s) visible in the page -- ` +
          `refusing to write a screenshot that would carry a credential into a commit. The matcher ` +
          `above missed them (a key in an attribute, a canvas, or a shadow root is not textContent), ` +
          `so widen it before photographing anything.`,
        );
      }
      return result.cells;
    },
    async screenshot(filePath) {
      const redacted = await this.redactCredentials();
      if (redacted > 0) console.log(`      [redact] removed ${redacted} credential cell(s) before capture`);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(filePath, Buffer.from(data, "base64"));
    },
    async close() { try { await send("Page.close"); } catch { /* ignore */ } ws.close(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Terminal-device staging (--stage-revoked)
//
// A device the workspace REMOVED (`revoked`) is terminal at the hub, shows as "Removed" in the
// console's own Fleet list, and -- in the console as it shipped -- was matched by NEITHER of the two
// pollers watching a fresh command, so both kept asking /v1/org/devices every 3 seconds for the life
// of the page load. The state is worth a screenshot because that is the only user-visible symptom
// (the card sits there saying "Waiting for computer to connect…" about a computer that is gone), and
// it cannot be reached by clicking alone: the card being watched is on one panel and the Remove
// button for that computer is on another, so this stages the removal through the hub route the
// console's own Remove button calls (DELETE /v1/org/devices/:id -- removeComputer in public/app/app.js).
//
// The screenshot is the point of the run, but it is NOT the evidence. The same wait asserts the claim
// a screenshot cannot make: that the poller has STOPPED. Not "the chip says removed" -- a wrong fix
// gets the words right and leaks a request every 3 seconds anyway -- and not a request count either,
// because the console's own ~4s refresh heartbeat GETs the same path (see INTERVAL_TRACKER_SOURCE).
// What is asserted is the poller itself: a live interval that fetched the device list. `expect: "bug"`
// (--pre-fix) runs the identical staging against the un-fixed console and asserts the opposite, and
// the fixed arm carries its own positive control by requiring the poller to be RUNNING first --
// without either, a green run cannot distinguish "the poller stopped" from "it never started".
// ---------------------------------------------------------------------------------------------
// Which poller belongs to which surface, by the function that creates it. Both cards can be on the
// page at once (--first-run), and both poll /v1/org/devices, so "some poller is still alive" is not
// the claim being tested -- removing the Connect card's computer must stop the Connect card's poller
// and nothing else, while the first-run card's is entitled to keep asking about its own device.
const SURFACE_FRAME = { connect: "showComputerOutput", "first-run": "watchFirstRunDevice" };

/** --stage-refresh-error: the console's own GET /v1/tasks answers 500 (only this page's fetch is wrapped, the hub is
 *  untouched), so its next 4 s poll fails. Waits for the "Couldn't refresh" line (showRefreshFailure in
 *  public/app/app.js), shoots it over the Tasks board the console kept, then lets the endpoint answer again and requires
 *  the line to clear on a later poll: a line that never clears fails the run rather than leaving a stale page behind. */
async function stageRefreshError({ cdpPage, outDir, file }) {
  await cdpPage.selectPage(PAGES.find((p) => p.id === "tasks"));
  await cdpPage.evaluate(`(() => {
    if (!window.__ocRealFetch) window.__ocRealFetch = window.fetch;
    window.fetch = (input, init) => String(input).split("?")[0] === "/v1/tasks" && (init?.method ?? "GET") === "GET"
      ? Promise.resolve(new Response(JSON.stringify({ error: "staged failure" }), { status: 500, headers: { "content-type": "application/json" } }))
      : window.__ocRealFetch(input, init);
    return true;
  })()`);
  const lineUp = `(() => { const el = document.getElementById("refresh-notice"); return Boolean(el) && el.textContent.trim().length > 0 && el.getClientRects().length > 0; })()`;
  await cdpPage.waitFor(lineUp, `the "Couldn't refresh" line after a failed poll`);
  const notice = await cdpPage.evaluate(`document.getElementById("refresh-notice").textContent`);
  await cdpPage.warnIfOverflowing(file);
  await cdpPage.screenshot(path.join(outDir, file));
  await cdpPage.evaluate(`(() => { window.fetch = window.__ocRealFetch; return true; })()`);
  await cdpPage.waitFor(`!${lineUp}`, `the "Couldn't refresh" line to clear after a good poll`);
  return { notice };
}

/** --stage-source-error: an optional Home source fails while every required read succeeds (phase 2 item A). The line
 *  names its card and the time of the data it still shows at once; the announcer says the same sentence once, when the
 *  refresh that opened it has settled (one polite update per refresh), so it is waited for separately. */
async function stageSourceError({ cdpPage, outDir, file }) {
  await cdpPage.selectPage(PAGES.find((p) => p.id === "overview"));
  await cdpPage.evaluate(`(() => {
    if (!window.__ocRealFetch) window.__ocRealFetch = window.fetch;
    window.fetch = (input, init) => String(input).split("?")[0] === "/v1/events" && (init?.method ?? "GET") === "GET"
      ? Promise.resolve(new Response(JSON.stringify({ error: "staged failure" }), { status: 500, headers: { "content-type": "application/json" } }))
      : window.__ocRealFetch(input, init);
    return true;
  })()`);
  const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
  await cdpPage.waitFor(`${text("refresh-notice")}.startsWith("Recent activity couldn't refresh") && document.getElementById("refresh-notice").getClientRects().length > 0`, "the Recent activity line after a failed events read");
  await cdpPage.waitFor(`${text("refresh-announce")} !== ""`, "the announcer once the failing refresh settled");
  const notice = await cdpPage.evaluate(text("refresh-notice"));
  const announced = await cdpPage.evaluate(text("refresh-announce"));
  if (announced !== notice) throw new Error(`--stage-source-error: the announcer said ${JSON.stringify(announced)}, not the line ${JSON.stringify(notice)}`);
  await cdpPage.evaluate(`(() => { window.scrollTo(0, 0); return true; })()`);
  await cdpPage.warnIfOverflowing(file);
  await cdpPage.screenshot(path.join(outDir, file));
  await cdpPage.evaluate(`(() => { window.fetch = window.__ocRealFetch; return true; })()`);
  await cdpPage.waitFor(`${text("refresh-notice")} === "" && ${text("refresh-announce")} === ""`, "the line and the announcer to clear after a good events read");
  return { notice };
}

/** --stage-task-paging's seed: 45 more open tasks, so the Open column has pages to show (the board reads 20 at a time),
 *  every ninth about webhooks with a description, so a search has something to find in titles and descriptions. */
async function seedManyTasks(call) {
  for (let i = 1; i <= 45; i++) {
    const webhook = i % 9 === 0;
    await call("POST", "/v1/tasks", webhook
      ? { title: `Harden webhook delivery, part ${i / 9}`, description: "Retry with backoff and sign every payload." }
      : { title: `Triage issue #${1200 + i}`, ...(i % 4 === 0 ? { description: "Reproduce, label and link the failing test." } : {}) });
  }
}

/** --stage-task-paging: the board as tasks tranche 2 made it. Shoots (1) the first page, with the Open column's "Show
 *  more" in view; (2) the Open column after Show more asked the hub for the next page; (3) a search answered by the hub,
 *  with its "N of M tasks" line. Each state is waited for and checked, so a board that does not page or a search that
 *  does not narrow fails the run instead of producing a plausible picture. Leaves the search empty again. */
async function stageTaskPaging({ cdpPage, outDir, suffix }) {
  await cdpPage.selectPage(PAGES.find((p) => p.id === "tasks"));
  const setSearch = (value) => cdpPage.evaluate(`(() => { const s = document.getElementById("task-search"); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("input")); return true; })()`);
  await setSearch("");
  const openCards = `document.querySelectorAll("#tasks .column:first-child .task").length`;
  const more = `document.querySelector("#tasks .column:first-child .task-more")`;
  await cdpPage.waitFor(`${openCards} === 20 && Boolean(${more})`, "the Open column's first page of 20, with Show more");
  const button = await cdpPage.evaluate(`${more}.textContent`);
  await cdpPage.evaluate(`(() => { ${more}.scrollIntoView({ block: "center" }); return true; })()`);
  await cdpPage.warnIfOverflowing(`tasks-show-more ${suffix}`);
  await cdpPage.screenshot(path.join(outDir, `tasks-show-more--${suffix}.png`));
  await cdpPage.evaluate(`(() => { ${more}.click(); return true; })()`);
  await cdpPage.waitFor(`${openCards} >= 40`, "the Open column's second page after Show more");
  const afterMore = await cdpPage.evaluate(openCards);
  await cdpPage.evaluate(`(() => { const cards = document.querySelectorAll("#tasks .column:first-child .task"); cards[cards.length - 1].scrollIntoView({ block: "center" }); return true; })()`);
  await cdpPage.screenshot(path.join(outDir, `tasks-more-loaded--${suffix}.png`));
  await setSearch("webhook");
  const countLine = `document.getElementById("task-toolbar-count").textContent`;
  await cdpPage.waitFor(`/^[0-9]+ of [0-9]+ tasks$/.test(${countLine}) && ${openCards} > 0 && ${openCards} < 20`, "the hub's answer to the search");
  const count = await cdpPage.evaluate(countLine);
  await cdpPage.evaluate(`(() => { document.getElementById("task-toolbar").scrollIntoView({ block: "start" }); window.scrollBy(0, -80); return true; })()`);
  await cdpPage.screenshot(path.join(outDir, `tasks-search--${suffix}.png`));
  await setSearch("");
  await cdpPage.waitFor(`${countLine} === ""`, "the search to clear");
  return { button, afterMore, count };
}

async function stageRemovedComputer({ cdpPage, call, surface, name, expect, outDir, file }) {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // The chip each surface writes its own words into: the Connect tab's card, or the self-serve card.
  const chipId = surface === "first-run" ? "first-run-status" : "computer-status-chip";
  const frame = SURFACE_FRAME[surface];
  const describe = (pollers) => pollers.length
    ? pollers.map((p) => `interval#${p.id} @${p.ms}ms, ${p.deviceHits} device fetch(es)`).join("; ")
    : "none";
  // Live intervals that have actually asked for the device list, belonging to THIS surface. A live
  // interval that never fetched is the "Expires in" countdown, which shares showComputerOutput's
  // creation frame; an interval created by the other card's function belongs to the other card.
  const polling = async () => (await cdpPage.devicePollers()).filter((p) => p.deviceHits > 0 && p.surface === frame);
  const hits = async () => (await cdpPage.deviceFetchesBySurface())[frame] ?? 0;

  const before = cdpPage.countRequests("GET", "/v1/org/devices");

  // Every accessor below degrades to an empty/zero default when the injected tracker is missing, and
  // an instrument that silently reports "nothing happened" is indistinguishable from a fixed console
  // -- which is the exact defect this harness exists to catch. So refuse to run without it. (It went
  // wrong once already: a stray newline inside the injected source made it a SyntaxError, and the run
  // reported "no interval was ever created" as if that were a finding.)
  if (!(await cdpPage.evaluate("typeof window.__ocDevicePollers"))) {
    throw new Error("the interval tracker is not installed in this page (see INTERVAL_TRACKER_SOURCE) -- refusing to report anything about polling, because a missing instrument looks exactly like a silent page");
  }

  // The positive control, in-arm: wait one poll period WITHOUT removing anything, so the poller has
  // demonstrably fetched the device list at least once. Everything below is a comparison against this.
  await settle(3500);
  const running = await polling();
  if (running.length === 0) {
    const log = await cdpPage.intervalEvents();
    const seen = log.map((e) => `${new Date(e.at).toISOString().slice(11, 23)} ${e.kind} #${e.id} ${e.ms}ms${e.pollerFrame ? " poller" : ""}${e.frame ? ` @${e.frame}` : ""}`).join("; ") || "no interval was ever created";
    throw new Error(`no device poller for the ${surface} surface was running before the removal (live pollers of any surface: ${describe(await cdpPage.devicePollers())}; this surface's is created by ${frame}) -- this run cannot tell "the poller stopped" from "the poller never started", so it proves nothing either way. Intervals: ${seen}`);
  }
  const hitsBeforeRemoval = await hits();

  const devices = (await call("GET", "/v1/org/devices")).devices ?? [];
  const target = devices.find((d) => d.name === name && d.status === "waiting");
  if (!target) {
    const seen = devices.map((d) => `${d.name}:${d.status}`).join(", ") || "none";
    throw new Error(`no waiting device named ${JSON.stringify(name)} for the ${surface} surface to remove (devices: ${seen})`);
  }
  await call("DELETE", `/v1/org/devices/${target.deviceId}`);

  // The console polls every 3s. One tick lands the terminal status and, when fixed, clears the
  // interval; the poller set is read after it and then held for three more ticks' worth.
  //
  // The baseline for "did it keep polling" is taken HERE, at the terminal tick -- not at the moment of
  // removal. A fixed poller still makes one more request after the removal: the tick that discovers the
  // terminal status is what clears it, and app.js then calls refresh() from that same tick. Measuring
  // from the removal counts that single honest request as growth, which fails a correct fix. What the
  // fix claims is that the polling does not CONTINUE, so the window has to start once the last
  // legitimate tick has been served.
  await settle(4000);
  const afterTick = cdpPage.countRequests("GET", "/v1/org/devices");
  const chip = await cdpPage.evaluate(`document.getElementById(${JSON.stringify(chipId)}).textContent`);
  const stillPolling = await polling();
  const hitsAtTerminal = await hits();
  await settle(9000);
  const hitsAfter = await hits();
  const grew = hitsAfter - hitsAtTerminal;
  const found = { surface, chip, pollers: describe(stillPolling), ticks: afterTick - before, grew, hitsAfterRemoval: hitsAtTerminal - hitsBeforeRemoval, uncharged: await cdpPage.deviceFetchesUncharged() };

  if (expect === "bug") {
    if (grew === 0) throw new Error(`--pre-fix expects the broken console's behaviour, but the poller stopped (live pollers at the terminal tick: ${describe(stillPolling)}; ${hitsAtTerminal - hitsBeforeRemoval} device fetch(es) between the removal and the terminal tick, ${grew} in the 9s after) -- either the served app.js is already fixed or the removal never landed`);
    if (!/wait/i.test(chip)) throw new Error(`--pre-fix expects the chip to still say it is waiting; it says ${JSON.stringify(chip)}`);
  } else {
    if (stillPolling.length) throw new Error(`a device poller is still live after the computer was removed: ${describe(stillPolling)} -- the interval was never cleared`);
    if (grew !== 0) {
      const charges = await cdpPage.deviceFetchCharges();
      const detail = charges.slice(-(grew + 2)).map((c) => `${new Date(c.at).toISOString().slice(11, 23)} from [${c.from.map((f) => `${f.ms}ms${f.pollerFrame ? "/poller" : ""}${f.at ? ` ${f.at}` : ""}`).join(", ") || "nothing"}]`).join("; ");
      throw new Error(`the poller is STILL running after the computer was removed: ${grew} more device fetch(es) in the 9s after the terminal tick -- a screenshot here would be a picture of the bug. Charged: ${detail}`);
    }
    if (!/removed/i.test(chip)) throw new Error(`expected the ${surface} chip to say the computer was removed; it says ${JSON.stringify(chip)}`);
  }
  await cdpPage.warnIfOverflowing(file);
  await cdpPage.screenshot(path.join(outDir, file));
  return found;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const pages = args.pages
    ? PAGES.filter((p) => args.pages.includes(p.id))
    : PAGES.filter((p) => !p.selfServeOnly || args.firstRun);
  if (args.pages && pages.length !== args.pages.length) {
    const known = new Set(PAGES.map((p) => p.id));
    const bad = args.pages.filter((id) => !known.has(id));
    if (bad.length) throw new Error(`unknown --pages id(s): ${bad.join(", ")} (known: ${PAGES.map((p) => p.id).join(", ")})`);
  }
  const widths = args.widths ?? DEFAULT_WIDTHS;
  const themes = args.themes ?? DEFAULT_THEMES;
  if (args.firstRun && args.asAdmin) throw new Error("--first-run mints a brand new workspace, so there is no workspace to be an admin of; drop --as-admin");
  if (args.firstRun && args.empty) throw new Error("--first-run always starts from an empty workspace -- the form makes it; drop --empty");
  if (args.preFix && !args.stageRevoked) throw new Error("--pre-fix only qualifies a --stage-revoked run (it asserts the un-fixed console's behaviour); add --stage-revoked");

  // Scratch AND the default screenshot folder go on the big drive when this machine has one (the operator: C: is nearly
  // full, B: is the Seagate). OPENCADRE_SCRATCH overrides; without B:, the system temp dir is used and a line says so.
  const { root: scratchBase, warning: scratchWarning } = scratchRoot();
  if (scratchWarning) console.warn(`      ${scratchWarning}`);
  const scratchDir = mkdtempSync(path.join(scratchBase, "opencadre-console-shots-"));
  // The scratch dir holds a hub database and a whole Edge profile (~450 MB). It used to outlive every run: 57 of them,
  // 53 from one day, were most of an 8.3 GB %TEMP% on a nearly full C: (2026-09-23). Removed on every way out: a
  // normal finish, an error, and Ctrl+C under --keep-alive. Edge is stopped and the hub's database closed first, since
  // each holds files in it open; anything still left is reported, never silently kept.
  let edgeForCleanup = null;
  let hubDbForCleanup = null;
  const cleanScratch = () => {
    try { if (edgeForCleanup) process.kill(edgeForCleanup.pid); } catch { /* already gone */ }
    try { hubDbForCleanup?.close(); } catch { /* already closed */ }
    try {
      rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`      could not remove the scratch dir ${scratchDir} (${err.code ?? err.message}); delete it by hand`);
    }
  };
  process.once("exit", cleanScratch);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));
  const dbPath = path.join(scratchDir, "hub.db");
  const outDir = shotsDir({ out: args.out, root: scratchBase, repoRoot: REPO_ROOT, resolve: path.resolve });
  mkdirSync(outDir, { recursive: true });

  console.log(`[1/4] booting hub (scratch db: ${scratchDir})...`);
  const port = await freePort();
  const tBoot = Date.now();
  const baseUrl = await bootHub({ port, dbPath });
  hubDbForCleanup = (await import(pathToFileURL(path.join(REPO_ROOT, "src", "db.js")).href)).db;
  console.log(`      up on ${baseUrl} in ${Date.now() - tBoot}ms`);

  console.log(`[2/4] minting owner + ${args.empty ? "skipping seed data (--empty)" : "seeding workspace"}...`);
  const tSeed = Date.now();
  const orgName = args.empty ? "Empty Workspace" : "Acme Robotics";
  // --first-run mints a person with NO workspace, because the workspace must be created by the
  // console's own form (see mintPerson) -- so it mints that person instead of an owner, and skips
  // seeding entirely. Under --first-run there is no single person here at all: one is minted per
  // breakpoint/theme pass, in the loop, so that every pass starts from the state a stranger starts
  // from. `cookie` and `orgId` are therefore assigned by that loop, not by this block.
  const owner = args.firstRun ? null : await mintOwner(orgName);
  let cookie = owner ? owner.cookie : null;
  let orgId = owner ? owner.orgId : null;
  if (args.firstRun) {
    console.log("      self-serve: NO workspace of any kind -- each pass mints a workspace-less person and lets the console's own create form make the workspace");
  } else if (!args.empty) {
    await startPlanForSeed(orgId);
    const call = api(baseUrl, cookie, orgId);
    await seedWorkspace(baseUrl, call, orgId);
    if (args.stageTaskPaging) await seedManyTasks(call);
  }
  // Seeding above always runs as the OWNER (it creates everything); --as-admin only changes whose
  // session the screenshots are taken with, so the workspace looks identical either way.
  if (args.asAdmin && args.empty) await startPlanForSeed(orgId); // the admin's invite is a write too
  const sessionCookie = args.asAdmin ? (await mintAdmin(baseUrl, cookie, orgId)).cookie : cookie;
  console.log(`      done in ${Date.now() - tSeed}ms${args.asAdmin ? " (capturing as admin)" : ""}`);

  console.log(`[3/4] shooting ${pages.length} page(s) x ${widths.length} width(s) x ${themes.length} theme(s)...`);
  const tShots = Date.now();
  const cdpPort = await freePort();
  const userDataDir = path.join(scratchDir, "edge-profile");
  const edgeProc = await launchEdge({ cdpPort, userDataDir });
  edgeForCleanup = edgeProc;
  const cdpPage = await openCdpPage(cdpPort);
  if (!args.firstRun) {
    await cdpPage.setCookie({ name: "oc_session", value: sessionCookie, url: baseUrl });
    // One real page load for the whole run: every later section switch is a same-document nav driven
    // by selectPage() (a real click), not a fresh Page.navigate -- see selectPage()'s own comment.
    // --first-run reloads per pass instead, because each pass is a different person (see the loop).
    await cdpPage.navigate(`${baseUrl}/app/`);
  }

  let shotCount = 0;
  for (const theme of themes) {
    await cdpPage.setColorScheme(theme);
    for (const w of widths) {
      await cdpPage.setViewport(w.width, w.height, { mobile: w.mobile });
      if (args.firstRun) {
        // A FRESH person per pass -- per pass, not once per run. The picker (the zero-workspace
        // screen) only exists before a workspace does, and the create happens in THIS browser, so a
        // person shared across passes would let the first pass destroy the state every later pass
        // needs to photograph: the later pass would then shoot whatever the console shows instead,
        // under the picker's filename. Declaring that limitation ("run the harness once per
        // breakpoint") would be honest but worse -- one extra hub call per pass buys complete
        // evidence from one run. Same reasoning as warnIfOverflowing below: the failure this avoids
        // is a WRONG IMAGE, which no assertion in this script can catch after the fact.
        const person = await mintPerson();
        cookie = person.cookie;
        await cdpPage.setCookie({ name: "oc_session", value: cookie, url: baseUrl });
        await cdpPage.navigate(`${baseUrl}/app/`);
        await cdpPage.waitForPicker();
        await cdpPage.warnIfOverflowing(`signup-picker @ ${w.name} ${theme}`);
        await cdpPage.screenshot(path.join(outDir, `signup-picker--${w.name}--${theme}.png`));
        shotCount++;
        // Then the stranger's own action: the console's real create form, which is the only thing
        // that makes the hub mint the first key (see mintPerson). Afterwards the console is on the
        // Overview section, where the first-run card lives, so the `overview` shot below carries it.
        // Every pass shares one browser profile, so every earlier pass's opencadre.selfserve.<orgId>
        // flag is still in this localStorage. Taking "the first self-serve key" therefore hands back
        // an EARLIER pass's workspace sometimes, and the hub answers with 403 "You're not a member of
        // this workspace" -- the cookie has moved on to this pass's person, the header has not. So
        // read the flag this pass ADDS, and say which keys it saw when that is not exactly one.
        const flagsBefore = await cdpPage.evaluate(
          `Object.keys(localStorage).filter((k) => k.startsWith("opencadre.selfserve."))`,
        );
        await cdpPage.createWorkspaceThroughTheConsole(orgName);
        // Read the org id back off the flag the console wrote, rather than from a variable this
        // script never had -- it doubles as proof the card's own on-switch actually fired.
        const flagsAfter = await cdpPage.evaluate(
          `Object.keys(localStorage).filter((k) => k.startsWith("opencadre.selfserve."))`,
        );
        const added = flagsAfter.filter((k) => !flagsBefore.includes(k));
        if (added.length !== 1) {
          throw new Error(`the console's create form should have written exactly one new opencadre.selfserve.<orgId> flag (see renderFirstRun in public/app/app.js); it wrote ${added.length}: added ${JSON.stringify(added)}, before ${JSON.stringify(flagsBefore)}, after ${JSON.stringify(flagsAfter)}`);
        }
        orgId = added[0].slice("opencadre.selfserve.".length);
        // Ask for the command too: the one thing the user copies is the point of the card, and a shot
        // showing only the button would not prove the hub hands over a working string.
        await cdpPage.evaluate(`document.getElementById("first-run-get-command").click()`);
        await cdpPage.waitFor(
          `(() => { const el = document.getElementById("first-run-cmd"); return Boolean(el) && !el.hidden && el.getClientRects().length > 0; })()`,
          "the first-run command to appear",
        );
        console.log(`      self-serve pass ${w.name}/${theme}: picker shot, workspace ${orgId} created through the console, command on screen`);
      }
      for (const page of pages) {
        // The picker was shot above, before the create, and no longer exists in this browser by the
        // time the loop runs -- re-selecting it here would throw or shoot the wrong screen.
        if (page.id === "signup-picker") continue;
        await cdpPage.selectPage(page);
        const file = path.join(outDir, `${page.id}--${w.name}--${theme}.png`);
        await cdpPage.warnIfOverflowing(`${page.id} @ ${w.name} ${theme}`);
        await cdpPage.screenshot(file);
        shotCount++;
      }
      if (args.stageRevoked) {
        const expect = args.preFix ? "bug" : "fixed";
        const call = api(baseUrl, cookie, orgId);
        // (1) The Connect tab's command card. Created through the console's own form, so what is
        // interrupted is a real waiting card; removed through the hub route Fleet's Remove uses --
        // see stageRemovedComputer's comment for why the state cannot be reached by clicking alone.
        await cdpPage.selectPage(PAGES.find((p) => p.id === "connect"));
        await cdpPage.addComputerThroughTheConsole(PC2_NAME);
        const connectStaged = await stageRemovedComputer({
          cdpPage, call, surface: "connect", name: PC2_NAME, expect, outDir,
          file: `connect-revoked--${w.name}--${theme}.png`,
        });
        shotCount++;
        console.log(`      connect @ ${w.name} ${theme}: removed ${PC2_NAME} -> chip ${JSON.stringify(connectStaged.chip)}, ${connectStaged.grew} device fetch(es) by any poller in the 9s after the terminal tick (${connectStaged.pollers || "no poller left running"}; ${connectStaged.ticks} GETs to the path in total, heartbeat included)`);
        // (2) The self-serve first-run card, whose device the prologue above created by clicking the
        // card's own button. Only under --first-run: in every other mode there is no such card.
        if (args.firstRun) {
          await cdpPage.selectPage(PAGES.find((p) => p.id === "overview"));
          const firstRunStaged = await stageRemovedComputer({
            cdpPage, call, surface: "first-run", name: FIRST_RUN_DEVICE_NAME, expect, outDir,
            file: `first-run-revoked--${w.name}--${theme}.png`,
          });
          shotCount++;
          console.log(`      first-run @ ${w.name} ${theme}: removed ${FIRST_RUN_DEVICE_NAME} -> chip ${JSON.stringify(firstRunStaged.chip)}, ${firstRunStaged.grew} device fetch(es) by any poller in the 9s after the terminal tick (${firstRunStaged.pollers || "no poller left running"}; ${firstRunStaged.ticks} GETs to the path in total, heartbeat included)`);
        }
      }
      if (args.stageRefreshError) {
        const staged = await stageRefreshError({ cdpPage, outDir, file: `refresh-error--${w.name}--${theme}.png` });
        shotCount++;
        console.log(`      refresh-error @ ${w.name} ${theme}: line ${JSON.stringify(staged.notice)}, cleared after the endpoint answered again`);
      }
      if (args.stageSourceError) {
        const staged = await stageSourceError({ cdpPage, outDir, file: `source-error--${w.name}--${theme}.png` });
        shotCount++;
        console.log(`      source-error @ ${w.name} ${theme}: line and announcer ${JSON.stringify(staged.notice)}, both cleared after the endpoint answered again`);
      }
      if (args.stageTaskPaging) {
        const staged = await stageTaskPaging({ cdpPage, outDir, suffix: `${w.name}--${theme}` });
        shotCount += 3;
        console.log(`      task-paging @ ${w.name} ${theme}: ${JSON.stringify(staged.button)} -> ${staged.afterMore} Open cards; search "webhook" -> ${JSON.stringify(staged.count)}`);
      }
    }
  }
  await cdpPage.close();
  console.log(`      ${shotCount} screenshot(s) in ${Date.now() - tShots}ms -> ${outDir}`);

  console.log(`[4/4] done in ${Date.now() - t0}ms total.\n`);
  printUsage({ baseUrl, orgId, cookie, outDir, keepAlive: args.keepAlive });

  if (!args.keepAlive) {
    try { process.kill(edgeProc.pid); } catch { /* already gone */ }
    process.exit(0);
  }
}

function printUsage({ baseUrl, orgId, cookie, outDir, keepAlive }) {
  console.log(`Base URL:      ${baseUrl}
Workspace id:  ${orgId}
Screenshots:   ${outDir}

To click around in a real browser tab, open ${baseUrl}/app/ then in DevTools console run:
  document.cookie = "oc_session=${cookie}; path=/"; location.reload();

To call the REST API directly:
  curl -s ${baseUrl}/v1/org/sessions \\
    -H "Cookie: oc_session=${cookie}" -H "X-OpenCadre-Workspace: ${orgId}"
${keepAlive ? "\nHub left running (--keep-alive) -- Ctrl+C this process to stop it." : "\nHub stopped. Re-run this script for a fresh one, or add --keep-alive to leave it up."}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
