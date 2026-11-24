#!/usr/bin/env node
// Universal Wake daemon (docs/design/UNIVERSAL_WAKE.md, section 5 item 4: "daemon core").
//
// STATUS: new opt-in infrastructure, not wired into anything. scripts/opencadre-wake.mjs (the
// proven peek-and-exit watcher run as a Claude Code background task / asyncRewake Stop hook)
// remains what the fleet actually runs. This script is the next capability layer on top of it —
// a standalone process that can drive MULTIPLE wake tiers (T1 lease/rate-limit bookkeeping
// today; T3 headless-resume adapters; more tiers as docs/design/UNIVERSAL_WAKE.md's later items
// land) for ONE session at a time. It is not started by install-session-hooks.mjs, not added to
// any client config, and not part of `npx opencadre connect`. Run it by hand:
//
//   OPENCADRE_URL=... OPENCADRE_KEY=... node scripts/opencadre-wake-daemon.mjs \
//     --session-id <sessionId> [--thread-id <threadId>] [--client codex|claude-code]
//
// It long-polls the hub the same way opencadre-wake.mjs does, reads session status from
// ~/.opencadre/state/<sessionId>.json (written by scripts/wake-state-hook.mjs), and runs one
// scripts/wake-daemon/orchestrator.mjs cycle per batch of mail: policy filter, busy/waiter
// guards, rate limit, lease, then T3 codex/claude headless-resume adapters in order, with
// verify/failover between them. See docs/design/UNIVERSAL_WAKE.md section 3 for the full guard
// table and section 5 item 7 for the T3 acceptance tests.
//
// Env: OPENCADRE_WAIT_SECONDS (50), OPENCADRE_WAKE_STATE_DIR (~/.opencadre), OPENCADRE_WAKE_MEDIUM,
//      OPENCADRE_WAKE_CODEX_CMD (codex), OPENCADRE_WAKE_CLAUDE_CMD (claude)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHub } from "./opencadre-config.mjs";
import { initLimiterState } from "./wake-daemon/rate-limiter.mjs";
import { runWakeCycle } from "./wake-daemon/orchestrator.mjs";
import { claudeResumeAdapter, codexExecResumeAdapter } from "./wake-daemon/t3-resume.mjs";
import { codexInjectItemsAdapter } from "./wake-daemon/inject-items.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const client = arg("client");
const { base: BASE, key: KEY, notEnabled: NOT_ENABLED } = resolveHub({ client });
// Not on this computer's enabled-project list: nothing to wake for here, and nothing is said to the hub.
if (NOT_ENABLED) process.exit(0);
const WAIT_SECONDS = Number(process.env.OPENCADRE_WAIT_SECONDS || 50);
const stateDir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre");
const leaseDir = stateDir;

const sessionId = arg("session-id");
const threadId = arg("thread-id", sessionId);

if (!BASE || !KEY) {
  console.error("opencadre-wake-daemon: set OPENCADRE_URL and OPENCADRE_KEY (or --client)");
  process.exit(1);
}
if (!sessionId) {
  console.error("opencadre-wake-daemon: --session-id <id> is required");
  process.exit(1);
}

function readSessionStatus() {
  try {
    const raw = readFileSync(join(stateDir, "state", `${sessionId}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return { sessionId, threadId, status: "idle" };
  }
}

async function verifyStatus() {
  return readSessionStatus().status;
}

// Order is tier order, and the orchestrator tries them in array order until one verifies. The
// turn-free injector goes FIRST, so a session with a Codex thread never reaches the T3 resume leg:
// injecting starts no turn, so it has no lock to miss and cannot put a foreign turn into a chat a
// human is in. The resume adapters stay registered for the sessions that have no injectable thread
// (canWake returns no-owner there, and the orchestrator fails over) — this change does not remove
// or alter them.
const adapters = [
  codexInjectItemsAdapter({
    command: process.env.OPENCADRE_WAKE_CODEX_CMD || "codex",
    stateDir,
  }),
  codexExecResumeAdapter({ command: process.env.OPENCADRE_WAKE_CODEX_CMD || "codex" }),
  claudeResumeAdapter({ command: process.env.OPENCADRE_WAKE_CLAUDE_CMD || "claude" }),
];

const limiterState = initLimiterState();
let afterId = "";

function onEscalate(session, reason) {
  // T6 already escalates unread-mail-by-time on the hub (src/escalation.ts), independent of
  // this daemon staying up. This is local observability only.
  console.error(`opencadre-wake-daemon: hard stop for session ${session.sessionId}: ${reason}`);
}

console.error(`opencadre-wake-daemon: watching session ${sessionId} (thread ${threadId}) via ${BASE}`);
for (;;) {
  const cursor = afterId ? `&afterId=${encodeURIComponent(afterId)}` : "";
  let messages = [];
  try {
    const res = await fetch(`${BASE}/v1/messages/wait?peek=true&timeoutSeconds=${WAIT_SECONDS}${cursor}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) {
      // A 401/502 answers instantly; without a pause the loop would hammer the hub.
      console.error(`opencadre-wake-daemon: hub returned ${res.status}; retrying`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    ({ messages = [] } = await res.json());
  } catch (err) {
    console.error(`opencadre-wake-daemon: hub unreachable (${err.message}); retrying`);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (messages.length === 0) continue;
  afterId = messages[messages.length - 1].id;

  const session = { ...readSessionStatus(), sessionId, threadId };
  const result = await runWakeCycle({
    session,
    messages,
    adapters,
    leaseDir,
    limiterState,
    verifyStatus,
    onEscalate,
  });
  console.error(`opencadre-wake-daemon: cycle -> ${JSON.stringify(result)}`);
}
