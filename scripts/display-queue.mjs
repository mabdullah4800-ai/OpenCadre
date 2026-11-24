#!/usr/bin/env node
/** Append/read OpenCadre exchanges for verbatim chat display. */
import fs from "node:fs";
import path from "node:path";

function displayPath() {
  return (
    process.env.OPENCADRE_DISPLAY_PATH ??
    path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-display.jsonl")
  );
}

export function appendExchange(record) {
  fs.mkdirSync(path.dirname(displayPath()), { recursive: true });
  fs.appendFileSync(displayPath(), `${JSON.stringify(record)}\n`);
}

export function readUnshown() {
  try {
    const lines = fs.readFileSync(displayPath(), "utf8").trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l)).filter((r) => !r.shown);
  } catch {
    return [];
  }
}

export function markAllShown() {
  try {
    const lines = fs.readFileSync(displayPath(), "utf8").trim().split("\n").filter(Boolean);
    const updated = lines.map((l) => {
      const r = JSON.parse(l);
      return JSON.stringify({ ...r, shown: true });
    });
    fs.writeFileSync(displayPath(), updated.length ? `${updated.join("\n")}\n` : "");
  } catch {
    /* empty */
  }
}

export function readAll() {
  try {
    return fs
      .readFileSync(displayPath(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function readPendingAgentReply() {
  return readAll().filter((r) => r.status === "pending_agent_reply");
}

export function markAgentReplied(threadId, outbound) {
  const rows = readAll();
  const idx = rows.findIndex((r) => r.inbound?.threadId === threadId && r.status === "pending_agent_reply");
  if (idx < 0) return false;
  rows[idx] = { ...rows[idx], status: "complete", outbound, shown: true };
  fs.writeFileSync(displayPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return true;
}

if (process.argv[2] === "unshown") {
  console.log(JSON.stringify(readUnshown(), null, 2));
}
