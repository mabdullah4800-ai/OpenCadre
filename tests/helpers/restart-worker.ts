// Child process for tests/recovery.test.ts. The hub keeps everything in one SQLite file, so a restart is a new
// process opening the same file. "write" builds live state and exits; "read" is the restarted hub.
// OPENCADRE_DB_PATH must point at the shared file before any hub module is imported.
const [phase, stateFile] = process.argv.slice(2);
const { readFileSync, writeFileSync } = await import("node:fs");
const service = await import("../../src/service.js");
const { requestApproval, listApprovals, decideApproval } = await import("../../src/approvals.js");
const { claimTask, createTask, listTasks } = await import("../../src/tasks.js");
const { beginIdempotent, completeIdempotent, requestHash } = await import("../../src/idempotency.js");

if (phase === "write") {
  const { orgId } = service.createOrganization("Restart Org");
  const ops = service.registerAgent(orgId, "Restart-Operator", { role: "operator", system: true });
  const a = service.registerAgent(orgId, "Restart-Builder");
  const b = service.registerAgent(orgId, "Restart-Reviewer");
  const builder = { id: a.agentId, name: "Restart-Builder" };
  const approval = await requestApproval(orgId, builder, { action: "terraform destroy", category: "terraform", expiresInSeconds: 3600 });
  // A person decides a clearance (migration 53), so the restarted hub decides as a signed-in person, not the operator agent.
  const { signInPerson } = await import("./person.js");
  const { decider } = await signInPerson(orgId, "Restart-Person");
  const sent = await service.sendMessage(orgId, builder, "Restart-Reviewer", "review before restart", "high");
  const task = createTask(orgId, builder, { title: "survive a restart" });
  claimTask(orgId, builder, task.id, 3600);
  const hash = requestHash("POST /v1/messages", { body: "x" });
  const begin = beginIdempotent(orgId, a.agentId, "restart-key-0001", "POST /v1/messages", hash);
  if (begin.state === "new") completeIdempotent(orgId, a.agentId, "restart-key-0001", begin.claimedAt, 201, '{"ok":true,"threadId":"t-before"}');
  writeFileSync(stateFile, JSON.stringify({
    orgId, opsId: ops.agentId, decider, builderId: a.agentId, reviewerId: b.agentId,
    approvalId: approval.id, threadId: sent.ok ? sent.threadId : null, taskId: task.id, hash,
  }));
  process.stdout.write("written");
} else {
  const s = JSON.parse(readFileSync(stateFile, "utf8"));
  const pending = listApprovals(s.orgId, { status: "pending" }).map((p) => p.id);
  const task = listTasks(s.orgId).find((t) => t.id === s.taskId);
  const firstRead = service.getMessages(s.orgId, s.reviewerId).map((m) => m.body);
  const secondRead = service.getMessages(s.orgId, s.reviewerId).length;
  const replay = beginIdempotent(s.orgId, s.builderId, "restart-key-0001", "POST /v1/messages", s.hash);
  const decided = decideApproval(s.orgId, s.decider, s.approvalId, "approve");
  process.stdout.write(JSON.stringify({
    approvalPending: pending.includes(s.approvalId),
    taskClaimedBy: task?.claimed_by_agent_name ?? null,
    leaseActive: task?.lease_active ?? null,
    firstRead,
    secondRead,
    replay,
    decidedOk: decided.ok,
  }));
}
