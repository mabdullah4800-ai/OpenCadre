#!/usr/bin/env node
/** Backup: log pending agent replies every second. No auto-reply. */
import fs from "node:fs";
import path from "node:path";
import { readPendingAgentReply } from "./display-queue.mjs";

const LOG = process.env.OPENCADRE_MONITOR_LOG ?? path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-monitor.log");
const INTERVAL_MS = Number(process.env.OPENCADRE_MONITOR_INTERVAL_MS ?? "1000");

function log(line) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
}

log("monitor starting (ingest-wake-only, no auto-reply)");
setInterval(() => {
  const pending = readPendingAgentReply();
  if (pending.length > 0) log(`pending_agent_reply=${pending.length}`);
}, INTERVAL_MS);
