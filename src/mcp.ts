import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticateAgentKey, isPausedWorkspaceKey, type AuthedAgent } from "./auth.js";
import { checkDeviceSession, checkDeviceWithoutSeat, clientLabel, DEFER_SEAT_HEADER, deviceRefusalResponse, isDeviceCredential, type DeviceRefusal } from "./devices.js";
import { mcpResource, oauthEnabled, verifyAccessToken, wwwAuthenticate } from "./oauth.js";
import { PAUSED_ERROR } from "./kill-switch.js";
import { readOnlyRefusal } from "./billing.js";
import { holdOpenRequest } from "./revocation.js";
import {
  askClarification, broadcastMessage, consumeMessages, countUnreadMessages, getAgentCapabilities, getAgentRoundBudget, getFile, getMessages, heartbeat,
  listActiveAgents, reply, PHASES, resolvePeekDefault, sendMessage, setAgentCapabilities, setAgentRoundBudget, setAgentStatus, setAgentWebhook,
  shareFile, waitForMessage, getThreadStatus, searchMessages,
} from "./service.js";
import type { MessageRecord } from "./service.js";
import { recordDecision, type EventRecord } from "./events.js";
import { listTimeline, sweepTimeline, waitForTimeline } from "./timeline.js";
import { ackEvent, OUTCOMES, pullEvents } from "./deliveries.js";
import { getAwareness } from "./awareness.js";
import { usageSummary } from "./usage.js";
import { validateWebhookAuthHeader, validateWebhookUrl } from "./webhook-guard.js";
import { maskSecrets } from "./secrets.js";
import { idempotentTool } from "./idempotency.js";
import { acceptTask, claimTask, completeTask, createTask, getTaskById, listNewestTasks, rejectTask, releaseTask, renewClaim, setTaskLane, soleClaimedTaskId, supersedeTask, TaskInputError } from "./tasks.js";
import { sectionCount, taskBoard } from "./task-board.js";
import { asData } from "./agent-text.js";
import { currentAgentName } from "./agent-names.js";
import { claimResource, listResourceLocks, releaseResource, renewResourceLock, ResourceLockInputError } from "./resource-locks.js";
import { BlackboardInputError, deleteFact, getFact, listFacts, setFact } from "./blackboard.js";
import { getAgentReliability, listAgentReliability } from "./reliability.js";
import { getTaskShapeStats } from "./task-telemetry.js";
import type { TaskView } from "./tasks.js";
import { parseProjectParam, ProjectSettingsError, setWipCap } from "./project-settings.js";
import { archiveMemory, createMemory, getMemory, listMemory, MemoryInputError, searchMemory, supersedeMemory } from "./memory.js";
import type { MemoryRecord } from "./memory.js";
import { getGoals, setGoal, type GoalRecord } from "./goals.js";
import { countNotedApprovals, decideApproval, listApprovalGrants, listApprovals, requestApproval, revokeApprovalGrant, waitForApproval, withdrawApproval } from "./approvals.js";
import { can, roleFor } from "./permissions.js";
import type { ApprovalRecord } from "./approvals.js";
import { NoNamespaceError, projectDisplayName, projectIsolationEnabled, withScopeCache } from "./scope.js";

const PRIORITY_SCHEMA = z.enum(["high", "medium", "low"]).optional();

// Baked into the set_status description so any connecting client sees
// the convention, not just humans reading the README. OpenCadre cannot
// force an agent to narrate its own work -- this is the strongest lever
// available: put the expectation directly where the model reads tool docs.
const COORDINATION_NOTE =
  " Convention: call this proactively on every meaningful step start/finish, not only when asked -- silence is indistinguishable from stalled/crashed in a multi-agent session. Use priority=\"low\" for routine updates so they never interrupt anyone.";

const IDEMPOTENT_TOOLS = new Set([
  "send_message", "broadcast_message", "reply", "share_file", "record_decision",
  "create_task", "save_task", "supersede_task", "set_task_lane", "claim_task", "renew_claim", "release_task", "complete_task", "accept_task", "reject_task", "set_goal",
  "claim_resource", "renew_resource_lock", "release_resource",
  "request_approval", "decide_approval", "withdraw_approval",
  "remember", "archive_memory", "supersede_memory",
]);
const REQUEST_ID_SCHEMA = z
  .string()
  .optional()
  .describe("Optional retry key (8-128 chars). Reuse it when retrying the same call after a timeout: the hub runs the write once and returns the first result.");

// Titles and behavior hints returned on tools/list (MCP spec 2025-06-18, ToolAnnotations).
// Every field is set. The spec's defaults — readOnly false, destructive true, idempotent false,
// openWorld true — would otherwise present a read as a destructive write that calls the outside
// world. destructiveHint and idempotentHint apply only when readOnlyHint is false; reads still
// send false and true so a client that skips that rule cannot inherit the destructive default.
type ToolHint = { title: string; annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">> };
// These reads do not write on their own behalf. get_timeline, wait_for_timeline, list_tasks,
// get_task, list_resource_locks, list_approvals, and wait_for_approval still run a lazy
// housekeeping sweep first: lapsed task leases and resource locks are announced, and approvals
// already past their deadline are expired. The same sweeps run on the server timer. The other
// read-only tools do not sweep. pull_events is not in this group: it also marks the caller's
// queued deliveries delivered.
const readTool = (title: string): ToolHint => ({
  title,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const writeTool = (title: string, destructive: boolean, idempotent: boolean, openWorld = false): ToolHint => ({
  title,
  annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld },
});
const TOOL_HINTS: Record<string, ToolHint> = {
  send_message: writeTool("Send Agent Message", false, false),
  broadcast_message: writeTool("Broadcast Message", false, false),
  ask_clarification: writeTool("Ask Agent Question", false, false),
  get_messages: writeTool("Read Unread Messages", false, false),
  wait_for_message: writeTool("Wait For Message", false, false),
  consume_messages: writeTool("Mark Messages Read", false, true),
  get_message_status: readTool("Thread Delivery Status"),
  search_messages: readTool("Search Messages"),
  reply: writeTool("Reply To Thread", false, false),
  get_active_agents: readTool("List Active Agents"),
  set_status: writeTool("Set Agent Status", false, true),
  get_timeline: readTool("Read Event Timeline"),
  wait_for_timeline: readTool("Wait For Events"),
  get_awareness: writeTool("Catch-Up Digest", false, false),
  pull_events: writeTool("Pull Unacked Events", false, true),
  ack_event: writeTool("Acknowledge Event", false, true),
  record_decision: writeTool("Record Decision", false, false),
  create_task: writeTool("Create Task", false, false),
  save_task: writeTool("Save Side Task", false, false),
  supersede_task: writeTool("File Task Correction", false, false),
  set_capabilities: writeTool("Declare Capabilities", true, true),
  get_capabilities: readTool("Get Capabilities"),
  set_round_budget: writeTool("Declare Round Budget", true, true),
  get_round_budget: readTool("Get Round Budget"),
  list_tasks: readTool("List Task Board"),
  get_task: readTool("Get Task Details"),
  claim_task: writeTool("Claim Task", false, false),
  renew_claim: writeTool("Renew Task Claim", false, false),
  release_task: writeTool("Release Task", false, true),
  complete_task: writeTool("Complete Task", false, true),
  // Moves one task to the given lane (and rank): the same call again leaves it where it is.
  set_task_lane: writeTool("Set Task Lane", false, true),
  accept_task: writeTool("Accept Task", false, true),
  reject_task: writeTool("Reject Task", false, true),
  claim_resource: writeTool("Lock Resource", false, false),
  renew_resource_lock: writeTool("Renew Resource Lock", false, false),
  release_resource: writeTool("Release Resource Lock", false, true),
  list_resource_locks: readTool("List Resource Locks"),
  set_fact: writeTool("Set Shared Fact", true, false),
  get_fact: readTool("Get Shared Fact"),
  list_facts: readTool("List Shared Facts"),
  delete_fact: writeTool("Delete Shared Fact", true, true),
  get_agent_reliability: readTool("Agent Reliability"),
  list_agent_reliability: readTool("Reliability Leaderboard"),
  get_task_shape_stats: readTool("Task Shape Stats"),
  remember: writeTool("Save Memory Note", false, false),
  recall: readTool("List Memory"),
  search_memory: readTool("Search Memory"),
  get_memory: readTool("Get Memory Entry"),
  archive_memory: writeTool("Archive Memory", false, true),
  supersede_memory: writeTool("Replace Memory", false, false),
  set_goal: writeTool("Set Goal", true, false),
  get_goal: readTool("Get Goal"),
  request_approval: writeTool("Request Human Approval", false, false, true),
  wait_for_approval: readTool("Wait For Approval"),
  list_approvals: readTool("List Approvals"),
  decide_approval: writeTool("Decide Approval", true, true),
  // Only the requester's own pending row changes, once; a repeat finds it withdrawn and changes nothing.
  withdraw_approval: writeTool("Withdraw Approval Request", true, true),
  list_approval_grants: readTool("List Approval Grants"),
  revoke_approval_grant: writeTool("Revoke Approval Grant", true, true),
  share_file: writeTool("Share File", false, false),
  download_file: readTool("Download File"),
  register_webhook: writeTool("Register Webhook", true, true, true),
  // Replaces one stored value with the given one: setting the same cap again changes nothing.
  set_wip_cap: writeTool("Set WIP Cap", true, true),
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Every connected agent pays tokens for tool output, so lists default to a
// page and long free text is clipped. REST keeps its unbounded defaults.
const pageSize = (limit: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(Math.trunc(limit ?? fallback) || fallback, 1), max);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const showingNote = (shown: number, total: number, noun: string) =>
  `(showing ${shown} of ${total} ${noun} -- pass status or a higher limit)`;

/** One schema-validation issue, as zod reports it: the parts this reads are the same for every tool. */
type InputIssue = { code: string; path: PropertyKey[]; message: string; values?: unknown[]; expected?: string };

const withArticle = (type: string) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return withArticle(typeof value);
}

/** A tool's input-validation failure in plain words, one line per issue: the field, then its valid values, that it is
 * required, or the type it takes (board task cf34b4c2: agents were left reading the schema library's raw issue text).
 * Bounded (review of #717): each line, the value it quotes, and the number of issues (beyond MAX_ISSUES, a count of the
 * rest). The rejected value goes back into an agent's context, may be huge, and may hold something sensitive, so none of
 * it is ever reflected wholesale. */
function describeInputIssues(issues: InputIssue[], args: unknown): string {
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const field = clip(issue.path.map(String).join("."), PREVIEW_CHARS);
    if (!field) return clip(issue.message, LINE_CHARS);
    let given: unknown = args;
    for (const key of issue.path) given = given && typeof given === "object" ? (given as Record<PropertyKey, unknown>)[key] : undefined;
    if (issue.code === "invalid_value" && Array.isArray(issue.values)) {
      const values = issue.values.map(String).join(", ");
      return clip(given === undefined ? `${field} is required, one of: ${values}` : `${field} must be one of: ${values} (got ${preview(given)})`, LINE_CHARS);
    }
    if (issue.code === "invalid_type" && issue.expected) {
      return clip(given === undefined ? `${field} is required (${withArticle(issue.expected)})` : `${field} must be ${withArticle(issue.expected)} (got ${kindOf(given)})`, LINE_CHARS);
    }
    // The schema library's own message names no rejected value for the codes above, but other codes (an unrecognized-key
    // list, say) can grow with the input, so it is bounded too.
    return clip(`${field}: ${issue.message}`, LINE_CHARS);
  });
  if (issues.length > MAX_ISSUES) lines.push(`(and ${issues.length - MAX_ISSUES} more issues)`);
  return lines.join("\n");
}

const PREVIEW_CHARS = 40;
const LINE_CHARS = 200;
const MAX_ISSUES = 10;
/** A rejected value as an error may show it: a short string quoted, a long one previewed with its length, and anything
 * else (an object, an array, a number) named by its type only, never serialized. */
function preview(value: unknown): string {
  if (typeof value !== "string") return kindOf(value);
  return value.length <= PREVIEW_CHARS ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, PREVIEW_CHARS))}… (${value.length} characters)`;
}

/** Rewords the SDK's tool-input validation error for every tool on this server with describeInputIssues. The error
 * keeps its shape -- the same McpError code and "Input validation error: Invalid arguments for tool <name>:" prefix,
 * returned as an isError result -- so only the explanation after the prefix changes. Anything it can't re-read is
 * rethrown as the SDK wrote it. */
export function installPlainInputErrors(server: McpServer): void {
  type Validate = (tool: { inputSchema?: unknown }, args: unknown, toolName: string) => Promise<unknown>;
  const target = server as unknown as { validateToolInput?: Validate };
  const sdkValidate = target.validateToolInput;
  if (typeof sdkValidate !== "function") return;
  target.validateToolInput = async function (this: unknown, tool, args, toolName) {
    try {
      return await sdkValidate.call(this, tool, args, toolName);
    } catch (err) {
      if (!(err instanceof McpError) || err.code !== ErrorCode.InvalidParams) throw err;
      // The SDK's element-budget refusal must never trigger a second schema traversal.
      if (!err.message.includes(`Input validation error: Invalid arguments for tool ${toolName}:`)) throw err;
      // Best effort only: if re-reading the input or wording it fails in any way, the SDK's own error stands (review of
      // #717: a throwing re-read used to replace the original InvalidParams with an unrelated error).
      let plain: string | null = null;
      try {
        plain = await plainInputError(tool.inputSchema, args);
      } catch { /* keep the SDK's error */ }
      if (plain === null) throw err;
      throw new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${toolName}: ${plain}`);
    }
  };
}

/** The plain-words explanation of why `args` fails `inputSchema`, or null when the schema cannot be re-read or reports
 * no issue (the caller then keeps the SDK's own error). */
async function plainInputError(inputSchema: unknown, args: unknown): Promise<string | null> {
  const schema = inputSchema as { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; error?: { issues?: InputIssue[] } }> } | undefined;
  if (typeof schema?.safeParseAsync !== "function") return null;
  const parsed = await schema.safeParseAsync(args);
  const issues = parsed.success ? [] : parsed.error?.issues ?? [];
  return issues.length ? describeInputIssues(issues, args) : null;
}

export const PROJECT_NOT_ENABLED_INSTRUCTIONS = "OpenCadre isn't enabled for this project.";

/** A device session in a project its workspace hasn't enabled, from a proxy that predates opt-in projects: answered as
 * a valid MCP server with no tools, so the chat sees no OpenCadre at all instead of a failing server. */
function answerAsEmptyServer(body: unknown, res: ServerResponse): void {
  type Rpc = { id?: string | number | null; method?: unknown; params?: { protocolVersion?: unknown } };
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  const replies = messages
    .filter((m) => m && typeof m === "object" && typeof m.method === "string" && m.id !== undefined && m.id !== null)
    .map((m) => {
      if (m.method === "initialize") {
        return {
          jsonrpc: "2.0", id: m.id,
          result: {
            protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} }, serverInfo: { name: "opencadre", version: "0.1.0" }, instructions: PROJECT_NOT_ENABLED_INSTRUCTIONS,
          },
        };
      }
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: [] } };
      if (m.method === "ping") return { jsonrpc: "2.0", id: m.id, result: {} };
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    });
  if (replies.length === 0) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
}

export async function handleMcpRequest(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  // Project scope answers (src/scope.ts) are cached for the life of one request.
  return withScopeCache(() => handleScopedMcpRequest(req, res));
}

async function handleScopedMcpRequest(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const bearerToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : undefined;
  const refuse = (checked: DeviceRefusal) => {
    // A proxy from before projects were opt-in can't stay quiet on a 403, so the hub answers it as an empty server.
    if (checked.reason === "project_not_enabled" && checked.legacyClient && !checked.resolveOnly) return answerAsEmptyServer(req.body, res);
    const refused = deviceRefusalResponse(checked);
    res.writeHead(refused.status, { "content-type": "application/json" });
    res.end(JSON.stringify(refused.body));
  };
  // A Codex proxy's startup traffic, once its chats name themselves by stamp: answered statelessly under no agent,
  // so a process joins the roster only if it ever makes an unstamped tool call (checkDeviceWithoutSeat). Build-time
  // reads of the agent in buildMcpServer are the org's isolation setting and placeholders no tool runs under here.
  if (isDeviceCredential(bearerToken) && wantsNoSeat(req)) {
    const checked = checkDeviceWithoutSeat(bearerToken, req.headers);
    if (!checked.ok) return refuse(checked);
    Object.assign(req, { orgId: checked.orgId });
    await answerStateless({ orgId: checked.orgId, agentId: "", agentName: "", keyClass: "agent", role: "agent" }, req, res);
    return;
  }
  // A device credential resolves to its own session agent from the session headers; from here on it is that agent.
  let authed: AuthedAgent | null;
  if (isDeviceCredential(bearerToken)) {
    const checked = checkDeviceSession(bearerToken, req.headers);
    if (!checked.ok) return refuse(checked);
    authed = checked.auth;
  } else {
    // An MCP connector's OAuth access token (src/oauth.ts), only while OPENCADRE_OAUTH=on: audience-bound to this
    // resource, revocation read per request.
    authed = authenticateAgentKey(bearerToken) ?? (oauthEnabled() ? verifyAccessToken(bearerToken, mcpResource()) : null);
  }
  if (!authed) {
    const paused = isPausedWorkspaceKey(bearerToken);
    // The MCP authorization spec: a 401 names the protected-resource metadata, so an OAuth client can find the sign-in.
    res.writeHead(paused ? 423 : 401, {
      "content-type": "application/json",
      ...(!paused && oauthEnabled() ? { "www-authenticate": wwwAuthenticate() } : {}),
    });
    res.end(JSON.stringify({ error: paused ? PAUSED_ERROR : "invalid or missing agent API key" }));
    return;
  }
  // The request log (src/http-log.ts) reads these, as it does for REST, so an MCP call records which agent made it.
  Object.assign(req, { orgId: authed.orgId, agentId: authed.agentId });

  // A pure MCP client (Cursor, ChatGPT Developer Mode) may never open the
  // /live WebSocket, which was the only other place presence got updated --
  // without this, such a client would show permanently offline in
  // get_active_agents despite actively calling tools. Every MCP request is
  // already a fresh authenticated call, so this is a real, cheap presence
  // signal, not a heuristic.
  heartbeat(authed.orgId, authed.agentId);
  // A tool call such as wait_for_message can hold this request for minutes; revoking the key ends it.
  // A connector's request is held with its token family, so revoking one family ends exactly its requests.
  holdOpenRequest(authed.agentId, res, "connectorFamilyId" in authed ? (authed as { connectorFamilyId: string }).connectorFamilyId : undefined);

  await routeMcpTransport(authed, req, res);
}

/** Builds a fresh MCP server with every tool registered, scoped to the calling agent's
 * authenticated identity. Called once per session (buildMcpServer + a real session id, reused
 * across that session's requests) or once per one-shot request (a stateless caller that never
 * negotiates a session — see routeMcpTransport). */
function buildMcpServer(authed: AuthedAgent): McpServer {
  const server = new McpServer({ name: "opencadre", version: "0.1.0" }, { maxToolInputElements: 10_000 });
  installPlainInputErrors(server);
  // Write tools accept an optional requestId: a retry with the same id replays the first result
  // instead of writing again (src/idempotency.ts).
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
    if (typeof name !== "string") return register(name, config, handler);
    const cfg = config as { inputSchema?: Record<string, unknown> };
    const run = handler as (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    const hints = TOOL_HINTS[name];
    if (!hints) throw new Error(`MCP tool "${name}" has no title or annotations`);
    const idempotent = IDEMPOTENT_TOOLS.has(name);
    // Read-only enforcement for MCP (src/billing.ts). It wraps EVERY tool, including any added later:
    // the predicate treats anything off its read list as a write, so a new tool is refused on a lapsed
    // workspace by default rather than quietly writing. MCP needs this at all because it never passes
    // through the Express app -- src/index.ts returns the MCP response before app(req, res) is reached,
    // so admitAgent never runs for a tool call and a REST-only gate would leave this path wide open.
    //
    // The check is per CALL, not per session. This server object is built once and reused for the life
    // of the MCP session, so a snapshot of the billing state taken at connect time would be stale by
    // construction: a workspace that lapses mid-session must start refusing on the very next call, and
    // one put back on a plan must start allowing on the very next call, without a reconnect.
    //
    // It runs BEFORE idempotentTool on purpose. Recording the requestId first would store a refusal
    // under that id, and a retry after the workspace is restored would replay the refusal instead of
    // doing the work -- the caller's own id, held against them.
    const withBillingGuard = (args: Record<string, unknown>, extra: unknown) => {
      const refused = readOnlyRefusal(authed.orgId, name, { role: authed.role });
      if (refused) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: `${refused.body.code}: ${refused.body.error}` }],
          isError: true,
        });
      }
      return idempotent
        ? idempotentTool({ orgId: authed.orgId, agentId: authed.agentId }, name, args, () => run(args, extra))
        : run(args, extra);
    };
    const annotated = { ...(config as object), title: hints.title, annotations: hints.annotations };
    return register(
      name,
      idempotent ? { ...annotated, inputSchema: { ...cfg.inputSchema, requestId: REQUEST_ID_SCHEMA } } : annotated,
      withBillingGuard,
    );
  };
  // The name is read per use, by id, so a session a person renames writes and shows its new name at once, without
  // reconnecting. A display/write-name lookup only: authority stays keyed by id (sessions PR1).
  const self = {
    id: authed.agentId,
    get name(): string { return currentAgentName(authed.orgId, authed.agentId) ?? authed.agentName; },
  };
  // Stage 3 RBAC parity (src/permissions.ts): MCP has no cookie/member-session path, so this is
  // always "agent" (a plain agent key) or "owner" (a bare operator key, roleFor's bootstrap
  // exception) -- never "member"/"admin". Computed once per connection, not per tool call.
  const callerRole = roleFor(authed.role, null);
  // Tool descriptions say what the agent actually reaches: its project while project isolation is on, else the workspace.
  const isolated = projectIsolationEnabled(authed.orgId);
  const area = isolated ? "your project" : "your workspace";

  server.registerTool(
    "send_message",
    {
      description: isolated
        ? "Send a fire-and-forget message to another named agent in your project (or a linked project, or a workspace-wide agent or person)."
        : "Send a fire-and-forget message to another named agent in your workspace.",
      inputSchema: { toAgent: z.string(), body: z.string(), priority: PRIORITY_SCHEMA },
    },
    async ({ toAgent, body, priority }) => {
      const result = await sendMessage(authed.orgId, self, toAgent, body, priority ?? "medium");
      if (!result.ok) return textResult(`Error: ${result.error}`);
      return textResult(`Message sent to ${toAgent} (${result.delivered}). Thread: ${result.threadId}`);
    },
  );

  server.registerTool(
    "broadcast_message",
    {
      description:
        "Send the same message to multiple agents. Provide toAgents (array of names), or a channel: \"project\" (the default) for the other agents in your project, " +
        `or "org" for everyone in the workspace${isolated ? " (workspace-wide agents only)" : ""}. Each recipient gets an independent thread.`,
      inputSchema: {
        body: z.string(),
        toAgents: z.array(z.string()).optional(),
        channel: z.enum(["project", "org"]).optional(),
        priority: PRIORITY_SCHEMA,
      },
    },
    async ({ body, toAgents, channel, priority }) => {
      if (toAgents?.length && channel) {
        return textResult("Error: use either toAgents or a channel, not both");
      }
      const targets = toAgents?.length ? { toAgents } : { channel: channel ?? ("project" as const) };
      const result = await broadcastMessage(authed.orgId, self, targets, body, priority ?? "medium");
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const lines = result.deliveries.map((d) =>
        d.ok ? `${d.toAgent}: ${d.delivered}, thread ${d.threadId}` : `${d.toAgent}: Error: ${d.error}`,
      );
      return textResult(`Broadcast sent to ${result.deliveries.length} agent(s).\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "ask_clarification",
    {
      description:
        `Ask another named agent in ${area} a question. If they're online right now, waits (bounded by timeoutSeconds) for a live reply; otherwise logs a durable question they'll see next time they check in.`,
      inputSchema: {
        toAgent: z.string(),
        body: z.string(),
        timeoutSeconds: z.number().optional(),
        priority: PRIORITY_SCHEMA,
      },
    },
    async ({ toAgent, body, timeoutSeconds, priority }) => {
      const result = await askClarification(authed.orgId, self, toAgent, body, timeoutSeconds ?? 60, priority ?? "medium");
      if (!result.ok) return textResult(`Error: ${result.error}`);
      if (result.live) return textResult(result.answer ?? "(no answer text)");
      return textResult(
        `${toAgent} isn't live right now (or didn't reply in time). Logged as a durable question, thread ${result.threadId} — they'll see it via get_messages and can reply to it.`,
      );
    },
  );

  function formatMessage(r: { kind: string; priority: string; awaiting_reply: number; from_agent_name: string; thread_id: string; body: string; file_id: string | null }): string {
    const flags = [r.priority !== "medium" ? r.priority : null, r.awaiting_reply ? "awaiting your reply" : null, r.file_id ? `file attached: ${r.file_id}` : null]
      .filter(Boolean)
      .join(", ");
    return `[${r.kind}${flags ? ", " + flags : ""}] from ${r.from_agent_name} (thread ${r.thread_id}): ${r.body}`;
  }

  const messageLimit = (limit: number | undefined) => pageSize(limit, 20, 100);
  const messagesText = (rows: MessageRecord[], limit: number, peek: boolean, afterId?: string): string => {
    const lines = [`${rows.length} message(s):`, ...rows.map(formatMessage)];
    if (rows.length >= limit) {
      // A peek leaves the returned rows unread, so they would otherwise count as "more".
      const more = countUnreadMessages(authed.orgId, authed.agentId, afterId) - (peek ? rows.filter((r) => !r.read_at).length : 0);
      if (more > 0) lines.push(`(${more} more unread -- call again)`);
    }
    return lines.join("\n");
  };

  server.registerTool(
    "get_messages",
    {
      description:
        "Return new/unread messages addressed to you, and mark them read. Pass peek=true to inspect without marking them read (e.g. a watcher or a manual check that must not steal mail from your real reader).",
      inputSchema: { since: z.string().optional(), peek: z.boolean().optional(), afterId: z.string().optional(), limit: z.number().optional() },
    },
    async ({ since, peek, afterId, limit }) => {
      const cap = messageLimit(limit);
      const effectivePeek = resolvePeekDefault(authed.keyClass, peek);
      const rows = getMessages(authed.orgId, authed.agentId, since, { peek: effectivePeek, afterId, limit: cap });
      if (rows.length === 0) return textResult("No new messages.");
      return textResult(messagesText(rows, cap, effectivePeek, afterId));
    },
  );

  server.registerTool(
    "wait_for_message",
    {
      description:
        // TEACH A MODEL TO WAIT CHEAPLY; DO NOT INVITE IT TO POLL. The old text said "pair with a 55s call on a 60s
        // scheduler tick". MEASURED 2026-09-22: one Codex chat did exactly that, with a ~55 s wait inside a code
        // cell that handed back every 30 s, and spent 787k input tokens (740k cached) while nothing happened.
        // The cost is how OFTEN the model regains control, since each time is a step that re-sends its context,
        // not the hub's wait. Waiting for a teammate is legitimate (pairing, a reply that blocks the task), so
        // the text keeps it and says how to do it with few steps. "End your turn" is advice ONLY where mail is
        // delivered without asking (a mail hook or wake watcher): review of the first version (Codex-OpenCadre-d193)
        // pointed out that this server serves EVERY client, and the Codex desktop app has no working mail hook, so
        // an agent there that ended its turn would never learn of its mail. Elsewhere it checks the inbox next turn.
        "Block until a new message arrives for you or timeoutSeconds elapses (max 280), then return whatever is unread. Waiting is legitimate when you are working with a teammate and need their reply to continue. Each time you regain control, you spend a full step (your whole context is sent again), so wait with FEW steps: pass timeoutSeconds: 280, and if your client runs this inside a code cell, wait on that cell with a matching long yield rather than short repeated waits. Do not loop this to stand by with nothing to do. If your setup delivers mail to you on its own (OpenCadre told you so at the start of this session), end your turn and you will be woken or told at your next turn. If it does not, check your inbox (get_messages) at the start of your next turn instead. Pass peek=true to leave returned messages unread; a peek-wait returns immediately while any unread mail remains.",
      inputSchema: { timeoutSeconds: z.number().optional(), peek: z.boolean().optional(), afterId: z.string().optional(), limit: z.number().optional() },
    },
    async ({ timeoutSeconds, peek, afterId, limit }) => {
      const cap = messageLimit(limit);
      const effectivePeek = resolvePeekDefault(authed.keyClass, peek);
      const rows = await waitForMessage(authed.orgId, authed.agentId, timeoutSeconds ?? 55, { peek: effectivePeek, afterId, limit: cap });
      if (rows.length === 0) return textResult("No new messages (timed out waiting).");
      return textResult(messagesText(rows, cap, effectivePeek, afterId));
    },
  );

  server.registerTool(
    "consume_messages",
    {
      description:
        "Mark specific messages as read after inspecting them with peek (required for watcher-class keys that peek by default). Does not return message bodies.",
      inputSchema: { messageIds: z.array(z.string()).min(1) },
    },
    async ({ messageIds }) => {
      const result = consumeMessages(authed.orgId, authed.agentId, messageIds);
      if (!result.ok) return textResult(`Error: ${result.error}`);
      return textResult(`Consumed ${result.consumed} message(s).`);
    },
  );

  server.registerTool(
    "get_message_status",
    {
      description:
        "Delivery/read status AND full text of every message on a thread you are part of, including ones you've already consumed -- the only way to recover a message's body once get_messages has marked it read. Delivered means it reached the recipient (live push, or returned by a read or peek); read means they consumed it.",
      inputSchema: { threadId: z.string() },
    },
    async ({ threadId }) => {
      const result = getThreadStatus(authed.orgId, authed.agentId, threadId);
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const at = (t: string | null) => (t ? `${t.slice(11, 16)} UTC` : "not yet");
      const lines = result.messages.map((m) => `- ${m.kind} ${m.from} -> ${m.to} · sent ${at(m.created_at)} · delivered ${at(m.delivered_at)} · read ${at(m.read_at)}\n    ${m.body}`);
      return textResult(`${result.messages.length} message(s) on thread ${threadId}:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "search_messages",
    {
      description:
        "Find messages you sent or received -- read or unread -- by text, sender or thread. get_messages returns only unread mail, and get_message_status needs a thread id you already have, so this is how you answer \"where did we discuss X\" or \"what did <agent> tell me about Y\". Read-only: it never marks mail read or delivered. Returns newest first.",
      inputSchema: { query: z.string().optional(), from: z.string().optional(), threadId: z.string().optional(), limit: z.number().optional() },
    },
    async ({ query, from, threadId, limit }) => {
      if (!query?.trim() && !from?.trim() && !threadId?.trim()) {
        return textResult("Error: give at least one of query, from or threadId, or use get_messages for new mail.");
      }
      const rows = searchMessages(authed.orgId, authed.agentId, { query, from, threadId, limit: messageLimit(limit) });
      if (rows.length === 0) return textResult("No messages matched.");
      return textResult(`${rows.length} match(es):\n${rows.map(formatMessage).join("\n")}`);
    },
  );

  server.registerTool(
    "reply",
    {
      description: "Reply on any message thread addressed to you (a question or a plain message). The reply goes to that message's sender on the same thread and clears the awaiting-reply flag if it was a question.",
      inputSchema: { threadId: z.string(), body: z.string() },
    },
    async ({ threadId, body }) => {
      const result = reply(authed.orgId, self, threadId, body);
      if (!result.ok) return textResult(`Error: ${result.error}`);
      return textResult("Reply sent.");
    },
  );

  server.registerTool(
    "get_active_agents",
    {
      description:
        `Clean, current-state snapshot of the agents you can reach in ${area} -- who's online, what each is working on right now, and which files they're editing. Never a message log; one line per agent, always reflects the latest set_status call, not history.`,
      inputSchema: {},
    },
    async () => {
      const agents = listActiveAgents(authed.orgId, authed.agentId);
      if (agents.length === 0) return textResult("No other agents registered yet.");
      const lines = agents.map((a) => {
        const parts = [`${a.state} (${a.state_reason})`];
        if (a.current_task) parts.push(`task: ${a.current_task}`);
        const files = a.editing_files_parsed;
        if (files.length > 0) parts.push(`editing: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` +${files.length - 5} more` : ""}`);
        const usage = usageSummary(a.usage);
        if (usage) parts.push(usage);
        // Which project each agent is in, so a linked project's agent is told apart from your own.
        if (isolated && a.project_key) parts.push(`project: ${projectDisplayName(authed.orgId, a.project_key)}`);
        // A session's name is just a word (sessions PR1), so the line says which tool and project the chat is in.
        const where = a.kind === "session" ? ` (${clientLabel(a.client ?? "auto", a.client ?? undefined)}${a.project_name ? ` in ${a.project_name}` : ""})` : "";
        return `${a.name}${where} — ${parts.join(" | ")}`;
      });
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "set_status",
    {
      description:
        "Announce what you're working on right now and which files you're touching, so the fleet has a clean, current view (via get_active_agents) instead of silence." + COORDINATION_NOTE +
        " Returns a warning (never a block) if another online agent is already editing an overlapping file -- ask before you start, don't assume a lock.",
      inputSchema: { task: z.string().nullable(), files: z.array(z.string()).optional(), phase: z.enum(PHASES).nullable().optional() },
    },
    async ({ task, files, phase }) => {
      const result = setAgentStatus(authed.orgId, authed.agentId, task, files ?? [], phase);
      if (result.collisions.length === 0) return textResult("Status updated.");
      const warnings = result.collisions.map((c) => `${c.agentName} is already editing: ${c.files.join(", ")}`);
      return textResult(`Status updated. Collision warning (advisory, not a lock):\n${warnings.join("\n")}`);
    },
  );

  // --- Timeline (Ambient Awareness v1, slice 1) -----------------------------
  function formatEvent(e: EventRecord): string {
    const who = e.actor_agent_name ?? "system";
    const target = e.target_agent_id === self.id ? " → you" : "";
    return `#${e.seq} ${e.created_at} ${e.type} by ${who}${target} ${clip(e.payload, 300)}`;
  }

  server.registerTool(
    "get_timeline",
    {
      description:
        `Read ${area}'s event timeline: task, approval, message, phase, conflict and decision events in order. Pass \`after\` (the last #seq you saw) to get only what's new.`,
      inputSchema: { after: z.number().optional(), types: z.array(z.string()).optional(), limit: z.number().optional() },
    },
    async ({ after, types, limit }) => {
      // Without a cursor the agent wants what is happening now, not the org's first events.
      const events = listTimeline(authed.orgId, { after, types, limit: limit ?? 30, latest: after === undefined, viewer: authed.agentId });
      return textResult(events.length === 0 ? "No new events." : events.map(formatEvent).join("\n"));
    },
  );

  server.registerTool(
    "wait_for_timeline",
    {
      description:
        // Same trap as wait_for_message above: a model that loops a long-poll pays a full step each time it regains control.
        `Block until new timeline events in ${area} arrive after \`after\` or timeoutSeconds elapses (max 280), then return them. Each time you regain control you spend a full step (your whole context is sent again): do NOT call this in a loop to watch the stream while idle, because that spends tokens while nothing happens. Use it for one bounded wait (timeoutSeconds: 280) on events you are actively expecting; otherwise stop and check the timeline at your next turn.`,
      inputSchema: { after: z.number().optional(), timeoutSeconds: z.number().optional(), types: z.array(z.string()).optional() },
    },
    async ({ after, timeoutSeconds, types }) => {
      const events = await waitForTimeline(authed.orgId, after ?? 0, timeoutSeconds ?? 55, types, authed.agentId);
      return textResult(events.length === 0 ? "No new events (timed out waiting)." : events.map(formatEvent).join("\n"));
    },
  );

  server.registerTool(
    "get_awareness",
    {
      description:
        "Catch up at a safe checkpoint (before starting a subtask, before editing shared files, before committing): a short, prioritized summary of what changed that matters to you since your last check. P1 needs attention now; ack handled items with ack_event.",
      inputSchema: { since: z.number().optional() },
    },
    async ({ since }) => {
      const digest = getAwareness(authed.orgId, authed.agentId, { since, board: true });
      // The caller's own name first: the proxy tells a new chat to call this to learn it, and a rename changes it.
      // The caller's own slice of the work board follows the digest (src/task-board.ts), when it has anything on it.
      return textResult(`You are ${self.name}.
${digest.text || "Nothing new that affects you."}${digest.board?.text ? `\n\n${digest.board.text}` : ""}`);
    },
  );

  server.registerTool(
    "pull_events",
    {
      description:
        "Get events addressed to you that you haven't acknowledged yet (questions, approvals, conflicts, expired claims...). After reading one, call ack_event with its #seq.",
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit }) => {
      sweepTimeline(authed.orgId);
      const events = pullEvents(authed.orgId, authed.agentId, limit);
      return textResult(events.length === 0 ? "Nothing waiting for you." : events.map(formatEvent).join("\n"));
    },
  );

  server.registerTool(
    "ack_event",
    {
      description:
        "Acknowledge an event addressed to you: acknowledged (seen), acted (handled), or dismissed (not relevant). This is how the fleet knows you actually saw it.",
      inputSchema: { seq: z.number(), outcome: z.enum(OUTCOMES) },
    },
    async ({ seq, outcome }) => {
      const result = ackEvent(authed.orgId, authed.agentId, seq, outcome);
      return textResult(result.ok ? `Event #${seq} ${result.delivery.state}.` : `Error: ${result.error}`);
    },
  );

  server.registerTool(
    "record_decision",
    {
      description: "Record a decision the fleet should know about (what was decided, why, and which files or area it affects).",
      inputSchema: { title: z.string(), rationale: z.string().optional(), scope: z.string().optional() },
    },
    async ({ title, rationale, scope }) => {
      if (!title.trim()) return textResult("Error: title is required");
      return textResult(`Recorded: ${formatEvent(recordDecision(authed.orgId, self, { title, rationale, scope }))}`);
    },
  );

  // --- Task board (issue #7) ------------------------------------------------
  // descriptionClip is undefined (full text) for a single-task result (create/claim/renew/release/
  // complete) -- an agent needs its real instructions, not a snippet -- and a fixed clip for
  // list_tasks, where showing every open task's full description at once would be unreadable.
  // Previously this dropped the description entirely in all cases: create_task accepts one, but
  // no tool ever surfaced it back, so no agent could read a task's real instructions through the
  // tool surface at all.
  function formatTask(t: TaskView, descriptionClip?: number, fullDetail = false): string {
    // A corrected row names its replacement when this reader may see it (tasks tranche 2: intentionally new output).
    // Without a visible title the id is not repeated either: the hub withholds the replacement for a reason.
    const superseded = t.superseded
      ? t.superseded_by_title !== null ? ` | superseded by "${t.superseded_by_title}" (id ${t.superseded_by})` : " | superseded by a newer task (title withheld)"
      : "";
    const owner = t.status === "claimed"
      ? ` | claimed by ${t.claimed_by_agent_name}${t.lease_active ? ` until ${t.lease_expires_at}` : " (lease EXPIRED, claimable)"}`
      : "";
    // Only the explicit one-task read expands evidence and correction text; board/action
    // responses keep their excerpts. TaskView has already applied visibility and masking.
    const summary = t.completion_summary ? ` | result: ${fullDetail ? t.completion_summary : clip(t.completion_summary, 150)}` : "";
    // review is only meaningful once a task is done: an open/claimed task is never "unreviewed" in any sense
    // an agent needs to act on, so this stays silent outside status === "done".
    const review = t.status === "done"
      ? t.reviewed
        ? ` | accepted by ${t.reviewed_by_agent_name}`
        : t.required_reviews > 1
          ? ` | UNREVIEWED (${t.review_count}/${t.required_reviews} reviews -- needs accept_task/reject_task from more distinct agents, never the claimant)`
          : " | UNREVIEWED (needs accept_task/reject_task by someone other than the claimant)"
      : "";
    const note = t.review_note ? ` | rejection note: ${fullDetail ? t.review_note : clip(t.review_note, 150)}` : "";
    const requires = t.required_capabilities_list.length ? ` | requires: ${t.required_capabilities_list.join(", ")}` : "";
    const minBudget = t.min_round_budget ? ` | min round budget: ${t.min_round_budget}` : "";
    const reviews = t.required_reviews > 1 && t.status !== "done" ? ` | requires ${t.required_reviews} independent reviews` : "";
    const parent = t.parent_task_id ? ` | subtask of ${t.parent_task_id}` : "";
    // A saved side request names the task it was saved from, when this reader may see it (never blocks either task).
    const sideRequest = t.side_request_of
      ? t.side_request_of_title !== null ? ` | side request of ${t.side_request_of} ("${clip(t.side_request_of_title, 80)}")` : " | side request of another task (title withheld)"
      : "";
    const subtasks = t.subtask_count > 0 ? ` | subtasks: ${t.subtasks_done}/${t.subtask_count} done+verified` : "";
    const description = t.description
      ? `\n    ${descriptionClip ? clip(t.description, descriptionClip) : t.description}`
      : "";
    // The board lane, when it says more than the status does: a hold and its reason, and NEXT's rank.
    // The reason is agents' text: one quoted line (src/agent-text.ts).
    const lane = (t.lane === "held" ? ` | held: ${asData(t.held_reason ?? "no reason given", 80)}` : "") + (t.rank !== null && t.rank !== undefined ? ` | rank ${t.rank}` : "");
    return `[${t.status}] ${t.title} (id ${t.id})${lane}${superseded}${owner}${summary}${review}${note}${requires}${minBudget}${reviews}${parent}${sideRequest}${subtasks}${description}`;
  }
  const taskResult = (r: ReturnType<typeof claimTask>, verb: string) =>
    textResult(r.ok ? `${verb}: ${formatTask(r.task)}` : `Error: ${r.error}`);
  const LEASE_NOTE = " Claims are leases (default 30 min): renew_claim while you work, or the task becomes claimable by others.";

  server.registerTool(
    "create_task",
    {
      description: `Add a task to ${area}'s shared task board so any agent there can claim it.`,
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        project: z.string().optional().describe("Workspace-wide agents only: the project key the task belongs to. A session's tasks always belong to its own project."),
        requiredCapabilities: z.array(z.string()).optional()
          .describe("Capability strings a claimant must already have declared via set_capabilities (e.g. [\"shell\", \"git-write\"]). Omit for no requirement. Prevents an agent whose client can't actually do the work from claiming it, discovered only mid-task."),
        minRoundBudget: z.number().optional()
          .describe("Minimum tool-call round budget a claimant must have declared via set_round_budget. Omit for no minimum. Prevents a bridge with a small round cap from silently truncating a task that genuinely needs many rounds."),
        requiredReviews: z.number().optional()
          .describe("How many DISTINCT agents must accept_task before this finalizes as reviewed. Defaults to 1. Raise it for a load-bearing claim other work will build on, where one reviewer's blind spot isn't enough scrutiny. A single reject_task still bounces it back immediately regardless of this number."),
        parentTaskId: z.string().optional()
          .describe("Makes this a subtask of an existing task -- the plan step of plan/execute/verify/synthesize. The parent's own complete_task is blocked until every subtask is done AND accepted (its own execute+verify), so a parent can only 'synthesize' once its whole plan has actually been carried out."),
        lane: z.enum(["next", "held"]).optional().describe("Where it starts on the work board: next (the default) or held, with heldReason. NOW is only ever a claim."),
        rank: z.number().optional().describe("Its place in NEXT: a whole number 0-100000, smaller first. Unranked tasks come after ranked ones, oldest first."),
        heldReason: z.string().optional().describe('Required with lane "held", e.g. "waiting for operator".'),
      },
    },
    async ({ title, description, project, requiredCapabilities, minRoundBudget, requiredReviews, parentTaskId, lane, rank, heldReason }) => {
      if (!title.trim()) return textResult("Error: title is required");
      try {
        return textResult(`Created: ${formatTask(createTask(authed.orgId, self, { title, description, project, requiredCapabilities, minRoundBudget, requiredReviews, parentTaskId, lane, rank, heldReason }))}`);
      } catch (err) {
        if (!(err instanceof TaskInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  // Save-task (sessions PR1): a side request the user raises mid-task is filed and the agent carries on. A relationship
  // only: never a subtask (a parent can't complete until its subtasks do), never a claim, and the caller's own status,
  // claims and leases are untouched.
  server.registerTool(
    "save_task",
    {
      description: `Save a side request as an open task on ${area}'s board without stopping your current work: when the user asks for something unrelated to what you're doing, file it here and carry on. It is not claimed, not assigned and never blocks your task; any agent (you included, later) can claim it.`,
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        relatedTaskId: z.string().optional().describe("The task you were working on. Defaults to the one task you hold a claim on, if exactly one."),
      },
    },
    async ({ title, description, relatedTaskId }) => {
      if (!title.trim()) return textResult("Error: title is required");
      const related = relatedTaskId?.trim() || soleClaimedTaskId(authed.orgId, authed.agentId);
      try {
        const created = createTask(authed.orgId, self, { title, description, sideRequestOf: related });
        // Re-read as this caller, so the line names the related task by title under the same visibility rule as get_task.
        const task = getTaskById(authed.orgId, { id: authed.agentId }, created.id) ?? created;
        return textResult(`Saved for later: ${formatTask(task)}. Carry on with your current work.`);
      } catch (err) {
        if (!(err instanceof TaskInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  // A correction is its own task LINKED to the one it corrects, never an edit of the filed row --
  // editing would rewrite the record of what someone actually filed. Mirrors supersede_memory, and
  // the row stays readable: `superseded` and `superseded_by_title` appear on every task read, so a
  // reader holding the old row is told what replaced it.
  server.registerTool(
    "supersede_task",
    {
      description:
        `File a correction to a task as its OWN task, linked to the row it corrects. Use this INSTEAD of filing a task whose body says "CORRECTION to <id>" and names no link: the link is what a reader of the old row sees, and a correction nobody can trace is one that gets silently missed. ` +
        `The corrected row is left readable with its status and text untouched -- a correction does not resolve work, it describes it differently. Refuses when the target is unknown or ALREADY superseded (supersede that row instead), so the chain stays one hop deep.`,
      inputSchema: {
        taskId: z.string().describe("The task being corrected. Its `superseded_by` is set to the new task's id."),
        title: z.string(),
        description: z.string().optional(),
        project: z.string().optional(),
        requiredCapabilities: z.array(z.string()).optional(),
        minRoundBudget: z.number().optional(),
        requiredReviews: z.number().optional(),
      },
    },
    async ({ taskId, title, description, project, requiredCapabilities, minRoundBudget, requiredReviews }) => {
      if (!title.trim()) return textResult("Error: title is required");
      try {
        const filed = supersedeTask(authed.orgId, self, taskId, { title, description, project, requiredCapabilities, minRoundBudget, requiredReviews }, { admin: can(callerRole, "tasks.manage") });
        return textResult(`Superseded ${taskId} -> ${filed.id}: ${formatTask(filed)}`);
      } catch (err) {
        if (!(err instanceof TaskInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "set_capabilities",
    {
      description: `Declare what you can actually do (e.g. ["shell", "git-write", "file-write"]) so create_task's requiredCapabilities can be enforced at claim time instead of discovered mid-task. Replaces your whole list each call -- not a merge. The hub does not verify this; it's your own client reporting on itself.`,
      inputSchema: { capabilities: z.array(z.string()) },
    },
    async ({ capabilities }) => {
      const result = setAgentCapabilities(authed.orgId, self.id, capabilities);
      return textResult(result.ok ? `Capabilities set: ${result.capabilities.join(", ") || "(none)"}` : `Error: ${result.error}`);
    },
  );

  server.registerTool(
    "get_capabilities",
    {
      description: "List your own capabilities as declared via set_capabilities.",
      inputSchema: {},
    },
    async () => {
      const capabilities = getAgentCapabilities(authed.orgId, self.id);
      return textResult(capabilities.length ? capabilities.join(", ") : "(none declared)");
    },
  );

  server.registerTool(
    "set_round_budget",
    {
      description: `Declare your bridge's configured tool-call round cap (e.g. MAX_TOOL_ROUNDS) so create_task's minRoundBudget can be enforced at claim time instead of a task silently truncating mid-work. Omit roundBudget (or pass null) to clear a previously-declared budget back to unknown. The hub does not verify this; it's your own client reporting on itself.`,
      inputSchema: { roundBudget: z.number().nullable().optional() },
    },
    async ({ roundBudget }) => {
      const result = setAgentRoundBudget(authed.orgId, self.id, roundBudget ?? null);
      return textResult(result.ok ? `Round budget set: ${result.roundBudget ?? "(cleared)"}` : `Error: ${result.error}`);
    },
  );

  server.registerTool(
    "get_round_budget",
    {
      description: "Your own declared round budget, as set via set_round_budget.",
      inputSchema: {},
    },
    async () => {
      const roundBudget = getAgentRoundBudget(authed.orgId, self.id);
      return textResult(roundBudget === null ? "(none declared)" : String(roundBudget));
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description: `List ${area}'s shared task board: what's open, who has claimed what, and what's done. Check this before starting work so two agents don't take the same task.`,
      inputSchema: {
        status: z.enum(["open", "claimed", "done"]).optional(),
        limit: z.number().optional(),
        board: z.boolean().optional().describe("Show the work board instead: NOW (claimed), NEXT (by rank), HELD (with reasons) and the last 10 DONE."),
      },
    },
    async ({ status, limit, board }) => {
      if (board) {
        const b = taskBoard(authed.orgId, authed.agentId);
        // Each section shows at most a page; its heading says "showing 25 of 140" when there are more.
        const section = (name: "now" | "next" | "held" | "done") => [`${name.toUpperCase()} (${sectionCount(b, name)}):`, ...b[name].map((t) => `  ${formatTask(t, 300)}`)];
        return textResult([
          ...section("now"),
          ...section("next"),
          ...section("held"),
          ...section("done"),
        ].join("\n"));
      }
      // The newest page, chosen in SQL (DESC LIMIT) and shown oldest first: the same rows, order and total as listing
      // every task and keeping the tail, which is what this did before tasks tranche 2.
      const { tasks: shown, total } = listNewestTasks(authed.orgId, authed.agentId, { status, limit: pageSize(limit, 25, 200) });
      if (shown.length === 0) return textResult("No tasks.");
      const lines = shown.map((t) => formatTask(t, 300));
      if (shown.length < total) lines.push(showingNote(shown.length, total, "tasks"));
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "set_task_lane",
    {
      description:
        "Move a task on the work board: to next (unclaimed work, optionally re-ranked) or held (blocked, with a reason such as \"waiting for operator\"). Its creator, its claimant or an admin may. NOW means claiming it: use claim_task, so your WIP cap applies. A claimed task goes back to NEXT by release_task. If someone holds a task you have claimed, claim_task takes it back to NOW. A held task can be claimed only by its creator or an admin.",
      inputSchema: {
        taskId: z.string(),
        lane: z.enum(["now", "next", "held"]),
        rank: z.number().nullable().optional().describe("Its place in NEXT: a whole number 0-100000, smaller first; null clears it."),
        reason: z.string().optional().describe('Required for held, e.g. "waiting for operator".'),
      },
    },
    async ({ taskId, lane, rank, reason }) => {
      const r = setTaskLane(authed.orgId, self, { admin: can(callerRole, "tasks.manage") }, taskId, { lane, rank, reason });
      return textResult(r.ok ? `Moved to ${r.task.lane.toUpperCase()}: ${formatTask(r.task)}` : `Error: ${r.error}`);
    },
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Read one task's full, untruncated details (description, completion summary, rejection note, status, claim, review) without claiming it. " +
        "list_tasks clips long descriptions and completion/rejection text for the board view; use this when you need the complete text of a " +
        "specific task you already know the id of.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const task = getTaskById(authed.orgId, { id: authed.agentId }, taskId);
      return task ? textResult(formatTask(task, undefined, true)) : textResult(`Error: No task found matching "${taskId}"`);
    },
  );

  server.registerTool(
    "claim_task",
    {
      description: "Claim a task before working on it. Fails if another agent holds an active claim." + LEASE_NOTE,
      inputSchema: { taskId: z.string(), leaseSeconds: z.number().optional() },
    },
    async ({ taskId, leaseSeconds }) => taskResult(claimTask(authed.orgId, self, taskId, leaseSeconds, { admin: can(callerRole, "tasks.manage") }), "Claimed"),
  );

  server.registerTool(
    "renew_claim",
    {
      description: "Extend your claim on a task you're still working on." + LEASE_NOTE,
      inputSchema: { taskId: z.string(), leaseSeconds: z.number().optional() },
    },
    async ({ taskId, leaseSeconds }) => taskResult(renewClaim(authed.orgId, self, taskId, leaseSeconds), "Renewed"),
  );

  server.registerTool(
    "release_task",
    {
      description: "Give up your claim so another agent can take the task.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => taskResult(releaseTask(authed.orgId, self, taskId), "Released"),
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task you've claimed as done, with a short summary of the result (e.g. PR link).",
      inputSchema: { taskId: z.string(), summary: z.string().optional() },
    },
    async ({ taskId, summary }) => taskResult(completeTask(authed.orgId, self, taskId, summary), "Completed"),
  );

  const REVIEW_NOTE = " Must be a different agent from the one who completed it: completing your own task is only a claim of done-ness, not confirmation.";

  server.registerTool(
    "accept_task",
    {
      description: "Confirm a done task's completion claim -- the second pair of eyes fleet-style review adds on top of complete_task. Some tasks require more than one independent accept (requiredReviews on create_task); this records your vote and only finalizes once enough distinct agents have accepted." + REVIEW_NOTE,
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const result = acceptTask(authed.orgId, self, taskId);
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const verb = result.task.reviewed ? "Accepted" : "Vote recorded";
      return textResult(`${verb}: ${formatTask(result.task)}`);
    },
  );

  server.registerTool(
    "reject_task",
    {
      description: "Bounce a done task back to its claimant (status returns to claimed, with a fresh 30 min lease) with a note on what's missing." + REVIEW_NOTE,
      inputSchema: { taskId: z.string(), note: z.string().optional() },
    },
    async ({ taskId, note }) => taskResult(rejectTask(authed.orgId, self, taskId, note), "Rejected"),
  );

  // --- Resource locks (design retro #4: a generic mutex for a shared mutable path/branch/lockfile,
  // since the hub can't provision a worktree on a remote agent's own machine) ------------------
  function formatLock(l: { resource_key: string; holder_agent_name: string; lease_expires_at: string; note: string | null }): string {
    const note = l.note ? ` -- ${clip(l.note, 150)}` : "";
    return `${l.resource_key}: held by ${l.holder_agent_name} until ${l.lease_expires_at}${note}`;
  }
  const RESOURCE_LEASE_NOTE = " Leases (default 30 min): renew_resource_lock while you work, or it becomes claimable by others.";

  server.registerTool(
    "claim_resource",
    {
      description: `Claim exclusive use of a named resource (a filesystem path, a branch name, anything two agents might otherwise collide on) before mutating it. Fails if someone else already holds an unexpired lease. If you already hold it, the reply starts "Already held by you" with alreadyHeld: true, and the lease moves to leaseSeconds from now only if that ends later than it does now; it is never shortened.${RESOURCE_LEASE_NOTE}`,
      inputSchema: { resourceKey: z.string(), leaseSeconds: z.number().optional(), note: z.string().optional().describe("Freeform, e.g. what you're using it for.") },
    },
    async ({ resourceKey, leaseSeconds, note }) => {
      try {
        const result = claimResource(authed.orgId, self, resourceKey, leaseSeconds, note);
        if (!result.ok) return textResult(`Error: ${result.error}`);
        if (!result.alreadyHeld) return textResult(`Claimed: ${formatLock(result.lock)}`);
        return textResult(`Already held by you (alreadyHeld: true; ${result.leaseChanged ? "lease extended" : "lease unchanged, it already ends later than the lease you asked for"}): ${formatLock(result.lock)}`);
      } catch (err) {
        if (!(err instanceof ResourceLockInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "renew_resource_lock",
    {
      description: "Extend your own lease on a resource you already hold, so you don't lose it while still working. The lease becomes leaseSeconds (default 30 min) from now, unless it already ends later: a renew never shortens a lease, and the reply starts \"Lease kept, not shortened\" when it keeps the current end. Works after your lease lapsed if nobody else has claimed the resource since. To give it up early, use release_resource.",
      inputSchema: { resourceKey: z.string(), leaseSeconds: z.number().optional() },
    },
    async ({ resourceKey, leaseSeconds }) => {
      const result = renewResourceLock(authed.orgId, self, resourceKey, leaseSeconds);
      if (!result.ok) return textResult(`Error: ${result.error}`);
      return textResult(`${result.leaseChanged ? "Renewed" : "Lease kept, not shortened"}: ${formatLock(result.lock)}`);
    },
  );

  server.registerTool(
    "release_resource",
    {
      description: "Give up your lock on a resource so another agent can claim it.",
      inputSchema: { resourceKey: z.string() },
    },
    async ({ resourceKey }) => {
      const result = releaseResource(authed.orgId, self, resourceKey);
      return textResult(result.ok ? `Released: ${resourceKey}` : `Error: ${result.error}`);
    },
  );

  server.registerTool(
    "list_resource_locks",
    {
      description: `List every resource lock in ${area}, held or recently lapsed. Check this before claiming a shared path/branch so two agents don't collide.`,
      inputSchema: {},
    },
    async () => {
      const locks = listResourceLocks(authed.orgId, { orgId: authed.orgId, agentId: authed.agentId });
      return textResult(locks.length ? locks.map(formatLock).join("\n") : "No resource locks.");
    },
  );

  // --- Blackboard (Stage 2 retro finding: a shared org-wide fact any agent can read without having
  // been on the thread where it was decided, instead of N^2 point-to-point messaging) -------------
  function formatFact(f: { key: string; value: string; version: number; set_by_agent_name: string; updated_at: string }): string {
    return `${f.key} = ${clip(f.value, 300)} (v${f.version}, set by ${f.set_by_agent_name}, ${f.updated_at})`;
  }

  server.registerTool(
    "set_fact",
    {
      description: `Set a shared fact any agent in ${area} can read (e.g. "deploy.target" -> "vps-prod-1"). Overwrites any existing value for the same key by default. Pass expectedVersion (from a prior get_fact/list_facts) to fail instead of overwriting if someone else changed it since you last read it -- use this for disputed facts two agents might race to set.`,
      inputSchema: {
        key: z.string().describe('Up to 200 chars, e.g. "deploy.target" or "chosen-approach".'),
        value: z.string(),
        expectedVersion: z.number().optional().describe("Only succeed if the fact is still at this version; fails with the current value otherwise."),
      },
    },
    async ({ key, value, expectedVersion }) => {
      try {
        const result = setFact(authed.orgId, self, key, value, { expectedVersion });
        if (!result.ok) return textResult(`Error: ${result.error}${result.current ? ` | current: ${formatFact(result.current)}` : ""}`);
        return textResult(`Set: ${formatFact(result.fact)}`);
      } catch (err) {
        if (!(err instanceof BlackboardInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "get_fact",
    {
      description: "Read one shared fact by key.",
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      const fact = getFact(authed.orgId, key, { orgId: authed.orgId, agentId: authed.agentId });
      return textResult(fact ? formatFact(fact) : `No fact found for key "${key}"`);
    },
  );

  server.registerTool(
    "list_facts",
    {
      description: `List every shared fact in ${area}. Check this before asking another agent something that might already be on the blackboard.`,
      inputSchema: { prefix: z.string().optional().describe('Only keys starting with this, e.g. "deploy." for every deploy-related fact.') },
    },
    async ({ prefix }) => {
      const facts = listFacts(authed.orgId, { prefix }, { orgId: authed.orgId, agentId: authed.agentId });
      return textResult(facts.length ? facts.map(formatFact).join("\n") : "No facts set.");
    },
  );

  server.registerTool(
    "delete_fact",
    {
      description: "Remove a shared fact -- use when it's no longer true and leaving a stale value would mislead other agents more than having none at all.",
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      const result = deleteFact(authed.orgId, self, key);
      return textResult(result.ok ? `Deleted: ${key}` : `Error: ${result.error}`);
    },
  );

  // --- Agent reliability (Stage 2 retro finding: real outcome history, the honest foundation a
  // learned trust/routing weight system would train on -- not the learning itself) ---------------
  function formatReliability(r: { agent_name: string; accepted: number; rejected: number; total: number; accept_rate: number | null }): string {
    const rate = r.accept_rate === null ? "no history yet" : `${Math.round(r.accept_rate * 100)}%`;
    return `${r.agent_name}: ${r.accepted} accepted, ${r.rejected} rejected (${r.total} total, ${rate})`;
  }

  server.registerTool(
    "get_agent_reliability",
    {
      description: "An agent's real task outcome history: how many of its completed tasks were accepted vs rejected by a distinct reviewer (never self-reported). Check this before routing risky or load-bearing work to someone.",
      inputSchema: { agentId: z.string().optional().describe("Defaults to yourself.") },
    },
    async ({ agentId }) => textResult(formatReliability(getAgentReliability(authed.orgId, agentId ?? self.id, { orgId: authed.orgId, agentId: authed.agentId }))),
  );

  server.registerTool(
    "list_agent_reliability",
    {
      description: `Every agent in ${area} with at least one reviewed task, most-reliable first. Agents with no review history yet are omitted, not shown at 0%.`,
      inputSchema: {},
    },
    async () => {
      const rows = listAgentReliability(authed.orgId, { orgId: authed.orgId, agentId: authed.agentId });
      return textResult(rows.length ? rows.map(formatReliability).join("\n") : "No reviewed tasks yet.");
    },
  );

  server.registerTool(
    "get_task_shape_stats",
    {
      description: `Telemetry for ${area}'s task board, grouped by required-capabilities shape: average end-to-end lifecycle time and accept/reject rate for completed tasks of that shape. This is data, not a decision -- use it to judge whether a shape (e.g. tasks needing shell+git) should be split smaller or scoped differently, the same signal an automated granularity-retraining loop would eventually consume.`,
      inputSchema: {},
    },
    async () => {
      const rows = getTaskShapeStats(authed.orgId, { orgId: authed.orgId, agentId: authed.agentId });
      if (!rows.length) return textResult("No completed tasks yet.");
      const lines = rows.map((r) => {
        const shape = r.shape.length ? r.shape.join(", ") : "(no required capabilities)";
        const lifecycle = r.avgLifecycleSeconds === null ? "n/a" : `${Math.round(r.avgLifecycleSeconds / 60)}m avg lifecycle`;
        const rate = r.acceptRate === null ? "no review history" : `${Math.round(r.acceptRate * 100)}% accepted (${r.accepted}/${r.accepted + r.rejected})`;
        return `${shape}: ${r.completedCount} completed, ${lifecycle}, ${rate}`;
      });
      return textResult(lines.join("\n"));
    },
  );

  // --- Shared project memory -------------------------------------------------
  function formatMemory(m: MemoryRecord, bodyClip?: number): string {
    const status = m.status === "archived" ? ` [ARCHIVED${m.superseded_by ? `, superseded by ${m.superseded_by}` : ""}${m.archived_reason ? `: ${clip(m.archived_reason, 150)}` : ""}]` : "";
    const tag = m.tag ? ` #${m.tag}` : "";
    const body = bodyClip ? clip(m.body, bodyClip) : m.body;
    return `${m.title} (id ${m.id})${tag}${status}\n    ${body}`;
  }

  server.registerTool(
    "remember",
    {
      description: `Record a durable, searchable note in ${area}'s shared project memory: an architectural decision, a gotcha, "we already tried X and it didn't work" -- anything that should outlive this conversation. Not for ephemeral status; use set_status or send_message for that.`,
      inputSchema: { title: z.string(), body: z.string(), tag: z.string().optional().describe("Freeform label to group related entries (e.g. a subsystem name); optional.") },
    },
    async ({ title, body, tag }) => {
      try {
        return textResult(`Remembered: ${formatMemory(createMemory(authed.orgId, self, { title, body, tag }))}`);
      } catch (err) {
        if (!(err instanceof MemoryInputError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      description: `List ${area}'s shared project memory, most recent first. Archived (stale/superseded) entries are hidden unless includeArchived is set.`,
      inputSchema: {
        tag: z.string().optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ tag, includeArchived, limit }) => {
      const { entries, nextCursor } = listMemory(authed.orgId, { tag, includeArchived, limit: pageSize(limit, 25, 200), viewer: { orgId: authed.orgId, agentId: authed.agentId } });
      if (entries.length === 0) return textResult("No memory entries.");
      const lines = entries.map((m) => formatMemory(m, 300));
      if (nextCursor !== undefined) lines.push(`(more available -- pass before=${nextCursor} for the next page)`);
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "search_memory",
    {
      description: `Case-insensitive substring search over ${area}'s shared memory titles and bodies (not semantic search). Archived entries are hidden unless includeArchived is set.`,
      inputSchema: {
        query: z.string(),
        tag: z.string().optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ query, tag, includeArchived, limit }) => {
      const { entries, nextCursor } = searchMemory(authed.orgId, query, { tag, includeArchived, limit: pageSize(limit, 25, 200), viewer: { orgId: authed.orgId, agentId: authed.agentId } });
      if (entries.length === 0) return textResult(`No memory entries match "${query}".`);
      const lines = entries.map((m) => formatMemory(m, 300));
      if (nextCursor !== undefined) lines.push(`(more available -- pass before=${nextCursor} for the next page)`);
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_memory",
    {
      description: "Fetch one memory entry by id in full, including its archived/superseded status if any.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const entry = getMemory(authed.orgId, id, { orgId: authed.orgId, agentId: authed.agentId });
      return textResult(entry ? formatMemory(entry) : `Error: No memory entry found matching "${id}"`);
    },
  );

  server.registerTool(
    "archive_memory",
    {
      description: "Mark a memory entry stale/no-longer-current, with an optional reason. It stays retrievable by id (get_memory) but drops out of recall/search_memory by default.",
      inputSchema: { id: z.string(), reason: z.string().optional() },
    },
    async ({ id, reason }) => {
      const result = archiveMemory(authed.orgId, self, id, reason);
      return textResult(result.ok ? `Archived: ${formatMemory(result.entry)}` : `Error: ${result.error}`);
    },
  );

  server.registerTool(
    "supersede_memory",
    {
      description: "Replace a memory entry with a fresh one: creates the new entry and archives the old one with a pointer to it, in one step. Use this instead of archive_memory + remember when a newer note replaces an older one outright.",
      inputSchema: { id: z.string(), title: z.string(), body: z.string(), tag: z.string().optional() },
    },
    async ({ id, title, body, tag }) => {
      const result = supersedeMemory(authed.orgId, self, id, { title, body, tag });
      return textResult(result.ok ? `Superseded ${id}: ${formatMemory(result.entry)}` : `Error: ${result.error}`);
    },
  );

  // --- Fleet goal (/goal) -----------------------------------------------------
  // One workspace-wide goal, not a per-agent one: "all agents work toward it" only means something
  // if everyone is looking at the same text. Any agent may call set_goal (like create_task) --
  // Claude-Supervisor being the one who actually does is a fleet-protocol convention, not a
  // permission the hub enforces by name. A goal.set event fires at priority 2 for every other
  // agent (src/policy.ts), so it surfaces in the next awareness digest instead of getting buried.
  server.registerTool(
    "set_goal",
    {
      description:
        "Set (or replace) the current goal, so every connected agent sees it in their next awareness digest. " +
        "While projects are kept apart it is your project's goal; otherwise it is the workspace's. " +
        "Setting a new one replaces the old, which stays recoverable in the timeline.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      if (!text.trim()) return textResult("Error: text is required");
      let goal: GoalRecord;
      try {
        goal = setGoal(authed.orgId, self, text);
      } catch (err) {
        if (!(err instanceof NoNamespaceError)) throw err;
        return textResult(`Error: ${err.message}`);
      }
      return textResult(`Goal set: "${goal.text}" (by ${goal.set_by_agent_name} at ${goal.set_at})`);
    },
  );

  server.registerTool(
    "get_goal",
    {
      description: "Read the current goal (your project's while projects are kept apart, plus the workspace goal if one is set).",
      inputSchema: {},
    },
    async () => {
      const { project, workspace } = getGoals(authed.orgId, { orgId: authed.orgId, agentId: authed.agentId });
      const line = (label: string, goal: GoalRecord) => `${label}"${goal.text}" (set by ${goal.set_by_agent_name} at ${goal.set_at})`;
      const lines = [project && line("Project goal: ", project), workspace && line(project ? "Workspace goal: " : "", workspace)].filter(Boolean);
      return textResult(lines.length ? lines.join("\n") : "No goal set yet.");
    },
  );

  // --- Approval gate (issue #10) --------------------------------------------
  function formatApproval(a: ApprovalRecord): string {
    // A person's decision names the person; the member agent they acted through is plumbing.
    const by = a.decided_by_person_name ?? a.decided_by_agent_name;
    const decided = by ? ` by ${by}${a.decision_note ? ` ("${a.decision_note}")` : ""}` : "";
    const expiry = a.status === "pending" ? ` | expires ${a.expires_at}` : "";
    const head = `${a.action} (${a.risk} risk, requested by ${a.requested_by_agent_name}, id ${a.id})`;
    // An approved row no person decided (an agent's decision from before migration 53) is not a clearance: never
    // rendered as an actionable APPROVED.
    if (a.status === "approved" && !a.decided_by_person_id) {
      return `[NOT CLEARED] ${head} was marked approved${decided}, but not by a person, so it is not a clearance: do not perform the action. A person has to approve it in OpenCadre.`;
    }
    // Nobody decided a withdrawn row, so there is no "by": the agent that asked took it back.
    if (a.status === "withdrawn") {
      return `[WITHDRAWN] ${head} was withdrawn by the agent that asked${a.decision_note ? ` ("${a.decision_note}")` : ""}: do not perform the action.`;
    }
    return `[${a.status.toUpperCase()}] ${head}${decided}${expiry}`;
  }
  /** The record a program reads instead of the text (the DeepSeek shell guard does): who may decide, and whether a PERSON
   * did. Identity is never inferred from display text; a hub from before this field reports none, and callers fail closed. */
  function approvalResult(a: ApprovalRecord, extra = "") {
    return {
      content: [{ type: "text" as const, text: formatApproval(a) + extra }],
      structuredContent: {
        approval: {
          id: a.id, status: a.status, category: a.category, decider_kind: a.decider_kind,
          decided_by_person_id: a.decided_by_person_id, decided_via: a.decided_via, expires_at: a.expires_at,
        },
      },
    };
  }
  const GATE_NOTE = " Only APPROVED means go. PENDING means keep waiting (wait_for_approval); DENIED, EXPIRED or WITHDRAWN means do not perform the action.";

  server.registerTool(
    "request_approval",
    {
      description:
        "Ask a person to approve a risky action BEFORE you do it (deploys, deletions, force pushes, spending money, sending external email). A signed-in person decides it in OpenCadre, on their phone or computer; no agent can. Blocks up to waitSeconds for a decision." + GATE_NOTE,
      inputSchema: {
        action: z.string(),
        details: z.string().optional(),
        risk: z.enum(["low", "medium", "high"]).optional(),
        approver: z.string().optional(),
        waitSeconds: z.number().optional(),
        expiresInSeconds: z.number().optional(),
        category: z.string().optional(),
        notifyOnly: z.boolean().optional(),
      },
    },
    async ({ action, details, risk, approver, waitSeconds, expiresInSeconds, category, notifyOnly }) => {
      try {
        const a = await requestApproval(authed.orgId, self, { action, details, risk, approver, waitSeconds: waitSeconds ?? 60, expiresInSeconds, category, notifyOnly });
        return approvalResult(a);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "wait_for_approval",
    {
      description: "Keep waiting (up to waitSeconds, max 280) for a decision on an approval request you made." + GATE_NOTE,
      inputSchema: { approvalId: z.string(), waitSeconds: z.number().optional() },
    },
    async ({ approvalId, waitSeconds }) => {
      const a = await waitForApproval(authed.orgId, approvalId, waitSeconds ?? 60, authed.agentId);
      return a ? approvalResult(a) : textResult(`Error: No approval request found matching "${approvalId}"`);
    },
  );

  server.registerTool(
    "list_approvals",
    {
      description: `List approval requests in ${area}, e.g. status=pending to see what's waiting for a decision. By default it leaves out notify-only [NOTED] records (commands an approval gate reported without asking) and says how many it left out; pass includeNoted: true, or status=noted, to list them.`,
      inputSchema: {
        status: z.enum(["pending", "approved", "denied", "expired", "noted", "withdrawn"]).optional(),
        limit: z.number().optional(),
        includeNoted: z.boolean().optional().describe("Also list notify-only [NOTED] records. Default false."),
      },
    },
    async ({ status, limit, includeNoted }) => {
      // Notify-only records are left out unless asked for (board task cf34b4c2); a status is always an explicit ask.
      const hideNoted = !status && includeNoted !== true;
      const list = listApprovals(authed.orgId, { status, viewer: authed.agentId, hideNoted });
      const hidden = hideNoted ? countNotedApprovals(authed.orgId, authed.agentId) : 0;
      const hiddenNote = hidden ? `(${hidden} notify-only [NOTED] records hidden -- pass includeNoted: true to list them)` : null;
      if (list.length === 0) return textResult(hiddenNote ? `No approval requests other than notify-only ones.\n${hiddenNote}` : "No approval requests.");
      // listApprovals is newest-first, so the most recent page is the head.
      const shown = list.slice(0, pageSize(limit, 25, 200));
      const lines = shown.map(formatApproval);
      if (shown.length < list.length) lines.push(showingNote(shown.length, list.length, "approval requests"));
      if (hiddenNote) lines.push(hiddenNote);
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "decide_approval",
    {
      description:
        "Approve or deny a pending approval request that an agent may decide. A clearance (every request today) needs a PERSON: it is decided in OpenCadre on their phone or computer, and this tool refuses it for any agent, you included. You can't decide your own requests. Pass grantMinutes (max 480) with an approval to let that agent do the same category of action without asking for that long.",
      inputSchema: { approvalId: z.string(), decision: z.enum(["approve", "deny"]), note: z.string().optional(), grantMinutes: z.number().optional() },
    },
    async ({ approvalId, decision, note, grantMinutes }) => {
      if (!can(callerRole, "approval.decide")) return textResult("Error: not permitted");
      // Never a person: MCP is authenticated by an agent key, a device credential or a connector token, each driven by a
      // model. A connector token names the person who approved the CONNECTION, not this decision.
      const r = decideApproval(authed.orgId, { ...self, person: null }, approvalId, decision, note, { grantMinutes });
      if (!r.ok) return textResult(`Error: ${r.error}`);
      const grant = r.grant
        ? `\nGrant: ${r.grant.agent_name} may run "${r.grant.category}" actions without asking until ${r.grant.expires_at} (id ${r.grant.id})`
        : "";
      return approvalResult(r.approval, grant);
    },
  );

  server.registerTool(
    "withdraw_approval",
    {
      description:
        "Withdraw an approval request YOU made that is still pending, e.g. because you no longer need to run the action. It is marked WITHDRAWN, nobody can approve it after that, and anything waiting on it stops. Only the agent that asked can withdraw a request: the same agent identity, so sessions that share one (a folder agent, one device credential) can withdraw each other's requests.",
      inputSchema: { approvalId: z.string(), note: z.string().optional().describe("Why, shown to the people who would have decided it.") },
    },
    async ({ approvalId, note }) => {
      const r = withdrawApproval(authed.orgId, self, approvalId, note);
      return r.ok ? approvalResult(r.approval) : textResult(`Error: ${r.error}`);
    },
  );

  server.registerTool(
    "list_approval_grants",
    {
      description: `List active time-boxed approval grants in ${area}: which agent may do which category of risky action without asking, and until when.`,
      inputSchema: {},
    },
    async () => {
      const grants = listApprovalGrants(authed.orgId, authed.agentId);
      return textResult(grants.length === 0
        ? "No active grants."
        : grants.map((g) => `${g.agent_name}: "${g.category}" until ${g.expires_at}, granted by ${g.granted_by_person_name ?? g.granted_by_agent_name} (id ${g.id})`).join("\n"));
    },
  );

  server.registerTool(
    "revoke_approval_grant",
    {
      description: "Revoke a time-boxed approval grant immediately.",
      inputSchema: { grantId: z.string() },
    },
    async ({ grantId }) => {
      if (!can(callerRole, "approvalGrant.revoke")) return textResult("Error: not permitted");
      return textResult(revokeApprovalGrant(authed.orgId, grantId, self) ? "Grant revoked." : "Error: grant not found");
    },
  );

  server.registerTool(
    "share_file",
    {
      description:
        "Upload a file (.md or .pdf only) and send it to another agent in one call. contentBase64 is the raw file content, base64-encoded.",
      inputSchema: {
        toAgent: z.string(),
        filename: z.string(),
        mimeType: z.string(),
        contentBase64: z.string(),
        message: z.string(),
        priority: PRIORITY_SCHEMA,
      },
    },
    async ({ toAgent, filename, mimeType, contentBase64, message, priority }) => {
      let buf: Buffer;
      try {
        buf = Buffer.from(contentBase64, "base64");
      } catch {
        return textResult("Error: contentBase64 is not valid base64.");
      }
      const result = await shareFile(authed.orgId, self, toAgent, filename, mimeType, buf, message, priority ?? "medium");
      if (!result.ok) return textResult(`Error: ${result.error}`);
      // Masked for consistency with the stored copy (docs/decisions #1789), even though this confirmation only
      // ever echoes the caller's own just-typed filename back to them.
      return textResult(`Shared ${maskSecrets(filename)} with ${toAgent} (${result.delivered}). File: ${result.fileId}, thread: ${result.threadId}`);
    },
  );

  server.registerTool(
    "download_file",
    {
      description: "Download a file by its id (from a message's file_id) as base64-encoded content.",
      inputSchema: { fileId: z.string() },
    },
    async ({ fileId }) => {
      const file = getFile(authed.orgId, fileId, { agentId: authed.agentId, role: authed.role });
      if (!file) return textResult(`Error: no file found with id ${fileId}`);
      return {
        content: [{
          type: "text" as const,
          text: `filename: ${file.filename}\nmimeType: ${file.mime_type}\nsizeBytes: ${file.size_bytes}\ncontentBase64: ${Buffer.from(file.content).toString("base64")}`,
        }],
      };
    },
  );

  server.registerTool(
    "set_wip_cap",
    {
      description:
        "Admin only. Set the WIP cap: the most live task claims one agent may hold before claim_task refuses a new one. The cap is per agent, by its home project: each agent's limit is its home project's cap, else the workspace default. project is a project key (github.com/owner/repo); leave it out, or pass \"*\", for the workspace default. cap is 1-50, or null for no cap (on a project, null means unlimited there even if the workspace default has a cap). From an agent's key you may only tighten a cap (set one where none applies, or lower it); raising or removing one takes a person in OpenCadre.",
      inputSchema: { project: z.string().optional(), cap: z.number().nullable() },
    },
    async ({ project: rawProject, cap }) => {
      if (!can(callerRole, "projectSettings.write")) return textResult("Error: not permitted");
      const project = parseProjectParam(rawProject);
      if (project === null) return textResult("Error: project must be a project key such as github.com/owner/repo");
      try {
        const set = setWipCap(authed.orgId, { agent: self, personId: null }, project, cap);
        return textResult(`WIP cap for ${set.project || "the workspace default"}: ${set.wipCap ?? "none"} (was ${set.previous ?? "none"}).`);
      } catch (err) {
        if (err instanceof ProjectSettingsError) return textResult(`Error: ${err.message}`);
        throw err;
      }
    },
  );

  server.registerTool(
    "register_webhook",
    {
      description:
        "Register a webhook URL that gets POSTed instantly whenever a message arrives for you while you have no live connection open -- turns silent async delivery into a real, event-driven wake-up (e.g. a Cursor Automation's webhook trigger URL). Pass url=null to clear it. authHeader is sent verbatim as the Authorization header on the webhook POST, if your receiving platform requires one.",
      inputSchema: { url: z.string().nullable(), authHeader: z.string().nullable().optional() },
    },
    async ({ url, authHeader }) => {
      if (typeof authHeader === "string") {
        const check = validateWebhookAuthHeader(authHeader);
        if (!check.ok) return textResult(`Error: ${check.error}`);
      }
      if (url) {
        const check = validateWebhookUrl(url);
        if (!check.ok) return textResult(`Error: ${check.error}`);
      }
      setAgentWebhook(authed.orgId, authed.agentId, url, authHeader ?? null);
      return textResult(url ? `Webhook registered: ${url}` : "Webhook cleared.");
    },
  );

  return server;
}

/** Design retro finding (Stage 1, "fast, token efficient"): a standards-compliant MCP client
 * (Claude Code and any other client using the official SDK, not our own bridge scripts below,
 * which speak raw tools/call over HTTP with no session negotiation) sends `initialize` before its
 * first tool call on every new transport. When the server built a brand-new McpServer -- re-running
 * every server.registerTool() call -- and threw it away after a single request/response, that meant
 * paying the full registration cost and an extra initialize round trip on literally every tool call,
 * not just once per conversation.
 *
 * Real per-session reuse: on `initialize`, this mints a real session id (the SDK's own
 * sessionIdGenerator/onsessioninitialized hook) and keeps that session's McpServer + transport pair
 * alive in mcpSessions, keyed by that id. Every later request on the SAME transport connection
 * carries the id back in the `mcp-session-id` header; matching it skips rebuilding the server
 * entirely and calls handleRequest again on the SAME already-connected transport -- the officially
 * supported "stateful" mode of StreamableHTTPServerTransport, not a home-grown shortcut.
 *
 * Security is unchanged, not weakened, by any of this: every request -- session or not -- still runs
 * the SAME authenticateAgentKey/checkDeviceSession check above before this function is even called.
 * A session id alone is never treated as proof of identity; routeMcpTransport below verifies the
 * bearer token on THIS request still resolves to the exact (orgId, agentId) the session was minted
 * for, so a stolen session id without the matching key is worthless, and a differently-authed caller
 * can never piggyback on another agent's already-built tool set.
 *
 * Callers that never negotiate a session at all -- our own scripts/deepseek-agent-bridge.mjs, a bare
 * curl, anything sending tools/call directly with no prior initialize -- fall through to exactly the
 * previous one-shot behavior: a fresh McpServer, a stateless transport (sessionIdGenerator:
 * undefined), closed after that single response. Nothing changes for them. */
interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  orgId: string;
  agentId: string;
  lastUsedAt: number;
}
const mcpSessions = new Map<string, McpSession>();

const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Sweeps sessions idle past the timeout. Exported so tests can force a sweep instead of waiting on
 * the real interval below. */
export function sweepIdleMcpSessions(now = Date.now()): number {
  let closed = 0;
  for (const [id, session] of mcpSessions) {
    if (now - session.lastUsedAt <= MCP_SESSION_IDLE_MS) continue;
    mcpSessions.delete(id);
    void session.transport.close();
    void session.server.close();
    closed++;
  }
  return closed;
}
if (!process.env.VITEST) setInterval(() => sweepIdleMcpSessions(), 5 * 60 * 1000).unref();

/** True only for a lone (never batched, per the MCP spec) JSON-RPC `initialize` call. */
function isInitializeRequest(body: unknown): boolean {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) && (body as { method?: unknown }).method === "initialize";
}

async function routeMcpTransport(
  authed: AuthedAgent,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

  if (sessionId) {
    const session = mcpSessions.get(sessionId);
    if (!session) {
      // The SDK's own convention for an unrecognized/expired session id: the client re-initializes.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MCP session not found or expired; initialize a new one" }));
      return;
    }
    // The session id names a server-side object, not a credential -- this request's OWN bearer token
    // must independently prove it's still the same agent the session was minted for.
    if (session.orgId !== authed.orgId || session.agentId !== authed.agentId) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "This API key doesn't match the agent this MCP session belongs to." }));
      return;
    }
    session.lastUsedAt = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (isInitializeRequest(req.body)) {
    const server = buildMcpServer(authed);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        mcpSessions.set(newSessionId, { server, transport, orgId: authed.orgId, agentId: authed.agentId, lastUsedAt: Date.now() });
      },
    });
    // A transport-level close (the client's connection dropped mid-initialize, before a session id
    // was ever minted) must not leak a half-built server that onsessioninitialized never got to store.
    transport.onclose = () => {
      if (transport.sessionId) mcpSessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // No session id, and not an initialize call: a stateless one-shot caller (our own bridge scripts,
  // a bare curl) that never negotiates a session at all. Exactly the previous behavior.
  await answerStateless(authed, req, res);
}

/** True for a request that asks for no seat and needs none: the header is set, it names no MCP session, and
 * nothing in it is a tool call (a batch is checked whole, so a tool call can never ride along seatless). */
function wantsNoSeat(req: IncomingMessage & { body?: unknown }): boolean {
  if (!/^(1|true)$/i.test(String(req.headers[DEFER_SEAT_HEADER] ?? ""))) return false;
  if (req.headers["mcp-session-id"]) return false;
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  return messages.every((m) => m && typeof m === "object" && (m as { method?: unknown }).method !== "tools/call");
}

/** One request on a throwaway server and a stateless transport: no session id is minted or bound. */
async function answerStateless(authed: AuthedAgent, req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  const server = buildMcpServer(authed);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
