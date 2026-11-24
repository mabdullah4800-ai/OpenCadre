// OpenCadre console. Vanilla JS, no build step. All server data is inserted
// with textContent -- never innerHTML -- so agent-supplied strings can't inject markup.

const KEY_STORE = "opencadre.agentKey";
const POLL_MS = 4000;
const HOLD_MS = 900;

const $ = (id) => document.getElementById(id);
const store = {
  get() { try { return localStorage.getItem(KEY_STORE); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY_STORE, v); } catch { /* private mode: session only */ } },
  clear() { try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } },
};

let agentKey = store.get();
let me = null;
let authMode = "key"; // "key" | "session"
let currentWorkspace = null; // orgId, session mode only
let currentWorkspaceRole = null; // "owner" | "admin" | "member", session mode only
let person = null; // {id, name, email} from /v1/auth/me, session mode only
// Every view has its own address (#/inbox, #/fleet ...), so the back button, a reload and a shared link all land on the
// view they name. Overview is the default landing page (docs/design/HUB_REDESIGN.md 1.1/2.3). The phone notification's
// #approval-<id> link is a different shape and is left to its own handler.
const ROUTE_OF_TAB = { overview: "home", fleet: "agents", timeline: "activity", connect: "add-computer" };
const TAB_OF_ROUTE = { ...Object.fromEntries(Object.entries(ROUTE_OF_TAB).map(([tab, route]) => [route, tab])), updates: "timeline" };
const routeOf = (tab) => ROUTE_OF_TAB[tab] ?? tab;
const tabFromHash = () => {
  const match = location.hash.match(/^#\/([a-z-]+)/);
  const tab = match ? TAB_OF_ROUTE[match[1]] ?? match[1] : null;
  return tab && document.querySelector(`.panel[data-panel="${tab}"]`) ? tab : null;
};
let activeTab = tabFromHash() ?? "overview";
let pollTimer = null;
let liveSocket = null;
let firstRefreshDone = false;
// The failure the "Couldn't refresh" line is showing, as "<step> <error name> <status>", or null while refreshes succeed.
let refreshFailure = null;
let noticeOpen = new Set();
const noticeHolds = []; // the generation of each refresh still out
let wsConnected = false;
let wsReconnectTimer = null;
let lastKnownPaused; // undefined until the first render, so applyRole()'s initial paint always counts as "known"
// Bumped whenever the console changes whose data it shows (sign in, a workspace switch, sign out), so a refresh that
// started before the change never renders into the view after it. In session mode agentKey is null for every
// workspace, so the key alone cannot tell workspace A's late response from workspace B's.
let consoleGeneration = 0;
const refreshReadScopes = new Set();
// Taken by every sign-in, workspace entry and sign-out when it STARTS (the generation moves only once one lands). A
// sign-in or entry whose ticket is no longer the latest stops at its next await: a sign-out, or a later choice, wins,
// so a login still in flight when someone signs out can never sign them back in.
let identityTicket = 0;

function updateLiveIndicator(connected) {
  const dot = $("live-dot");
  const text = $("live-status-text");
  if (!dot || !text) return;
  if (connected) {
    dot.className = "live-dot is-live";
    text.textContent = "Live";
  } else {
    dot.className = "live-dot is-polling";
    text.textContent = "Updating every few seconds";
  }
}

// True once there's a live identity to poll or push for, in either auth mode.
const isSignedIn = () => (authMode === "session" ? Boolean(currentWorkspace) : Boolean(agentKey));

function connectLiveWs() {
  if (!isSignedIn() || typeof WebSocket === "undefined") {
    updateLiveIndicator(false);
    return;
  }
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // Session mode: the browser sends the oc_session cookie on same-origin WebSocket handshakes on its
    // own, so ?workspace= is all this needs (src/live-auth.ts). Key mode keeps ?apiKey=.
    const wsUrl = authMode === "session"
      ? `${protocol}//${location.host}/live?workspace=${encodeURIComponent(currentWorkspace)}`
      : `${protocol}//${location.host}/live?apiKey=${encodeURIComponent(agentKey)}`;
    const generation = consoleGeneration;
    const socket = new WebSocket(wsUrl);
    liveSocket = socket;
    const ownsSocket = () => liveSocket === socket && generation === consoleGeneration && isSignedIn();
    socket.onopen = () => {
      if (!ownsSocket()) return;
      wsConnected = true;
      updateLiveIndicator(true);
      // Reconcile changes missed while disconnected; frames themselves carry no dashboard state.
      refresh();
    };
    socket.onmessage = () => {
      if (!ownsSocket()) return;
      // Live push from hub: refresh without waiting for the 4 s poll. A burst of frames coalesces into one refresh.
      refresh();
    };
    socket.onclose = (event) => {
      if (liveSocket !== socket) return;
      liveSocket = null;
      wsConnected = false;
      updateLiveIndicator(false);
      clearTimeout(wsReconnectTimer);
      if (generation === consoleGeneration && authMode === "session" && [4001, 4003, 4004].includes(event?.code)) {
        void reconcileWorkspaceAccess(event.code);
        return;
      }
      if (generation === consoleGeneration && isSignedIn()) {
        wsReconnectTimer = setTimeout(() => {
          if (generation === consoleGeneration && isSignedIn()) connectLiveWs();
        }, 5000);
      }
    };
    socket.onerror = () => {
      if (!ownsSocket()) return;
      wsConnected = false;
      updateLiveIndicator(false);
    };
  } catch {
    wsConnected = false;
    updateLiveIndicator(false);
  }
}

/** A live access cutoff clears only this workspace before checking the still-valid person session. A newer entry
 * owns its own ticket; no late socket/identity answer can quarantine its cookie or replace its workspace. */
async function reconcileWorkspaceAccess(code, workspace = currentWorkspace) {
  if (authMode !== "session" || !workspace) return;
  const ticket = ++identityTicket;
  const owns = ownedBy(ticket);
  currentWorkspace = null;
  currentWorkspaceRole = null;
  me = null;
  beginConsoleGeneration();
  clearTimeout(pollTimer);
  $("org-name").textContent = "";
  renderSidebarIdentity();
  $("workspace-picker-whoami").textContent = person?.email || person?.name || "you";
  $("workspace-list").replaceChildren(el("p", {}, "Checking workspace access…"));
  $("workspace-picker-empty").hidden = true;
  $("workspace-create-details").hidden = true;
  showPage("workspace-picker");
  const scope = createRefreshReadScope();
  let identity = null;
  try {
    identity = await api("/v1/auth/me", { session: true, workspace: null, owns, refreshReadScope: scope });
    if (!owns()) return;
    const membership = identity.workspaces.find((w) => w.orgId === workspace);
    // A refused handshake can carry 4001 while the cookie remains valid. Keep choices rather than loop.
    // A paused member also stays here until they explicitly choose an available workspace.
    if (code === 4001 || code === 4003 || !membership) {
      renderWorkspacePicker(identity);
      if (code === 4003) toast("This workspace is paused. You can choose another workspace.");
      return;
    }
    const memberAgent = await api("/v1/me", { session: true, workspace, owns, refreshReadScope: scope });
    if (!owns()) return;
    person = identity.person;
    authMode = "session";
    currentWorkspace = workspace;
    currentWorkspaceRole = membership.role;
    await enterConsole(memberAgent);
  } catch (err) {
    if (!owns()) return;
    if (err instanceof AuthError) return signOut("Your session isn't valid. Sign in again.");
    if (identity && (err instanceof PausedError || err?.status === 403)) {
      renderWorkspacePicker(identity);
      if (err instanceof PausedError) toast("This workspace is paused. You can choose another workspace.");
      return;
    }
    // Failed or nominally timed-out authorization leaves the old workspace empty; retry is explicit and owned.
    $("workspace-list").replaceChildren(el("p", {}, "Couldn't check workspace access."), el("button", {
      type: "button", onclick: () => { if (owns()) void reconcileWorkspaceAccess(code, workspace); },
    }, "Retry"));
  } finally {
    scope.dispose();
  }
}

function disconnectLiveWs() {
  clearTimeout(wsReconnectTimer);
  wsConnected = false;
  const socket = liveSocket;
  liveSocket = null; // revoke callback ownership before close can synchronously fire onclose
  updateLiveIndicator(false);
  if (socket) {
    try { socket.close(); } catch { /* ignore */ }
  }
}

// ---------- helpers ----------
function el(tag, attrs, ...children) { return build(document.createElement(tag), attrs, children); }
function emptyMark(name) {
  const d = {
    check: "M5 12.5 9.2 17 19 7",
    inbox: "M3 6h18v13H3zM3 6.5 12 13l9-6.5",
    laptop: "M4 6h16v9H4zM2 18h20",
    folder: "M3 7h6l2 2h10v9H3z",
    pulse: "M3 12h4l2-5 4 10 2-5h6",
    lock: "M8 11V8a4 4 0 0 1 8 0v3M6 11h12v8H6z",
    link: "M9 12h6M8 9l-2.5 3L8 15M16 9l2.5 3L16 15",
    shield: "M12 3 19 6v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V6z",
  }[name] || "M5 12.5 9.2 17 19 7";
  return svgEl("svg", { class: "empty-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
    svgEl("path", { d: d, fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
}
function leaseClock() {
  return svgEl("svg", { class: "lease-clock", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", focusable: "false" },
    svgEl("circle", { cx: "8", cy: "8", r: "6.2", fill: "none", stroke: "currentColor", "stroke-width": "1.4" }),
    svgEl("path", { d: "M8 4.6V8l2.2 1.5", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round" }));
}
function svgEl(tag, attrs, ...children) { return build(document.createElementNS("http://www.w3.org/2000/svg", tag), attrs, children); }
function build(node, attrs = {}, children) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.setAttribute("class", v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// SQLite datetime('now') has no zone and a space; ISO strings already have Z.
function parseTime(s) {
  if (!s) return null;
  return new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
}
function ago(s) {
  const t = parseTime(s);
  if (!t) return "";
  const sec = Math.round((Date.now() - t.getTime()) / 1000);
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
function until(s) {
  const t = parseTime(s);
  if (!t) return "";
  const sec = Math.round((t.getTime() - Date.now()) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 90) return `${sec}s left`;
  if (sec < 5400) return `${Math.round(sec / 60)}m left`;
  return `${Math.round(sec / 3600)}h left`;
}
// Same direction as until() but in longer-lived, plain-language units (an invite's 7-day window),
// e.g. "in 3 days" rather than "in 7200m left" -- until() is tuned for minutes-away countdowns.
function fromNow(s) {
  const t = parseTime(s);
  if (!t) return "";
  const sec = Math.round((t.getTime() - Date.now()) / 1000);
  if (sec <= 0) return "expired";
  const unit = (n, word) => `in ${n} ${word}${n === 1 ? "" : "s"}`;
  if (sec < 3600) return unit(Math.round(sec / 60), "minute");
  if (sec < 86400) return unit(Math.round(sec / 3600), "hour");
  return unit(Math.round(sec / 86400), "day");
}

const VENDORS = ["claude", "codex", "cursor", "gemini", "grok"];
// A logo comes from an EXACT tool id (src/connect.ts CONNECT_CLIENTS), anything else is the generic mark. Never from a
// display name: a name is the user's to choose, and "Claude-reviewer" can be a Codex chat (Codex-049a on #704).
const VENDOR_OF_TOOL = new Map([["claude-code", "claude"], ["codex", "codex"], ["cursor", "cursor"], ["gemini", "gemini"], ["grok", "grok"]]);
const vendorOfTool = (tool) => VENDOR_OF_TOOL.get(tool) ?? "other";
// Each agent's tool by its stable id, from the reads that carry one: the roster's `client` and the sessions' `tool`,
// live and ended. Approvals, messages, events and locks name their agent by id; one with no tool on record is generic.
let toolByAgentId = new Map();
const vendorOfAgent = (agentId) => vendorOfTool(toolByAgentId.get(agentId));
function indexAgentTools(agents, ...sessionLists) {
  const next = new Map();
  for (const a of agents ?? []) if (a.client) next.set(a.id, a.client);
  for (const list of sessionLists) for (const s of list ?? []) if (s.tool) next.set(s.agentId, s.tool);
  toolByAgentId = next;
  patchIndexedAgentLogos();
}
// Tool metadata can arrive after the independent message/approval domain. Patch only its mark,
// leaving connected action, hold and reply nodes in place. Display names never decide the vendor.
function patchIndexedAgentLogos() {
  for (const node of document.querySelectorAll("[data-vendor-agent-id]")) {
    const vendor = vendorOfAgent(node.dataset.vendorAgentId);
    const previous = node.dataset.vendor;
    if (vendor === previous) continue;
    node.dataset.vendor = vendor;
    for (const logo of node.querySelectorAll("svg.vendor-logo")) {
      const label = logo.getAttribute("aria-label");
      logo.replaceWith(vendorLogo(vendor, label ? { label: vendorLabel(vendor) } : {}));
    }
    const tag = node.querySelector(".vendor-tag");
    for (const text of tag?.childNodes ?? []) if (text.nodeType === 3 && text.textContent.startsWith(vendorLabel(previous) + " · ")) text.textContent = vendorLabel(vendor) + text.textContent.slice(vendorLabel(previous).length);
  }
}
const vendorLabel = (v) => (v === "other" ? "Agent" : v[0].toUpperCase() + v.slice(1));
/** The tool's logo (index.html's #vl-* sprite), where a coloured dot used to be. It takes its text's colour (fill:
 * currentColor, console-v2.css .vendor-logo), except a mark whose company draws it in colour: Claude's is orange
 * (.vendor-logo--claude). Decorative when the tool's name is in the text beside it; with a
 * `label`, an image of that name. `x`/`y` place it inside another SVG (the fleet map). */
function vendorLogo(vendor, { label, size = 14, x, y } = {}) {
  const v = VENDORS.includes(vendor) ? vendor : "other";
  return svgEl("svg", { class: `vendor-logo vendor-logo--${v}`, viewBox: "0 0 24 24", width: size, height: size, x, y, focusable: "false",
    ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }) }, svgEl("use", { href: `#vl-${v}` }));
}

// The hub's own digest text (src/awareness.ts summarize()) includes the raw thread UUID for
// question.asked/answered items -- genuinely useful to a CLI/MCP agent, which needs that exact id
// to call the reply API, but just visual noise for a human reading the console (nothing here is
// clickable). Display-only cleanup, not a hub/API change: the underlying digest item is untouched.
function humanizeAwarenessSummary(summary) {
  return summary.replace(/\s*\(?reply on thread [0-9a-f-]{20,}\)?/i, "").replace(/\s+on thread [0-9a-f-]{20,}/i, "");
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

class AuthError extends Error {}
// 423: the key is fine, the workspace is paused. Distinct from AuthError so a paused
// session shows the banner instead of being signed out as if its key were bad.
class PausedError extends Error {}
// 402: the plan refused this (a limit, or a read-only workspace). The banner says which and offers a way out.
class PlanError extends Error {}
let planRefusal = null;

/** Key sign-in sends a Bearer header, same as always. Session sign-in sends the httpOnly cookie
 * (credentials: "same-origin") plus X-OpenCadre-Workspace, which both selects the workspace and acts
 * as the CSRF check ACCOUNTS.md specifies (a cross-site request can't set a non-simple header without
 * a preflight the hub never approves). */
async function api(path, { method = "GET", body, key = agentKey, session = authMode === "session", workspace = currentWorkspace, owns = null, refreshReadScope = null, deferPlanRefusal = false } = {}) {
  // Whose data the console shows can change while a request is out (a workspace switch, sign-out, sign-in). Its answer,
  // or its failure, then belongs to the previous identity, and nothing after the caller's await may run for it: no
  // paint, no state, no toast, no tab change, no credential on screen, and none of the status handling below (a 401, a
  // 423, a 402's banner). So it never settles. A request is owned by the generation it started in, unless its caller
  // says who owns it: an identity transition passes its ticket (ownedBy), the sign-out cleanup owns itself.
  const generation = consoleGeneration;
  const stale = () => !(owns ? owns() : generation === consoleGeneration);
  // Every write sends JSON, even with nothing to say. Signed-in routes refuse any other content type (a cross-site
  // form can't send JSON without a CORS preflight), so a bodiless POST like "Accept invite" was rejected.
  const sendsBody = body !== undefined || method !== "GET";
  const headers = sendsBody ? { "content-type": "application/json" } : {};
  // A person reads the console, so it is told a withdrawn request as it is ("Withdrawn" in History); the hub reports it
  // as "denied" only to clients that don't say they know the status.
  if (path.startsWith("/v1/approvals")) headers["X-OpenCadre-Approval-Statuses"] = "withdrawn";
  const opts = { method, headers, body: sendsBody ? JSON.stringify(body ?? {}) : undefined };
  if (refreshReadScope && method !== "GET") throw new Error("The refresh read deadline only applies to GET requests.");
  if (refreshReadScope?.signal) opts.signal = refreshReadScope.signal;
  if (session) {
    opts.credentials = "same-origin";
    if (workspace) headers["X-OpenCadre-Workspace"] = workspace;
  } else if (key) {
    // A falsy key means "no credential to send" (public routes like /v1/auth/config): an empty
    // "Bearer " header would still count as a real, shared credential for the hub's rate limiter,
    // which keys on the raw bearer value -- every anonymous visitor would land in one bucket.
    headers.authorization = `Bearer ${key}`;
  }
  let res;
  try {
    const request = fetch(path, opts);
    res = refreshReadScope ? await refreshReadScope.wait(request) : await request;
  } catch (err) {
    if (stale()) return new Promise(() => {});
    if (refreshReadScope?.timedOut) throw refreshReadScope.error;
    if (refreshReadScope?.disposed) throw refreshReadScope.cancelError;
    throw err;
  }
  let data;
  try {
    const body = res.json();
    data = refreshReadScope ? await refreshReadScope.wait(body) : await body;
  } catch (err) {
    if (stale()) return new Promise(() => {});
    if (refreshReadScope?.timedOut) throw refreshReadScope.error;
    if (refreshReadScope?.disposed) throw refreshReadScope.cancelError;
    data = {};
  }
  if (stale()) return new Promise(() => {}); // never settles: see above
  if (refreshReadScope?.timedOut) throw refreshReadScope.error;
  if (refreshReadScope?.disposed) throw refreshReadScope.cancelError;
  if (res.status === 423) throw new PausedError(data.error || "This workspace is paused.");
  if (res.status === 402) {
    const err = new PlanError(data.error || "Your plan doesn't allow this.");
    err.code = data.code ?? null;
    err.limit = data.limit ?? null;
    if (!deferPlanRefusal) {
      planRefusal = { message: err.message, code: err.code, at: Date.now() };
      renderBillingBanner();
      renderSidebarIdentity();
      renderSidebarAlert();
    }
    throw err;
  }
  if (res.status === 401) throw new AuthError(session ? "Your session isn't valid. Sign in again." : "That key isn't valid for this hub.");
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

// ---------- sign in / out ----------
// Exactly one of these top-level sections is visible at a time.
const PAGES = ["signin", "workspace-picker", "invite-accept", "console"];
function showPage(name) {
  for (const p of PAGES) $(p).hidden = p !== name;
}

// Skeleton (docs/design/HUB_REDESIGN.md 4.17): only for the very first load, never a later poll --
// firstRefreshDone flips once refresh()'s first pass renders real content, and this timer checks
// it before painting anything, so a first load that resolves in under 150ms never flashes a
// skeleton at all, and one that's already rendered by the time 150ms passes never overwrites it.
// A first load that has already failed shows the "Couldn't refresh" line instead, so the skeleton never paints over it.
const SKELETON_IDS = ["clearances", "fleet-groups", "inbox-list", "tasks"];
function paintSkeleton(id, count = 3) {
  const container = $(id);
  const domain = { clearances: "approvals", "fleet-groups": "sessions", "inbox-list": "messages", tasks: "tasks" }[id];
  if (!container || (domain ? homeSources[domain].status !== "pending" : firstRefreshDone) || container.children.length || container.textContent.trim()) return;
  container.replaceChildren(...Array.from({ length: count }, () => el("div", { class: "skeleton skeleton-strip" })));
}

// A refresh that fails, in a fetch or a render, says so in one quiet line above the page (#refresh-notice, not a
// live region), and the next good refresh clears it. It is not a toast and never repeats: a failure that keeps
// happening leaves the line exactly as it is, so a screen reader hears it once. The 4 s poll and pushes are the retry;
// nothing here schedules its own. What this workspace already showed stays on screen; a first load that fails loses
// its skeleton, since nothing is loading any more until the next try.
const REFRESH_NOTICE_TEXT = "Couldn't refresh. Trying again every few seconds.";
const REFRESH_TIMEOUT_NOTICE_TEXT = "Dashboard reads timed out. Trying again every few seconds.";
function showRefreshFailure(step, err) {
  const error = typeof err?.name === "string" && /^[A-Za-z]\w{0,39}$/.test(err.name) ? err.name : typeof err;
  const status = typeof err?.status === "number" ? err.status : undefined;
  const signature = `${step} ${error} ${status ?? ""}`;
  if (signature !== refreshFailure) {
    refreshFailure = signature;
    // Which step and what class of error, logged once per distinct failure. Never the error's message: it can carry a
    // hub error body, task text or a credential.
    console.warn("OpenCadre: couldn't refresh the console.", status === undefined ? { step, error } : { step, error, status });
  }
  syncNotice();
  if (!firstRefreshDone) for (const id of SKELETON_IDS) $(id)?.querySelectorAll(".skeleton").forEach((node) => node.remove());
}

/** Whose data the console shows is changing (sign-in, a workspace switch, sign-out). Starts a new generation, so a
 * refresh still out for the old identity can neither paint (loadAndRender's stale check) nor hold up the new one
 * (refreshNow scopes its flight to the generation), and empties everything the page showed or cached of the old
 * workspace (resetWorkspaceView) so it is never shown under the new one, whether or not the new one ever loads. */
function beginConsoleGeneration() {
  consoleGeneration++;
  disconnectLiveWs();
  for (const scope of refreshReadScopes) scope.cancel();
  firstRefreshDone = false;
  refreshFailure = null; // the old workspace's failures say nothing about the new one
  resetWorkspaceView();
  syncNotice();
}

// Every surface that renders one workspace's data, emptied on a change of workspace or person. A surface is only safe
// to leave out if its next render does not depend on a load succeeding, and none of these qualifies: a failed first
// load (or one that never answers) would leave the previous workspace, or the previous person, on screen under the new
// one (Codex-OpenCadre-049a on #657 at 067eabbe: A's open message and its reply box stayed in B's Inbox).
const WORKSPACE_SURFACES = [
  // Tasks, Agents, Home, Activity
  "tasks", "fleet-groups", "fleet-other-agents", "sessions-ended-list", "fleet-locks-list",
  "overview-attention", "overview-metrics", "overview-happening", "overview-activity", "timeline",
  "awareness-summary", "awareness-items", "home-fleet-map", "home-limits-rows",
  // Inbox: approvals, messages, mentions, decided history and standing grants
  "clearances", "inbox-list", "inbox-mentions", "history", "grants",
  // Settings and Add a computer
  "onboarding-steps", "policy-list", "members-list", "invites-list", "project-links-list", "settings-projects",
  "killswitch-body", "billing-usage", "connect-computers-list", "push-devices-list", "snippets", "isolation-refusal", "invite-link-result",
];
const WORKSPACE_TEXTS = [
  "overview-subtitle", "overview-attention-count", "overview-fleet-summary", "overview-background", "fleet-count",
  "fleet-locks-summary", "task-toolbar-count", "settings-org-name", "settings-org-id", "settings-session-name",
  "paused-banner-meta", "inbox-badge", "computer-cmd-text", "computer-code", "computer-agent-prompt-text",
  "wizard-name-done", "wizard-chat-hint", "first-run-key-value", "first-run-cmd-text", "isolation-status",
  // Errors and results of the old workspace's own actions (a refused organization key, an invite link, a webhook test)
  "agent-error", "computer-error", "policy-error", "project-add-error", "project-link-error", "webhook-status", "push-status",
  "first-run-status",
  "billing-plan", "billing-note",
  // Home's dashboard
  "home-fresh-text", "home-fleet-more", "home-limits-trial", "overview-happening-caption-text", "overview-activity-caption-text",
  "home-limits-caption-text", "home-fleet-caption-text",
];
const WORKSPACE_HIDDEN = [
  "sessions-ended", "fleet-locks", "overview-goal", "overview-background", "paused-banner", "inbox-mark-all-read",
  "inbox-badge", "connect-output", "computer-output", "computer-status-chip", "wizard-dead", "wizard-go-agents",
  "wizard-go-projects", "first-run-card", "onboarding-card", "first-run-key-value", "first-run-cmd", "isolation-refusal",
  "invite-link-result", "agent-error", "computer-error", "policy-error", "project-add-error", "project-link-error",
  "webhook-status", "push-status", "first-run-status",
  "billing-note", "billing-usage-note",
  "home-fresh", "home-fleet-card", "home-limits-card", "home-limits-trial", "overview-happening-caption",
  "overview-activity-caption", "home-limits-caption", "home-fleet-caption",
];
// Buttons an action disables while its request is out. The old identity's answer never arrives (api() drops it), so
// its own `finally` never re-enables them: the reset does.
const IN_FLIGHT_BUTTONS = ["btn-add-computer", "first-run-get-command", "resume-btn", "isolation-toggle"];

/** The caches behind those surfaces go too, so a later local re-render (a filter, a view toggle, Cancel on a reply)
 * cannot paint the previous workspace back from memory. Plan and price caches keyed by orgId stay: they cannot answer
 * for another workspace. */
function resetWorkspaceView() {
  cancelTaskReads();
  taskRevisionRefreshes.clear();
  resetVisibleReaders();
  // Tasks: the loaded pages and their cursors, the search and filter, pinned tasks and every cached detail
  taskBoard = newTaskBoard();
  taskBoardTicket++;
  clearTimeout(taskSearchTimer);
  taskDetailCache.clear();
  taskCards = new Map();
  taskFilter.q = "";
  taskFilter.project = "";
  // Agents
  lastFleetDevices = [];
  lastFleetSessions = [];
  lastUnlinkedAgents = [];
  fleetAgentById = new Map();
  toolByAgentId = new Map(); // a logo is never the previous person's or workspace's tool
  pendingFleetGroups = null;
  pendingOtherAgents = null;
  namedAgentSubjects.clear();
  namedAgentRows.clear();
  agentRowWanted = null;
  lastFleetProjectsData = null;
  pendingFleetProjectsData = null;
  settingsProjectRows.clear();
  reliabilityById = new Map();
  capabilitiesById = new Map();
  fileLocksRequest++; // a lock list still out for the old workspace is dropped
  // Activity and Home
  currentTimelineEvents = [];
  currentAwarenessDigest = null;
  goalCache = { workspace: null, at: 0 };
  goalRequest++;
  goalExpanded = false;
  // Home's dashboard: its sources, tiles, tick and a pending Refresh
  homeSources = newHomeSources();
  coreDomainFailures.clear();
  cancelFileLocks();
  cancelSelectedInboxStatus();
  homeTiles = homeLast = null;
  homeRefreshing = false;
  clearInterval(homeTick);
  homeTick = null;
  // Inbox: the list and its caches, the selected item, the open message and any reply draft
  inboxLoaded = false;
  lastInboxMessages = [];
  lastInboxApprovals = [];
  lastInboxMentions = [];
  clearanceNodes.clear();
  approvalReadDecisions = null;
  lastApprovalHistory = [];
  lastApprovalGrants = [];
  focusedApprovalSubject = null;
  focusedApprovalSeq++;
  selectedInboxItem = null;
  inboxSelectionWorkspace = null;
  openMessageId = null;
  openMessageData = null;
  replyingToThreadId = null;
  replyDraft = "";
  // Settings, plan and the connect wizard
  policyLoaded = false;
  policySignature = null;
  membersLoaded = false;
  webhookEdited = false;
  isolationState = null;
  isolationGen++;
  projectLinks = [];
  planRefusal = null;
  lastKnownPaused = undefined;
  clearInterval(computerTimerInterval);
  clearInterval(computerStatusPollInterval);
  clearInterval(firstRunPoll);
  firstRunPoll = null;
  firstRunDevice = null;
  firstRunConnected = false;
  // The first agent's key is held for the workspace it was minted in, and only while that workspace is the one open.
  if (selfServe && selfServe.orgId !== currentWorkspace) selfServe = null;

  for (const id of WORKSPACE_SURFACES) $(id)?.replaceChildren();
  for (const id of WORKSPACE_TEXTS) { const node = $(id); if (node) node.textContent = ""; }
  for (const id of WORKSPACE_HIDDEN) { const node = $(id); if (node) node.hidden = true; }
  if ($("add-computer-form")) setWizardStep("name");
  for (const id of ["webhook-url", "webhook-auth", "task-search", "computer-name"]) { const input = $(id); if (input) input.value = ""; }
  for (const [id, label] of [["task-project-filter", "All projects"], ["task-project", "Any project"], ["timeline-agent-filter", "All agents"]]) {
    $(id)?.replaceChildren(el("option", { value: "" }, label));
  }
  if ($("task-project-filter")) $("task-project-filter").hidden = true;
  for (const id of ["link-project-a", "link-project-b"]) $(id)?.replaceChildren();
  // Every field in the console goes back to its markup default: drafts (a task, an invite, a computer or agent name),
  // typed secrets (the organization key, a webhook secret) and chosen options belong to the workspace they were typed in.
  for (const field of $("console")?.querySelectorAll("input, textarea, select") ?? []) {
    if (field.tagName === "SELECT") {
      for (const option of field.options) option.selected = option.defaultSelected;
      if (![...field.options].some((o) => o.defaultSelected)) field.selectedIndex = field.options.length ? 0 : -1;
    } else if (field.type === "checkbox" || field.type === "radio") field.checked = field.defaultChecked;
    else field.value = field.defaultValue;
  }
  // A phone notification's approval card, open or still loading, and any toast still up belong to the old identity too.
  const overlay = $("focused-approval-overlay");
  if (overlay) { overlay.hidden = true; overlay.replaceChildren(); }
  for (const id of IN_FLIGHT_BUTTONS) { const node = $(id); if (node) node.disabled = false; }
  const projectAdd = $("project-add-form")?.querySelector("button");
  if (projectAdd) projectAdd.disabled = false;
  clearTimeout(toastTimer);
  if ($("toast")) $("toast").hidden = true;
  if ($("inbox-focus")) showInboxFocusEmpty();
  syncBadgeMobile("inbox-badge");
  document.title = "OpenCadre Console";
}

async function enterConsole(identity, { approvalId = null, approvalOwns } = {}) {
  me = identity;
  renderConnectApps(); // the identity already names the hub: the cards need not wait for the first refresh
  $("org-name").textContent = identity.orgName ?? "";
  renderSidebarIdentity();
  applyRole();
  showPage("console");
  selectTab(activeTab, { history: "replace", refreshReaders: false });
  setTimeout(() => {
    for (const id of SKELETON_IDS) paintSkeleton(id);
  }, 150);
  refreshNow();
  schedulePoll();
  connectLiveWs();
  // A phone notification's deep link, handed in by the entry that owns it (boot, for the workspace the link names):
  // the console underneath is now live, so the focused card decides through the same api()/refresh() as the rest.
  if (approvalId) showFocusedApproval(approvalId, approvalOwns);
}

// ---------- identity transitions ----------
// signIn, enterWorkspace and signOut each take a ticket when they START; the generation moves only when one lands. The
// calls that carry a transition are owned by its ticket (api's `owns`), so an answer or a FAILURE for a superseded
// transition never settles: it cannot sign anyone out, show a paused banner, a toast or an error, or enter a console
// over a newer sign-in. Every other request is owned by the generation it started in.
const ownedBy = (ticket) => () => ticket === identityTicket;

async function signIn(key) {
  const ticket = ++identityTicket;
  const identity = await api("/v1/me", { key, session: false, owns: ownedBy(ticket) });
  authMode = "key";
  agentKey = key;
  beginConsoleGeneration();
  store.set(key);
  // A key does not replace the session cookie, so it lifts no quarantine; it is only remembered, for this tab's reloads.
  noteKeySignInDuringQuarantine(key).catch(() => {});
  await enterConsole(identity);
}

// A workspace member identity is absent during entry/refusal; the authenticated person remains known.
function renderUnacceptedWorkspaceIdentity() {
  // Withdraw role-specific affordances without applyRole's member/onboarding/push reads.
  for (const id of ["policy-card", "killswitch-card", "members-card", "projects-card", "create-agent-key-details"]) $(id).hidden = true;
  layoutSettingsGrid();
  syncSidebarMode();
  $("org-name").textContent = "";
  for (const id of ["billing-banner-title", "billing-banner-meta", "billing-banner-action", "sidebar-alert-title", "sidebar-alert-meta", "sidebar-alert-action"]) $(id).textContent = "";
  for (const id of ["billing-banner", "sidebar-alert"]) delete $(id).dataset.tone;
  renderSidebarIdentity();
  renderWorkspaceBanner();
  renderBillingBanner();
  renderSidebarAlert();
}

/** Session mode: the person already picked (or only has) this workspace. Re-reads /v1/auth/me for the
 * membership role (freshest source after an invite accept or a new workspace, rather than trusting a
 * value threaded through from an earlier call), then sets X-OpenCadre-Workspace so /v1/me resolves
 * through that membership's own agent row. `approvalId` is a deep link into THIS workspace, carried through the
 * transition by the entry that owns it and consumed here, never kept anywhere a later identity could find it. */
async function enterWorkspace(orgId, { approvalId = null, wanted = null } = {}) {
  const ticket = ++identityTicket;
  const owns = ownedBy(ticket);
  const captured = quarantineIds(); // what this answer can be evidence about: never a sign-out added after it was sent
  const identity = await api("/v1/auth/me", { session: true, owns });
  // A notification's entry that a newer notification replaced while this was out enters nothing (checked before any state moves).
  if (wanted && !wanted()) return;
  if (readQuarantine()) {
    // A sign-out is pending: entering with the cookie is allowed only as evidence it is now a known person matching no
    // pending entry ("replaced"), and only when that lifts everything pending (an entry added since this request went
    // out may be this very cookie's).
    liftIfReplaced(captured, stringOrNull(identity.person?.id));
    if (readQuarantine()) throw new AuthError("Sign in again to open a workspace.");
  }
  const before = { me, person, currentWorkspaceRole, authMode, currentWorkspace };
  person = identity.person;
  currentWorkspaceRole = identity.workspaces.find((w) => w.orgId === orgId)?.role ?? null;
  authMode = "session";
  currentWorkspace = orgId;
  me = null; // Only the owned local before snapshot can restore the previous member identity.
  beginConsoleGeneration();
  renderUnacceptedWorkspaceIdentity();
  const memberAgent = await api("/v1/me", { owns });
  if (wanted && !wanted()) {
    // Withdrawn while /v1/me was out (a newer notification replaced this one): nothing of this workspace is presented, and the
    // page goes back to the workspace it was on as a transition of its own, whole and at once. `me` and the other globals
    // come back from the snapshot (a refresh of the staged workspace may have assigned `me` since), a new console generation
    // rejects every read of the abandoned workspace and empties what it painted, and the identity's own display is redrawn,
    // so none of it depends on the reload succeeding. A newer entry that has begun since owns the page: nothing here.
    if (ticket === identityTicket) {
      ({ me, person, currentWorkspaceRole, authMode, currentWorkspace } = before);
      beginConsoleGeneration();
      if (me) {
        $("org-name").textContent = me.orgName ?? "";
        renderSidebarIdentity();
        renderWorkspaceBanner();
        renderBillingBanner();
        renderSidebarAlert();
        applyRole();
        connectLiveWs();
        refreshNow();
      }
    }
    return;
  }
  await enterConsole(memberAgent, { approvalId, approvalOwns: wanted ?? undefined });
}

function resetSignInForms() {
  $("signin-key").value = "";
  $("signin-error").hidden = true;
  $("signin-key-error").hidden = true;
  $("signin-email-sent").hidden = true;
  stopEmailCooldown();
  emailSentTo = null;
  // Sending a magic link hides this form (see the submit handler below); signOut() re-derives its
  // correct visibility with loadSignInConfig() right after calling this, so don't guess it here.
}

/** Signs out. The page is cleared synchronously first, so nothing of the person leaving stays on screen while the
 * server side runs. Then, for a signed-in session, this browser's push device is removed and the session cookie
 * invalidated, both with the session and workspace captured here, never re-read after an await. The page then reloads
 * to the bare sign-in address, which drops every cache, pending answer and overlay the reset might have missed. The
 * cleanup is bounded: a hub that fails or hangs still ends on the sign-in page, with the invalidation left PENDING
 * (see the sign-out marker below). A deliberate sign-in started meanwhile wins: this sign-out then neither reloads
 * nor marks anything, so it cannot kill a login made after it.
 * `reload: false` is for a page that never showed anyone's data (boot() rejecting a saved key): nothing to discard,
 * and a reload there would only come back to the same check. */
function signOut(message, { reload = true } = {}) {
  const ticket = ++identityTicket; // a sign-in or workspace entry still in flight stops where it is
  // A cookie session exists in session mode, and also on the workspace picker (authMode is still "key" there, but the
  // person was read from the cookie). Its person id is what tells a later NEW session from this one.
  const outgoing = { session: authMode === "session" || Boolean(person), workspace: currentWorkspace, personId: person?.id ?? null };
  // The quarantine is on disk BEFORE anything is awaited, in this same synchronous step as the page reset, so a reload
  // at any later moment (during the push removal, during the signout call, before the 5 s cap) finds it and never
  // enters with the cookie. Only evidence about this sign-out's own entry may lift it, below.
  const existing = readSignedOut();
  let entryId = null;
  if (outgoing.session) {
    // A cookie session signing out: its cookie is now quarantined, for every tab of this browser (the other tabs hear
    // of it through the `storage` event). The entry is added to whatever is pending already, never in its place: this
    // tab's view of whose session it showed may be stale. This tab holds the retry lease while its own cleanup runs, so
    // no other tab sends the same invalidation meanwhile.
    entryId = addQuarantineEntry({ personId: outgoing.personId }, { lease: Date.now() + SIGN_OUT_CLEANUP_MS + SIGN_OUT_LEASE_GRACE_MS });
    storeTabRecord({ reason: reasonCode(message), tabKey: null });
  } else if (existing || reload) {
    // A key-mode exit proves nothing about any cookie: pending sign-outs stay as they are. It drops this tab's key
    // fingerprint and carries the reason across the reload.
    storeTabRecord({ reason: reload ? reasonCode(message) : existing?.reason ?? null, tabKey: null });
  }
  store.clear();
  agentKey = null;
  me = null;
  authMode = "key";
  currentWorkspace = null;
  currentWorkspaceRole = null;
  person = null;
  beginConsoleGeneration();
  clearTimeout(pollTimer);
  disconnectLiveWs();
  resetSignInForms();
  showPage("signin");
  const err = $("signin-error");
  err.hidden = !message;
  err.textContent = message ?? "";
  if (!reload) return void loadSignInConfig();
  let invalidated = false;
  const cleanup = outgoing.session
    ? removeThisDevicePush(outgoing.workspace).then(() => {
      // A newer login started while the push device was being removed: this cleanup sends nothing more. The cookie
      // stays quarantined, and the retry looks at whose it is before it sends anything.
      if (ticket !== identityTicket) return;
      // Nor when the quarantine it wrote is no longer the current one: another tab lifted it (the cookie was confirmed
      // gone, or now belongs to someone else, whose session this must not end) or wrote a newer one, which is its own.
      // (If storage refused the entry, there is nothing to own: the invalidation is still sent.)
      if (entryId && !ownsQuarantine(entryId)) return;
      return api("/v1/auth/signout", { method: "POST", session: true, workspace: outgoing.workspace, owns: () => true })
        .then(() => { invalidated = true; }, (e) => { if (e instanceof AuthError) invalidated = true; }); // 401: already gone
    })
    : Promise.resolve();
  let bound;
  Promise.race([cleanup, new Promise((done) => { bound = setTimeout(done, SIGN_OUT_CLEANUP_MS); })]).then(() => {
    clearTimeout(bound);
    // Its invalidation confirmed lifts its own entry, and no other ("confirmed"). The reason stays, for the sign-in page
    // after the reload.
    if (invalidated && entryId) liftQuarantine([entryId]);
    if (ticket !== identityTicket) {
      // Someone signed in since: their page, not ours to reload. A cookie still quarantined keeps being retried here.
      if (readSignedOut()?.pending) retryPendingSignOut();
      return;
    }
    location.replace("/app/"); // the bare console address: no workspace, approval, invite or key in it
  });
}

// ---------- the sign-out marker: the old cookie's quarantine ----------
// Two kinds of record, and none ever holds a credential, a message body, a workspace or a draft.
//
// 1. The QUARANTINE, shared by every tab of this browser and kept across restarts: localStorage, schema v1 (the only
//    schema), ONE KEY PER PENDING SIGN-OUT, so that no write ever rewrites another tab's (a shared value rewritten by
//    read-modify-write loses whatever another tab wrote between the read and the write):
//      "opencadre.signOutQuarantine.v1.entry.<id>"   -> { "personId": string | null }
//          One per sign-out whose invalidation the hub has not confirmed. WRITE-ONCE: created once, removed once, never
//          rewritten. <id> is minted fresh (random) for every new obligation (a sign-out, a #657 marker's migration, an
//          entry past the processing bound), so a removed key is never reused, and evidence naming an old id can never
//          lift a newer obligation. personId is whose session the tab signing out showed; null: an unknown person.
//      "opencadre.signOutQuarantine.v1.backoff.<id>" -> { "attempts": number, "nextAt": number }
//          That entry's retry timing only. Written by the retrying tab while the entry exists; a write racing the
//          entry's removal can only leave an orphan, which is ignored and removed later: it can never recreate an entry.
//      "opencadre.signOutQuarantine.v1.lease"        -> { "owner": string, "until": number }
//          Which page load sends the invalidation, and until when. Best effort: two tabs racing on it can only both send
//          one idempotent, backed-off invalidation. It never touches an entry.
//    Entries are only ever added or removed, each by its own key: a tab's view of whose session it showed can be stale,
//    and a timestamp is no proof of anything, so every pending sign-out stays until evidence about it arrives.
//    An entry with no person (an old marker without one, a value that is malformed or larger than
//    QUARANTINE_MAX_VALUE_CHARS, or any entry past the first QUARANTINE_MAX_PARSED, whose value is not even read)
//    matches EVERY cookie. Its id is its key, stable across reads and tabs, so evidence about it can own it.
//    What is bounded: the size and processing of each value, and how many entries are parsed per person. What is not:
//    how many keys there are, or how long listing them takes; that is bounded only by the browser's storage quota.
//    Nothing pending is ever skipped or evicted: past the parsing bound, entries fail closed as unknown.
//    Listing: localStorage.key(i) shifts when another tab removes a key, so the keys are walked until two passes agree,
//    and every key seen in any pass is then read directly (one removed meanwhile reads as gone). If no two passes agree
//    within QUARANTINE_LISTING_PASSES, the listing is incomplete and fails closed as an unknown entry that no evidence
//    lifts: nothing is lifted as "replaced", nothing is sent, nothing auto-enters, until a later listing completes.
// 2. This TAB's record, sessionStorage "opencadre.signedOut": { "reason": allowlisted code | null, "tabKey": SHA-256
//    hex of the key someone signed in with in this tab during a quarantine | null }. The key itself is never kept.
//    #657 (production 69c4ef00) kept its single pending marker in this same key, with a `pending` field: such a marker
//    becomes an entry under a fresh id (never the marker's own signOutId), and is reduced to reason and tabKey in the
//    same synchronous step, before any request.
//
// While any entry is pending, a cookie that matches one is QUARANTINED: no tab enters with it (boot neither enters its
// workspace nor lists it nor accepts an invite as its person, and a tab showing it is reset). Evidence lifts only the
// entries it was taken about (the ids captured before the request; the entries are re-read after every await):
//   - "gone": the hub answers 401 for the browser's cookie. A browser holds one session cookie, so none of the captured
//     entries' cookies is left in it: they all lift.
//   - "replaced": the cookie belongs to a KNOWN person matching no entry (no entry for them, and no unknown entry), in a
//     complete listing: the captured entries' cookies were replaced in this browser. Each captured key is read directly
//     and lifts only if it still names a known, different person; nothing invalidates the new session.
//   - "confirmed": the invalidation sent for the entries matching the cookie (that person's, and any unknown entry) was
//     confirmed. Those lift; entries for other people stay until their own evidence arrives.
// Starting a sign-in lifts nothing: a key login does not replace the cookie, and a link requested (or a send that
// failed) establishes nothing. The person can still sign in, with a key or a new session, at any time.
// What the quarantine is NOT, and where it stops:
//   - It is not a revocation on the hub: it is this browser refusing to use the cookie. Until the invalidation reaches
//     the hub, the session stays valid there (until it expires); a copy of the cookie outside this browser is not stopped.
//   - It covers the tabs of this browser only while its storage works: if localStorage cannot be read or written (some
//     private modes, storage disabled, or its quota full), there is no cross-tab or across-restart protection.
//   - The SAME person signing in again before the hub confirms cannot be told from the old session (the hub names the
//     person, not the session): that fails closed. They stay signed out in this browser, and once the hub answers the
//     retry ends that new session too; then they sign in once more. An unknown-person entry does the same to anyone.
//   - Look, then send: the retry looks at whose the cookie is, then sends the invalidation. A sign-in completed in the
//     moment between the two is ended by it. The window is one round trip; closing it needs the hub to check whose
//     session a sign-out is for.
const SIGN_OUT_CLEANUP_MS = 5000;
const SIGN_OUT_RETRY_BASE_MS = 2000;
const SIGN_OUT_RETRY_MAX_MS = 60_000;
// How long a retry lease outlives the attempt it covers: long enough that the owner renews it with its next backoff,
// short enough that another tab takes over soon after the owner closes.
const SIGN_OUT_LEASE_GRACE_MS = 10_000;
const SIGN_IN_SETTLE_MS = 2000;
const SIGNED_OUT = "opencadre.signedOut"; // sessionStorage: this tab's record
const QUARANTINE_PREFIX = "opencadre.signOutQuarantine.v1.";
const QUARANTINE_ENTRY = `${QUARANTINE_PREFIX}entry.`;
const QUARANTINE_BACKOFF = `${QUARANTINE_PREFIX}backoff.`;
const QUARANTINE_LEASE = `${QUARANTINE_PREFIX}lease`;
const QUARANTINE_MAX_PARSED = 16;
const QUARANTINE_MAX_VALUE_CHARS = 256;
const QUARANTINE_MAX_ID_CHARS = 64;
const QUARANTINE_LISTING_PASSES = 8;
// The signOutId of the entry an incomplete listing reads as: an unknown person (it matches every cookie) that no
// evidence can lift, because it names no key. It lasts only as long as the listing stays incomplete.
const LISTING_INCOMPLETE = "listing-incomplete";
const SIGNED_OUT_REASONS = { "key-rejected": "Your key was rejected. Sign in again." };
const SIGNED_OUT_ELSEWHERE = "You signed out in another tab. Sign in again to continue.";
const reasonCode = (message) => Object.keys(SIGNED_OUT_REASONS).find((code) => SIGNED_OUT_REASONS[code] === message) ?? null;
/** A fresh id: its time first (so ids sort roughly by age), then 64 random bits. */
const newSignOutId = () => {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `${Date.now().toString(36)}-${[...random].map((n) => n.toString(36)).join("")}`;
};
const PAGE_ID = newSignOutId(); // this page load, as a retry lease's owner (a reload is a new page, with a new id)
const finiteOrZero = (n) => (Number.isFinite(n) ? n : 0);
const stringOrNull = (s) => (typeof s === "string" ? s : null);
const isId = (s) => typeof s === "string" && s.length > 0 && s.length <= QUARANTINE_MAX_ID_CHARS;

/** Every localStorage key: { keys, complete }. Listed until two passes agree (another tab removing a key shifts
 * key(i), which can hide a key from a pass); every key seen in any pass is returned, to be read directly. If no two
 * passes agree within QUARANTINE_LISTING_PASSES, the listing is INCOMPLETE: the caller fails closed. */
function storageKeys() {
  const seen = new Set();
  let previous = null;
  for (let pass = 0; pass < QUARANTINE_LISTING_PASSES; pass++) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) seen.add(key);
    const listed = keys.join("\n");
    if (listed === previous) return { keys: [...seen], complete: true };
    previous = listed;
  }
  return { keys: [...seen], complete: false };
}
/** An entry's person from its stored value: null (an unknown person, matching every cookie) for anything that is not a
 * small, valid v1 entry value. */
function entryPerson(raw) {
  if (typeof raw !== "string" || raw.length > QUARANTINE_MAX_VALUE_CHARS) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && isId(value.personId) ? value.personId : null;
  } catch { return null; }
}
function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= QUARANTINE_MAX_VALUE_CHARS ? JSON.parse(raw) : null;
  } catch { return null; }
}
/** The pending sign-outs: null when there are none, else { entries: [{ personId, signOutId, attempts, nextAt }],
 * retryOwner, retryUntil, incomplete }. An incomplete listing adds an unknown entry that no evidence can lift (see
 * LISTING_INCOMPLETE): nothing lifts as "replaced", nothing is sent, and nothing auto-enters, while it lasts. Orphaned
 * backoff keys (their entry is gone) are removed on the way. */
function readQuarantine() {
  let keys;
  let complete;
  try { ({ keys, complete } = storageKeys()); } catch { return null; }
  const ids = keys.filter((k) => k.startsWith(QUARANTINE_ENTRY)).map((k) => k.slice(QUARANTINE_ENTRY.length)).sort();
  const entries = [];
  for (const id of ids) {
    let raw;
    try { raw = localStorage.getItem(QUARANTINE_ENTRY + id); } catch { raw = ""; } // unreadable: unknown, fail closed
    if (raw === null) continue; // removed since it was listed: gone
    // Past the parsing bound the person is not read (an unknown person); the backoff, a timing value of bounded size,
    // is read for every entry, so none is retried more often than its backoff says.
    const parsed = entries.length < QUARANTINE_MAX_PARSED;
    const backoff = readJson(QUARANTINE_BACKOFF + id);
    entries.push({ personId: parsed ? entryPerson(raw) : null, signOutId: id,
      attempts: finiteOrZero(backoff?.attempts), nextAt: finiteOrZero(backoff?.nextAt) });
  }
  for (const key of keys) {
    if (!key.startsWith(QUARANTINE_BACKOFF)) continue;
    const id = key.slice(QUARANTINE_BACKOFF.length);
    try { if (localStorage.getItem(QUARANTINE_ENTRY + id) === null) localStorage.removeItem(key); } catch { /* best effort */ }
  }
  if (!complete) entries.push({ personId: null, signOutId: LISTING_INCOMPLETE, attempts: 0, nextAt: 0 });
  if (!entries.length) return null;
  const lease = readJson(QUARANTINE_LEASE);
  return { entries, retryOwner: isId(lease?.owner) ? lease.owner : null, retryUntil: finiteOrZero(lease?.until), incomplete: !complete };
}
/** The ids of the entries pending now: what a request about to be sent can later give evidence about. */
const quarantineIds = () => (readQuarantine()?.entries ?? []).map((e) => e.signOutId);
/** Whether `signOutId` is still pending, read directly from its key. */
const ownsQuarantine = (signOutId) => {
  try { return Boolean(signOutId) && localStorage.getItem(QUARANTINE_ENTRY + signOutId) !== null; } catch { return false; }
};
/** The entries a cookie of `personId` matches: that person's, and every unknown-person entry (they match any cookie). */
const matchingEntries = (q, personId) => (q?.entries ?? []).filter((e) => e.personId === null || (personId && e.personId === personId));
/** Adds a pending sign-out under a fresh id, in one write to a key no one else writes. Past the parsing bound it is
 * written as an unknown person. Returns the id, or null if storage refused it. `lease` takes the retry lease too. */
function addQuarantineEntry({ personId, attempts = 0, nextAt = 0 }, { lease = null } = {}) {
  const id = newSignOutId();
  const known = isId(personId) && (readQuarantine()?.entries.length ?? 0) < QUARANTINE_MAX_PARSED ? personId : null;
  try { localStorage.setItem(QUARANTINE_ENTRY + id, JSON.stringify({ personId: known })); } catch { return null; }
  if (finiteOrZero(attempts) || finiteOrZero(nextAt)) {
    try { localStorage.setItem(QUARANTINE_BACKOFF + id, JSON.stringify({ attempts: finiteOrZero(attempts), nextAt: finiteOrZero(nextAt) })); }
    catch { /* timing only */ }
  }
  if (lease) takeRetryLease(lease);
  return id;
}
/** Lifts exactly the entries named (evidence about them was received): removes their keys, nothing else. */
function liftQuarantine(ids) {
  for (const id of ids) {
    try {
      localStorage.removeItem(QUARANTINE_ENTRY + id);
      localStorage.removeItem(QUARANTINE_BACKOFF + id);
    } catch { /* storage unavailable: see "where it stops" above */ }
  }
  if (ids.length && !readQuarantine()) {
    clearTimeout(signOutRetryTimer);
    signOutRetryTimer = null;
    signOutRetryRun++;
    // Nothing pending: this tab's key fingerprint has nothing left to answer for. A reason still to show stays.
    const tab = readTabRecord();
    if (tab?.reason) storeTabRecord({ reason: tab.reason, tabKey: null });
    else if (tab) clearTabRecord();
  }
}
/** "replaced": the cookie is `personId`'s, a known person. Returns false, lifting nothing, when an entry pending NOW
 * matches that cookie (or the listing is incomplete). Otherwise lifts the captured entries it can prove were replaced:
 * membership in a listing never decides a lift, so each captured key is read directly, and one that still names this
 * person, or no known person (unknown or malformed), is not lifted. */
function liftIfReplaced(captured, personId) {
  const now = readQuarantine();
  if (!personId || now?.incomplete || matchingEntries(now, personId).length) return false;
  liftQuarantine(captured.filter((id) => {
    let raw;
    try { raw = localStorage.getItem(QUARANTINE_ENTRY + id); } catch { return false; }
    if (raw === null) return false;
    const who = entryPerson(raw);
    return who !== null && who !== personId;
  }));
  return true;
}
function readTabRecord() {
  try {
    const raw = sessionStorage.getItem(SIGNED_OUT);
    if (!raw || raw.length > QUARANTINE_MAX_VALUE_CHARS * 4) return null;
    const { reason, tabKey } = JSON.parse(raw);
    return { reason: SIGNED_OUT_REASONS[reason] ? reason : null, tabKey: typeof tabKey === "string" && /^[0-9a-f]{64}$/.test(tabKey) ? tabKey : null };
  } catch { return null; }
}
function storeTabRecord({ reason = null, tabKey = null } = {}) {
  try { sessionStorage.setItem(SIGNED_OUT, JSON.stringify({ reason: SIGNED_OUT_REASONS[reason] ? reason : null, tabKey: stringOrNull(tabKey) })); }
  catch { /* the reason is only for the next page */ }
}
function clearTabRecord() {
  try { sessionStorage.removeItem(SIGNED_OUT); } catch { /* nothing kept */ }
}
/** #657's single marker (sessionStorage, with a `pending` field), found in this tab: a pending one becomes an entry
 * under a FRESH id (never the marker's signOutId, which another tab's evidence may name), and the marker is reduced to
 * its reason and key fingerprint in the same synchronous step. */
function adoptTabQuarantine() {
  let old;
  try {
    const raw = sessionStorage.getItem(SIGNED_OUT);
    if (!raw) return;
    old = raw.length > QUARANTINE_MAX_VALUE_CHARS * 4 ? { pending: true } : JSON.parse(raw);
  } catch { old = { pending: true }; } // unreadable: fail closed, as an unknown person
  if (!old || typeof old !== "object" || !("pending" in old)) return;
  if (old.pending === true) addQuarantineEntry({ personId: old.personId, attempts: old.attempts, nextAt: old.nextAt });
  storeTabRecord({ reason: old.reason, tabKey: old.tabKey });
}
/** This tab's record and whether any sign-out is pending, as one read (migrating a #657 marker first). */
function readSignedOut() {
  adoptTabQuarantine();
  const tab = readTabRecord();
  const q = readQuarantine();
  if (!tab && !q) return null;
  return { reason: tab?.reason ?? null, tabKey: tab?.tabKey ?? null, pending: Boolean(q) };
}
let signOutRetryTimer = null;
let signOutRetryRun = 0; // only the newest retry loop's timer starts an attempt
let signOutAttemptRunning = false; // one retry attempt at a time in this page; the running one schedules the next
let signOutLastAttempt = -Infinity; // and at least SIGN_OUT_RETRY_BASE_MS between two of them, whatever storage says
/** A one-way fingerprint of a key, so boot can recognise the key this tab signed in with without keeping the key. */
async function keyFingerprint(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Whose the browser's cookie is, read without entering anything: { gone: true } (401), { personId } (null when the
 * hub names no one), or { unsure: true } (the hub could not say). */
async function lookAtCookie() {
  try {
    const identity = await api("/v1/auth/me", { session: true, workspace: null, owns: () => true });
    return { personId: stringOrNull(identity?.person?.id) };
  } catch (err) {
    return err instanceof AuthError ? { gone: true } : { unsure: true };
  }
}
/** What a look, taken with `captured` pending, proves (see the rules above); reads the set as it is NOW. */
function applyLook(look, captured) {
  if (look.gone) liftQuarantine(captured);
  else if (look.personId) liftIfReplaced(captured, look.personId);
}
/** One attempt: look first, so an invalidation is never sent for a cookie that matches no pending entry, then send it
 * for the entries that match that cookie, re-checked after the look. Returns "quarantined" while anything is pending,
 * "gone" otherwise. */
async function attemptPendingSignOut() {
  const captured = quarantineIds();
  if (!captured.length) return "gone";
  const settled = () => (readQuarantine() ? "quarantined" : "gone");
  const look = await lookAtCookie();
  if (look.unsure) return settled();
  applyLook(look, captured);
  // The entries this cookie matches, among those captured and still pending now (never one added since). Nothing is
  // sent while the listing is incomplete: whose the pending entries are is not known.
  const now = readQuarantine();
  if (now?.incomplete) return settled();
  const chosen = matchingEntries(now, look.personId).map((e) => e.signOutId).filter((id) => captured.includes(id));
  if (look.gone || !chosen.length) return settled();
  try {
    await api("/v1/auth/signout", { method: "POST", session: true, workspace: null, owns: () => true });
  } catch (err) {
    if (err instanceof AuthError) liftQuarantine(captured); // 401: the cookie is no session ("gone")
    return settled();
  }
  liftQuarantine(chosen); // "confirmed", for the entries it was sent for
  return settled();
}
const leasedElsewhere = (q) => Boolean(q.retryOwner) && q.retryOwner !== PAGE_ID && q.retryUntil > Date.now();
const nextDue = (q) => Math.min(...q.entries.map((e) => e.nextAt));
/** Holds the retry lease until `until`: its own key, best effort (see the schema above). */
function takeRetryLease(until) {
  try { localStorage.setItem(QUARANTINE_LEASE, JSON.stringify({ owner: PAGE_ID, until })); } catch { /* best effort */ }
}
/** After a failed attempt: the entries that were due and are still pending back off, each on its own backoff key. An
 * entry removed meanwhile gets at most an orphaned backoff key, which never brings it back. */
function backOff(dueIds) {
  for (const e of readQuarantine()?.entries ?? []) {
    if (!dueIds.includes(e.signOutId) || !ownsQuarantine(e.signOutId)) continue;
    const attempts = e.attempts + 1;
    const nextAt = Date.now() + Math.min(SIGN_OUT_RETRY_MAX_MS, SIGN_OUT_RETRY_BASE_MS * 2 ** attempts);
    try { localStorage.setItem(QUARANTINE_BACKOFF + e.signOutId, JSON.stringify({ attempts, nextAt })); } catch { /* timing only */ }
  }
  // The lease is renewed only by this page holding it (or taking a lapsed one): never taken from a tab mid-cleanup.
  const q = readQuarantine();
  if (q && !leasedElsewhere(q)) takeRetryLease(nextDue(q) + SIGN_OUT_LEASE_GRACE_MS);
}
/** Retries the invalidation, on each entry's capped backoff, for as long as anything is pending, whoever signs in with
 * a key meanwhile. Every open tab runs this, but only the tab holding the lease sends: the lease is taken synchronously
 * before anything is awaited and renewed with the backoff, so the others wait until it lapses (its tab closed or
 * reloaded). Two tabs can still both send when both find the lease lapsed at the same moment: the call is idempotent
 * (a second one finds the session gone: 401), and the next one is still on the shared backoff. */
function retryPendingSignOut() {
  const q = readQuarantine();
  if (!q) return;
  const run = ++signOutRetryRun;
  clearTimeout(signOutRetryTimer);
  const due = Math.max(nextDue(q), leasedElsewhere(q) ? q.retryUntil : 0, signOutLastAttempt + SIGN_OUT_RETRY_BASE_MS);
  signOutRetryTimer = setTimeout(async () => {
    signOutRetryTimer = null;
    // A newer loop replaced this one, or an attempt is still out here (it schedules the next one when it ends).
    if (run !== signOutRetryRun || signOutAttemptRunning) return;
    const before = readQuarantine();
    if (!before) return;
    if (nextDue(before) > Date.now() || leasedElsewhere(before) || signOutLastAttempt + SIGN_OUT_RETRY_BASE_MS > Date.now()) {
      return void retryPendingSignOut();
    }
    const dueIds = before.entries.filter((e) => e.nextAt <= Date.now()).map((e) => e.signOutId);
    takeRetryLease(Date.now() + SIGN_OUT_CLEANUP_MS + SIGN_OUT_LEASE_GRACE_MS);
    signOutAttemptRunning = true;
    signOutLastAttempt = Date.now();
    let state;
    try { state = await attemptPendingSignOut(); } finally { signOutAttemptRunning = false; }
    if (state === "quarantined") backOff(dueIds);
    retryPendingSignOut();
  }, Math.max(0, due - Date.now()));
}
/** Before a deliberate sign-in (a key, GitHub or Google, an emailed link): a new ticket, so nothing older in flight
 * can act on what this sign-in does, and one bounded attempt at a pending invalidation. The quarantine itself stays
 * unless that attempt lifts it: starting a sign-in is not a sign-out, and not a new session either. */
async function settleSignOutBeforeSignIn() {
  identityTicket++;
  if (!readSignedOut()?.pending) return;
  let bound;
  await Promise.race([attemptPendingSignOut(), new Promise((done) => { bound = setTimeout(done, SIGN_IN_SETTLE_MS); })]);
  clearTimeout(bound);
  retryPendingSignOut();
}
/** A key sign-in that landed while a cookie is quarantined: remember which key it was, in this tab only, so a reload of
 * this tab may sign in with it again (and not with a key another tab saved). The quarantine stays. */
async function noteKeySignInDuringQuarantine(key) {
  if (!readQuarantine()) return;
  const tabKey = await keyFingerprint(key);
  if (readQuarantine()) storeTabRecord({ reason: readTabRecord()?.reason ?? null, tabKey });
}
/** This tab is showing the cookie's identity (a workspace entered with it, the workspace picker, or an invite as the
 * cookie's person), as opposed to an explicit key session, which is not the cookie's. */
const showingCookie = () => authMode === "session" || Boolean(person && !(authMode === "key" && me));
/** Another tab signed the cookie out: the same reset a sign-out does here (a new ticket and generation, nothing of the
 * workspace left on screen or in memory), without a second invalidation or a reload, then the sign-in page. */
function leaveSignedOutElsewhere() {
  identityTicket++; // a sign-in or workspace entry still in flight for the cookie stops where it is
  agentKey = null;
  me = null;
  authMode = "key";
  currentWorkspace = null;
  currentWorkspaceRole = null;
  person = null;
  beginConsoleGeneration();
  clearTimeout(pollTimer);
  disconnectLiveWs();
  resetSignInForms();
  const invite = inviteToken();
  if (invite) {
    $("invite-signed-in").hidden = true;
    return void loadInviteAccept(invite, { asSignedOut: true });
  }
  showPage("signin");
  const err = $("signin-error");
  err.textContent = SIGNED_OUT_ELSEWHERE;
  err.hidden = false;
  loadSignInConfig();
}
// Another tab added a pending sign-out. An entry that matches the cookie identity this tab is showing (that person's, or
// an unknown person's) ends that view at once. Read from the event's own values, not the store: by now the other tab
// may have lifted it with a confirmed invalidation, which ends the cookie all the more. An explicit key session here is
// not the cookie's and stays (with its own tab fingerprint), and so does a cookie view of a different person. Every tab
// then takes part in the leased retry.
window.addEventListener("storage", (e) => {
  // Any change to an entry key (or the whole storage cleared). Backoff and lease writes are not news.
  if (e.key !== null && !(typeof e.key === "string" && e.key.startsWith(QUARANTINE_ENTRY))) return;
  const matchesThisCookie = (personId) => personId === null || !person?.id || personId === person.id;
  // A created entry for this tab's person (or no one) resets it, even if that sign-out is already confirmed and gone by
  // now. And whatever changed, the EFFECTIVE set, read with the full fail-closed listing (entries past the parsing
  // bound, malformed values, an incomplete listing: all unknown), resets it when it matches this tab's cookie.
  const created = typeof e.key === "string" && e.oldValue === null && e.newValue !== null && matchesThisCookie(entryPerson(e.newValue));
  const q = readQuarantine();
  if (showingCookie() && (created || Boolean(q?.entries.some((x) => matchesThisCookie(x.personId))))) leaveSignedOutElsewhere();
  if (q) retryPendingSignOut();
});

$("signin-key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("signin-key").value.trim();
  const errorEl = $("signin-key-error");
  errorEl.hidden = true;
  try {
    await settleSignOutBeforeSignIn();
    await signIn(key);
  } catch (err) {
    errorEl.textContent = err instanceof AuthError ? err.message
      : err instanceof PausedError ? "This workspace is paused. Ask an operator to resume it, then sign in again."
      : `Couldn't reach the hub: ${err.message}`;
    errorEl.hidden = false;
  }
});
$("signout").addEventListener("click", () => signOut());
$("workspace-picker-signout").addEventListener("click", () => signOut());

// ---------- sign in: OAuth + email (session mode) ----------
function oauthUrl(provider, next) {
  return `/v1/auth/start?provider=${encodeURIComponent(provider)}&next=${encodeURIComponent(next)}`;
}

// /v1/auth/config, /v1/invites/:token and /v1/auth/me are all public or cookie-only; { key: "" } just
// avoids sending a stray Authorization header built from a null agentKey on a route that ignores it.
async function loadSignInConfig() {
  const loading = $("signin-methods-loading");
  try {
    const { enabled, methods, signup } = await api("/v1/auth/config", { key: "" });
    loading.hidden = true;
    applySignupWording(signup, Boolean(methods?.github || methods?.google || methods?.email));
    const oauthWrap = $("signin-oauth");
    const github = $("signin-github");
    const google = $("signin-google");
    const emailForm = $("signin-email-form");
    if (methods?.github) { github.hidden = false; oauthWrap.hidden = false; }
    if (methods?.google) { google.hidden = false; oauthWrap.hidden = false; }
    if (methods?.email) emailForm.hidden = false;
    $("signin-divider").hidden = !(oauthWrap.hidden === false && emailForm.hidden === false);
    if (oauthWrap.hidden && emailForm.hidden) {
      // Two different situations reach this branch, and they need different words.
      //
      // `enabled: true` with every method false means the hub is CONFIGURED for hosted sign-in but could
      // not reach the provider to say which methods are on (src/rest.ts). It no longer claims all three,
      // which is right -- but the buttons disappearing on their own is confusing, so say why. Before
      // #423 the hub claimed all three here, so this state did not exist and silence was harmless.
      //
      // `enabled: false` means there is genuinely no hosted sign-in on this hub. Silence is correct
      // there: nothing is wrong, the deployment just uses agent keys. Saying "couldn't check" would be a
      // false alarm on a deliberately key-only hub.
      if (enabled) {
        loading.textContent = "Couldn't check sign-in options. You can still sign in with an agent key below.";
        loading.hidden = false;
      }
      // Either way, the key form is open rather than the page being a dead end.
      document.querySelector(".signin-key-details").open = true;
    }
  } catch {
    loading.textContent = "Couldn't check sign-in options. You can still sign in with an agent key below.";
    document.querySelector(".signin-key-details").open = true;
  }
}

// Where sign-in returns: the console, or the MCP connector's consent page when it sent a signed-out person here with
// ?next=/oauth/authorize?... (src/rest.ts). The hub checks next again (safeNext); this only picks between the two.
function signInNext() {
  const next = new URLSearchParams(location.search).get("next");
  // The connector's consent page keeps its own address exactly.
  if (next && next.startsWith("/oauth/authorize?")) return next;
  return "/app/";
}
$("signin-github").addEventListener("click", async () => { await settleSignOutBeforeSignIn(); location.href = oauthUrl("github", signInNext()); });
$("signin-google").addEventListener("click", async () => { await settleSignOutBeforeSignIn(); location.href = oauthUrl("google", signInNext()); });
// Email sign-in. Sending swaps the form for a sent state: the address used, Resend, and "Use a different email" (back to
// the form, address kept, for a typo). Resend waits out a cooldown shown on the button itself -- the hub allows a few
// emails an hour per address (src/rest.ts emailLimiter), and each send replaces the previous link's PKCE cookie, so only
// the newest link works. Errors land in #signin-error (role="alert"); a confirmation lands in the polite status line.
const EMAIL_RESEND_COOLDOWN_S = 60;
let emailCooldownTimer = null;
let emailSentTo = null;

function emailSendError(err) {
  if (err instanceof TypeError) return "Couldn't reach OpenCadre. Check your connection, then try again.";
  return err.message;
}
function startEmailCooldown() {
  const btn = $("signin-email-resend");
  let left = EMAIL_RESEND_COOLDOWN_S;
  clearInterval(emailCooldownTimer);
  const paint = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend in ${left}s` : "Resend";
  };
  paint();
  emailCooldownTimer = setInterval(() => {
    left -= 1;
    paint();
    if (left <= 0) clearInterval(emailCooldownTimer);
  }, 1000);
}
function stopEmailCooldown() {
  clearInterval(emailCooldownTimer);
  emailCooldownTimer = null;
  $("signin-email-resend").disabled = false;
  $("signin-email-resend").textContent = "Resend";
}
async function sendSignInEmail(email) {
  await settleSignOutBeforeSignIn();
  await api("/v1/auth/email", { method: "POST", body: { email, next: signInNext() }, session: true });
}
function showEmailForm() {
  stopEmailCooldown();
  $("signin-email-sent").hidden = true;
  $("signin-email-status").textContent = "";
  $("signin-email-form").hidden = false;
  const input = $("signin-email");
  input.value = emailSentTo ?? input.value;
  input.focus();
  input.select?.();
}

$("signin-email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("signin-email").value.trim();
  const errorEl = $("signin-error");
  errorEl.hidden = true;
  const submit = $("signin-email-submit");
  submit.disabled = true;
  try {
    await sendSignInEmail(email);
    emailSentTo = email;
    $("signin-email-sent-addr").textContent = email;
    $("signin-email-status").textContent = "";
    $("signin-email-form").hidden = true;
    $("signin-email-sent").hidden = false;
    $("signin-email-sent").focus();
    startEmailCooldown();
  } catch (err) {
    errorEl.textContent = emailSendError(err);
    errorEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
});
$("signin-email-resend").addEventListener("click", async () => {
  if (!emailSentTo) return showEmailForm();
  const errorEl = $("signin-error");
  errorEl.hidden = true;
  $("signin-email-status").textContent = "";
  const btn = $("signin-email-resend");
  btn.disabled = true;
  try {
    await sendSignInEmail(emailSentTo);
    $("signin-email-status").textContent = "We sent a new link. Only the newest one works.";
    startEmailCooldown();
  } catch (err) {
    errorEl.textContent = emailSendError(err);
    errorEl.hidden = false;
    // The hub's rate limit: waiting is the only thing that helps, so the wait starts again. Anything else (a dropped
    // connection, a hub error) sent nothing, so Resend is ready at once.
    if (err?.status === 429) startEmailCooldown(); else stopEmailCooldown();
  }
});
$("signin-email-change").addEventListener("click", () => {
  $("signin-error").hidden = true;
  showEmailForm();
});

// ---------- workspace picker ----------
function renderWorkspacePicker(identity) {
  person = identity.person;
  $("workspace-picker-whoami").textContent = person?.email || person?.name || "you";
  const list = $("workspace-list");
  list.replaceChildren(...identity.workspaces.map((w) => el("button", {
    class: "workspace-item", type: "button", onclick: () => enterWorkspace(w.orgId).catch((err) => toast(err.message)),
  },
    el("span", { class: "workspace-item-name" }, w.name),
    el("span", { class: "workspace-item-role" }, w.role))));

  const canCreate = Boolean(identity.canCreateWorkspace);
  $("workspace-picker-empty").hidden = identity.workspaces.length > 0 || canCreate;
  const createDetails = $("workspace-create-details");
  createDetails.hidden = !canCreate;
  createDetails.open = identity.workspaces.length === 0 && canCreate;
  showPage("workspace-picker");
  // A person already signed in comes straight here from /v1/auth/me, never through loadSignInConfig, so the signup
  // mode is read here too, for the sign-in wording (Codex-OpenCadre-f46c on d2c6d86).
  if (identity.workspaces.length === 0) {
    api("/v1/auth/config", { key: "" })
      .then(({ signup }) => applySignupWording(signup))
      .catch(() => { /* the note without the link is still true */ });
  }
}

$("workspace-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("workspace-create-name").value.trim();
  const errorEl = $("workspace-create-error");
  errorEl.hidden = true;
  try {
    // `agent` is a TOP-LEVEL sibling of `workspace`, not nested inside it (src/rest.ts), and it is
    // present only when the hub runs with OPENCADRE_SIGNUP=open: createWorkspace mints the workspace's
    // first operator key in the same round trip, precisely so a self-serve person is not left "holding
    // a session cookie and nothing to connect an agent with" (src/accounts.ts, §2.3). Destructuring
    // only `workspace` here silently threw that key away -- the one credential the self-serve path
    // exists to hand over. (/v1/auth/config does report the signup mode too; loadSignInConfig uses it for the sign-in
    // wording, but a first operator key only ever arrives here.) In waitlist mode `agent` is absent
    // and this is byte-for-byte the call it always was.
    const { workspace, agent } = await api("/v1/workspaces", { method: "POST", body: { name }, session: true });
    rememberSelfServe(workspace.orgId, agent);
    await enterWorkspace(workspace.orgId);
  } catch (err) {
    // One unstarted workspace per owner (src/accounts.ts): the hub names the one already waiting for its trial, so the
    // person is taken there -- to its plan picker -- rather than left at a refusal with nowhere to go.
    const waiting = err?.data?.code === "WORKSPACE_PENDING" ? err.data.workspace?.orgId : null;
    if (waiting) {
      toast(err.message);
      await enterWorkspace(waiting);
      return;
    }
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// ---------- invite accept ----------
function inviteToken() {
  return new URLSearchParams(location.search).get("invite");
}

async function loadInviteAccept(token, { asSignedOut = false } = {}) {
  showPage("invite-accept");
  try {
    const invite = await api(`/v1/invites/${encodeURIComponent(token)}`, { key: "" });
    $("invite-loading").hidden = true;
    if (!invite.valid) { $("invite-invalid").hidden = false; return; }
    $("invite-body").hidden = false;
    $("invite-workspace-name").textContent = invite.workspaceName;
    $("invite-role").textContent = invite.role;
    // Reuse the same config check as the main sign-in page for the OAuth/email options shown here.
    const { methods } = await api("/v1/auth/config", { key: "" }).catch(() => ({ methods: {} }));
    $("invite-github").hidden = !methods?.github;
    $("invite-google").hidden = !methods?.google;
    $("invite-email-form").hidden = !methods?.email;
    let identity = null;
    // A sign-out still pending in this tab: the cookie is the person who just left, so this page is signed out.
    if (!asSignedOut) try { identity = await api("/v1/auth/me", { session: true }); } catch { /* not signed in yet */ }
    // Nor when another tab signed the cookie out while it was being read.
    if (identity && readSignedOut()?.pending) identity = null;
    if (identity) {
      person = identity.person;
      $("invite-whoami").textContent = person?.email || person?.name || "you";
      $("invite-signed-in").hidden = false;
    } else {
      $("invite-signed-out").hidden = false;
    }
  } catch {
    $("invite-loading").hidden = true;
    $("invite-invalid").hidden = false;
  }
}

$("invite-github").addEventListener("click", async () => { await settleSignOutBeforeSignIn(); location.href = oauthUrl("github", `/app/?invite=${encodeURIComponent(inviteToken())}`); });
$("invite-google").addEventListener("click", async () => { await settleSignOutBeforeSignIn(); location.href = oauthUrl("google", `/app/?invite=${encodeURIComponent(inviteToken())}`); });
$("invite-email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("invite-email").value.trim();
  const errorEl = $("invite-error");
  errorEl.hidden = true;
  try {
    await settleSignOutBeforeSignIn();
    await api("/v1/auth/email", { method: "POST", body: { email, next: `/app/?invite=${encodeURIComponent(inviteToken())}` }, session: true });
    toast(`Check ${email} for a sign-in link.`);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});
$("invite-accept-btn").addEventListener("click", async () => {
  const errorEl = $("invite-error");
  errorEl.hidden = true;
  try {
    const { workspace } = await api(`/v1/invites/${encodeURIComponent(inviteToken())}/accept`, { method: "POST", session: true });
    history.replaceState(null, "", "/app/");
    await enterWorkspace(workspace.orgId);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// ---------- boot: session, then a saved key, then the sign-in page ----------
// A failed OAuth/email callback (src/rest.ts's /v1/auth/callback) redirects here with ?auth_error=<message>.
function consumeAuthError() {
  const params = new URLSearchParams(location.search);
  const message = params.get("auth_error");
  if (message) {
    params.delete("auth_error");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
  }
  return message;
}

async function boot() {
  let signedOut = readSignedOut();
  // The reason is shown once. A confirmed sign-out has nothing more to carry; a pending one stays until it lifts.
  if (signedOut && !signedOut.pending) clearTabRecord();
  else if (signedOut?.reason) storeTabRecord({ reason: null, tabKey: signedOut.tabKey });
  const authError = consumeAuthError() ?? (signedOut?.reason ? SIGNED_OUT_REASONS[signedOut.reason] : null);
  const ticket = identityTicket; // a sign-in the person starts meanwhile wins over this automatic one
  if (signedOut?.pending) {
    // Before anything uses the cookie: whose is it? A known person matching no pending entry (an emailed link or OAuth
    // completed) or no session at all lifts what was pending when it looked; anything else, a hang included, keeps it.
    const captured = quarantineIds();
    let bound;
    const look = await Promise.race([lookAtCookie(), new Promise((done) => { bound = setTimeout(() => done({ unsure: true }), SIGN_OUT_CLEANUP_MS); })]);
    clearTimeout(bound);
    if (ticket !== identityTicket) return;
    // Tabs race: the evidence lifts only the entries captured before it was asked for, judged against what is pending
    // now; an entry another tab added meanwhile stays, and keeps this boot out.
    applyLook(look, captured);
    if (!readQuarantine()) clearTabRecord();
    signedOut = readSignedOut();
  }
  let quarantined = Boolean(signedOut?.pending);
  const invite = inviteToken();
  if (invite) return loadInviteAccept(invite, { asSignedOut: quarantined });
  const deepLink = approvalDeepLink();
  // Another tab can sign the cookie out while this boot reads it or enters with it: its quarantine holds here too.
  const signedOutMeanwhile = () => {
    if (quarantined || !readSignedOut()?.pending) return false;
    signedOut = readSignedOut();
    quarantined = true;
    return true;
  };
  const enter = (orgId, opts) => enterWorkspace(orgId, opts).catch((err) => {
    if (err instanceof AuthError && readSignedOut()?.pending) return leaveSignedOutElsewhere(); // refused: quarantined
    throw err;
  });
  if (!quarantined) try {
    const identity = await api("/v1/auth/me", { session: true, owns: ownedBy(ticket) });
    if (!signedOutMeanwhile()) {
      if (deepLink && identity.workspaces.some((w) => w.orgId === deepLink.workspaceId)) {
        return enter(deepLink.workspaceId, { approvalId: deepLink.approvalId });
      }
      if (identity.workspaces.length === 1) return enter(identity.workspaces[0].orgId);
      return renderWorkspacePicker(identity);
    }
  } catch { /* no session cookie, or it's expired: fall through */ }
  signedOutMeanwhile();
  // Quarantined: never enter with the cookie, and keep retrying the invalidation.
  if (quarantined) retryPendingSignOut();
  // The !me guard matters beyond tests too: boot()'s own network round trip can still be in flight
  // after something else (a test harness bypassing it, or a future caller) already established an
  // identity, and re-running signIn here would stomp that state with a second, redundant sign-in.
  if (ticket !== identityTicket) return;
  // A saved key is an automatic sign-in too. While quarantined, only the key the person signed in with in THIS tab
  // (its fingerprint is in the marker), never one another tab saved.
  let keyAllowed = Boolean(agentKey && !me);
  if (keyAllowed && quarantined) {
    keyAllowed = Boolean(signedOut.tabKey) && (await keyFingerprint(agentKey).catch(() => null)) === signedOut.tabKey;
    if (ticket !== identityTicket) return;
  }
  if (keyAllowed) {
    try { return await signIn(agentKey); }
    catch (err) { return signOut(err instanceof AuthError ? "Your saved key was rejected. Sign in again." : `Couldn't reach the hub: ${err.message}`, { reload: false }); }
  }
  showPage("signin");
  loadSignInConfig();
  if (authError) {
    const err = $("signin-error");
    err.textContent = authError;
    err.hidden = false;
  }
}

// ---------- nav (sidebar / bottom bar / "More" drawer) ----------
// A section's data-tab shows up in three places at once: the sidebar (desktop/tablet), the bottom
// bar (mobile, the 4 highest-frequency sections), and the "More" drawer (mobile, the rest) --
// docs/design/HUB_REDESIGN.md 2.1/5.4. All three share the same click handling and aria-current
// bookkeeping; only the drawer additionally needs to close itself on a selection.
function selectTab(name, { history: record = "push", refreshReaders = true } = {}) {
  closeFleetMenus();
  if (name !== "tasks") cancelTaskReads();
  activeTab = name;
  // An address already naming a place inside this view (#/settings/billing) is kept: rewriting it to the bare view
  // lost the section before Settings could open at it (Codex-OpenCadre-f46c on c222b25).
  const here = `#/${routeOf(name)}`;
  const insideThisView = location.hash === here || location.hash.startsWith(`${here}/`);
  if (record !== "none" && !insideThisView && !location.hash.startsWith("#approval-")) {
    history[record === "replace" ? "replaceState" : "pushState"](null, "", `#/${routeOf(name)}`);
  }
  for (const item of document.querySelectorAll("[data-tab]")) {
    if (item.dataset.tab === name) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("is-active", panel.dataset.panel === name);
  }
  if (name === "fleet") refreshFileLocks();
  else if (fileLocksFlight) cancelFileLocks();
  if (name !== "inbox") cancelSelectedInboxStatus();
  else if (selectedInboxItem?.kind === "message") void refreshSelectedInboxStatus();
  if (name === "settings" && typeof refreshIsolation === "function") refreshIsolation();
  if (name === "fleet" && typeof agentsViewFromHash === "function") { const v = agentsViewFromHash(); if (v && v !== fleetViewMode) setAgentsView(v, { record: false }); }
  if (name === "inbox" && typeof inboxViewFromHash === "function" && inboxViewFromHash() !== inboxView) { inboxView = inboxViewFromHash(); applyInboxView(); }
  // Settings always opens on a page: the one in the address (#/settings/people), else the last one shown.
  if (name === "settings" && typeof scrollToSettingsSection === "function") scrollToSettingsSection(location.hash.match(/^#\/settings\/([a-z]+)/)?.[1] ?? settingsPage, { record: false, reveal: true, refreshReaders: false });
  if (typeof syncSidebarMode === "function") syncSidebarMode();
  if (name === "inbox" && inboxView === "history" && isSignedIn()) refresh();
  closeMoreDrawer();
  syncHomeTick();
  if (name === "overview") renderHomeFreshness();
  if (name === "tasks") reconcileOpenTaskReads();
  withdrawHiddenReaderFlights();
  if (isSignedIn() && refreshReaders) refresh(); // first identity entry already owns refreshNow()
}
for (const item of document.querySelectorAll("[data-tab]")) item.addEventListener("click", () => selectTab(item.dataset.tab));
// Back and forward move between views. The history entry already holds the address, so nothing new is recorded.
window.addEventListener("popstate", () => {
  const name = tabFromHash();
  if (!name || $("console")?.hidden) return;
  if (name !== activeTab) selectTab(name, { history: "none" });
  // Back and forward between two sections of Settings stay on the view, so the view doesn't change; the section does.
  const section = location.hash.match(/^#\/settings\/([a-z]+)/)?.[1];
  if (name === "settings") scrollToSettingsSection(section ?? settingsPage, { record: false });
  if (name === "fleet") { const v = agentsViewFromHash(); if (v && v !== fleetViewMode) setAgentsView(v, { record: false }); }
  if (name === "inbox" && inboxViewFromHash() !== inboxView) { inboxView = inboxViewFromHash(); applyInboxView(); }
});

// Jumps to Inbox pre-filtered to one type (Overview's "Review ->" previews, Timeline's "Inbox ->").
function goToInbox(filter) {
  inboxFilter = filter;
  applyInboxFilter();
  selectTab("inbox");
}
// Overview's "View X ->" links jump tabs without being nav-item copies themselves (no [data-tab],
// so selectTab's aria-current/copy-counting logic never sees them).
$("overview-view-fleet")?.addEventListener("click", () => selectTab("fleet"));
$("overview-view-timeline")?.addEventListener("click", () => selectTab("timeline"));

// Nav badges (unread/pending counts) are duplicated between the sidebar and the mobile bottom-bar/
// drawer copies, since mobile can't reach the sidebar -- this mirrors whichever call site just
// updated the sidebar's own element onto its mobile twin, so there's one source of truth per badge.
function syncBadgeMobile(id) {
  const primary = $(id);
  const clone = $(`${id}-mobile`);
  if (!primary || !clone) return;
  clone.hidden = primary.hidden;
  clone.textContent = primary.textContent;
}

// The drawer is a modal dialog (role="dialog" aria-modal="true" in index.html), so it behaves as one: focus moves in on
// open, Tab and Shift+Tab stay inside, the page behind it is inert (no focus, no clicks, hidden from assistive tech), and
// closing lifts that and puts focus back on More. The bottom bar is behind it too: More itself is reached again by
// closing, never by tabbing out. So is the skip link, which sits outside the shell.
const DRAWER_BACKGROUND = () => [$("skip-link"), $("sidebar"), $("bottom-bar"), document.querySelector(".shell-main")].filter(Boolean);
const drawerFocusables = () => [...$("more-drawer").querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
  .filter((n) => !n.disabled && !n.closest("[hidden]"));
function openMoreDrawer() {
  $("more-drawer").hidden = false;
  $("more-drawer-backdrop").hidden = false;
  $("more-btn")?.setAttribute("aria-expanded", "true");
  for (const region of DRAWER_BACKGROUND()) region.setAttribute("inert", "");
  drawerFocusables()[0]?.focus();
}
function closeMoreDrawer() {
  const wasOpen = !$("more-drawer").hidden;
  $("more-drawer").hidden = true;
  $("more-drawer-backdrop").hidden = true;
  $("more-btn")?.setAttribute("aria-expanded", "false");
  for (const region of DRAWER_BACKGROUND()) region.removeAttribute("inert");
  // Only when it was open: selectTab calls this on every navigation, and must not pull focus to More each time.
  if (wasOpen) $("more-btn")?.focus();
}
// Skip to content: focus moves to main, and the address keeps naming the view (following href="#main" would replace
// #/tasks with #main, so a reload or a copied link would lose the view).
$("skip-link")?.addEventListener("click", (e) => { e.preventDefault(); $("main")?.focus(); });
$("more-btn")?.addEventListener("click", () => ($("more-drawer").hidden ? openMoreDrawer() : closeMoreDrawer()));
$("more-drawer-close")?.addEventListener("click", closeMoreDrawer);
$("more-drawer-backdrop")?.addEventListener("click", closeMoreDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("more-drawer").hidden) closeMoreDrawer(); });
$("more-drawer")?.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const items = drawerFocusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !$("more-drawer").contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !$("more-drawer").contains(at))) { e.preventDefault(); first.focus(); }
});

// ---------- polling ----------
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refreshNow();
    if (isSignedIn()) schedulePoll();
  }, POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && isSignedIn()) refresh(); });

// ---------- refresh scheduling ----------
// One refresh runs at a time, and a request made while one runs queues exactly one more after it. Pushes, a return
// to the tab and actions ask through refresh(), which waits for REFRESH_SETTLE_MS of quiet so a burst of frames costs
// one refresh, but never waits longer than REFRESH_MAX_WAIT_MS from the first request, so a steady stream of frames
// still refreshes about once a second. The first load and the 4 s poll call refreshNow() and do not wait.
const REFRESH_SETTLE_MS = 250;
const REFRESH_MAX_WAIT_MS = 1000;
const REFRESH_READ_DEADLINE_MS = 15_000;
class RefreshReadTimeoutError extends Error {
  constructor() {
    super("Dashboard reads timed out after 15 seconds.");
    this.name = "RefreshReadTimeoutError";
  }
}
class RefreshReadCancelledError extends Error {
  constructor() {
    super("Dashboard read scope ended before this response could be used.");
    this.name = "RefreshReadCancelledError";
  }
}
function createRefreshReadScope({ settleOnCancel = false } = {}) {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let rejectDeadline;
  let rejectDisposed;
  let timer = null;
  let timedOut = false;
  let disposed = false;
  const error = new RefreshReadTimeoutError();
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const cancelError = new RefreshReadCancelledError();
  const disposedPromise = new Promise((_, reject) => { rejectDisposed = reject; });
  const scope = {
    signal: controller?.signal,
    error,
    cancelError,
    get timedOut() { return timedOut; },
    get disposed() { return disposed; },
    wait: promise => Promise.race([promise, deadline, disposedPromise]),
    cancel() {
      // Approval jobs join the flight even if api() abandons an obsolete response forever.
      // Their outer wait must settle on identity change, not just lose its deadline timer.
      if (settleOnCancel) return scope.dispose();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      refreshReadScopes.delete(scope);
      controller?.abort();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      refreshReadScopes.delete(scope);
      if (disposed) return;
      disposed = true;
      controller?.abort();
      rejectDisposed(cancelError);
    },
  };
  timer = setTimeout(() => {
    timedOut = true;
    controller?.abort();
    rejectDeadline(error);
  }, REFRESH_READ_DEADLINE_MS);
  refreshReadScopes.add(scope);
  return scope;
}
// The flight in progress, owned by the generation that started it: { generation, successor, promise }. A new generation
// never joins an older flight, so a request still out for the previous identity cannot hold up the new one.
let refreshRunning = null;
let refreshSoonTimer = null;
let refreshFirstAskedAt = 0;
let refreshWaiters = [];

// Ancillary surfaces share the existing scheduler but never join its atomic core batch.
// Each source has one bounded flight and one coalesced follow-up; no independent polling timer.
const visibleReaders = new Map();
let membersActionEpoch = 0;
let inviteCreateTicket = 0;
const inviteRevokeFlights = new Map();
const readerCards = { members: "members-card", isolation: "projects-card", policy: "policy-card",
  push: "webhook-card", onboarding: "onboarding-card", goal: "overview-goal" };
const readerLabels = { members: "People", isolation: "Project links", policy: "Safety policy",
  push: "Phone devices", onboarding: "Checklist", goal: "Goal" };
const readerAdmin = () => ["owner", "admin"].includes(effectiveRole());
function checklistEligible() {
  const org = me?.orgId;
  if (!org || me?.billing?.awaitingPlan || flagOn(onboardingHideKey(org))) return false;
  if (!$("first-run-card").hidden) return false;
  // A pending first-run device read must not briefly expose both cards.
  const devices = homeSources.devices.data?.devices ?? [];
  return !flagOn(selfServeFlagKey(org)) || flagOn(firstRunHideKey(org))
    || (!firstRunConnected && devices.some(d => d.status === "connected" || d.status === "merged"));
}
function visibleReaderEligible(name) {
  if (!isSignedIn() || !me || document.hidden) return false;
  if (name === "goal") return activeTab === "overview";
  if (name === "onboarding") return activeTab === "overview" && checklistEligible();
  if (activeTab !== "settings") return false;
  if (name === "push") return settingsPage === "notifications" && authMode === "session";
  return readerAdmin() && settingsPage === ({ members: "people", isolation: "projects", policy: "safety" })[name];
}
function readerState(name) {
  if (!visibleReaders.has(name)) visibleReaders.set(name, { ticket: 0, flight: null, status: "pending", lastOkAt: 0, data: null });
  return visibleReaders.get(name);
}
function readerCaption(name) {
  let node = $(`reader-${name}-status`);
  if (!node) {
    node = el("p", { id: `reader-${name}-status`, class: "field-hint" });
    const card = $(readerCards[name]);
    // Empty/finished Home cards may be hidden; their read status remains observable.
    (name === "goal" || name === "onboarding" ? card?.parentNode : card)?.append(node);
  }
  const state = readerState(name);
  if (!node) return;
  if (name === "policy") $("policy-loading").hidden = state.status !== "loading" || Boolean(state.lastOkAt);
  // Quiet when the read is fine, or still loading over an answer already shown. Otherwise the line names the reader
  // (People, Safety policy, ...) and what happened, in its own text.
  if (state.status === "ok" || state.status === "pending" || !state.status || (state.status === "loading" && state.lastOkAt)) {
    node.replaceChildren();
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const what = readerLabels[name];
  // A failure over an answer already on screen says how old that answer is (main's "Last applied ... ago").
  const age = state.lastOkAt ? ` Last applied ${ago(new Date(state.lastOkAt).toISOString())}.` : "";
  const text = state.status === "failed" ? `${what} couldn't refresh. Trying again on the next refresh.${age}`
    : state.status === "forbidden" ? `${what} unavailable for your access.`
    : `Checking ${what.toLowerCase()}…`;
  node.replaceChildren(el("span", { class: state.status === "loading" ? undefined : "reader-warn" }, text));
}
function invalidateVisibleReader(name) {
  const state = visibleReaders.get(name);
  if (!state) return;
  state.ticket++;
  if (state.flight) { state.flight.queued = false; state.flight.scope.cancel(); state.flight = null; }
}
function withdrawHiddenReaderFlights() {
  if (!visibleReaderEligible("members")) { membersActionEpoch++; withdrawInviteRevokes(); clearInviteResult(); }
  for (const [name, state] of visibleReaders) if (state.flight?.scheduled && !visibleReaderEligible(name)) {
    invalidateVisibleReader(name);
    state.status = state.lastOkAt ? "ok" : "pending";
    readerCaption(name);
  }
}
function resetVisibleReaders() {
  membersActionEpoch++;
  withdrawInviteRevokes();
  for (const name of visibleReaders.keys()) {
    invalidateVisibleReader(name);
    const caption = $(`reader-${name}-status`); if (caption) caption.textContent = "";
  }
  visibleReaders.clear();
  $("push-card").hidden = true;
}
function clearVisibleReader(name) {
  if (name === "members") {
    membersActionEpoch++;
    withdrawInviteRevokes();
    membersLoaded = false; $("members-list").replaceChildren(); $("invites-list").replaceChildren();
    $("invite-form").hidden = true; clearInviteResult();
    $("invite-email-input").value = "";
  } else if (name === "policy") {
    policyLoaded = false; policySignature = null; $("policy-list").replaceChildren(); $("policy-add-form").hidden = true;
    $("policy-add-project").value = "";
  } else if (name === "isolation") {
    isolationState = null; projectLinks = []; $("isolation-section").hidden = true; $("project-links-list").replaceChildren();
  } else if (name === "push") {
    $("push-card").hidden = true; $("push-devices-list").replaceChildren(); $("push-devices").hidden = true;
  } else if (name === "onboarding") {
    $("onboarding-card").hidden = true; $("onboarding-steps").replaceChildren();
  } else if (name === "goal") {
    goalCache = { workspace: goalWorkspace(), at: 0 }; renderGoal(null); $("overview-goal-text").textContent = "";
    $("overview-goal-meta").textContent = "";
  }
}
async function runVisibleReader(name, load, apply, { scheduled = false } = {}) {
  if (scheduled && !visibleReaderEligible(name)) return;
  const state = readerState(name);
  if (state.flight) { state.flight.queued = true; return state.flight.promise; }
  const generation = consoleGeneration;
  const flight = { scope: null, queued: false, promise: null, scheduled };
  state.flight = flight;
  flight.promise = (async () => {
    do {
      flight.queued = false;
      const ticket = ++state.ticket;
      const scope = createRefreshReadScope({ settleOnCancel: true }); flight.scope = scope;
      const current = () => generation === consoleGeneration && state.ticket === ticket && state.flight === flight
        && (!scheduled || visibleReaderEligible(name));
      state.status = "loading"; readerCaption(name);
      const read = (path, options = {}) => scope.wait(api(path, { ...options, owns: current, refreshReadScope: scope }));
      try {
        const data = await scope.wait(load(read, scope, current));
        if (!current()) break;
        apply(data);
        state.data = data; state.lastOkAt = Date.now(); state.status = "ok"; readerCaption(name);
      } catch (err) {
        if (!current()) break;
        if (err instanceof AuthError) {
          state.data = null; state.lastOkAt = 0; state.status = "forbidden"; clearVisibleReader(name); readerCaption(name);
          if (authMode === "session") void reconcileWorkspaceAccess(4001); else signOut("Your key was rejected. Sign in again.");
        } else if (err instanceof PausedError) {
          state.data = null; state.lastOkAt = 0; state.status = "forbidden"; clearVisibleReader(name); readerCaption(name);
          if (authMode === "session") void reconcileWorkspaceAccess(4003);
          else { me = { ...me, workspace: { ...me?.workspace, paused: true } }; renderWorkspaceBanner(err.message); }
        } else if (err?.status === 403) {
          // A source refusal is not /me membership loss: withdraw only this source's data/actions.
          state.data = null; state.lastOkAt = 0; state.status = "forbidden"; clearVisibleReader(name); readerCaption(name);
        } else {
          state.status = "failed"; readerCaption(name); // retain safe last-good content with its real age
        }
      } finally { scope.dispose(); }
    } while (flight.queued && generation === consoleGeneration && (!scheduled || visibleReaderEligible(name)));
  })().finally(() => { if (state.flight === flight) state.flight = null; });
  return flight.promise;
}
function refreshVisibleReaders() {
  withdrawHiddenReaderFlights();
  for (const [name, read] of [["members", refreshMembers], ["isolation", refreshIsolation], ["policy", refreshClearancePolicy],
    ["push", refreshPushCard], ["onboarding", refreshOnboarding], ["goal", refreshGoal]]) {
    if (visibleReaderEligible(name)) void read({ scheduled: true });
  }
}

// Preserve stable controls and focus while updating independent metadata. Dirty rows keep their local
// choice, but a changed remote value disables Save until Cancel adopts the latest authorized snapshot.
function reconcileReaderRows(container, items, keyOf, buildRow) {
  const old = new Map([...container.children].map(n => [n.dataset.readerKey, n]));
  const wanted = items.map(item => {
    const key = String(keyOf(item)); const fresh = buildRow(item); fresh.dataset.readerKey = key;
    const prior = old.get(key);
    if (!prior) return fresh;
    const controls = [...prior.querySelectorAll("select")]; const nextControls = [...fresh.querySelectorAll("select")];
    const sameRights = controls.length === nextControls.length && prior.querySelectorAll("button:not([data-reader-cancel])").length === fresh.querySelectorAll("button").length
      && controls.every((s, i) => [...s.options].map(o => o.value).join() === [...nextControls[i].options].map(o => o.value).join());
    if (!sameRights) return fresh; // authorization/removed management affordances outrank held drafts
    const dirty = controls.some(s => s.dataset.original !== undefined && s.value !== s.dataset.original);
    const held = dirty || prior.contains(document.activeElement) || prior.querySelector("button:disabled, .is-holding");
    if (!held) return prior.isEqualNode(fresh) ? prior : fresh;
    for (const selector of [".member-row-name", ".policy-row-name", ".push-device-meta", ".link-pair", ".link-by", ".invite-row-meta"]) {
      const target = prior.querySelector(selector); const incoming = fresh.querySelector(selector);
      if (target && incoming && !target.isEqualNode(incoming)) target.replaceChildren(...incoming.childNodes);
    }
    let conflict = false;
    controls.forEach((s, i) => {
      s.setAttribute("aria-label", nextControls[i].getAttribute("aria-label") ?? "");
      if (s.dataset.original !== undefined && s.value !== s.dataset.original) {
        if (s.dataset.original !== nextControls[i].dataset.original) conflict = true;
      } else { s.value = nextControls[i].value; s.dataset.original = nextControls[i].dataset.original; }
    });
    let notice = prior.querySelector("[data-reader-conflict]");
    if (conflict && !notice) {
      notice = el("span", { class: "field-hint", "data-reader-conflict": "" }, "Changed remotely. Cancel to use the latest value.");
      const cancel = el("button", { type: "button", class: "btn btn-sm btn-quiet", "data-reader-cancel": "" }, "Cancel");
      prior.append(notice, cancel);
    }
    if (conflict || notice) {
      const save = [...prior.querySelectorAll("button")].find(b => b.textContent === "Save"); if (save) save.disabled = true;
      prior.querySelector("[data-reader-cancel]").onclick = () => {
        const focused = prior.contains(document.activeElement); prior.replaceWith(fresh);
        if (focused) fresh.querySelector("select, button")?.focus();
      };
    }
    return prior;
  });
  for (const node of [...container.children]) if (!wanted.includes(node)) node.remove();
  wanted.forEach((node, i) => { if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null); });
}

/** Resolves once a refresh that started after this call has finished. */
function refresh() {
  return new Promise((done) => {
    refreshWaiters.push(done);
    const now = Date.now();
    if (!refreshSoonTimer) refreshFirstAskedAt = now;
    clearTimeout(refreshSoonTimer);
    refreshSoonTimer = setTimeout(() => {
      refreshSoonTimer = null;
      const waiters = refreshWaiters;
      refreshWaiters = [];
      // Signed out by the time the wait ends (or never signed in): nothing to load, and nothing to paint over the page.
      if (!isSignedIn()) return waiters.forEach((w) => w());
      refreshNow().catch(() => {}).then(() => waiters.forEach((w) => w()));
    }, Math.max(0, Math.min(REFRESH_SETTLE_MS, refreshFirstAskedAt + REFRESH_MAX_WAIT_MS - now)));
  });
}

function refreshNow() {
  if (refreshRunning && refreshRunning.generation === consoleGeneration) {
    const current = refreshRunning;
    // Calls during a flight request one successor. Its completion belongs to those callers, not to the original
    // bounded read; refresh() waiters still wait for a read that starts after their request.
    current.successor ??= current.promise.then(() => {
      if (current.generation !== consoleGeneration || !isSignedIn()) return;
      // An earlier subscriber may already have started the eligible successor. Join that flight rather than
      // treating our internal continuation as another external request for a third read.
      if (refreshRunning?.generation === current.generation) return refreshRunning.promise;
      return refreshNow();
    });
    return current.successor;
  }
  const flight = { generation: consoleGeneration, successor: null, promise: null };
  flight.promise = (async () => {
    try {
      await loadAndRender();
    } finally {
      // An obsolete flight finishing late must not clear the current generation's flight.
      if (refreshRunning === flight) refreshRunning = null;
    }
  })();
  refreshRunning = flight;
  return flight.promise;
}

// Each read owns its deadline and application. The scheduler joins settlement, never publication.
// Only the current identity gate may authorize a result; an obsolete api() deliberately never settles,
// so the outer scope wait is required as well as the waits inside fetch and response.json().
async function loadAndRender() {
  const generation = consoleGeneration;
  const key = agentKey;
  const stale = () => generation !== consoleGeneration || key !== agentKey;
  const scopes = [];
  const newScope = () => {
    const scope = createRefreshReadScope({ settleOnCancel: true });
    scopes.push(scope);
    return scope;
  };
  const scopedRead = (scope, path) => scope.wait(api(path, { refreshReadScope: scope, deferPlanRefusal: true }));
  const identityScope = newScope();
  const decisionsDuringRead = new Map();
  approvalReadDecisions = decisionsDuringRead;
  const overlayAtRead = focusedApprovalSubject;
  const pendingForThisRead = rows => rows.filter(a => !decisionsDuringRead.has(a.id));
  const grantsForThisRead = rows => {
    const merged = new Map(rows.map(g => [g.id, g]));
    for (const result of decisionsDuringRead.values()) if (result.grant) merged.set(result.grant.id, result.grant);
    return [...merged.values()];
  };
  const historyForThisRead = rows => {
    const merged = new Map(rows.filter(a => a.status !== "pending").map(a => [a.id, a]));
    for (const [id, result] of decisionsDuringRead) if (result.approval) merged.set(id, result.approval);
    return [...merged.values()].sort((a, b) => parseTime(b.decided_at || b.created_at) - parseTime(a.decided_at || a.created_at)).slice(0, 15);
  };
  const failed = (name, step, err) => {
    if (stale() || err instanceof RefreshReadCancelledError) return;
    homeSources[name] = applySource(homeSources[name] ?? newSource(), { ok: false, kind: err?.status === 403 ? "forbidden" : "failed" });
    const surface = { tasks: "tasks", roster: "fleet-groups", approvals: "clearances", messages: "inbox-list" }[name];
    if (surface) $(surface)?.querySelectorAll(".skeleton").forEach(node => node.remove());
    if (name === "messages" && err?.status !== 403 && !inboxLoaded) renderInboxError();
    if ((CORE_HOME_DOMAINS.includes(name) || step.startsWith("render:")) && err?.status !== 403) coreDomainFailures.set(name, { step, err });
    else coreDomainFailures.delete(name);
  };
  const refreshFreshness = () => {
    const failure = coreDomainFailures.values().next().value;
    const applied = CORE_HOME_DOMAINS.map(name => homeSources[name].lastOkAt);
    homeSources.core = { lastOkAt: applied.every(Boolean) ? Math.min(...applied) : 0, failed: Boolean(failure) };
    if (failure) showRefreshFailure(failure.step, failure.err);
    else refreshFailure = null;
    renderHomeFreshness();
    syncHomeTick();
  };
  const agents = () => homeSources.roster.data?.agents ?? [];
  const endedRefused = () => ["ended", "sessions"].some(name => homeSources[name].status === "forbidden");
  const applyFleetSources = () => {
    // Pending optional reads are not permission refusals. Do not wipe a roster or a live form for them.
    if (homeSources.devices.status !== "pending" && homeSources.sessions.status !== "pending") {
      renderFleetGroups(homeSources.devices.data, homeSources.sessions.data, agents());
    }
    fleetAgentById = new Map(agents().map(a => [a.id, a]));
    indexAgentTools(agents(), homeSources.sessions.data?.sessions, endedRefused() ? [] : homeSources.ended.data?.sessions);
    renderEndedSessions(endedRefused() ? [] : homeSources.ended.data?.sessions ?? []);
  };
  const project = () => {
    if (stale()) return;
    try {
      homeLast = {
        approvals: lastInboxApprovals,
        messages: homeSources.messages.data?.messages ?? [],
        awarenessDigest: homeSources.awareness.data,
        liveSessions: homeSources.sessions.data?.sessions ?? null,
        taskCounts: homeSources.tasks.data ? taskBoard.totals : null,
        grants: lastApprovalGrants,
        agents: agents(),
        events: homeSources.events.data?.events ?? [],
        sources: homeSources,
      };
      renderOverview(homeLast);
      if (me) renderBilling({ agents: homeSources.roster.data?.agents, devices: homeSources.devices.data?.devices, projects: homeSources.projects.data?.projects, forbidden: { devices: homeSources.devices.status === "forbidden", projects: homeSources.projects.status === "forbidden" } });
      renderSidebarIdentity();
      renderSidebarAlert();
      updateInboxBadge(lastInboxApprovals, homeLast.messages, homeLast.awarenessDigest);
      const incomplete = ["approvals", "messages", "awareness"].some(name => homeSources[name].status !== "ok");
      $("inbox-badge").dataset.partial = String(incomplete);
      $("inbox-badge").title = incomplete ? "Some inbox updates could not be checked" : "";
      coreDomainFailures.delete("home");
    } catch (err) { coreDomainFailures.set("home", { step: "renderOverview", err }); }
    refreshFreshness();
  };
  noticeHolds.push(generation);
  const authorized = scopedRead(identityScope, "/v1/me").then(identity => {
    if (stale() || identityScope.disposed || identityScope.timedOut) return false;
    const identityWasMissing = !me;
    if (me && permissionMoved(me, identity)) { permissionChanged(identity); return false; }
    me = identity;
    if (authMode === "session" && typeof identity.memberRole === "string") currentWorkspaceRole = identity.memberRole;
    homeSources.identity = { status: "ok", data: identity, receivedAt: Date.now(), lastOkAt: homeSources.identity.lastOkAt };
    coreDomainFailures.delete("identity");
    try {
      $("org-name").textContent = identity.orgName ?? "";
      if (identityWasMissing) applyRole();
      syncInboxWorkspace();
      renderWorkspaceBanner();
      renderSettings();
      renderConnectApps();
      renderBillingBanner();
      renderSidebarIdentity();
      renderSidebarAlert();
      syncSidebarMode();
      const pausedNow = Boolean(me.workspace?.paused);
      if (pausedNow !== lastKnownPaused) {
        lastKnownPaused = pausedNow;
        if (me.role === "operator") renderKillSwitch();
      }
      homeSources.identity.lastOkAt = Date.now();
      coreDomainFailures.delete("identity-render");
    } catch (err) { coreDomainFailures.set("identity-render", { step: "renderIdentity", err }); }
    // A fresh accepted gate also restores push after an identity refusal disconnected it.
    connectLiveWs();
    // Ancillary readers own their flights and cancellation; they never join a core application barrier.
    if (typeof refreshVisibleReaders === "function") refreshVisibleReaders();
    if (activeTab === "fleet") void refreshFileLocks();
    return true;
  }, err => {
    if (stale()) return false;
    if (authMode === "session" && (err?.status === 403 || err instanceof AuthError || err instanceof PausedError)) {
      void reconcileWorkspaceAccess(err instanceof AuthError ? 4001 : err instanceof PausedError ? 4003 : 4004);
    } else if (authMode === "key" && err?.status === 403) {
      // Current identity refusal ends authorization for every protected source, not just the gauge.
      // Keep the key for the existing bounded retry; this is no assertion that the credential is invalid.
      me = null;
      beginConsoleGeneration();
      renderUnacceptedWorkspaceIdentity();
      showRefreshFailure("/v1/me", err);
    } else if (err instanceof AuthError) signOut("Your key was rejected. Sign in again.");
    else if (err instanceof PausedError) {
      me = me ? { ...me, workspace: { ...me.workspace, paused: true } } : null;
      renderWorkspaceBanner(err.message);
      connectAppsReadFailed();
    } else { failed("identity", "/v1/me", err); refreshFreshness(); connectAppsReadFailed(); }
    return false;
  }).finally(() => identityScope.dispose());

  // Capture read success independently of authorization, but keep it local until the gate accepts it.
  const domain = (name, path, render, { fetcher = null, withdraw = null, optional = false } = {}) => {
    const scope = newScope();
    const response = scope.wait(fetcher ? fetcher(p => scopedRead(scope, p)) : scopedRead(scope, path))
      .then(data => ({ ok: true, data, receivedAt: Date.now() }), err => ({ ok: false, err }));
    return response.then(async result => {
      if (!(await authorized) || stale() || scope.disposed || scope.timedOut && result.ok) return;
      const previous = homeSources[name] ?? newSource();
      if (!result.ok) {
        failed(name, path.split("?")[0], result.err);
        if (result.err?.status === 403 && withdraw) {
          try { withdraw(); } catch (err) { coreDomainFailures.set(name, { step: "withdraw:" + name, err }); }
        }
        // Source-only failures never withdraw the whole workspace under a valid /me.
        if (!optional && result.err instanceof PlanError) {
          planRefusal = { message: result.err.message, code: result.err.code, at: Date.now() };
          renderBillingBanner();
        }
        if (name === "awareness") syncSelectedMention();
        project();
        return;
      }
      try {
        const candidate = { status: "ok", data: result.data, receivedAt: result.receivedAt, lastOkAt: previous.lastOkAt };
        // Renderers that combine sources see the accepted candidate; a throwing renderer keeps its old application age.
        homeSources[name] = candidate;
        if (render(result.data) === false) { homeSources[name] = previous; return; }
        homeSources[name] = { ...candidate, lastOkAt: Date.now() };
        coreDomainFailures.delete(name);
        firstRefreshDone = true;
      } catch (err) {
        homeSources[name] = previous;
        failed(name, "render:" + name, err);
      }
      project();
    }).finally(() => scope.dispose());
  };
  const jobs = [
    domain("roster", "/v1/agents", data => {
      updateFleetCount(data.agents);
      setTrustData(homeSources.reliability.data, data.agents);
      renderOtherAgents(data.agents);
      applyFleetSources();
    }, { withdraw: () => { updateFleetCount([]); renderOtherAgents([]); applyFleetSources(); } }),
    domain("tasks", "/v1/tasks", data => applyTaskBoard(data), { fetcher: get => fetchTaskBoard(get), withdraw: () => {
      taskBoard = newTaskBoard(); taskBoardTicket++; taskDetailCache.clear(); taskCards.clear(); renderTaskBoard();
    } }),
    domain("approvals", "/v1/approvals?status=pending", data => {
      const approvals = pendingForThisRead(data.approvals);
      homeSources.approvals.data = { ...data, approvals };
      applyPendingApprovals(approvals, overlayAtRead);
    }, { withdraw: () => applyPendingApprovals([], overlayAtRead) }),
    domain("grants", "/v1/approval-grants", data => {
      lastApprovalGrants = grantsForThisRead(data.grants);
      homeSources.grants.data = { ...data, grants: lastApprovalGrants };
      if (activeTab === "inbox" && inboxView === "history") renderHistory(lastApprovalHistory, lastApprovalGrants);
    }, { withdraw: () => { lastApprovalGrants = []; if (activeTab === "inbox" && inboxView === "history") renderHistory(lastApprovalHistory, []); } }),
    domain("messages", "/v1/messages?peek=true", data => renderInbox(data.messages), { optional: true, withdraw: () => {
      openMessageId = openMessageData = replyingToThreadId = null; replyDraft = "";
      if (selectedInboxItem?.kind === "message") { selectedInboxItem = null; showInboxFocusEmpty(); }
      renderInbox([]);
    } }),
    domain("awareness", "/v1/awareness", data => { renderAwareness(data); renderInboxMentions(data); }, { optional: true, withdraw: () => {
      if (selectedInboxItem?.kind === "mention") { selectedInboxItem = null; showInboxFocusEmpty(); }
      currentAwarenessDigest = null; renderAwareness(null); renderInboxMentions(null);
    } }),
    domain("events", "/v1/events?limit=40", data => {
      if ($("timeline-filter")?.value !== "decision.recorded" || activeTab !== "timeline") renderTimeline(data.events);
    }, { optional: true, withdraw: () => { currentTimelineEvents = []; renderTimeline([]); } }),
    domain("devices", "/v1/org/devices", () => { applyFleetSources(); renderConnectPlanNote(homeSources.devices.data?.devices); renderConnectComputers(homeSources.devices.data?.devices, homeSources.sessions.data?.sessions); }, { optional: true, withdraw: applyFleetSources }),
    domain("sessions", "/v1/org/sessions?status=live", () => { applyFleetSources(); renderConnectComputers(homeSources.devices.data?.devices, homeSources.sessions.data?.sessions); }, { optional: true, withdraw: applyFleetSources }),
    domain("ended", "/v1/org/sessions?status=ended&since=" + encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString()), applyFleetSources, { optional: true, withdraw: applyFleetSources }),
    domain("projects", "/v1/org/projects", data => renderProjectsSection(data, "ok"), { optional: true, withdraw: () => renderProjectsSection(null, "forbidden") }),
    domain("reliability", "/v1/reliability/all", data => { setTrustData(data, agents()); renderOtherAgents(agents()); }, { optional: true, withdraw: () => setTrustData(null, agents()) }),
  ];
  if (activeTab === "inbox" && inboxView === "history") jobs.push(domain("history", historyShowNoted ? "/v1/approvals?includeNoted=true" : "/v1/approvals", data => renderHistory(historyForThisRead(data.approvals), lastApprovalGrants), { withdraw: () => renderHistory([], lastApprovalGrants) }));
  if (activeTab === "timeline" && $("timeline-filter")?.value === "decision.recorded") jobs.push(domain("decisions", "/v1/events?types=decision.recorded&limit=200", data => renderTimeline(data.events), { optional: true, withdraw: () => renderTimeline([]) }));
  jobs.push(authorized.then(ok => ok && !stale() ? refreshSelectedInboxStatus() : undefined));
  try { await Promise.allSettled([authorized, ...jobs]); }
  finally {
    for (const scope of scopes) scope.dispose();
    const hold = noticeHolds.indexOf(generation);
    if (hold !== -1) noticeHolds.splice(hold, 1);
    if (approvalReadDecisions === decisionsDuringRead) approvalReadDecisions = null;
    if (!stale()) { project(); syncNotice(); }
  }
}

// ---------- overview ----------
// New home page (docs/design/HUB_REDESIGN.md 2.3): reads only endpoints already fetched by refresh(),
// no new network calls. "Needs your attention" previews the same items Clearances/Inbox/Awareness own;
// its "Review ->" action jumps to that item's real tab rather than duplicating decide()/reply logic
// here -- full inline actions land with the Inbox merge (Stage 3), which is where that data actually
// becomes one list instead of three.
function renderOverview({ approvals, messages, awarenessDigest, liveSessions, taskCounts, grants, agents, events, sources = null }) {
  const isOperator = me?.role === "operator";
  const subtitle = $("overview-subtitle");
  if (subtitle) subtitle.textContent = me?.orgName ? `${me.orgName} · signed in as ${me.agentName}` : "";
  renderOverviewAttention(approvals, messages, awarenessDigest);
  const ATTENTION_SOURCES = [["approvals", "approvals"], ["messages", "messages"], ["awareness", "updates"]];
  const notOk = sources ? ATTENTION_SOURCES.filter(([name]) => sources[name]?.status !== "ok") : [];
  const attentionPartial = notOk.length > 0;
  if (attentionPartial) {
    // Name the source: "Approvals couldn't refresh", or "Checking updates…" while one is still loading.
    const withStatus = (...statuses) => notOk.filter(([name]) => statuses.includes(sources[name]?.status)).map(([, label]) => label);
    const failed = notOk.filter(([name]) => !["loading", "pending", "forbidden"].includes(sources[name]?.status)).map(([, label]) => label);
    const forbidden = withStatus("forbidden");
    const names = (list) => { const s = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]; return s[0].toUpperCase() + s.slice(1); };
    const empty = $("overview-attention")?.querySelector(".empty");
    // A source this person may not read is said as such, not as a failure.
    if (empty) empty.replaceChildren(failed.length
      ? el("strong", { class: "reader-warn" }, `${names(failed)} couldn't refresh`)
      : forbidden.length ? el("span", {}, `${names(forbidden)} unavailable for your access`)
      : el("span", {}, `Checking ${notOk.map(([, label]) => label).join(", ")}…`));
  }
  if ($("overview-attention-count")) { $("overview-attention-count").dataset.partial = String(Boolean(attentionPartial)); $("overview-attention-count").title = attentionPartial ? "Only checked or previously shown items are included" : ""; }
  // Without a refresh's sources, a list stands for an answered read and none for a refused one.
  const sessions = sources?.sessions ?? (Array.isArray(liveSessions) ? { status: "ok", data: { sessions: liveSessions }, lastOkAt: 0 }
    : { status: isOperator ? "failed" : "forbidden", data: null, lastOkAt: 0 });
  const fleet = homeFleet(sessions, agents);
  // Questions only from this answer, never a kept one; without one, the tile and the map say so, and since when.
  const m = sources?.messages;
  const questions = m ? (m.status === "ok" ? m.data?.messages ?? [] : null) : messages;
  const unchecked = questions ? null : `Questions could not be checked${m.lastOkAt ? ` since ${clockTime(m.lastOkAt)}` : ""}; needs you counts approvals only.`;
  const needs = needsYouIds(fleet.members, approvals, questions);
  const happening = $("overview-happening-section");
  if (happening) happening.hidden = !isOperator;
  if (isOperator) renderWorkingNow(fleet, sessions);
  renderHomeTiles({ fleet, needs, unchecked, taskCounts, approvals, grants, sources });
  renderHomeFleetMap(isOperator ? fleet : null, needs, unchecked, sessions);
  renderHomeLimits(agents, sources);
  const ev = sources?.events;
  renderOverviewActivity(ev ? ev.data?.events ?? null : events);
  homeCaption("overview-activity-caption", ev, "recent activity");
  renderHomeNext();
}

/** Home's notice while the workspace has no plan: it says so plainly, with no action to take here. */
function renderHomeNext() {
  const box = $("home-next");
  if (!box) return;
  const b = me?.billing;
  box.hidden = !b?.awaitingPlan;
  if (!b?.awaitingPlan) return;
  $("home-next-title").textContent = "No plan yet";
  $("home-next-meta").textContent = "This workspace has no plan, so its limits are 0 and no computer or agent can connect until one is assigned.";
  $("home-next-action").hidden = true;
}

// The goal is per workspace. The cache is keyed by the workspace it was read for, a switch clears what is shown at
// once, and a reply that lands after the workspace changed is dropped (Codex-OpenCadre-f46c on 7dbb8f2).
let goalCache = { workspace: null, at: 0 };
let goalRequest = 0;
let goalExpanded = false;
const goalWorkspace = () => currentWorkspace ?? me?.orgId ?? null;
async function refreshGoal(options = {}) {
  const workspace = goalWorkspace();
  if (workspace !== goalCache.workspace) {
    invalidateVisibleReader("goal");
    goalCache = { workspace, at: 0 };
    goalExpanded = false;
    renderGoal(null);
  }
  return runVisibleReader("goal", async read => (await read("/v1/goal"))?.goal ?? null, goal => {
    if (goalWorkspace() !== workspace) return;
    renderGoal(goal); goalCache.at = Date.now();
  }, options);
}
function renderGoal(goal) {
  const box = $("overview-goal");
  if (!box) return;
  box.hidden = !goal?.text;
  if (!goal?.text) return;
  const text = goal.text.trim();
  const long = text.length > 280 || text.split("\n").length > 3;
  $("overview-goal-text").textContent = text;
  $("overview-goal-text").classList.toggle("is-clamped", long && !goalExpanded);
  $("overview-goal-meta").textContent = goal.set_by_agent_name ? `set by ${goal.set_by_agent_name} · ${ago(goal.set_at)}` : "";
  const toggle = $("overview-goal-toggle");
  toggle.hidden = !long;
  toggle.textContent = goalExpanded ? "Show less" : "Show all";
  toggle.setAttribute("aria-expanded", String(goalExpanded));
}
$("overview-goal-toggle")?.addEventListener("click", () => {
  goalExpanded = !goalExpanded;
  const text = $("overview-goal-text");
  text.classList.toggle("is-clamped", !goalExpanded);
  $("overview-goal-toggle").textContent = goalExpanded ? "Show less" : "Show all";
  $("overview-goal-toggle").setAttribute("aria-expanded", String(goalExpanded));
});

function renderOverviewAttention(approvals, messages, awarenessDigest) {
  const container = $("overview-attention");
  const countEl = $("overview-attention-count");
  if (!container) return;

  const approvalItems = [...approvals].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((a) => ({ key: `approval:${a.id}`, ts: new Date(a.created_at).getTime(), node: overviewApprovalStrip(a) }));
  const unread = messages.filter((m) => !m.read_at).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((m) => ({ key: `message:${m.id}`, ts: new Date(m.created_at).getTime(), node: overviewMessageStrip(m) }));
  const directed = directedItems(awarenessDigest, messages)
    .map((i) => ({ key: `mention:${i.seq}`, ts: 0, node: overviewAwarenessStrip(i) })); // no timestamp on digest items -- kept in digest order, after the dated items

  const merged = [...approvalItems, ...unread].sort((a, b) => b.ts - a.ts).concat(directed);
  const total = merged.length;

  countEl.hidden = total === 0;
  countEl.textContent = String(total);

  if (total === 0) {
    container.replaceChildren(el("div", { class: "empty empty-state" }, emptyMark("shield"), el("p", { class: "empty-line" }, el("strong", {}, "Nothing needs you")),
      el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => selectTab("inbox") }, "Open inbox")));
    return;
  }
  // An acknowledgement must not steal keyboard focus from an unrelated Home action.
  const kept = new Map([...container.children].map((node) => [node.dataset.attentionKey, node]));
  const nodes = merged.slice(0, 5).map(({ key, node }) => {
    node.dataset.attentionKey = key;
    const existing = kept.get(key);
    return existing?.isEqualNode(node) ? existing : node;
  });
  // children is live: snapshot it before removal so adjacent obsolete rows cannot be skipped.
  for (const node of [...container.children]) if (!nodes.includes(node)) node.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null); });
}

function overviewApprovalStrip(a) {
  const vendor = vendorOfAgent(a.requested_by_agent_id);
  return el("article", { class: "strip row-attention", dataset: { vendor } },
    el("span", { class: `risk risk-${a.risk}` }, riskLabel(a.risk)),
    el("p", { class: "row-main" }, el("code", { class: "row-command", title: a.action }, a.action)),
    el("span", { class: "row-who" }, vendorLogo(vendor), `${a.requested_by_agent_name} · ${ago(a.created_at)}`),
    el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => goToInbox("approvals") }, "Review"));
}

function overviewMessageStrip(m) {
  const vendor = vendorOfAgent(m.from_agent_id);
  const question = m.kind === "question";
  return el("article", { class: `strip row-attention${question ? " priority-1" : ""}`, dataset: { vendor } },
    el("span", { class: `row-kind${question ? " is-question" : ""}` }, question ? "Question" : "Message"),
    el("p", { class: "row-main", title: m.body }, m.body),
    el("span", { class: "row-who" }, vendorLogo(vendor), `${m.from_agent_name ?? "Unknown"} · ${ago(m.created_at)}`),
    el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => goToInbox("messages") }, question ? "Answer" : "Open"));
}

// A directed update is labelled by what it is. Only a question gets "Answer"; the digest also carries conflicts,
// expired leases, goal changes and more (src/awareness.ts), each with its own place to go (f46c on 7dbb8f2).
const AWARENESS_KIND = {
  "question.asked": { label: "Question", action: "Answer", go: () => goToInbox("mentions"), question: true },
  "question.answered": { label: "Answer", action: "Open", go: () => goToInbox("messages") },
  "message.sent": { label: "Message", action: "Open", go: () => goToInbox("messages") },
  "approval.requested": { label: "Approval", action: "Review", go: () => goToInbox("approvals") },
  "conflict.detected": { label: "Conflict", action: "Open", go: () => goToInbox("mentions") },
  "task.lease_expired": { label: "Task", action: "Open", go: () => selectTab("tasks") },
  "task.created": { label: "Task", action: "Open", go: () => selectTab("tasks") },
  "task.completed": { label: "Task", action: "Open", go: () => selectTab("tasks") },
  "goal.set": { label: "Goal", action: "Open", go: () => selectTab("overview") },
  "decision.recorded": { label: "Decision", action: "Open", go: () => goToInbox("mentions") },
};
function overviewAwarenessStrip(item) {
  const vendor = "other"; // the digest item names its actor, no id (src/awareness.ts AwarenessItem): no tool to know
  const kind = AWARENESS_KIND[item.type] ?? { label: "Update", action: "Open", go: () => goToInbox("mentions") };
  return el("article", { class: "strip row-attention priority-" + (item.priority === 1 ? "1" : "2"), dataset: item.actor ? { vendor } : null },
    el("span", { class: `row-kind${kind.question ? " is-question" : ""}` }, kind.label),
    el("p", { class: "row-main" }, awarenessQuestionBody(item) ?? humanizeAwarenessSummary(item.summary)),
    el("span", { class: "row-who" }, item.actor ? vendorLogo(vendor) : null, item.actor ?? ""),
    el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: kind.go }, kind.action));
}

/** Who is working: every live chat, plus every named agent (an agt_ key, not a chat and not a person) that is online. An
 * operator-role key counts: a self-serve workspace's first agent is one (Codex-OpenCadre-f46c on 820ae2d); the viewer is
 * already excluded by otherAgents. */
function workingNow(liveSessions, agents) {
  const live = liveSessions ?? [];
  const inSessions = new Set(live.map((s) => s.agentId));
  const named = otherAgents(agents)
    .filter((a) => a.online && a.kind !== "session" && a.key_class !== "human" && !inSessions.has(a.id))
    .map((a) => ({ agentId: a.id, agentName: a.name, online: true, currentTask: a.current_task, lastHeartbeatAt: a.last_heartbeat_at, liveness: "chat" }));
  return [...live, ...named];
}

function renderOverviewHappening(liveSessions, agents) {
  const sessions = { status: "ok", data: { sessions: liveSessions ?? [] }, lastOkAt: 0 };
  renderWorkingNow(homeFleet(sessions, agents), sessions);
}

/** Working now: the first eight of homeFleet's population; without an answer, nothing else instead. */
function renderWorkingNow(fleet, sessions) {
  const summary = $("overview-fleet-summary");
  const container = $("overview-happening");
  const background = $("overview-background");
  if (!container) return;
  homeCaption("overview-happening-caption", sessions, "who is working");
  const working = fleet.view === "sessions" ? fleet.members : null;
  if (!working) {
    if (summary) summary.textContent = "";
    if (background) background.hidden = true;
    container.replaceChildren();
    return;
  }
  const online = working.filter((s) => s.online).length;
  if (summary) summary.textContent = working.length ? `${online} of ${working.length} online` : "";
  const shown = working.slice(0, HOME_SHOWN);
  if (background) {
    const hidden = working.slice(shown.length);
    const moreOnline = hidden.filter((s) => s.online).length;
    const moreIdle = hidden.length - moreOnline;
    const parts = [moreOnline > 0 ? `${moreOnline} more online` : null, moreIdle > 0 ? `${moreIdle} idle` : null].filter(Boolean);
    background.hidden = parts.length === 0;
    background.textContent = `${parts.join(", ")}: see the Agents page.`;
  }
  if (shown.length === 0) {
    // Before a plan, adding a computer can only be refused, so the empty state points at nothing (Home's next action,
    // renderHomeNext, is the plan).
    const planFirst = Boolean(me?.billing?.awaitingPlan);
    container.replaceChildren(el("div", { class: "empty empty-state" }, emptyMark("laptop"), el("p", { class: "empty-line" }, el("strong", {}, "No one is working yet")),
      planFirst ? "Agents appear here once your plan has started and your first computer is connected."
        : "Add a computer to start.",
      !planFirst && me?.role === "operator" && el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: () => selectTab("connect") }, "Add a computer")));
    return;
  }
  container.replaceChildren(...shown.map(homeSessionRow));
}

/** One chat on Home: who, what they are doing, where, their state, and when they were last seen. */
function homeSessionRow(s) {
  const row = homeRow(s);
  const task = row.current_task;
  // Still open, but no heartbeat within the hub's 2-minute window: idle, and for how long, rather than "offline".
  const idle = !row.online;
  const pending = !idle && s.liveness === "process";
  const state = idle ? idleIndicator(s.lastHeartbeatAt) : stateIndicator(row);
  const tool = TOOL_LABEL[s.tool] ?? s.tool ?? "Agent";
  return el("article", { class: `strip row-session${pending ? " is-pending" : ""}${idle ? " is-idle" : ""}`, dataset: { vendor: vendorOfTool(s.tool) } },
    el("p", { class: "callsign", title: `${tool}: ${s.agentName}` }, vendorLogo(vendorOfTool(s.tool), { label: tool }), s.agentName),
    el("p", { class: `row-task${task ? "" : " is-idle"}`, title: task ?? "" }, task || (pending ? "Waiting for its first action" : "No task announced")),
    el("span", { class: "row-where" }, [s.project, s.deviceName].filter(Boolean).join(" · ")),
    state,
    el("span", { class: "row-seen" }, s.lastHeartbeatAt && !idle ? ago(s.lastHeartbeatAt) : ""));
}
function homeRow(s) {
  const roster = fleetAgentById.get(s.agentId);
  return { ...roster, ...s, current_task: s.currentTask ?? roster?.current_task, online: s.online ?? roster?.online,
    state: s.state ?? roster?.state, state_reason: s.state_reason ?? roster?.state_reason, phase: s.phase ?? roster?.phase };
}

/** Recent activity; `null` is no answer (its caption says why), never "no activity". */
function renderOverviewActivity(events) {
  const container = $("overview-activity");
  if (!container) return;
  if (events === null) return void container.replaceChildren();
  // /v1/events returns the latest window oldest-first; Home shows its newest 8, newest on top, like Activity does.
  const recent = [...events].sort((a, b) => b.seq - a.seq).slice(0, 8);
  if (recent.length === 0) {
    container.replaceChildren(el("div", { class: "empty empty-state" }, emptyMark("pulse"), el("p", { class: "empty-line" }, el("strong", {}, "No activity yet"))));
    return;
  }
  container.replaceChildren(...recent.map((e) => el("article", { class: "strip" },
    el("p", { class: "strip-body" }, summarizeEvent(e)),
    el("div", { class: "strip-meta" }, el("span", {}, ago(e.created_at))))));
}

// ---------- home dashboard (plan 9d1f as Codex-OpenCadre-049a ruled, 2026-10-01) ----------
// No style attribute, el.style or markup here: SVG geometry is attributes, colour a class. A source is {status, data,
// lastOkAt}: "ok" stamps when APPLIED, a 403 drops the data, a failure keeps it; a new generation resets every source.

const HOME_SHOWN = 8;
const HOME_STALE_MS = 3 * POLL_MS;
const PLAN_NEAR_LIMIT_PCT = 80; // not USAGE_AMBER_PCT, the vendor-usage chip's
const newSource = () => ({ status: "pending", data: null, receivedAt: 0, lastOkAt: 0 });
const newHomeSources = () => ({ core: { lastOkAt: 0, failed: false }, identity: newSource(), roster: newSource(), tasks: newSource(), approvals: newSource(), grants: newSource(), awareness: newSource(), reliability: newSource(), decisions: newSource(), sessions: newSource(), ended: newSource(), devices: newSource(), projects: newSource(), messages: newSource(), events: newSource() });
const coreDomainFailures = new Map();
const CORE_HOME_DOMAINS = ["identity", "roster", "tasks", "approvals", "grants"];
let homeSources = newHomeSources();
let homeTiles = null;
let homeLast = null; // the last render's reads, for an early 403 or failure
let homeRefreshing = false; // a Refresh the person pressed is out
let homeTick = null;
let homeShownAt = 0; // the tab's return: one poll's grace before "may be out of date"

const readSource = (path, get = api) => get(path).then((data) => ({ ok: true, data }), (err) => {
  if (err instanceof RefreshReadTimeoutError || err instanceof RefreshReadCancelledError) throw err;
  return { ok: false, kind: err?.status === 403 ? "forbidden" : "failed" };
});
const sourceData = (read) => (read?.ok ? read.data : null);
function applySource(source, read, at) {
  if (read.ok) return { status: "ok", data: read.data, lastOkAt: at };
  if (read.kind === "forbidden") return { status: "forbidden", data: null, lastOkAt: 0 };
  return { ...source, status: "failed" };
}

/** The same member's agent role or memberRole moved (owner and admin share "operator"). */
function permissionMoved(was, now) {
  if (was.orgId !== now.orgId || was.agentId !== now.agentId) return false;
  return was.role !== now.role || (now.memberRole !== undefined && (was.memberRole ?? null) !== (now.memberRole ?? null));
}
/** New role first, then a new generation (this batch dropped), then a fresh read. */
function permissionChanged(identity) {
  me = identity;
  if (authMode === "session" && typeof identity.memberRole === "string") currentWorkspaceRole = identity.memberRole;
  beginConsoleGeneration();
  $("org-name").textContent = identity.orgName ?? "";
  renderSidebarIdentity();
  applyRole();
  connectLiveWs();
  refreshNow();
}

const vizSvg = (cls, attrs, ...children) => svgEl("svg", { class: cls, "aria-hidden": "true", focusable: "false", ...attrs }, ...children);
/** The .state-dot shapes, in SVG. */
function stateGlyph(state, cx, cy) {
  const ring = (cls) => svgEl("circle", { class: `viz-glyph viz-glyph--${cls} is-ring`, cx, cy, r: 3.75 });
  if (state === "online" || state === "working") return svgEl("circle", { class: `viz-glyph viz-glyph--${state}`, cx, cy, r: 4.5 });
  if (state === "waiting") return svgEl("g", {}, ring("waiting"), svgEl("circle", { class: "viz-glyph viz-glyph--waiting", cx, cy, r: 1.75 }));
  if (state === "blocked") return svgEl("g", {}, ring("blocked"), svgEl("rect", { class: "viz-glyph viz-glyph--blocked", x: cx - 1.75, y: cy - 1.75, width: 3.5, height: 3.5 }));
  return ring(state === "idle" ? "idle" : "offline");
}
const warnGlyph = () => vizSvg("viz-mark viz-mark--warn", { viewBox: "0 0 12 12", width: 12, height: 12 }, svgEl("path", { d: "M6 1.2 11 10.5H1Z" }), svgEl("rect", { class: "viz-mark-cut", x: 5.4, y: 4.4, width: 1.2, height: 3.2 }), svgEl("rect", { class: "viz-mark-cut", x: 5.4, y: 8.3, width: 1.2, height: 1.1 }));
const lockGlyph = () => vizSvg("viz-mark viz-mark--lock", { viewBox: "0 0 12 12", width: 12, height: 12 }, svgEl("rect", { x: 2, y: 5.5, width: 8, height: 5.5, rx: 1 }), svgEl("path", { class: "viz-mark-line", d: "M4 5.5V4a2 2 0 0 1 4 0v1.5" }));

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const clockTime = (ms) => new Date(ms).toTimeString().slice(0, 8);

// ---- metric definitions (pure) ----

/** The ONE population of the agents tile, Working now and the map: live chats plus online named agents, online first.
 * Only a 403 selects the visible roster; a failure with nothing kept is "unavailable". */
function homeFleet(sessions, agents) {
  if (sessions?.data) {
    const proven = (s) => s.liveness !== "process";
    const members = workingNow(sessions.data.sessions ?? [], agents).filter((s) => !s.endedAt)
      .sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) || Number(proven(b)) - Number(proven(a)));
    return { view: "sessions", members };
  }
  if (sessions?.status === "forbidden") {
    const members = otherAgents(agents).map((a) => ({ agentId: a.id, agentName: a.name, online: Boolean(a.online) }))
      .sort((a, b) => Number(b.online) - Number(a.online));
    return { view: "roster", members };
  }
  return { view: sessions?.status === "failed" ? "unavailable" : "loading", members: null };
}

/** Members with a pending approval, or an unread question to the viewer awaiting a reply (SQLite 1, Postgres true).
 * Never a "waiting" state. `messages` null: approvals only. */
function needsYouIds(members, approvals, messages) {
  const ids = new Set((members ?? []).map((m) => m.agentId));
  const out = new Set();
  const now = Date.now();
  for (const a of approvals ?? []) {
    const expires = parseTime(a.expires_at);
    if ((a.status ?? "pending") === "pending" && !(expires && expires.getTime() <= now) && ids.has(a.requested_by_agent_id)) out.add(a.requested_by_agent_id);
  }
  for (const m of messages ?? []) {
    const toViewer = !m.to_agent_id || !me?.agentId || m.to_agent_id === me.agentId;
    if (m.kind === "question" && (m.awaiting_reply === 1 || m.awaiting_reply === true) && !m.read_at && toViewer && ids.has(m.from_agent_id)) out.add(m.from_agent_id);
  }
  return out;
}

function agentTileMetric(fleet, needs) {
  if (!fleet.members) return { state: fleet.view };
  const members = fleet.members;
  const online = members.filter((m) => m.online).length;
  const rest = members.length - online;
  const need = members.filter((m) => needs.has(m.agentId)).length;
  const foot = members.length === 0 ? (me?.billing?.awaitingPlan ? "" : "Connect a computer to see agents")
    : [`${online} online`, `${rest} ${fleet.view === "sessions" ? "idle" : "offline"}`, need ? `${need} ${plural(need, "needs", "need")} you` : null].filter(Boolean).join(" · ");
  return { state: "ok", value: online, total: members.length, unit: members.length ? `of ${members.length} ${fleet.view === "sessions" ? "live" : "you can see"}` : "",
    foot, glyphs: members.map((m) => (m.online ? "online" : fleet.view === "sessions" ? "idle" : "offline")) };
}

/** The board's Open column, open + expired; in progress and review are named beside it. No counts: null, never 0. */
function openTaskMetric(counts) {
  if (!counts) return null;
  const n = (k) => Number(counts[k]) || 0;
  return { value: n("open") + n("expired"), open: n("open"), expired: n("expired"), inProgress: n("in_progress"), review: n("needs_review") };
}

/** The pending list's oldest request and soonest expiry, from any order. */
function approvalTileMetric(approvals) {
  const list = approvals ?? [];
  const min = (key) => list.reduce((best, a) => (a[key] && (!best || parseTime(a[key]) < parseTime(best)) ? a[key] : best), null);
  return { value: list.length, oldest: min("created_at"), soonest: min("expires_at") };
}

/** Active grants, and the one ending SOONEST (the hub sorts latest first). */
function grantTileMetric(grants) {
  const list = grants ?? [];
  const soonest = list.reduce((best, g) => (!best || parseTime(g.expires_at) < parseTime(best.expires_at) ? g : best), null);
  return { value: list.length, soonest };
}

/** Each count: a number, "forbidden" or null; never a made-up 0. */
function planUsage({ agents, devices, projects, forbidden = {} } = {}) {
  const count = (list, keep, key) => (list ? list.filter(keep).length : forbidden[key] ? "forbidden" : null);
  return {
    agents: agents ? agents.filter((a) => a.online).length : null,
    computers: count(devices, (d) => d.status === "connected", "devices"),
    projects: count(projects, (p) => p.enabled, "projects"),
  };
}

/** Plan limit rows for Home AND Settings (ruling 1): a gauge only where the count is the set the limit counts (never
 * the visible roster against the live-agent limit), and every row says what could be read. Live agents: the hub's
 * billing.used.agents (src/live-count.ts), null if withheld, absent from an older hub. */
function planRows(b, used) {
  return USAGE_ROWS.map((row) => {
    const max = allowanceOf(b, row.limit, row.perSeat);
    const live = row.key === "agents" && b?.used ? b.used.agents ?? null : undefined;
    const seen = used[row.key];
    const n = live === undefined ? seen : live;
    const known = typeof n === "number";
    const also = typeof live == "number" && typeof seen == "number" && seen !== live ? `${seen} that you can see` : "";
    const limitWord = max === 0 ? "Not included" : max === null ? "Unlimited" : `Up to ${max}`;
    const countNote = n === "forbidden" ? "Only owners and admins can see the count" : live === null ? "The workspace count isn't shown to you"
      : !known ? "Count not available" : live === undefined ? row.counted(n) : [`${n} live in this workspace`, also].filter(Boolean).join(" · ");
    const r = { key: row.key, label: known && live != null ? "Live agents in this workspace" : row.label, max, used: n, gauge: false, level: "", forbidden: n === "forbidden" };
    // A unit the plan does not include and nobody uses has nothing to say.
    if (!(row.complete || live != null) || !known || !max) return { ...r, limitText: limitWord, note: (max === 0 && n === 0) || (max === null && countNote === "Count not available") ? "" : countNote };
    const level = n >= max ? "full" : (n / max) * 100 >= PLAN_NEAR_LIMIT_PCT ? "near" : "";
    const verdict = level === "full" ? "At the limit" : level === "near" ? "Near the limit for your plan" : "";
    return { ...r, gauge: true, level, limitText: `${n} / ${max}`, note: [verdict, also].filter(Boolean).join(" · "), valueText: `${n} of ${max} ${row.noun}${verdict ? `, ${verdict.toLowerCase()}` : ""}` };
  });
}

function freshnessText(lastOkAt, now) {
  const sec = Math.max(0, Math.round((now - lastOkAt) / 1000));
  if (sec < 10) return "Updated just now";
  return sec < 60 ? `Updated ${sec} s ago` : `Updated ${Math.floor(sec / 60)} min ago`;
}
const homeStale = (core, now) => !document.hidden && now - core.lastOkAt > HOME_STALE_MS && now - homeShownAt > POLL_MS;
/** "Updating…" only for a Refresh the person pressed. */
function homeFreshState(now = Date.now()) {
  const core = homeSources.core;
  if (homeRefreshing) return { tone: "busy", text: "Updating…", action: null };
  if (core.failed) return { tone: "failed", text: core.lastOkAt ? `Couldn't refresh · showing data from ${clockTime(core.lastOkAt)}` : "Couldn't load Home", action: "Retry" };
  if (!core.lastOkAt) return null;
  return homeStale(core, now) ? { tone: "stale", text: `${freshnessText(core.lastOkAt, now)} · may be out of date`, action: "Refresh" }
    : { tone: "fresh", text: freshnessText(core.lastOkAt, now), action: null };
}

// ---- rendering ----

function renderHomeFreshness() {
  syncNotice();
  const chip = $("home-fresh");
  if (!chip) return;
  const s = homeFreshState();
  chip.hidden = !s;
  if (!s) return;
  chip.dataset.tone = s.tone;
  $("home-fresh-text").textContent = s.text;
  const btn = $("home-fresh-action");
  btn.hidden = !s.action;
  if (s.action) btn.textContent = s.action;
}
/** Ticks only while Home is on screen. */
function syncHomeTick() {
  const want = activeTab === "overview" && !document.hidden && isSignedIn() && homeSources.core.lastOkAt > 0;
  if (want && !homeTick) homeTick = setInterval(renderHomeFreshness, 5000);
  else if (!want && homeTick) { clearInterval(homeTick); homeTick = null; }
}
function homeUserRefresh() {
  if (homeRefreshing) return;
  const generation = consoleGeneration;
  homeRefreshing = true;
  renderHomeFreshness();
  refresh().then(() => {
    if (generation !== consoleGeneration) return;
    homeRefreshing = false;
    renderHomeFreshness();
  });
}
$("home-fresh-action")?.addEventListener("click", homeUserRefresh);
for (const btn of document.querySelectorAll("[data-home-retry]")) btn.addEventListener("click", homeUserRefresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) homeShownAt = Date.now();
  syncHomeTick();
});

const NOTICE_CARDS = [["Agents", "sessions", "ended"], ["Recent activity", "events"], ["Questions", "messages"], ["Plan limits", "devices", "projects"]];
/** #refresh-announce says each episode once. While this generation's refresh is out, every caller holds its failures to say
 * together; going stale is no refresh's answer, so it is said at once. */
function syncNotice() {
  const hold = noticeHolds.includes(consoleGeneration);
  const core = homeSources.core;
  const timedOut = refreshFailure?.includes("RefreshReadTimeoutError");
  const on = refreshFailure || core.failed ? { core: timedOut ? REFRESH_TIMEOUT_NOTICE_TEXT : REFRESH_NOTICE_TEXT } : {};
  for (const [card, ...names] of NOTICE_CARDS) {
    const bad = names.filter((n) => homeSources[n]?.status === "failed");
    const at = Math.min(...bad.map((n) => homeSources[n].lastOkAt));
    for (const n of bad) on[n] = `${card} couldn't refresh.${at ? ` Showing data from ${clockTime(at)}.` : ""}`;
  }
  // A failure changes the visible notice, not the age of data already announced as stale.
  // Keep that episode open until fresh data applies, so incremental recovery cannot announce it twice.
  if ((!core.failed || noticeOpen.has("stale")) && core.lastOkAt && homeStale(core, Date.now())) on.stale = `Home may be out of date. Last updated ${clockTime(core.lastOkAt)}.`;
  const keys = Object.keys(on);
  const say = (ks) => [...new Set(ks.map((k) => on[k]))].join(" ");
  const closed = [...noticeOpen].some((k) => !on[k]);
  const opened = keys.filter((k) => !noticeOpen.has(k) && (!hold || k == "stale"));
  const heard = say(opened);
  noticeOpen = new Set(keys.filter((k) => noticeOpen.has(k) || opened.includes(k)));
  const text = on.core ?? (say(keys.filter((k) => k !== "stale")) || on.stale || "");
  const changed = $("refresh-notice").textContent !== text;
  if (changed) $("refresh-notice").textContent = text;
  if (heard || changed || closed) $("refresh-announce").textContent = heard;
}

/** A card's own "showing data from" once its source failed. */
function homeCaption(id, source, what) {
  const box = $(id);
  if (!box) return;
  const failed = source?.status === "failed";
  box.hidden = !failed;
  if (failed) $(`${id}-text`).textContent = source.data ? `Couldn't refresh ${what} · showing data from ${clockTime(source.lastOkAt)}` : `Couldn't load ${what}.`;
}

function homeTile(key, label, action, mark = null) {
  const id = `home-tile-${key}`;
  const t = {
    node: null, mark: el("span", { class: "home-tile-mark", hidden: !mark }, mark), value: el("span", { class: "home-tile-number" }), unit: el("span", { class: "home-tile-unit" }),
    viz: el("div", { class: "home-tile-viz" }), foot: el("p", { class: "home-tile-foot" }), foot2: el("p", { class: "home-tile-foot" }),
    button: action ? el("button", { class: "btn btn-sm btn-quiet home-tile-action", type: "button", onclick: action[1] }, action[0]) : null,
  };
  t.node = el("article", { class: "home-tile", "aria-labelledby": id, dataset: { tile: key } },
    el("div", { class: "home-tile-head" }, el("h3", { class: "home-tile-label", id }, t.mark, label), t.button),
    el("p", { class: "home-tile-value" }, t.value, " ", t.unit), t.viz, t.foot, t.foot2);
  return t;
}
function setTile(t, { value = "", unit = "", foot = "", foot2 = "", tone = "", viz = null, sig = "" }) {
  t.value.textContent = value;
  t.unit.textContent = unit;
  t.foot.textContent = foot;
  t.foot2.textContent = foot2;
  t.foot2.hidden = !foot2;
  t.node.dataset.tone = tone;
  if (t.viz.dataset.sig !== sig) {
    t.viz.dataset.sig = sig;
    t.viz.replaceChildren(...(viz ? [viz] : []));
  }
}
function openInboxHistory() {
  selectTab("inbox");
  document.querySelector('.inbox-view-tab[data-inbox-view="history"]')?.click();
}

/** Built once per generation, so a focused button survives a poll. */
function renderHomeTiles({ fleet, needs, unchecked, taskCounts, approvals, grants, sources = null }) {
  const container = $("overview-metrics");
  if (!container) return;
  if (!homeTiles || !container.contains(homeTiles.agents.node)) {
    homeTiles = {
      agents: homeTile("agents", "Agents online"),
      tasks: homeTile("tasks", "Open tasks"),
      approvals: homeTile("approvals", "Waiting for approval", ["Review", () => goToInbox("approvals")], warnGlyph()),
      grants: homeTile("grants", "Standing approvals", ["Manage", openInboxHistory]),
    };
    container.replaceChildren(...Object.values(homeTiles).map((t) => t.node));
  }
  const a = agentTileMetric(fleet, needs);
  if (a.state === "ok") {
    const shown = a.glyphs.slice(0, HOME_SHOWN);
    const glyphs = shown.length ? vizSvg("viz-glyphs", { viewBox: `0 0 ${shown.length * 16} 12`, width: shown.length * 16, height: 12 },
      shown.map((g, i) => stateGlyph(g, i * 16 + 6, 6))) : null;
    const more = a.glyphs.length - shown.length;
    setTile(homeTiles.agents, { value: String(a.value), unit: a.unit, foot: a.foot, foot2: unchecked, tone: a.total ? "" : "zero",
      viz: glyphs && el("span", { class: "home-tile-glyphs", "aria-hidden": "true" }, glyphs, more > 0 ? `+${more}` : null), sig: a.glyphs.join() });
  } else {
    setTile(homeTiles.agents, a.state === "unavailable" ? { value: "Not available", foot: "Couldn't load who is working.", tone: "na" } : { tone: "loading" });
  }

  const tk = openTaskMetric(taskCounts);
  if (tk) {
    const pct = (n) => `${(n / tk.value) * 100}%`;
    // Percent widths of the strip's own box (no viewBox: the hatch is never stretched).
    const strip = tk.value ? vizSvg("viz-strip", { height: 10 },
      tk.open ? svgEl("rect", { class: "viz-seg viz-seg--open", x: 0, y: 1, width: pct(tk.open), height: 8, rx: 3 }) : null,
      tk.expired ? svgEl("rect", { class: "viz-seg viz-seg--lapsed", x: pct(tk.open), y: 1, width: pct(tk.expired), height: 8, rx: 3 }) : null,
      tk.open && tk.expired ? svgEl("line", { class: "viz-seg-gap", x1: pct(tk.open), x2: pct(tk.open), y1: 0, y2: 10 }) : null) : null;
    setTile(homeTiles.tasks, { value: String(tk.value), foot: tk.expired ? `${tk.open} open · ${tk.expired} claim lapsed` : `${tk.open} open`,
      foot2: `${tk.inProgress} in progress · ${tk.review} waiting for review`, tone: tk.value ? "" : "zero", viz: strip, sig: `${tk.open}/${tk.expired}` });
  } else {
    setTile(homeTiles.tasks, { value: "Not available", tone: "na" });
  }

  const ap = approvalTileMetric(approvals);
  setTile(homeTiles.approvals, { value: String(ap.value), tone: ap.value ? "wait" : "zero",
    foot: ap.value ? `Oldest asked ${ago(ap.oldest)} · ${until(ap.soonest)} on the soonest` : "Nothing is waiting" });
  homeTiles.approvals.button.hidden = homeTiles.approvals.mark.hidden = ap.value === 0;
  if (sources?.approvals && !sources.approvals.data) {
    setTile(homeTiles.approvals, { value: "Not available", foot: sources.approvals.status === "pending" ? "Checking approvals…" : "Approvals could not be checked", tone: "na" });
    homeTiles.approvals.button.hidden = homeTiles.approvals.mark.hidden = true;
  }

  const gr = grantTileMetric(grants);
  setTile(homeTiles.grants, { value: String(gr.value), tone: gr.value ? "" : "zero",
    foot: gr.soonest ? `${gr.soonest.agent_name} · ${gr.soonest.category} · ${until(gr.soonest.expires_at)}` : "None active" });
  if (sources?.grants && !sources.grants.data) setTile(homeTiles.grants, { value: "Not available", foot: sources.grants.status === "pending" ? "Checking standing approvals…" : "Standing approvals could not be checked", tone: "na" });
  for (const [tile, name] of [["tasks", "tasks"], ["approvals", "approvals"], ["grants", "grants"]]) {
    const state = sources?.[name];
    if (state?.status === "failed" && state.data) {
      const foot = homeTiles[tile].foot2;
      foot.textContent = [foot.textContent, "Could not refresh · showing data from " + clockTime(state.lastOkAt)].filter(Boolean).join(" · ");
      foot.hidden = false;
    }
  }
}

/** The fleet map: Working now's rows, in order, round the hub. An image with a sentence; the list is its table. */
function renderHomeFleetMap(fleet, needs, unchecked, sessions) {
  const card = $("home-fleet-card");
  const box = $("home-fleet-map");
  if (!card || !box) return;
  const members = fleet?.view === "sessions" ? fleet.members : null;
  card.hidden = !members?.length;
  if (card.hidden) return void box.replaceChildren();
  homeCaption("home-fleet-caption", sessions, "the fleet");
  const shown = members.slice(0, HOME_SHOWN).map((m) => ({ ...homeRow(m), needs: needs.has(m.agentId) }));
  const more = members.length - shown.length;
  const online = members.filter((m) => m.online).length;
  const needNames = shown.filter((m) => m.needs).map((m) => m.agentName);
  const label = [`Fleet map: ${members.length} working now, ${online} online, ${members.length - online} idle.`,
    needNames.length ? `${needNames.join(", ")} ${plural(needNames.length, "needs", "need")} you.` : null,
    unchecked,
    more > 0 ? `${more} more not drawn.` : null].filter(Boolean).join(" ");
  $("home-fleet-more").textContent = more > 0 ? `+${more} more on the Agents page` : "";
  // Everything drawn: the sentence, and each slab's name, state and tone.
  const sig = JSON.stringify([label, shown.map((m) => [m.agentName, m.tool, m.online, agentState(m), m.needs])]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const W = 340, SW = 128, SH = 30, PITCH = 42;
  const rows = Math.max(2, Math.ceil(shown.length / 2));
  const H = rows * PITCH + 4;
  const cx = W / 2, cy = H / 2;
  const wires = [], slabs = [];
  shown.forEach((m, i) => {
    const left = i % 2 === 0;
    const x = left ? 0 : W - SW, y = 4 + Math.floor(i / 2) * PITCH + (rows - Math.ceil(shown.length / 2)) * PITCH / 2;
    const state = m.online ? agentState(m) : "idle";
    const tone = `${m.online ? "" : " is-idle"}${m.needs ? " is-needs" : ""}`;
    wires.push(svgEl("line", { class: `viz-wire${tone}`, x1: cx, y1: cy, x2: left ? x + SW : x, y2: y + SH / 2 }));
    const name = m.agentName.length > 13 ? `${m.agentName.slice(0, 12)}…` : m.agentName;
    slabs.push(svgEl("g", { class: `viz-slab${tone}`, "data-vendor": vendorOfTool(m.tool) },
      svgEl("rect", { class: "viz-slab-body", x, y, width: SW, height: SH, rx: 7 }),
      svgEl("circle", { class: "viz-glyph-bg", cx: x + 15, cy: y + SH / 2, r: 7.5 }),
      stateGlyph(state, x + 15, y + SH / 2),
      svgEl("text", { class: "viz-slab-text", x: x + 28, y: y + SH / 2 + 4 }, name),
      vendorLogo(vendorOfTool(m.tool), { size: 12, x: x + SW - 20, y: y + SH / 2 - 6 })));
  });
  box.replaceChildren(svgEl("svg", { class: "viz-map", role: "img", "aria-label": label, viewBox: `0 0 ${W} ${H}`, focusable: "false" },
    ...wires,
    svgEl("circle", { class: "viz-hub-ring", cx, cy, r: 26 }),
    svgEl("rect", { class: "viz-hub-chip brand-chip", x: cx - 11, y: cy - 11, width: 22, height: 22, rx: 5 }),
    ...slabs));
}

/** Plan limits on Home (planRows, as Settings). Hidden before a plan. */
function renderHomeLimits(agents, sources) {
  const card = $("home-limits-card");
  const box = $("home-limits-rows");
  if (!card || !box) return;
  const b = me?.billing;
  card.hidden = !b || Boolean(b.awaitingPlan);
  if (card.hidden) return void box.replaceChildren();
  const src = (name) => sources?.[name] ?? newSource();
  const rows = planRows(b, planUsage({ agents, devices: src("devices").data?.devices, projects: src("projects").data?.projects,
    forbidden: { devices: src("devices").status === "forbidden", projects: src("projects").status === "forbidden" } }));
  const trial = onTrial(b) ? daysUntil(b.trialEndsAt) : null;
  const chip = $("home-limits-trial");
  chip.hidden = trial === null;
  chip.textContent = trial === null ? "" : `Trial · ${trial <= 0 ? "ends today" : `${trial} ${plural(trial, "day")} left`}`;
  chip.dataset.tone = trial !== null && trial <= 3 ? "wait" : "";
  const failed = ["devices", "projects"].map(src).find((s) => s.status === "failed");
  homeCaption("home-limits-caption", failed, "the counts");
  const sig = JSON.stringify(rows);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...rows.map((r) => el("div", { class: `limit-row${r.level ? ` is-${r.level}` : ""}`, dataset: { limit: r.key } },
    el("div", { class: "limit-head" }, el("span", { class: "limit-label" }, r.label), el("span", { class: "limit-value" }, r.limitText)),
    r.gauge ? el("div", { class: "limit-meter", role: "meter", "aria-label": r.label, "aria-valuemin": "0", "aria-valuemax": String(r.max), "aria-valuenow": String(r.used), "aria-valuetext": r.valueText },
      vizSvg("viz-gauge", { height: 8 }, svgEl("rect", { class: "viz-track", width: "100%", height: 8, rx: 4 }),
        svgEl("rect", { class: "viz-fill", width: `${Math.min(100, Math.round((r.used / r.max) * 100))}%`, height: 8, rx: 4 }))) : null,
    r.note ? el("p", { class: "limit-note" }, r.level ? warnGlyph() : r.forbidden ? lockGlyph() : null, r.note) : null,
    r.key === "agents" && !r.gauge && r.max ? el("p", { class: "limit-note" }, "The limit counts every agent in the workspace.") : null)));
}

// ---------- fleet ----------
/** Fleet's topbar counter counts every agent, sessions included -- it's a presence indicator,
 * not scoped to either Fleet section. */
/** Every agent except the one this console is signed in as: "agents online" means the agents, not the person
 * reading the page. A brand-new workspace used to read "1 agent online" above "No one is working yet". */
const otherAgents = (agents) => (me?.agentId ? (agents ?? []).filter((a) => a.id !== me.agentId) : agents ?? []);
function updateFleetCount(agents) {
  const others = otherAgents(agents);
  const online = others.filter((a) => a.online).length;
  $("fleet-count").textContent = `${online} of ${others.length} agents online`;
}

/** Agents that connect with their own agt_ key rather than through a connected computer, so the hub has no computer
 * linked to them (Codex-OpenCadre-049a's ruling: the group says exactly that, and never guesses a computer; such an
 * agent may well run on one). Not session-kind rows, not a signed-in person's own member agent, not the legacy
 * operator key and not the key this console is signed in with (see renderOtherAgents). */
function unlinkedAgents(agents) {
  const legacyOperatorKey = (a) => a.role === "operator" && (a.name === LEGACY_OPERATOR_KEY_NAME || a.id === me?.agentId);
  return (agents ?? []).filter((a) => a.kind !== "session" && a.key_class !== "human" && !legacyOperatorKey(a));
}
const lastSeen = (at) => (at ? `last seen ${ago(at)}` : "never connected");

/** Agents -> "Agents without a linked computer": the unlinkedAgents list, with Rotate key and Remove. Session-kind agents
 * (one per tool session on a connected computer) have their own home in the project/computer views. */
function renderOtherAgents(agents) {
  const list = $("fleet-other-agents");
  if (!list) return;
  // Only a complete successful roster can revoke a subject. A missing read is not absence.
  if (!Array.isArray(agents)) return;
  pendingOtherAgents = agents;
  // docs/design/HUB_REDESIGN.md 1.8.2 (operator feedback): Fleet's Agents view is real named tool
  // agents only -- never a session-kind row (those live in the project/computer views), never a
  // signed-in person's own member agent (key_class human -- that's Settings -> Members instead),
  // never the legacy waitlist "Operator" key (role operator, minted under that name by src/waitlist.ts
  // -- unused, hidden entirely per the spec's own carve-out, not relabeled in place like #159 did),
  // and never the operator key this console is signed in with. Any OTHER operator-role key is a
  // working agent, like on Home (workingNow): a self-serve workspace's "First Agent" is one, and its
  // Rotate key here is the only way back to a lost first key (renderFirstRunKey sends people here).
  const named = unlinkedAgents(agents);
  namedAgentSubjects = new Map(named.map((a) => [a.id, a]));
  if (named.length === 0) {
    namedAgentRows.clear();
    list.replaceChildren(el("p", { class: "muted" }, "No agents without a linked computer yet."));
    return;
  }
  const sorted = [...named].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const firstOffline = sorted.findIndex((a) => !a.online);
  // One gate for both affordances: rotate AND remove are owner-only rows in permissions.ts
  // ("agents.rotateKey"/"agents.delete"), and roleFor resolves a session ADMIN to admin, not
  // owner -- so a me.role-only check here showed an admin buttons the API refuses (403).
  const manageOk = canManageAgents();
  // Trust debt (sprint job 2): the RBAC change moved these actions to owner-only, an admin
  // who used them before now silently can't -- so where the buttons were, say where they went
  // instead of leaving an unexplained gap. Only for the affected audience: a session admin
  // (owners see the buttons; plain agents and key-mode never did -- key-mode operators are
  // owner-equivalent by the bootstrap exception, so nothing moved for them either).
  const trustDebtHint = effectiveRole() === "admin"
    ? el("p", { class: "muted manage-roles-note" },
        "Rotating and removing agent keys is workspace-owner only now (your role is admin). ",
        el("a", { href: "https://github.com/mabdullah4800-ai/OpenCadre/blob/main/docs/design/rbac-permission-model.md", target: "_blank", rel: "noopener" }, "Why"))
    : null;
  const nextRows = new Map();
  const nodes = sorted.flatMap((a, i) => {
    // Offline agents sit apart from live ones, under their own label (only when there are live ones above them).
    const offlineLabel = i === firstOffline && i > 0 ? el("p", { class: "session-device-label" }, "Offline") : null;
    // No tool label: the hub reports none for a keyed agent, and guessing one from its name would invent a vendor
    // (Codex-OpenCadre-049a's ruling). A session's tool, which the hub does report, is shown on session rows.
    const generation = consoleGeneration;
    let row;
    const holds = () => generation === consoleGeneration && row.isConnected && namedAgentRows.get(a.id) === row
      && namedAgentSubjects.has(a.id);
    const owns = () => holds() && canManageAgents();
    // Wake is admin-level (permissions.ts "agents.webhook"), so an admin sees it where Rotate key and Remove are hidden,
    // but only on rows the hub lets them set (canSetWakeOn).
    const wakeOk = canSetWakeOn(a);
    const fresh = el("article", { class: "strip" },
      el("div", {},
        el("p", { class: "callsign" }, a.name)),
      // The same words as every other status in the console (STATE_LABEL), in the same colour (--state-online).
      el("span", { class: `lamp ${a.online ? "on" : "off"}` }, a.online ? "online" : "offline"),
      a.current_task ? clampedText(a.current_task) : el("p", { class: "strip-body" }, a.online ? "No task announced" : "Not connected"),
      el("div", { class: "strip-meta" },
        usageChip(a.usage),
        ...trustChips(a.id),
        a.editing_files_parsed.length ? el("span", {}, `editing ${a.editing_files_parsed.join(", ")}`) : null,
        el("span", {}, lastSeen(a.last_heartbeat_at)),
        wakeOk ? wakeAction({ id: a.id, name: a.name }, () => holds() && canSetWakeOn(a)) : null,
        manageOk ? el("button", { class: "btn btn-sm btn-quiet", type: "button", "data-rotate": a.id, onclick: () => { if (owns()) rotateKey(namedAgentSubjects.get(a.id), owns); } }, "Rotate key") : null,
        manageOk && canRemoveAgent(a.id, a.key_class) ? removeAction({ id: a.id, name: a.name }, {
          owns,
          onCancel: () => { if (pendingOtherAgents) renderOtherAgents(pendingOtherAgents); },
        }) : null));
    const prior = namedAgentRows.get(a.id);
    if (prior && Boolean(prior.querySelector("[data-rotate]")) === manageOk
        && Boolean(prior.querySelector("[data-wake]")) === wakeOk
        && Boolean(prior.querySelector("[data-remove]")) === canRemoveAgent(a.id, a.key_class)) {
      // Keep current subject controls, including a hold or pending rotation, and refresh safe metadata.
      row = prior;
      for (let n = 0; n < 3; n++) row.children[n].replaceWith(fresh.children[0]);
      const meta = row.querySelector(".strip-meta");
      const buttons = [...meta.querySelectorAll("button")];
      reconcileListNodes(meta, [...[...fresh.querySelector(".strip-meta").children].filter((n) => n.tagName !== "BUTTON"), ...buttons]);
    } else row = fresh;
    nextRows.set(a.id, row);
    return [offlineLabel, row].filter(Boolean);
  });
  namedAgentRows = nextRows;
  if (trustDebtHint) nodes.push(trustDebtHint);
  reconcileListNodes(list, nodes);
  if (agentRowWanted && revealAgentRow(agentRowWanted)) agentRowWanted = null;
}

// ---------- taking someone to one agent's row ----------
/** The self-serve first agent's name (src/accounts.ts FIRST_AGENT_NAME): the recovery note names it, because on a later
 * visit the key and its name are gone from this page and the hub mints every first agent under this one name. */
const FIRST_AGENT_NAME = "First Agent";
/** The name src/waitlist.ts gave the operator key it minted for a waitlist-approved workspace (before self-serve). */
const LEGACY_OPERATOR_KEY_NAME = "Operator";
let agentRowWanted = null; // a row asked for before that list had rendered it; renderOtherAgents finishes the job

/** Agents → Agents without a linked computer, at `name`'s row, with focus on its Rotate key (or the row, for someone who
 * can't rotate). One history entry: the address is set first, so selectTab keeps it and opens that view from it. */
function openAgentRow(name) {
  openUnlinkedAgents();
  agentRowWanted = revealAgentRow(name) ? null : name;
}
/** Agents → Agents without a linked computer (each agent's Rotate key and Wake form), in one history entry. */
function openUnlinkedAgents() {
  if (location.hash !== "#/agents/named") history.pushState(null, "", "#/agents/named");
  selectTab("fleet");
  if (fleetViewMode !== "agents") setAgentsView("agents", { record: false });
}
function revealAgentRow(name) {
  const row = [...document.querySelectorAll("#fleet-other-agents .callsign")].find((c) => c.textContent === name)?.closest(".strip");
  if (!row) return false;
  row.scrollIntoView?.({ block: "center" });
  row.classList.add("is-found");
  setTimeout(() => row.classList.remove("is-found"), 2000);
  const target = row.querySelector("[data-rotate]") ?? row;
  if (target === row) row.setAttribute("tabindex", "-1");
  target.focus();
  return true;
}

// ---------- removing an agent ----------
// DELETE /v1/org/agents/:agentId retires an agent for good: its key and connections stop now, its history stays.
// Reused for both Other agents (named agt_ agents) and live session rows in Fleet's project/computer views.
const REMOVE_WARNING = "Its key stops working now and it leaves Fleet. Its history stays.";
let pendingOtherAgents = null;
let namedAgentSubjects = new Map();
let namedAgentRows = new Map();

/** Keep retained row descendants connected, including the active input/hold. */
function reconcileListNodes(list, nodes) {
  const wanted = new Set(nodes);
  for (const node of [...list.childNodes]) if (!wanted.has(node)) node.remove();
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  let cursor = list.firstChild;
  for (const node of nodes) {
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** The same people who rotate keys remove agents, but never themselves, and never a person's member agent
 * (people leave under Settings → Members). Owner-only now (permissions.ts "agents.delete"), so this asks
 * the effective role -- a bare Operator key is owner-equivalent, a session admin is NOT. */
function canRemoveAgent(agentId, keyClass) {
  return canManageAgents() && agentId !== me?.agentId && keyClass !== "human";
}

/** A quiet Remove button. It opens a confirm row on its card: the warning, a hold-to-remove button and Cancel.
 * `onCancel` lets each list (Other agents vs. Fleet's session groups) re-apply its own pending poll data,
 * since a poll must never replace a card mid-removal. */
function removeAction(agent, { afterRemove, onCancel, owns = () => true } = {}) {
  const generation = consoleGeneration;
  const open = el("button", { class: "btn btn-sm btn-quiet", type: "button", "data-remove": agent.id }, "Remove");
  let activeAction = null;
  const current = () => generation === consoleGeneration && open.isConnected && canRemoveAgent(agent.id, agent.key_class) && owns();
  open.addEventListener("click", () => {
    if (!current()) return;
    const strip = open.closest(".strip");
    if (!strip || strip.querySelector(".remove-confirm")) return;
    const action = { node: null };
    const actionCurrent = () => current() && activeAction === action && action.node.isConnected;
    const close = () => {
      if (!actionCurrent()) return;
      activeAction = null;
      row.remove();
      open.hidden = false;
    };
    // A hold that finishes on a card already replaced must do nothing.
    const hold = holdButton(() => { if (hold.isConnected && actionCurrent()) removeAgent(agent, hold, () => { close(); afterRemove?.(); }, generation, actionCurrent); }, {
      label: "Hold to remove", holdingLabel: "Keep holding…", doneLabel: "Removing…", variant: "quiet-halt",
    });
    const cancel = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Cancel");
    const row = el("div", { class: "remove-confirm", role: "group", "aria-label": `Remove ${agent.name}` },
      el("p", { class: "remove-warning" }, REMOVE_WARNING), hold, cancel);
    action.node = row;
    activeAction = action;
    cancel.addEventListener("click", () => {
      if (!actionCurrent()) return;
      close();
      if (generation === consoleGeneration) onCancel?.();
    });
    open.hidden = true;
    strip.append(row);
  });
  return open;
}

async function removeAgent(agent, holdBtn, onRemoved, generation = consoleGeneration, owns = () => true) {
  if (generation !== consoleGeneration || !canRemoveAgent(agent.id, agent.key_class) || !owns()) return;
  try {
    const data = await api(`/v1/org/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
    if (generation !== consoleGeneration || !owns() || !canRemoveAgent(agent.id, agent.key_class)) return;
    toast(`Removed ${data.agentName || agent.name}`);
    onRemoved?.();
    refresh();
  } catch (err) {
    if (generation !== consoleGeneration || !owns() || !canRemoveAgent(agent.id, agent.key_class)) return;
    holdBtn?.resetHold();
    toast(`Remove failed: ${err.message}`);
  }
}

// Out of usage explains an offline agent, so it outranks the percentage. The hub already
// shows a limit whose reset time has passed as not limited.
const USAGE_AMBER_PCT = 80;
function usageChip(usage) {
  if (usage?.limited) return el("span", { class: "status-chip usage-chip chip-limited" }, `Out of usage · resets ${usage.resetsAt ? clock(usage.resetsAt) : "unknown"}`);
  if (typeof usage?.usedPct !== "number") return null;
  const amber = usage.usedPct >= USAGE_AMBER_PCT ? " chip-waiting" : "";
  return el("span", { class: `status-chip usage-chip${amber}` }, [`${Math.round(usage.usedPct)}%`, usage.window].filter(Boolean).join(" · "));
}
function clock(s) {
  const t = parseTime(s);
  const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return t.toDateString() === new Date().toDateString() ? hhmm : `${t.toLocaleString("en", { month: "short" })} ${t.getDate()} ${hhmm}`;
}

async function rotateKey(agent, owns = () => true) {
  const generation = consoleGeneration;
  const current = () => generation === consoleGeneration && canManageAgents() && owns();
  if (!current()) return;
  const own = agent.id === me?.agentId;
  const warning = own
    ? `Rotate your own key (${agent.name})? This console switches to the new key; anything else using the old key stops working.`
    : `Rotate ${agent.name}'s key? The current key stops working immediately, so update ${agent.name}'s config with the new one.`;
  if (!confirm(warning) || !current()) return;
  try {
    const data = await api(`/v1/org/agents/${encodeURIComponent(agent.id)}/rotate-key`, { method: "POST" });
    if (!current()) return;
    if (data.agentId === me?.agentId) {
      agentKey = data.apiKey;
      store.set(data.apiKey);
    }
    selectTab("connect");
    $("create-agent-key-details").open = true;
    showSnippets(data.agentName, data.apiKey);
    toast(data.ownKey ? "Your key was rotated. This console now uses the new key." : `Rotated ${data.agentName}'s key.`);
  } catch (err) { if (current()) toast(`Rotate failed: ${err.message}`); }
}

// ---------- wake on mail ----------
// PUT /v1/org/agents/:agentId/webhook: the hub POSTs this URL when mail reaches the agent while it is offline. A person
// sets it here, so an app that can't see its own trigger's key (a Grok Bot routine) never handles it. Both are
// write-only: the hub says only the URL's host (its path or query can carry a token) and whether a header is set, and
// both fields are emptied once saved. An empty URL field keeps the saved address; an empty header field keeps the saved
// header only while the address doesn't change.
const canSetWake = () => readerAdmin();
/** The wake POST carries the agent's mail, so the hub refuses a person's own agent, and an operator-role agent to anyone
 * but an owner (src/service.ts wakeTarget). Those rows don't offer Wake. */
const canSetWakeOn = (a) => canSetWake() && a.key_class !== "human" && (a.role !== "operator" || effectiveRole() === "owner");
const WAKE_HEADER_DROPPED = "Changing the address removes the saved header; paste it again.";

/** The last wake POST's outcome in words (the hub records the status code only, never the response body). A 401 or 403
 * is the receiver refusing the key, so it points at the header. */
function lastWakeText(last) {
  if (!last) return null;
  if (last.outcome === "delivered") return "Last wake: delivered.";
  if (last.outcome === "failed") return "Last wake: failed (network).";
  if (last.outcome === "gave_up") return "Last wake: gave up after retries.";
  const keyRefused = last.status === 401 || last.status === 403 ? " Check the Authorization header." : "";
  return `Last wake: rejected (${last.status}).${keyRefused}`;
}

/** A quiet Wake button that opens (and, pressed again, closes) the wake form on its card. */
function wakeAction(agent, owns) {
  const generation = consoleGeneration;
  const path = `/v1/org/agents/${encodeURIComponent(agent.id)}/webhook`;
  const open = el("button", { class: "btn btn-sm btn-quiet", type: "button", "data-wake": agent.id, "aria-expanded": "false" }, "Wake");
  const current = () => generation === consoleGeneration && open.isConnected && canSetWake() && owns();
  let form = null;
  open.addEventListener("click", () => {
    if (!current()) return;
    if (form) {
      form.remove();
      form = null;
      open.setAttribute("aria-expanded", "false");
      return;
    }
    const strip = open.closest(".strip");
    if (!strip) return;
    let saved = { webhook_host: null, webhook_auth_set: false };
    const status = el("p", { class: "wake-status", role: "status" });
    const authStatus = el("p", { class: "wake-auth-status" });
    const lastLine = el("p", { class: "wake-last", hidden: true });
    const hintId = `wake-hint-${agent.id}`;
    const url = el("input", { type: "url", name: "wake-url", placeholder: "Paste the routine's POST-to URL to change it", autocomplete: "off", spellcheck: "false" });
    const auth = el("input", { type: "password", name: "wake-auth", autocomplete: "new-password", "aria-describedby": hintId });
    const removeAuth = el("input", { type: "checkbox", name: "wake-remove-auth" });
    const note = el("p", { class: "wake-note", hidden: true }, WAKE_HEADER_DROPPED);
    const testButton = el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => void sendTest() }, "Send test wake");
    const mine = el("form", { class: "wake-form", "aria-label": `Wake ${agent.name}` },
      status, authStatus, lastLine,
      el("label", {}, "Wake URL", url),
      el("label", {}, "Authorization header", auth),
      el("p", { class: "wake-hint", id: hintId }, 'Bearer <key> (paste the whole value, including "Bearer ")'),
      el("label", {}, removeAuth, "Remove header"),
      note,
      el("button", { class: "btn btn-sm", type: "submit" }, "Save"),
      el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => void save({ url: null }) }, "Clear"),
      testButton);
    const live = () => current() && form === mine && mine.isConnected;
    const show = (hook) => {
      saved = hook;
      status.textContent = hook.webhook_url_set ? `Wake on mail: on (${hook.webhook_host})` : "Wake on mail: off";
      authStatus.textContent = `Authorization header: ${hook.webhook_auth_set ? "set" : "not set"}`;
      const words = lastWakeText(hook.last_wake);
      lastLine.hidden = !words;
      lastLine.textContent = words ?? "";
      if (words) lastLine.title = parseTime(hook.last_wake.at).toLocaleString();
      else lastLine.removeAttribute("title");
      warn();
    };
    // One wake POST to the saved address (POST .../webhook/test); its outcome shows on the last-wake line.
    async function sendTest() {
      if (!live() || testButton.disabled) return;
      testButton.disabled = true;
      try {
        const hook = await api(`${path}/test`, { method: "POST" });
        if (live()) show(hook);
      } catch (err) {
        if (live()) status.textContent = `Test wake failed: ${err.message}`;
      } finally {
        testButton.disabled = false;
      }
    }
    // Before saving: a new address drops the saved header unless it is pasted again (the hub's rule). The console never
    // holds the saved URL, so it warns on any typed address.
    function warn() {
      note.hidden = !(saved.webhook_auth_set && url.value.trim() && !auth.value && !removeAuth.checked);
    }
    url.addEventListener("input", warn);
    auth.addEventListener("input", warn);
    removeAuth.addEventListener("change", warn);
    async function save(body) {
      if (!live()) return;
      try {
        const hook = await api(path, { method: "PUT", body });
        if (!live()) return;
        auth.value = "";
        url.value = "";
        removeAuth.checked = false;
        show(hook);
        toast(`Wake on mail is ${hook.webhook_url_set ? "on" : "off"} for ${agent.name}.`);
      } catch (err) {
        if (!live()) return;
        auth.value = "";
        warn();
        status.textContent = `Wake failed: ${err.message}`;
      }
    }
    mine.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = {};
      if (url.value.trim()) body.url = url.value.trim();
      if (removeAuth.checked) body.authHeader = null;
      else if (auth.value) body.authHeader = auth.value;
      void save(body);
    });
    form = mine;
    open.setAttribute("aria-expanded", "true");
    strip.append(mine);
    api(path).then((hook) => { if (live()) show(hook); }, (err) => { if (live()) status.textContent = `Wake failed: ${err.message}`; });
  });
  return open;
}

// ---------- clearances ----------
const clearanceNodes = new Map();
let approvalReadDecisions = null;
let lastApprovalHistory = [];
let lastApprovalGrants = [];

function applyPendingApprovals(approvals, overlay = focusedApprovalSubject) {
  renderClearances(approvals);
  updateInboxBadge(approvals, lastInboxMessages, currentAwarenessDigest);
  if (homeLast) renderOverview(homeLast = { ...homeLast, approvals });
  // Reconcile only the overlay that existed when this read began. An older batch must not
  // invalidate a newer notification. Absence means no longer pending, not necessarily approved.
  if (overlay && overlay === focusedApprovalSubject && overlay.current() && !approvals.some((a) => a.id === overlay.id)) {
    overlay.notPending = true;
    $("focused-approval-overlay").replaceChildren(focusedApprovalMessage("No longer pending.", "This request is no longer in your pending approvals. Close this card to continue."));
  }
}

function renderClearances(approvals) {
  lastInboxApprovals = approvals;
  document.title = approvals.length ? `(${approvals.length}) OpenCadre Console` : "OpenCadre Console";

  const container = $("clearances");
  // QA #185: unlike Fleet/Inbox (which replaceChildren() on every render), this function patches
  // incrementally so an in-progress "hold to approve" never gets clobbered mid-gesture -- but that
  // meant paintSkeleton()'s placeholder rows, appended before the first real approvals ever arrived,
  // were never removed once real data showed up. Clear them here, same idea as the `.empty` removal
  // just below.
  container.querySelectorAll(".skeleton").forEach((node) => node.remove());
  const ids = new Set(approvals.map((a) => a.id));
  for (const [id, node] of clearanceNodes) {
    if (!ids.has(id)) { node.remove(); clearanceNodes.delete(id); }
  }
  for (const a of approvals) {
    const existing = clearanceNodes.get(a.id);
    if (existing) {
      existing.querySelector("[data-left]").textContent = until(a.expires_at);
      continue;
    }
    const node = clearanceStrip(a);
    clearanceNodes.set(a.id, node);
    container.append(node);
  }
  container.querySelector(".empty")?.remove();
  if (clearanceNodes.size === 0) {
    container.append(el("div", { class: "empty empty-first-visit empty-page" }, el("strong", {}, "All clear"), "No agent is waiting for approval. Risky actions from any connected agent will appear here."));
  }
  if (selectedInboxItem?.kind === "approval" && !ids.has(selectedInboxItem.item.id)) {
    selectedInboxItem = null;
    showInboxFocusEmpty();
  }
  if (!selectedInboxItem && approvals.length) selectInboxItem("approval", approvals[0]);
}

/** The lengths a person can approve for, in grantMinutes as POST /v1/approvals/:id/decide takes them (the hub caps a
 * grant at 480). 0 approves only this request. */
const APPROVAL_SCOPES = [[0, "Once"], [30, "30 min"], [120, "2 h"], [480, "8 h"]];
let approvalScopeSeq = 0;
/** What a timed grant covers, as the hub applies it (src/approvals.ts activeGrant): the same agent, category and
 * project (`project_key IS ?`, so a request outside any project matches only a grant made outside any project), until
 * the length chosen runs out, counted from the approval. Shown as chips, never as a tooltip. */
function grantChips(a, minutes) {
  const expiry = new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [a.requested_by_agent_name, a.category, a.project_key ? projectLabel(a.project_key) : "no project", `until ${expiry}`]
    .map((text) => el("span", { class: "grant-chip" }, text));
}
/** Once | 30 min | 2 h | 8 h as native radios (one Tab stop, arrow keys move the choice), Once by default. A timed choice
 * shows the grant it makes; `hold` is renamed for the choice. minutes() reads the checked radio when it is asked. */
function approvalScopeControl(a, hold) {
  const name = `approval-scope-${++approvalScopeSeq}`;
  const group = el("div", { class: "scope-seg", role: "radiogroup", "aria-label": "What this approval allows" },
    ...APPROVAL_SCOPES.map(([value, text]) => el("label", { class: "scope-seg-opt" },
      el("input", { type: "radio", name, value: String(value), checked: value === 0 }), text)));
  const chips = el("p", { class: "grant-chips", "aria-live": "polite" });
  const minutes = () => Number(group.querySelector("input:checked")?.value ?? 0);
  const show = () => {
    const m = minutes();
    chips.hidden = !m;
    // The chips are what this approval lets through from now on, so the lead says so before them.
    chips.replaceChildren(...(m ? [el("span", { class: "grant-chips-lead" }, "Also auto-approves:"), ...grantChips(a, m)] : []));
    // The button is held, not tapped: its name says so, and names the scope.
    hold.setLabel(m ? `Hold to approve for ${scopeLength(m)}` : "Hold to approve once");
  };
  group.addEventListener("change", (event) => {
    // One choice at a time, whatever the DOM implementation does with a radio group.
    for (const radio of group.querySelectorAll("input")) radio.checked = radio === event.target;
    show();
  });
  // The hub counts the length from the decision, so "until HH:MM" is kept current: on a 30-second tick while the card
  // is open (it stops once the card leaves the page) and again when a hold starts.
  const tick = setInterval(() => {
    if (!group.isConnected) { clearInterval(tick); return; }
    if (minutes()) show();
  }, 30_000);
  hold.addEventListener("pointerdown", () => { if (minutes()) show(); });
  hold.addEventListener("keydown", () => { if (minutes()) show(); });
  show();
  return { node: el("div", { class: "grant-choice" }, group, chips), minutes };
}
/** "30 min", "2 h", "8 h": a grant's length as the scope control names it. */
const scopeLength = (m) => APPROVAL_SCOPES.find(([v]) => v === m)?.[1] ?? `${m} min`;
function clearanceStrip(a) {
  const vendor = vendorOfAgent(a.requested_by_agent_id);
  const own = me && a.requested_by_agent_id === me.agentId;
  let scope = null;
  const hold = holdButton(() => decide(a, node, "approve", scope ? scope.minutes() : 0), { label: "Hold to approve once" });
  scope = a.category ? approvalScopeControl(a, hold) : null;

  const node = el("article", { class: "strip clearance", dataset: { vendor, inboxId: a.id, vendorAgentId: a.requested_by_agent_id ?? "" } },
    el("div", {},
      el("span", { class: "vendor-tag" }, a.category ? `Approval · ${a.category}` : "Approval"),
      el("p", { class: "callsign" }, vendorLogo(vendor), a.requested_by_agent_name)),
    el("span", { class: `risk risk-${a.risk}` }, riskLabel(a.risk)),
    el("pre", { class: "command" }, a.action),
    a.details ? el(typeof a.details === "object" ? "pre" : "p", { class: "strip-body" }, typeof a.details === "object" ? JSON.stringify(a.details, null, 2) : a.details) : null,
    el("div", { class: "strip-meta" },
      el("span", {}, `asked ${ago(a.created_at)}`),
      el("span", { "data-left": "" }, until(a.expires_at))),
    own
      ? el("p", { class: "strip-body" }, "You requested this, so another agent or teammate has to decide it.")
      : el("div", { class: "decide" },
          scope?.node,
          el("button", { class: "btn btn-halt", type: "button", onclick: () => decide(a, node, "deny") }, "Deny"),
          hold));
  node.addEventListener("click", (e) => {
    if (!e.target.closest("button, select, label, input") && !node.closest("#inbox-focus")) selectInboxItem("approval", a);
  });
  node.tabIndex = 0;
  node.addEventListener("keydown", (e) => { if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectInboxItem("approval", a); } });
  return node;
}

/** Agent-written prose (a status line, a task's result) as calm text: markdown markers dropped, clamped to a few
 * lines, with "Show more" only when there is more. The live fleet had one status that filled a screen. */
const plainText = (text) => String(text ?? "").replace(/\*\*|`/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
function clampedText(text, { cls = "strip-body", lines = 2, long = 160 } = {}) {
  const body = plainText(text);
  const p = el("p", { class: `${cls} clamp` }, body);
  p.style.setProperty("--clamp", String(lines));
  if (body.length <= long) return p;
  const toggle = el("button", { class: "clamp-toggle", type: "button", "aria-expanded": "false" }, "Show more");
  toggle.addEventListener("click", () => {
    const open = p.classList.toggle("is-open");
    toggle.textContent = open ? "Show less" : "Show more";
    toggle.setAttribute("aria-expanded", String(open));
  });
  return el("div", { class: "clamp-wrap" }, p, toggle);
}
/** One wording for an approval's risk everywhere it shows: "High risk", sentence case. */
const riskLabel = (risk) => `${risk === "high" ? "High" : risk === "medium" ? "Medium" : "Low"} risk`;
function holdButton(onComplete, { label = "Hold to approve", holdingLabel = "Keep holding…", doneLabel = "Approving…", variant = "" } = {}) {
  const btn = el("button", { class: `hold${variant ? ` hold-${variant}` : ""}`, type: "button", "aria-label": label },
    el("span", { class: "fill" }), el("span", { class: "label" }, label));
  btn.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
  // For a caller whose onComplete can fail (e.g. the API call rejects): put the button back to its
  // starting state instead of leaving it stuck on doneLabel forever.
  btn.resetHold = () => {
    btn.classList.remove("is-holding", "is-done");
    btn.querySelector(".label").textContent = label;
  };
  // A caller whose action changes before the hold (the approval scope) renames the button; a hold under way keeps its label.
  btn.setLabel = (next) => {
    label = next;
    btn.setAttribute("aria-label", label);
    if (!btn.classList.contains("is-holding") && !btn.classList.contains("is-done")) btn.querySelector(".label").textContent = label;
  };
  let timer = null;
  const start = (e) => {
    if (timer || btn.classList.contains("is-done")) return;
    if (e.type === "keydown" && e.key !== " " && e.key !== "Enter") return;
    if (e.type === "keydown" && e.repeat) return;
    e.preventDefault();
    btn.classList.add("is-holding");
    btn.querySelector(".label").textContent = holdingLabel;
    const generation = consoleGeneration;
    timer = setTimeout(() => {
      timer = null;
      if (generation !== consoleGeneration || !btn.isConnected) return; // the workspace or person changed mid-hold
      btn.classList.remove("is-holding");
      btn.classList.add("is-done");
      btn.querySelector(".label").textContent = doneLabel;
      onComplete();
    }, HOLD_MS);
  };
  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    btn.classList.remove("is-holding");
    btn.querySelector(".label").textContent = label;
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);
  btn.addEventListener("keydown", start);
  btn.addEventListener("keyup", cancel);
  btn.addEventListener("blur", cancel);
  btn.addEventListener("click", (e) => e.preventDefault());
  return btn;
}

async function decide(a, node, decision, grantMinutes = 0) {
  if (node.classList.contains("is-deciding")) return false;
  node.classList.add("is-deciding");
  try {
    const result = await api(`/v1/approvals/${a.id}/decide`, { method: "POST", body: { decision, grantMinutes } });
    const who = a.requested_by_agent_name;
    toast(decision === "approve"
      ? (result.grant ? `Approved. ${who} can run ${a.category} actions for ${scopeLength(grantMinutes)}.` : `Approved ${who}'s request.`)
      : `Denied ${who}'s request.`);
    approvalReadDecisions?.set(a.id, result);
    node.remove();
    clearanceNodes.get(a.id)?.remove();
    clearanceNodes.delete(a.id);
    const grants = result.grant ? [result.grant, ...lastApprovalGrants.filter((grant) => grant.id !== result.grant.id)] : lastApprovalGrants;
    if (homeLast) homeLast = { ...homeLast, grants };
    // A local decision proves only its own subject. An old cached queue cannot invalidate a newer notification.
    applyPendingApprovals(lastInboxApprovals.filter((pending) => pending.id !== a.id), focusedApprovalSubject?.id === a.id ? focusedApprovalSubject : null);
    if (result.approval) {
      const history = [result.approval, ...lastApprovalHistory.filter((record) => record.id !== a.id)].slice(0, 15);
      renderHistory(history, grants);
    }
    refresh();
    return true;
  } catch (err) {
    node.classList.remove("is-deciding");
    toast(err.message);
    const hold = node.querySelector(".hold");
    hold?.resetHold?.(); // back to its own label, the chosen scope included
    refresh();
    return false;
  }
}

/** Who decided a clearance, as the record says it: the person (migration 53 stores their name), else the agent that
 * decided it before people did. */
const decidedBy = (a) => a.decided_by_person_name || a.decided_by_agent_name || "";

function renderHistory(decided, grants) {
  lastApprovalHistory = decided;
  lastApprovalGrants = grants;
  $("grants").replaceChildren(...grants.map((g) => el("div", { class: "grant-row" },
    el("span", { class: "outcome outcome-approved" }, "Grant"),
    el("span", {}, `${g.agent_name} may run ${g.category} actions until ${parseTime(g.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`),
    el("button", { class: "btn btn-quiet", type: "button", onclick: async () => {
      try {
        await api(`/v1/approval-grants/${g.id}`, { method: "DELETE" });
        toast(`Revoked ${g.agent_name}'s ${g.category} grant.`);
        refresh();
      } catch (err) { toast(err.message); }
    } }, "Revoke"))));

  $("history").replaceChildren(...(decided.length
    ? decided.map((a) => el("li", {},
        // Withdrawn: the agent that asked took it back, so nobody decided it and no "by" follows.
        el("span", { class: `outcome outcome-${a.status}` }, a.status === "withdrawn" ? "Withdrawn" : a.status),
        el("span", { class: "mono" }, a.action),
        el("span", { class: "muted" }, `${a.requested_by_agent_name}${decidedBy(a) ? ` · by ${decidedBy(a)}` : ""} · ${ago(a.decided_at || a.created_at)}`)))
    : [el("li", { class: "muted empty-state" }, emptyMark("check"), "No decisions yet.")]));
}

// ---------- tasks ----------
// Tasks tranche 2 (docs/superpowers/plans/2026-09-30-task-paging.md; §0 is Codex-OpenCadre-049a's ruling). The console
// used to read every task in full every 4 s and page, search and count on the client. Now each column reads its own
// pages of task summaries from the hub (GET /v1/tasks?summary=1&column=...), "Show more" asks for the next page with the
// hub's cursor, search and the project filter are the hub's q and project, the hub's counts give each column's total and
// Home's number, and a card's description and result load when the card is opened.
const TASK_PAGE = 20;
const TASK_PAGE_MAX = 500; // the hub's cap on one request; a refresh re-reads a longer column in several
const TASK_SEARCH_DEBOUNCE_MS = 250;
const TASK_BOARD_COLUMNS = [["open", "Open"], ["in_progress", "In progress"], ["done", "Done"]];
const taskFilter = { q: "", project: "" };
/** The board as loaded. columns: each column's rows, in the hub's order, and the cursor to its next page (null: nothing
 * more). counts: the hub's five buckets for the current search and filter; totals: the same without them (Home, and the
 * "N of M" line). projects: the project filter's options, from the hub. pinned: tasks opened from a link that no loaded
 * page holds, id -> task, shown in their column until a page does. restart: the next read starts at one page per column
 * (a new search or filter); otherwise a refresh re-reads each column as far as it is loaded. */
function newTaskBoard() {
  return {
    columns: { open: { items: [], cursor: null }, in_progress: { items: [], cursor: null }, done: { items: [], cursor: null } },
    counts: null, totals: null, projects: [], pinned: new Map(), loadingMore: new Set(), restart: false,
    // How many "Show more" pages each column has taken in: a refresh that began before one landed was sized for fewer
    // rows, so it leaves that column as it is rather than cut it back (the next refresh reads the whole extent).
    appended: { open: 0, in_progress: 0, done: 0 },
  };
}
let taskBoard = newTaskBoard();
// Bumped whenever what the board asks for changes (a search, the project filter, a change of identity): an answer to an
// earlier question is dropped instead of painted over the later one.
let taskBoardTicket = 0;
let taskSearchTimer = null;
// Cards are keyed by task id so a refresh keeps what the reader opened. A card whose markup would come out the same
// is reused as is (still open, its history and details still loaded); a changed one is rebuilt, and opens again if it
// was open. The markup is the key rather than the task's fields because a card also shows times ("5m ago") and buttons
// that depend on who is looking; it carries the task's revision (data-rev), so a changed task is always rebuilt.
let taskCards = new Map(); // task id -> { markup, node }
function keyedTaskCard(t, previous) {
  const fresh = taskCard(t);
  const markup = fresh.outerHTML;
  const before = previous.get(t.id);
  if (before && before.markup === markup) {
    taskCards.set(t.id, before);
    return before.node;
  }
  if (before?.node.querySelector(".task-details")?.open) fresh.querySelector(".task-details").open = true;
  taskCards.set(t.id, { markup, node: fresh });
  return fresh;
}

/** Which column a task belongs in: the hub's rule (src/tasks.ts listTaskPage), from the row's own lease_active. */
function taskColumnOf(t) {
  if (t.status === "done") return "done";
  return t.status === "claimed" && t.lease_active ? "in_progress" : "open";
}
const uniqueTasks = (list) => {
  const seen = new Set();
  return list.filter((t) => t && !seen.has(t.id) && seen.add(t.id));
};
const taskFiltered = () => Boolean(taskFilter.q.trim() || taskFilter.project);
const sumCounts = (c) => c.open + c.expired + c.in_progress + c.needs_review + c.done;

/** One read of the task list: summaries, one column (or none: every column, for counts), this search and filter unless
 * `filtered` is false, from the start or from a cursor. */
function taskListUrl(column, { limit, cursor = null, filtered = true }) {
  const params = new URLSearchParams({ summary: "1" });
  if (column) params.set("column", column);
  if (filtered && taskFilter.q.trim()) params.set("q", taskFilter.q.trim());
  if (filtered && taskFilter.project) params.set("project", taskFilter.project);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return `/v1/tasks?${params}`;
}

/** One column from its start, as far as `extent` rows: in requests of at most the hub's cap, each continuing from the
 * last one's cursor, so a column the reader paged past one request's cap is read back whole. The answer is the first
 * page's (its counts and projects) with every row read and the cursor after the last. */
async function readTaskColumn(get, key, extent) {
  const first = await get(taskListUrl(key, { limit: Math.min(TASK_PAGE_MAX, extent) }));
  const tasks = [...(first?.tasks ?? [])];
  let cursor = first?.nextCursor ?? null;
  while (cursor && tasks.length < extent) {
    const page = await get(taskListUrl(key, { limit: Math.min(TASK_PAGE_MAX, extent - tasks.length), cursor }));
    tasks.push(...(page?.tasks ?? []));
    cursor = page?.nextCursor ?? null;
  }
  return { ...first, tasks, nextCursor: cursor };
}

/** Reads the board: each column from its start, as far as it is loaded now (one page after a new search; past the hub's
 * per-request cap in several requests), so a refresh or a retry replaces what is shown instead of appending to it, and
 * never drops what the reader paged to; the unfiltered totals while a search or filter is on; and each pinned task.
 * `get` is the caller's fetcher: loadAndRender passes its `need`, so a failed read names /v1/tasks in the refresh
 * diagnostic. The ticket and generation guards of the callers apply to the whole read. */
async function fetchTaskBoard(get = api) {
  const ticket = taskBoardTicket;
  const appended = { ...taskBoard.appended };
  const reads = TASK_BOARD_COLUMNS.map(([key]) => {
    const loaded = taskBoard.restart ? 0 : taskBoard.columns[key].items.length;
    return readTaskColumn(get, key, Math.max(TASK_PAGE, loaded));
  });
  const totals = taskFiltered() ? get(taskListUrl(null, { limit: 0, filtered: false })) : Promise.resolve(null);
  const pinnedIds = [...taskBoard.pinned.keys()];
  // A pinned task that is gone or hidden now (404) is dropped; one that couldn't be read this time stays as it was.
  const pinned = Promise.all(pinnedIds.map((id) => get(`/v1/tasks/${encodeURIComponent(id)}`)
    .then((data) => data?.task ?? null, (err) => {
      if (err instanceof RefreshReadTimeoutError || err instanceof RefreshReadCancelledError) throw err;
      return err?.status === 404 ? null : undefined;
    })));
  const [pages, totalsData, pinnedTasks] = await Promise.all([Promise.all(reads), totals, pinned]);
  return {
    ticket,
    appended,
    pages: Object.fromEntries(TASK_BOARD_COLUMNS.map(([key], i) => [key, pages[i] ?? {}])),
    totals: totalsData?.counts ?? null,
    pinned: pinnedIds.map((id, i) => [id, pinnedTasks[i]]),
  };
}

/** Takes a read from fetchTaskBoard into the board and paints it. False, and nothing painted, when the read answers an
 * earlier search, filter or identity. */
function applyTaskBoard(data) {
  if (data.ticket !== taskBoardTicket) return false;
  for (const [key] of TASK_BOARD_COLUMNS) {
    if (data.appended && data.appended[key] !== taskBoard.appended[key]) continue; // a Show more landed meanwhile
    const page = data.pages[key];
    taskBoard.columns[key] = { items: uniqueTasks(page.tasks ?? []), cursor: page.nextCursor ?? null };
  }
  taskBoard.restart = false;
  taskBoard.counts = data.pages.open.counts ?? null;
  taskBoard.totals = taskFiltered() ? (data.totals ?? taskBoard.totals) : taskBoard.counts;
  if (Array.isArray(data.pages.open.projects)) taskBoard.projects = data.pages.open.projects;
  for (const [id, task] of data.pinned) {
    if (task === null) taskBoard.pinned.delete(id);
    else if (task && taskBoard.pinned.has(id)) taskBoard.pinned.set(id, task);
  }
  renderTaskBoard();
  reconcileOpenTaskReads();
  return true;
}

/** Reads and paints the board on its own: after a search, a filter change or a refused cursor. The 4 s refresh reads it
 * together with everything else (loadAndRender). */
async function loadTaskBoard() {
  const generation = consoleGeneration;
  try {
    const data = await fetchTaskBoard();
    if (generation !== consoleGeneration) return;
    applyTaskBoard(data);
  } catch (err) {
    if (generation !== consoleGeneration || err instanceof AuthError || err instanceof PausedError) return; // the refresh handles those
    showRefreshFailure("/v1/tasks", err);
  }
}

/** "Show more": the column's next page, from its cursor, appended without repeating a task already shown. A refresh or a
 * new search that replaced the column meanwhile wins, and a cursor the hub refuses (it restarted, or the list is not the
 * one the cursor was issued for) reads the board again from the top. */
async function loadMoreTasks(key) {
  const column = taskBoard.columns[key];
  if (!column.cursor || taskBoard.loadingMore.has(key)) return;
  const ticket = taskBoardTicket;
  const generation = consoleGeneration;
  const cursor = column.cursor;
  const current = () => ticket === taskBoardTicket && generation === consoleGeneration;
  taskBoard.loadingMore.add(key);
  renderTaskBoard();
  try {
    const page = await api(taskListUrl(key, { limit: TASK_PAGE, cursor }));
    if (!current() || taskBoard.columns[key].cursor !== cursor) return;
    const have = new Set(taskBoard.columns[key].items.map((t) => t.id));
    taskBoard.columns[key] = {
      items: [...taskBoard.columns[key].items, ...uniqueTasks(page.tasks ?? []).filter((t) => !have.has(t.id))],
      cursor: page.nextCursor ?? null,
    };
    taskBoard.appended[key]++;
    if (page.counts) taskBoard.counts = page.counts;
  } catch (err) {
    if (!current()) return;
    if (err?.status === 400) {
      taskBoard.columns[key].cursor = null;
      loadTaskBoard();
    } else if (!(err instanceof AuthError || err instanceof PausedError)) {
      toast(`Couldn't load more tasks: ${err.message}`);
    }
  } finally {
    if (current()) {
      taskBoard.loadingMore.delete(key);
      renderTaskBoard();
    }
  }
}

/** A board whose every task is already here (nothing further to page), in the hub's column rules: Open is open plus
 * expired claims, oldest first; In progress, oldest first; Done, newest completion first. */
function renderTasks(tasks) {
  const list = uniqueTasks(tasks ?? []);
  const byCompletion = (a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""));
  for (const [key] of TASK_BOARD_COLUMNS) {
    const rows = list.filter((t) => taskColumnOf(t) === key);
    taskBoard.columns[key] = { items: key === "done" ? rows.sort(byCompletion) : rows, cursor: null };
  }
  taskBoard.counts = null;
  taskBoard.totals = null;
  taskBoard.projects = [...new Set(list.map((t) => t.project_key).filter(Boolean))].sort();
  renderTaskBoard();
}

function renderTaskBoard() {
  const scrollTop = $("tasks").scrollTop;
  const scrollLeft = $("tasks").scrollLeft;
  const focused = document.activeElement;
  const focusedTask = focused?.closest?.(".task")?.dataset.taskId;
  const focusOnSummary = focused?.matches?.(".task-details > summary");
  renderTaskProjectFilter(taskBoard.projects);
  const seen = new Set();
  const lists = TASK_BOARD_COLUMNS.map(([key, title]) => [key, title, taskBoard.columns[key].items.filter((t) => !seen.has(t.id) && seen.add(t.id))]);
  // A task opened from a link shows in its own column, after the loaded rows, until a loaded page holds it.
  for (const t of taskBoard.pinned.values()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    lists.find(([key]) => key === taskColumnOf(t))[2].push(t);
  }
  const c = taskBoard.counts;
  const finite = (n) => Number.isFinite(n) ? n : null;
  const totalOf = c ? {
    open: finite(c.open) != null && finite(c.expired) != null ? c.open + c.expired : null,
    in_progress: finite(c.in_progress),
    done: finite(c.needs_review) != null && finite(c.done) != null ? c.needs_review + c.done : null,
  } : {};
  const filtering = taskFiltered();
  const count = $("task-toolbar-count");
  // Not while a new search is still out: the counts on hand answer the previous one.
  if (count) count.textContent = filtering && c && !taskBoard.restart ? `${sumCounts(c)} of ${sumCounts(taskBoard.totals ?? c)} tasks` : "";
  const previous = taskCards;
  taskCards = new Map();
  $("tasks").replaceChildren(...lists.map(([key, title, list]) => {
    const counted = Object.prototype.hasOwnProperty.call(totalOf, key) ? totalOf[key] : list.length;
    const total = counted == null ? null : counted;
    const { cursor, items } = taskBoard.columns[key];
    const hidden = total == null ? 0 : Math.max(0, total - items.length);
    const loading = taskBoard.loadingMore.has(key);
    return el("div", { class: "column" },
      el("h3", {}, title, el("span", { class: "column-count" }, total == null ? "—" : String(total))),
      list.length ? list.map((t) => keyedTaskCard(t, previous))
        : el("div", { class: "empty empty-state" },
          el("div", { class: "ui-vignette", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
          emptyMark(filtering ? "pulse" : "check"),
          el("p", { class: "empty-line" }, filtering ? "No matches" : key === "open" ? "No open tasks" : "None yet"),
          filtering ? el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => { const box = $("task-search"); if (box) { box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); } } }, "Clear search")
            : key === "open" ? el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: () => $("task-title")?.focus() }, "Add a task") : null),
      cursor ? el("button", { class: "btn btn-sm btn-quiet task-more", type: "button", disabled: loading, onclick: () => loadMoreTasks(key) },
        loading ? "Loading…" : hidden > 0 ? `Show ${Math.min(hidden, TASK_PAGE)} more (${hidden} hidden)` : "Show more") : null);
  }));
  $("tasks").scrollTop = scrollTop;
  $("tasks").scrollLeft = scrollLeft;
  // Revoke discarded cards after retained nodes have been reattached, never during their transient move.
  for (const owner of taskReadOwners) if (!owner.current()) withdrawTaskReads(owner);
  // Moving keyed nodes through new columns can drop browser focus. Restore only the reader's former
  // subject, and only while focus is still lost rather than moved to another action.
  if (focusedTask && (!document.activeElement || document.activeElement === document.body)) {
    const node = taskCards.get(focusedTask)?.node;
    const target = focused?.isConnected ? focused : focusOnSummary ? node?.querySelector(".task-details > summary") : null;
    target?.focus({ preventScroll: true });
  }
}

const loadedTask = (taskId) => {
  for (const { items } of Object.values(taskBoard.columns)) {
    const found = items.find((t) => t.id === taskId);
    if (found) return found;
  }
  return taskBoard.pinned.get(taskId) ?? null;
};

/** Takes the reader to one task's card, loaded or not: clears a search or project filter that could hide it (the board
 * reads its first pages again), fetches the task when no loaded page holds it and pins it to its column, then opens
 * its details and brings it into view. */
async function openTaskCard(taskId) {
  let task = loadedTask(taskId);
  if (taskFiltered()) {
    setTaskFilter({ q: "", project: "" });
    if ($("task-search")) $("task-search").value = "";
    if ($("task-project-filter")) $("task-project-filter").value = "";
    loadTaskBoard();
  }
  if (!task) {
    const generation = consoleGeneration;
    try {
      task = (await api(`/v1/tasks/${encodeURIComponent(taskId)}`)).task ?? null;
    } catch (err) {
      if (generation === consoleGeneration && !(err instanceof AuthError || err instanceof PausedError)) toast(`Couldn't open that task: ${err.message}`);
      return;
    }
    if (generation !== consoleGeneration || !task) return;
  }
  if (!Object.values(taskBoard.columns).some(({ items }) => items.some((t) => t.id === taskId))) taskBoard.pinned.set(taskId, task);
  renderTaskBoard();
  const found = [...document.querySelectorAll("#tasks .task")].find((n) => n.dataset.taskId === taskId);
  if (!found) return;
  const details = found.querySelector(".task-details");
  if (details) details.open = true;
  found.scrollIntoView?.({ block: "center" });
  found.classList.add("is-found");
  setTimeout(() => found.classList.remove("is-found"), 2000);
  found.querySelector(".task-details > summary")?.focus();
}

/** The project filter's options: every project among the tasks this viewer may see, from the hub, not the projects that
 * happen to be on the loaded pages. A chosen project stays listed (and the filter visible) so it can always be cleared. */
function renderTaskProjectFilter(keys) {
  const select = $("task-project-filter");
  if (!select) return;
  const chosen = taskFilter.project;
  const options = [...new Set([...(keys ?? []), ...(chosen ? [chosen] : [])])].sort();
  select.hidden = options.length < 2 && !chosen;
  select.replaceChildren(el("option", { value: "" }, "All projects"), ...options.map((k) => el("option", { value: k }, projectLabel(k))));
  select.value = chosen;
}

/** A new search or project filter: what the board asks for changed, so an answer still out for the old one is dropped,
 * the old cursors are forgotten (they belong to the old list), and the next read starts at one page per column. The
 * cards on screen stay until that read answers, but their "Show more" goes at once: it would page the old list. */
function setTaskFilter(change) {
  cancelTaskReads();
  taskRevisionRefreshes.clear();
  Object.assign(taskFilter, change);
  taskBoardTicket++;
  clearTimeout(taskSearchTimer);
  taskBoard.pinned.clear();
  taskBoard.loadingMore.clear();
  taskBoard.restart = true;
  for (const column of Object.values(taskBoard.columns)) column.cursor = null;
  renderTaskBoard();
}
$("task-search")?.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
$("task-search")?.addEventListener("input", (e) => {
  // Only a change of what is searched for: a space typed at the end, or clearing an empty box, asks the hub nothing.
  if (e.target.value.trim() === taskFilter.q.trim()) {
    taskFilter.q = e.target.value;
    return;
  }
  setTaskFilter({ q: e.target.value });
  taskSearchTimer = setTimeout(loadTaskBoard, TASK_SEARCH_DEBOUNCE_MS);
});
$("task-project-filter")?.addEventListener("change", (e) => { setTaskFilter({ project: e.target.value }); loadTaskBoard(); });

// A task nobody has touched for this long is called out on its card. Derived from the timestamps the hub already
// returns; finished (done and accepted) and replaced tasks are never called stale.
const TASK_STALE_DAYS = 14;
function taskIdleDays(t) {
  if (t.superseded || (t.status === "done" && t.reviewed)) return null;
  const latest = Math.max(...[t.created_at, t.updated_at, t.completed_at, t.reviewed_at].map((s) => parseTime(s)?.getTime() ?? 0));
  if (!latest) return null;
  const days = Math.floor((Date.now() - latest) / 86_400_000);
  return days >= TASK_STALE_DAYS ? days : null;
}

function taskCard(t) {
  const stale = t.status === "claimed" && !t.lease_active;
  // The hub lets only the claimant complete or release a claim, and only someone else accept or reject the work, so
  // the buttons follow the same rule instead of offering an action that can only fail.
  const mine = Boolean(me?.agentId) && t.claimed_by_agent_id === me.agentId;
  const idleDays = taskIdleDays(t);
  // Done review state is orthogonal to status (src/tasks.ts): a done task is either unreviewed (nobody but the
  // claimant has looked at it yet) or accepted by a distinct agent. A rejected task is back to status "claimed"
  // with review_note set, so its note surfaces in the normal claimed meta line below, not here.
  const reviewNote = t.status === "done"
    ? t.reviewed ? ` · accepted by ${t.reviewed_by_agent_name}` : " · unreviewed"
    : "";
  const meta = t.status === "done"
    ? `done by ${t.claimed_by_agent_name} · ${ago(t.completed_at)}${reviewNote}`
    : t.status === "claimed" && t.lease_active
      ? `${t.claimed_by_agent_name} · ${until(t.lease_expires_at)}${t.review_note ? ` · rejected: ${t.review_note}` : t.has_review_note ? " · sent back" : ""}`
      : stale ? `claim by ${t.claimed_by_agent_name} expired · an eligible agent can claim it` : `added by ${t.created_by_agent_name} · ${ago(t.created_at)}`;

  const actions = [];
  // A replaced task offers no Claim: its work lives on the newer task. Presentation only -- the hub still allows the
  // claim (src/tasks.ts claimTask does not look at superseded_by), so an agent can still take it if it means to.
  if ((t.status === "open" || stale) && !t.superseded) {
    actions.push(el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => claimTaskDirect(t.id) }, "Claim"));
  }
  // Only when this viewer can see the newer task (the hub withholds its title otherwise).
  if (t.superseded && t.superseded_by && t.superseded_by_title) {
    actions.push(el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => openTaskCard(t.superseded_by) }, "Open the newer task"));
  }
  // A saved side request links back to the task it was saved from; the link never blocks either task.
  if (t.side_request_of && t.side_request_of_title) {
    actions.push(el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => openTaskCard(t.side_request_of) }, "Open the original task"));
  }
  // Lease active or not: the hub lets the claimant complete or release until someone else takes the task over
  // (src/tasks.ts completeTask/releaseTask match the claimant, not the lease).
  if (t.status === "claimed" && mine) {
    actions.push(el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: () => completeTaskDirect(t.id) }, "Complete"));
    actions.push(el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => releaseTaskDirect(t.id) }, "Release"));
  }
  if (t.status === "done" && !t.reviewed && !mine) {
    actions.push(el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: () => acceptTaskDirect(t.id) }, "Accept"));
    actions.push(el("button", { class: "btn btn-sm btn-halt", type: "button", onclick: () => rejectTaskDirect(t.id) }, "Reject"));
  }

  const badges = [
    t.superseded ? el("span", { class: "task-badge is-replaced" }, `Replaced by ${t.superseded_by_title ?? "a newer task"}`) : null,
    t.side_request_of ? el("span", { class: "task-badge is-side" }, `Side request of ${t.side_request_of_title ?? "another task"}`) : null,
    idleDays ? el("span", { class: "task-badge is-idle" }, `No activity for ${idleDays} days`) : null,
  ].filter(Boolean);

  const details = taskDetails(t);
  // A real button: Enter and Space work natively, and aria-expanded follows the card however it is opened.
  const title = el("button", { class: "task-title task-title-btn", type: "button", "aria-controls": details.id, "aria-expanded": String(details.open),
    onclick: () => { details.open = !details.open; title.setAttribute("aria-expanded", String(details.open)); } }, t.title);
  details.addEventListener("toggle", () => title.setAttribute("aria-expanded", String(details.open)));
  return el("div", { class: `task${stale ? " stale" : ""}${t.status === "done" && !t.reviewed ? " unreviewed" : ""}${t.superseded ? " is-superseded" : ""}`, dataset: { taskId: t.id, rev: taskRevision(t) } },
    title,
    badges.length ? el("div", { class: "task-badges" }, ...badges) : null,
    el("div", { class: "task-meta", title: t.status === "claimed" && t.lease_active ? "Expires unless renewed" : undefined },
      t.status === "claimed" && t.lease_active ? leaseClock() : null, meta),
    t.status === "done" && t.completion_summary ? clampedText(t.completion_summary, { cls: "task-summary", lines: 3, long: 220 }) : null,
    details,
    actions.length ? el("div", { class: "task-actions" }, ...actions) : null
  );
}

/** What a task asks for, readable before anyone claims, completes or accepts it (Codex-OpenCadre-f46c's finding 7):
 * its description, its project, how many reviews it needs, what an agent must be able to do to claim it, and the
 * reason it was sent back. Collapsed by default so the board stays scannable. Nothing to show, no toggle.
 *
 * A board row is a summary (tasks tranche 2): it says whether a description, a result or a long review note exists
 * (has_description, has_completion_summary, has_review_note) without carrying them, and opening the card reads the full
 * task (GET /v1/tasks/:id) into the first block. A full row (a task opened from a link) shows them at once. */
function taskDetails(t) {
  const reviews = Number(t.required_reviews) || 1;
  const needs = t.required_capabilities_list ?? [];
  const text = el("div", { class: "task-detail-text" }, ...(isTaskSummary(t) ? [] : taskTextRows(t, { withResult: false })));
  const rows = [
    t.project_key ? el("p", { class: "task-fact" }, el("span", {}, "Project"), projectLabel(t.project_key)) : null,
    reviews > 1 ? el("p", { class: "task-fact" }, el("span", {}, "Reviews"), `${t.review_count ?? 0} of ${reviews} accepts`) : null,
    needs.length ? el("p", { class: "task-fact" }, el("span", {}, "Claimed by an agent that can"), needs.join(", ")) : null,
    t.status !== "done" && t.review_note ? el("p", { class: "task-fact" }, el("span", {}, "Sent back because"), t.review_note) : null,
  ].filter(Boolean);
  const history = el("div", { class: "task-history" });
  // The card title is the toggle a person sees (renderTaskCard); the summary stays for the details element and for
  // focus restoration, but is not a second, invisible tab stop.
  const details = el("details", { class: "task-details", id: `task-details-${String(t.id).replace(/[^\w-]/g, "_")}` },
    el("summary", { class: "visually-hidden", tabindex: "-1" }, "Details and history"), text, ...rows,
    el("p", { class: "task-history-label" }, "History"), history);
  details.addEventListener("toggle", async () => {
    // A replacement restores .open before its card is attached; defer ownership checks until
    // the board has registered/reattached the final keyed nodes (also handles synchronous DOM fixtures).
    await Promise.resolve();
    if (!details.open) {
      const owner = taskReaderOwnerByDetails.get(details);
      if (owner) withdrawTaskReads(owner);
      return;
    }
    if (isSignedIn() && activeTab !== "tasks") return;
    loadTaskHistory(t.id, history);
    loadTaskDetail(t, text);
  });
  return details;
}

const isTaskSummary = (t) => t.has_description !== undefined;
/** The texts a summary leaves out, from a full task: its description, its result (in the details for a summary; a full
 * row shows it on the card), and a review note too long for the summary to carry. */
function taskTextRows(task, { withResult, withNote = false }) {
  return [
    task.description ? el("p", { class: "task-description" }, task.description) : null,
    withResult && task.status === "done" && task.completion_summary
      ? el("p", { class: "task-fact task-result" }, el("span", {}, "Result"), task.completion_summary) : null,
    withNote && task.status !== "done" && task.review_note ? el("p", { class: "task-fact" }, el("span", {}, "Sent back because"), task.review_note) : null,
  ].filter(Boolean);
}

/** What makes a task's details worth reading again: the hub's content revision (tasks.revision, migration 54), which
 * every change to a task bumps, even two in the same second (a rejection and a re-completion between two polls leave
 * status and completed_at as they were, but not the result). The other fields stay in the key for a row without one (a
 * task read in full). Part of the card's markup (data-rev), so a changed task's card is rebuilt, and the key of its
 * cached details. */
const taskRevision = (t) => [t.revision, t.status, t.reviewed, t.review_count, t.completed_at, t.claimed_by_agent_id, t.superseded_by,
  t.has_description, t.has_completion_summary, t.has_review_note].map((v) => v ?? "").join("|");
// Full tasks read for opened cards, by identity generation and task id, each with the revision it was read at. A switch of
// workspace or person clears it (resetWorkspaceView), and a generation in the key means an entry can never answer for
// another identity even before that.
const taskDetailCache = new Map(); // `${generation}|${taskId}` -> { rev, task }
const taskReadOwners = new Set();
const taskReaderOwnerByDetails = new WeakMap();
const taskRevisionRefreshes = new Set();

function taskReaderOwner(t, container) {
  const details = container.closest(".task-details");
  if (!details) return null;
  let owner = taskReaderOwnerByDetails.get(details);
  if (owner?.current()) return owner;
  if (owner) withdrawTaskReads(owner);
  const card = details.closest(".task");
  const generation = consoleGeneration;
  const ticket = taskBoardTicket;
  const rev = taskRevision(t);
  owner = {
    task: t, details, card, generation, ticket, rev, withdrawn: false, refused: false,
    detail: null, history: null,
    current: () => !owner.withdrawn && generation === consoleGeneration && ticket === taskBoardTicket &&
      details.open && details.isConnected && taskCards.get(t.id)?.node === card && card.dataset.rev === rev,
  };
  taskReaderOwnerByDetails.set(details, owner);
  taskReadOwners.add(owner);
  return owner;
}

function withdrawTaskReads(owner) {
  owner.withdrawn = true;
  for (const kind of ["detail", "history"]) {
    const flight = owner[kind];
    owner[kind] = null;
    if (flight) { flight.scope.dispose(); delete flight.container.dataset.loading; }
  }
  taskReadOwners.delete(owner);
}

function cancelTaskReads() {
  for (const owner of taskReadOwners) withdrawTaskReads(owner);
}

/** A task-domain application hook, never joined to the core/ancillary aggregates. The board already applied a
 * consistent owned snapshot. Only connected open cards in the current Tasks view schedule child reads. */
function reconcileOpenTaskReads() {
  if (activeTab !== "tasks") return;
  for (const { node } of taskCards.values()) {
    const details = node.querySelector(".task-details");
    const t = loadedTask(node.dataset.taskId);
    if (!t || !details?.open || !node.isConnected) continue;
    loadTaskDetail(t, details.querySelector(".task-detail-text"));
    loadTaskHistory(t.id, details.querySelector(".task-history"), { reconcile: true });
  }
}

function startTaskRead(owner, kind, container) {
  if (!owner?.current() || owner.refused) return null;
  if (owner[kind]) return null;
  const scope = createRefreshReadScope({ settleOnCancel: true });
  const flight = { scope, container, queued: false };
  owner[kind] = flight;
  container.dataset.loading = "1";
  return flight;
}

function taskReadGet(scope, path) {
  // api deliberately abandons obsolete identity responses; the outer wait releases our own flight anyway.
  return scope.wait(api(path, { refreshReadScope: scope }));
}

function taskReadError(container, message, { clear = false, cls = "" } = {}) {
  container.querySelectorAll(".task-read-error").forEach(node => node.remove());
  const error = el("p", { class: `error task-read-error ${cls}` }, message);
  if (clear || container.dataset.loaded !== "1") container.replaceChildren(error);
  else container.append(error);
}

/** Fills an opened summary card's first block from the full task: from the cache while the task is unchanged, else
 * from the hub. A failed or refused read says so and shows nothing older: the cached entry goes with it. */
async function loadTaskDetail(t, container) {
  if (!isTaskSummary(t) || !(t.has_description || t.has_completion_summary || (t.has_review_note && !t.review_note))) return;
  const owner = taskReaderOwner(t, container);
  if (!owner?.current() || owner.refused) return;
  const generation = owner.generation;
  const key = `${generation}|${t.id}`;
  const rev = taskRevision(t);
  const fill = (task) => container.replaceChildren(...taskTextRows(task, { withResult: true, withNote: !t.review_note }));
  const cached = taskDetailCache.get(key);
  if (cached?.rev === rev) return fill(cached.task);
  const flight = startTaskRead(owner, "detail", container);
  if (!flight) return;
  taskDetailCache.delete(key);
  container.dataset.loading = "1";
  container.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  try {
    const { task } = await taskReadGet(flight.scope, `/v1/tasks/${encodeURIComponent(t.id)}`);
    if (!owner.current() || owner.detail !== flight) return;
    if (!task || task.id !== t.id) throw new Error("The task answer did not match this card.");
    if (t.revision != null && task.revision != null && t.revision !== task.revision) {
      const refreshKey = `${generation}|${owner.ticket}|${t.id}|${rev}`;
      if (!taskRevisionRefreshes.has(refreshKey)) { taskRevisionRefreshes.add(refreshKey); refresh(); }
      taskReadError(container, "The task changed. Waiting for its current summary.", { clear: true });
      return;
    }
    taskDetailCache.set(key, { rev, task });
    fill(task);
  } catch (err) {
    if (!owner.current() || owner.detail !== flight) return;
    taskDetailCache.delete(key);
    container.replaceChildren(el("p", { class: "error task-detail-error" }, `Couldn't load the details: ${err.message}`));
    if (err?.status === 404 || err?.status === 403) {
      owner.refused = true;
      const historyFlight = owner.history;
      owner.history = null;
      historyFlight?.scope.dispose();
      const history = owner.details.querySelector(".task-history");
      delete history.dataset.loading;
      delete history.dataset.loaded;
      history.replaceChildren(el("p", { class: "error" }, "History unavailable for this task."));
    }
  } finally {
    flight.scope.dispose();
    if (owner.detail === flight) { owner.detail = null; delete container.dataset.loading; }
  }
}

const TASK_HISTORY_PAGE = 200; // the hub's page cap (src/events.ts MAX_PAGE)
const TASK_HISTORY_MAX_PAGES = 5;
/** Fills `container` with what happened to one task, oldest first, in the same sentences Activity uses. The hub
 * filters to this task (subjectType/subjectId) and the pages are read from the start, so a busy workspace can't push
 * the task's early events out of view (Codex-OpenCadre-f46c on 492aa5e). A task with more than five pages says so. */
async function loadTaskHistory(taskId, container, { reconcile = false } = {}) {
  // One load at a time: toggling open twice in quick succession would race two pagings and the slower one would win.
  const t = loadedTask(taskId) ?? { id: taskId };
  const owner = taskReaderOwner(t, container);
  if (!owner?.current() || owner.refused) return;
  if (owner.history) { if (reconcile) owner.history.queued = true; return; }
  const flight = startTaskRead(owner, "history", container);
  if (!flight) return;
  let completed = false;
  if (container.dataset.loaded !== "1") container.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  try {
    const mine = [];
    let after = 0;
    let retention = null;
    let more = false;
    for (let page = 0; page < TASK_HISTORY_MAX_PAGES; page++) {
      const data = await taskReadGet(flight.scope, `/v1/events?subjectType=task&subjectId=${encodeURIComponent(taskId)}&latest=false&after=${after}&limit=${TASK_HISTORY_PAGE}`);
      if (!owner.current() || owner.history !== flight) return;
      const events = data.events ?? [];
      retention ??= data.retention ?? null;
      mine.push(...events);
      more = events.length === TASK_HISTORY_PAGE;
      if (!more) break;
      after = data.nextAfter ?? events.at(-1).seq;
    }
    const rows = mine.map((e) => el("p", { class: "task-history-row" }, el("span", {}, summarizeEvent(e)), el("time", { class: "muted" }, ago(e.created_at))));
    if (more) rows.push(el("p", { class: "muted" }, `Showing the first ${mine.length} events for this task.`));
    if (retention && rows.length) rows.unshift(el("p", { class: "muted" }, "Older events are past what your plan keeps."));
    const scrollTop = container.scrollTop;
    container.replaceChildren(...(rows.length ? rows
      : [el("p", { class: "muted" }, retention ? "Nothing in the history your plan keeps." : "No history yet.")]));
    container.dataset.loaded = "1";
    container.scrollTop = scrollTop;
    completed = true;
  } catch (err) {
    if (!owner.current() || owner.history !== flight) return;
    taskReadError(container, `Couldn't load the history: ${err.message}`, { clear: err?.status === 403 || err?.status === 404 });
    if (err?.status === 403 || err?.status === 404) delete container.dataset.loaded;
  } finally {
    flight.scope.dispose();
    if (owner.history === flight) {
      owner.history = null;
      delete container.dataset.loading;
      // A failed traversal must expose its settled error/loading boundary. The next explicit refresh can retry;
      // only a successful traversal immediately services an already queued reconciliation.
      if (completed && flight.queued && owner.current() && !owner.refused && activeTab === "tasks") void loadTaskHistory(taskId, container);
    }
  }
}

function renderTaskProjectOptions(projectsData) {
  const select = $("task-project");
  if (!select) return;
  const chosen = select.value;
  const projects = (projectsData?.projects ?? []).filter((p) => p.enabled);
  select.replaceChildren(el("option", { value: "" }, "Any project"), ...projects.map((p) => el("option", { value: p.projectKey }, p.name)));
  select.value = projects.some((p) => p.projectKey === chosen) ? chosen : "";
}
/** A project key is a git remote or "local:Name"; people know it by its last part. */
const projectLabel = (key) => String(key).replace(/^local:/, "").split("/").filter(Boolean).pop() ?? key;

async function claimTaskDirect(taskId) {
  try {
    await api(`/v1/tasks/${taskId}/claim`, { method: "POST" });
    toast("Task claimed.");
    refresh();
  } catch (err) { toast(`Claim failed: ${err.message}`); }
}

async function releaseTaskDirect(taskId) {
  try {
    await api(`/v1/tasks/${taskId}/release`, { method: "POST" });
    toast("Task released to fleet.");
    refresh();
  } catch (err) { toast(`Release failed: ${err.message}`); }
}

async function completeTaskDirect(taskId) {
  try {
    await api(`/v1/tasks/${taskId}/complete`, { method: "POST", body: { summary: "Completed by operator via console" } });
    toast("Task marked complete.");
    refresh();
  } catch (err) { toast(`Complete failed: ${err.message}`); }
}

async function acceptTaskDirect(taskId) {
  try {
    await api(`/v1/tasks/${taskId}/accept`, { method: "POST" });
    toast("Task accepted.");
    refresh();
  } catch (err) { toast(`Accept failed: ${err.message}`); }
}

async function rejectTaskDirect(taskId) {
  try {
    await api(`/v1/tasks/${taskId}/reject`, { method: "POST", body: { note: "Rejected by operator via console" } });
    toast("Task rejected back to claimed.");
    refresh();
  } catch (err) { toast(`Reject failed: ${err.message}`); }
}

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("task-title");
  const title = input.value.trim();
  if (!title) return;
  const descriptionInput = $("task-description");
  const description = descriptionInput?.value.trim() ?? "";
  const project = $("task-project")?.value ?? "";
  const requiredReviews = Number($("task-reviews")?.value) || 1;
  const body = { title };
  if (description) body.description = description;
  if (project) body.project = project;
  if (requiredReviews > 1) body.requiredReviews = requiredReviews;
  try {
    await api("/v1/tasks", { method: "POST", body });
    input.value = "";
    if (descriptionInput) descriptionInput.value = "";
    if ($("task-project")) $("task-project").value = "";
    if ($("task-reviews")) $("task-reviews").value = "1";
    const more = $("task-form-more");
    if (more) more.open = false;
    toast("Task added.");
    refresh();
  } catch (err) { toast(err.message); }
});

// ---------- timeline ----------
let currentTimelineEvents = [];

function parsePayload(raw) {
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
}

function summarizeEvent(e) {
  const p = parsePayload(e.payload);
  const who = e.actor_agent_name || "OpenCadre";
  switch (e.type) {
    case "message.sent":
      return `${who} sent a message${p.priority && p.priority !== "medium" ? ` (${p.priority})` : ""}`;
    case "question.asked":
      return `${who} asked a question`;
    case "question.answered":
      return `${who} answered a question`;
    case "approval.requested":
      return `${who} requested approval: ${p.action || "action"}`;
    case "approval.decided":
      return `${who} ${p.decision === "approve" ? "approved" : "denied"} a command request${p.note ? `: ${p.note}` : ""}`;
    case "approval.expired":
      return `Approval expired for: ${p.action || "action"}`;
    case "approval.withdrawn":
      return `${who} withdrew its approval request: ${p.action || "action"}`;
    case "approval.noted":
      return `${who} noted action: ${p.action || "action"}`;
    case "approval.grant_created":
      return `${who} granted "${p.category}" actions until ${p.expiresAt ? parseTime(p.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`;
    case "approval.grant_revoked":
      return `Grant for "${p.category}" revoked`;
    case "task.created":
      return `${who} created task: "${p.title || "untitled"}"`;
    case "task.claimed":
      return `${who} claimed task: "${p.title || "untitled"}"${p.takeoverFrom ? ` (took over from ${p.takeoverFrom})` : ""}`;
    case "task.released":
      return `${who} released task: "${p.title || "untitled"}"`;
    case "task.completed":
      return `${who} completed task: "${p.title || "untitled"}"${p.summary ? ` (${p.summary})` : ""}`;
    case "task.lease_expired":
      return `Lease expired on task: "${p.title || "untitled"}" (claimant: ${p.claimant || "unknown"})`;
    case "conflict.detected":
      return `Conflict warning: ${who} overlapping with ${p.with || "agent"} on ${(Array.isArray(p.files) ? p.files : []).join(", ")}`;
    case "decision.recorded":
      return `${who} recorded decision: "${p.title || ""}"${p.scope ? ` [${p.scope}]` : ""}`;
    case "goal.set":
      return `${who} set the fleet goal: "${p.text || ""}"`;
    case "agent.phase_changed":
      return `${who} is now ${p.to || "none"}`;
    case "agent.task_changed":
      return `${who} is working on "${p.to || "none"}"`;
    case "agent.key_rotated":
      return `${who} rotated ${p.agentName || "an agent"}'s key`;
    case "agent.removed":
      return `${who} removed ${p.agentName || "an agent"}`;
    case "agent.webhook_set":
      return `${who} turned on wake on mail for ${p.agentName || "an agent"}`;
    case "agent.webhook_cleared":
      return `${who} turned off wake on mail for ${p.agentName || "an agent"}`;
    case "agent.stale":
      return `Agent went stale (unverified heartbeat)`;
    case "agent.suspended":
      return `Agent auto-suspended for stale heartbeat`;
    case "agent.resumed":
      return `${who === "OpenCadre" ? "Agent" : who} resumed after stale suspend`;
    case "agent.usage_limited":
      return `${who} is out of usage${p.resetsAt ? ` until ${clock(p.resetsAt)}` : ""}`;
    case "agent.usage_restored":
      return `${who} has usage again`;
    case "clearance.policy_changed": {
      const where = p.project || "the workspace";
      return p.mode ? `${who} set the approval policy for ${where} to ${p.mode}` : `${who} removed the approval policy for ${where}`;
    }
    case "workspace.paused":
      return `${who} paused the workspace: every agent was disconnected`;
    case "workspace.resumed":
      return `${who} resumed the workspace`;
    case "member.joined":
      return `${p.name || who} joined as ${p.role || "a member"}`;
    case "member.role_changed":
      return `${who} changed a member's role from ${p.from} to ${p.to}`;
    case "member.removed":
      return p.self ? `${who} left the workspace` : `${who} removed a member`;
    case "invite.created":
      return `${who} created an invite for a new ${p.role || "member"}`;
    case "invite.revoked":
      return `${who} revoked an invite`;
    case "clearance.bypassed":
      return `${who} ran ${p.category ? `a ${p.category} command` : "a risky command"} without approval: ${p.action || ""}`;
    case "clearance.policy_pass":
      return `${who}'s ${p.category ? `${p.category} command` : "risky command"} went back to its tool's own permission settings with no OpenCadre approval (${p.reason === "timeout" ? "nobody decided in time" : "the hub was unreachable"}): ${p.action || ""}`;
    case "review.prescreened":
      return `${who === "OpenCadre" ? "Pre-screen" : who} ${p.label || p.decision || "reviewed"} (${p.scope || "diff"}${p.risk ? `, ${p.risk} risk` : ""})`;
    case "agent.connected": return who + " connected";
    case "agent.capabilities_set": return who + " updated its abilities";
    case "agent.round_budget_set": return who + " changed its work budget";
    case "message.escalated": return "OpenCadre alerted operators about " + (p.messageCount ? p.messageCount + " unanswered message" + (p.messageCount === 1 ? "" : "s") : "unanswered messages");
    case "task.review_recorded": return who + ' reviewed task "' + (p.title || "untitled") + '"';
    case "task.accepted": return who + ' accepted task "' + (p.title || "untitled") + '"';
    case "task.rejected": return who + ' sent task "' + (p.title || "untitled") + '" back';
    case "task.superseded": return who + ' replaced task "' + (p.title || "untitled") + '"';
    case "resource.locked": return who + " started editing " + (p.resourceKey || e.subject_id);
    case "resource.released": return who + " stopped editing " + (p.resourceKey || e.subject_id);
    case "resource.lock_expired": return "An editing hold expired on " + (p.resourceKey || e.subject_id);
    case "blackboard.fact_set": return who + ' updated shared fact "' + (p.key || e.subject_id) + '"';
    case "blackboard.fact_deleted": return who + ' removed shared fact "' + (p.key || e.subject_id) + '"';
    case "memory.recorded": return who + ' saved "' + (p.title || "a note") + '"';
    case "memory.archived": return who + ' archived "' + (p.title || "a note") + '"';
    case "device.created": return who + " started connecting " + (p.name || "a computer");
    case "device.revoked": return who + " removed " + (p.name || "a computer");
    case "device.reconnected": return (p.name || "A computer") + " reconnected";
    case "connector.notice": return "OpenCadre sent a chat its computer's connector notice";
    case "session.joined": return who + " started a chat";
    case "session.ended": return (p.agentName || who) + " ended a chat";
    case "project.enabled": return who + " enabled project " + (p.name || p.projectKey || e.subject_id);
    case "project.disabled": return who + " disabled project " + (p.name || p.projectKey || e.subject_id);
    case "project.linked": return who + " linked two projects";
    case "project.unlinked": return who + " unlinked two projects";
    case "workspace.isolation_enabled": return who + " enabled project isolation";
    case "workspace.isolation_disabled": return who + " disabled project isolation";
    default:
      return who + " made a workspace update";
  }
}

function activityJumpAction(e) {
  const type = e.type;
  const chevron = svgEl("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true" },
    svgEl("path", { d: "m6 3 5 5-5 5", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const jump = (label, action) => el("button", { class: "btn btn-sm btn-quiet activity-jump", type: "button", "aria-label": label, onclick: (ev) => { ev.stopPropagation(); action(); } },
    el("span", { class: "visually-hidden" }, label), chevron);
  if (type.startsWith("task.")) return jump("View tasks", () => selectTab("tasks"));
  if (type.startsWith("approval.")) return jump("View approvals", () => goToInbox("approvals"));
  if (type.startsWith("message.") || type.startsWith("question.")) return jump("View messages", () => goToInbox("messages"));
  if (type.startsWith("agent.") || type.startsWith("device.") || type.startsWith("session.") || type.startsWith("resource.")) return jump("View agents", () => selectTab("fleet"));
  if (type === "goal.set") return jump("View goal", () => selectTab("overview"));
  if (type.startsWith("member.") || type.startsWith("invite.")) return jump("View people", () => { selectTab("settings"); scrollToSettingsSection("people"); });
  if (type.startsWith("project.") || type.startsWith("workspace.isolation_")) return jump("View projects", () => { selectTab("settings"); scrollToSettingsSection("projects"); });
  if (type === "clearance.policy_changed" || type.startsWith("workspace.")) return jump("View safety", () => { selectTab("settings"); scrollToSettingsSection("safety"); });
  return null;
}
function renderTimeline(events) {
  currentTimelineEvents = events;

  const container = $("timeline");
  if (!container) return;
  const openDetails = new Set([...container.querySelectorAll(".activity-event-details[open]")]
    .map((detail) => detail.dataset.seq));
  const typeFilter = $("timeline-filter")?.value ?? "";
  const agentFilter = $("timeline-agent-filter")?.value ?? "";

  const agentSelect = $("timeline-agent-filter");
  if (agentSelect) {
    const agents = Array.from(new Set(events.map((e) => e.actor_agent_name).filter(Boolean))).sort();
    const currentVal = agentSelect.value;
    const options = [el("option", { value: "" }, "All agents")];
    for (const a of agents) {
      options.push(el("option", { value: a, selected: a === currentVal }, a));
    }
    agentSelect.replaceChildren(...options);
    if (currentVal && agents.includes(currentVal)) agentSelect.value = currentVal;
  }

  const filtered = events.filter((e) => {
    const matchType = !typeFilter || typeFilter.split(",").some((prefix) => e.type.startsWith(prefix));
    const matchAgent = !agentFilter || e.actor_agent_name === agentFilter;
    return matchType && matchAgent;
  });

  if (filtered.length === 0) {
    container.replaceChildren(el("div", { class: "empty empty-page empty-state" },
      emptyMark("pulse"),
      el("p", { class: "empty-line" }, el("strong", {}, (typeFilter || agentFilter) ? "No matches" : "No activity yet")),
      (typeFilter || agentFilter)
        ? el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => { if ($("timeline-filter")) $("timeline-filter").value = ""; if ($("timeline-agent-filter")) $("timeline-agent-filter").value = ""; $("timeline-refresh")?.click(); } }, "Clear filters")
        : me?.role === "operator" ? el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: () => selectTab("connect") }, "Add a computer") : null));
    return;
  }

  const sorted = [...filtered].sort((a, b) => b.seq - a.seq);
  container.replaceChildren(...sorted.map((e) => {
    const vendor = vendorOfAgent(e.actor_agent_id);
    const isConflict = e.type === "conflict.detected";
    const isBypass = e.type === "clearance.bypassed";
    const isDecision = e.type === "decision.recorded";
    const isApproval = e.type.startsWith("approval.");
    const isMessage = e.type.startsWith("message.") || e.type.startsWith("question.");
    const p = parsePayload(e.payload);

    // Semantic rail dot, one colour per state: a request WAITING on a person is amber; one approved (or a standing
    // approval created) is the online/done green; a denial, conflict or bypass is red; everything else is neutral. An
    // approval that was granted used to wear the amber "waiting" dot.
    const isDenied = isApproval && p.decision === "deny";
    const isApproved = (e.type === "approval.decided" && p.decision === "approve") || e.type === "approval.grant_created";
    const dotClass = isConflict || isDenied || isBypass ? "dot-red" : isApproved ? "dot-green"
      : e.type === "approval.requested" ? "dot-amber" : isMessage ? "dot-ink" : "dot-muted";
    const railDot = el("span", { class: `rail-dot ${dotClass}` });

    const specialClass = isConflict ? "event-conflict" : isBypass ? "event-bypass" : isDecision ? "event-decision" : isApproval ? "event-approval" : "";
    const detail = p.rationale || p.details || (p.files ? `files: ${p.files.join(", ")}` : null);

    // 4-step delivery tracker for messages and questions
    const deliveryTracker = isMessage ? renderDeliveryTracker(e) : null;

    const jumpAction = activityJumpAction(e);
    const eventDetails = el("details", { class: "activity-event-details", open: openDetails.has(String(e.seq)) },
      el("summary", {}, "Details"),
      el("div", { class: "activity-event-details-body" },
        el("span", {}, `Event #${e.seq} · ${e.type}`),
        detail ? el("p", {}, detail) : null));

    eventDetails.dataset.seq = String(e.seq);
    const row = el("article", { class: `strip timeline-entry ${specialClass}`, dataset: { vendor } },
      railDot,
      el("div", { class: "activity-entry-main" },
        el("p", { class: "timeline-summary" }, summarizeEvent(e)),
        el("div", { class: "activity-entry-sub" },
          vendor !== "unknown" ? el("span", { class: "vendor-tag" }, vendorLogo(vendor), vendorLabel(vendor)) : null,
          el("span", {}, ago(e.created_at)),
          deliveryTracker),
        eventDetails),
      jumpAction ? el("div", { class: "activity-entry-action" }, jumpAction) : null);
    if (jumpAction) row.addEventListener("click", (ev) => {
      // Reading or copying stays put: a click inside Details, or one that ends a text selection, never jumps away.
      if (ev.target.closest("button, a, summary, details")) return;
      if (String(window.getSelection?.() ?? "").trim()) return;
      jumpAction.click();
    });
    return row;
  }));
}

/** One dot per persisted delivery state (src/deliveries.ts DeliveryState), and nothing else: queued (the row every
 * directed event gets when it is emitted), delivered (a transport receipt), then the agent's own ack_event outcome. There
 * is no "live" state to show -- a message that is only queued must not read as delivered live -- and a payload field is
 * not a delivery state, so only `e.delivery_state` moves the dots. An event without one is at its first state, queued. */
const DELIVERY_RANK = { queued: 0, delivered: 1, acknowledged: 2, acted: 2, dismissed: 2 };
const DELIVERY_LABEL = { queued: "queued", delivered: "delivered", acknowledged: "acknowledged", acted: "acted on", dismissed: "dismissed" };
function renderDeliveryTracker(e) {
  const state = e.delivery_state in DELIVERY_RANK ? e.delivery_state : "queued";
  const rank = DELIVERY_RANK[state];
  const label = DELIVERY_LABEL[state];
  return el("span", { class: "delivery-tracker", title: `Delivery: ${label}` },
    el("span", { class: "d-dot d-active" }),
    el("span", { class: `d-dot ${rank >= 1 ? "d-active" : ""}` }),
    el("span", { class: `d-dot ${rank >= 2 ? "d-acked" : ""}` }),
    el("span", { class: "d-label" }, label)
  );
}

$("timeline-filter")?.addEventListener("change", () => {
  renderTimeline(currentTimelineEvents);
  if (isSignedIn()) refresh(); // Decisions need their own server-side slice, not a filter over just 40 mixed events.
});
$("timeline-agent-filter")?.addEventListener("change", () => {
  renderTimeline(currentTimelineEvents);
});
$("timeline-refresh")?.addEventListener("click", () => {
  refresh();
  toast("Activity refreshed.");
});


// ---------- awareness ----------
let currentAwarenessDigest = null;

function renderAwareness(digest) {
  currentAwarenessDigest = digest;
  // Directed items are actionable in Inbox. Activity shows only ambient checkpoint updates.
  const items = (digest?.items || []).filter((i) => !i.directed);
  const bgEntries = Object.entries(digest?.background || {});
  const section = document.querySelector(".activity-updates");
  if (section) section.hidden = items.length === 0 && bgEntries.length === 0;

  const summaryContainer = $("awareness-summary");
  if (summaryContainer) {
    if (bgEntries.length > 0) {
      const BACKGROUND_LABEL = {
        "agent.phase_changed": "phase changes",
        "agent.task_changed": "task updates",
        "task.created": "tasks created",
        "task.claimed": "tasks claimed",
        "task.released": "tasks released",
        "task.completed": "tasks completed",
        "decision.recorded": "decisions elsewhere",
        "question.asked": "questions between teammates",
        "question.answered": "answers between teammates",
        "conflict.detected": "conflicts between teammates",
        "approval.requested": "approval requests",
        "approval.decided": "approval decisions",
        "approval.expired": "expired approvals",
        "approval.noted": "risky commands noted",
      };
      summaryContainer.replaceChildren(
        el("span", { class: "field-label" }, "Other changes:"),
        ...bgEntries.map(([type, count]) =>
          el("span", { class: "bg-pill" }, `${count} ${BACKGROUND_LABEL[type] || "other updates"}`)
        )
      );
    } else {
      summaryContainer.replaceChildren();
    }
  }

  const itemsContainer = $("awareness-items");
  if (!itemsContainer) return;
  itemsContainer.hidden = items.length === 0;
  if (items.length === 0) {
    itemsContainer.replaceChildren();
    return;
  }
  const needsYou = items.filter((i) => i.priority === 1);
  const headsUp = items.filter((i) => i.priority === 2);

  const sections = [];
  if (needsYou.length > 0) {
    sections.push(
      el("div", { class: "awareness-section" },
        el("div", { class: "awareness-section-head" },
          el("h3", { class: "awareness-section-title" },
            "Needs you",
            el("span", { class: "pill-chip pill-p1" }, String(needsYou.length))
          )
        ),
        ...needsYou.map(renderAwarenessItem)
      )
    );
  }

  if (headsUp.length > 0) {
    sections.push(
      el("div", { class: "awareness-section" },
        el("div", { class: "awareness-section-head" },
          el("h3", { class: "awareness-section-title" },
            "Heads up",
            el("span", { class: "pill-chip pill-p2" }, String(headsUp.length))
          )
        ),
        ...headsUp.map(renderAwarenessItem)
      )
    );
  }

  itemsContainer.replaceChildren(...sections);
}

/** Directed updates, minus the ones that only announce a message already listed: a message.sent or question.asked
 * update names its thread, and when that thread has an unread message on screen the update is the same thing twice
 * (the full UI audit found each message three times on Home and in the Inbox, once in agent-facing words). */
const MESSAGE_UPDATE_TYPES = new Set(["message.sent", "question.asked", "question.answered"]);
function directedItems(digest, messages) {
  const unreadThreads = new Set((messages ?? []).filter((m) => !m.read_at).map((m) => m.thread_id));
  return (digest?.items ?? []).filter((i) => {
    if (!i.directed) return false;
    if (!MESSAGE_UPDATE_TYPES.has(i.type)) return true;
    const threadId = i.summary?.match(/thread ([0-9a-f-]{20,})/i)?.[1];
    return !(threadId && unreadThreads.has(threadId));
  });
}

function awarenessQuestionBody(item) {
  if (item.type !== "question.asked") return null;
  const threadId = item.summary?.match(/thread ([0-9a-f-]{20,})/i)?.[1];
  if (!threadId) return null;
  const message = lastInboxMessages.find((m) => m.thread_id === threadId)
    ?? (openMessageData?.thread_id === threadId ? openMessageData : null);
  return message?.body ? truncateBody(message.body) : null;
}
function renderAwarenessItem(item) {
  const pClass = item.priority === 1 ? "priority-1" : "priority-2";
  const vendor = "other"; // the digest item names its actor, no id (src/awareness.ts AwarenessItem): no tool to know

  let articleNode;
  const ackButtons = item.directed
    ? el("div", { class: "ack-actions" },
        el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: (e) => ackDigestEvent(item.seq, "acknowledged", articleNode, item.priority, e.currentTarget) }, "Mark seen"),
        el("button", { class: "btn btn-sm", type: "button", onclick: (e) => ackDigestEvent(item.seq, "acted", articleNode, item.priority, e.currentTarget) }, "Done"),
        el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: (e) => ackDigestEvent(item.seq, "dismissed", articleNode, item.priority, e.currentTarget) }, "Dismiss"))
    : null;

  articleNode = el("article", { class: `strip ${pClass}`, dataset: item.actor ? { vendor } : null },
    el("div", {},
      el("span", { class: `p-badge ${item.priority === 1 ? "p1" : "p2"}` }, item.priority === 1 ? "Needs you" : "Heads up"),
      item.actor ? el("span", { class: "vendor-tag" }, vendorLogo(vendor), `${vendorLabel(vendor)} · ${item.actor}`) : null),
    el("p", { class: "strip-body" }, awarenessQuestionBody(item) ?? humanizeAwarenessSummary(item.summary)),
    item.reason ? el("div", { class: "strip-meta" }, el("span", {}, item.reason)) : null,
    ackButtons);

  return articleNode;
}

async function ackDigestEvent(seq, outcome, itemNode, priority, btnEl) {
  if ($("inbox-focus")?.contains(itemNode) && selectedInboxItem?.kind === "mention" && selectedInboxItem.item.seq === seq && selectedInboxItem.status.state !== "current") return;
  // Optimistic UI feedback
  if (itemNode) {
    itemNode.classList.add("is-acked");
  }
  if (btnEl) {
    btnEl.textContent = outcome === "acknowledged" ? "✓ Seen" : outcome === "acted" ? "✓ Done" : "✓ Dismissed";
  }

  try {
    await api(`/v1/events/${seq}/ack`, { method: "POST", body: { outcome } });
    toast(outcome === "acknowledged" ? "Marked seen." : outcome === "acted" ? "Marked done." : "Dismissed.");
    refresh();
  } catch (err) {
    if (itemNode) itemNode.classList.remove("is-acked");
    toast(`Could not update this item: ${err.message}`);
    refresh();
  }
}

// ---------- inbox ----------
// The list stays compact on desktop; selecting an item puts its actionable detail in the right pane.
let lastInboxApprovals = [];
let lastInboxMentions = [];
let selectedInboxItem = null;
let inboxSelectionWorkspace = null;
function showInboxFocusEmpty() {
  $("inbox-focus")?.replaceChildren(    el("div", { class: "empty empty-state" }, emptyMark("inbox"), el("p", { class: "empty-line" }, el("strong", {}, "Select an item"))));
}
function syncInboxWorkspace() {
  const workspace = me?.orgId ?? null;
  if (workspace === inboxSelectionWorkspace) return;
  inboxSelectionWorkspace = workspace;
  selectedInboxItem = null;
  openMessageId = null;
  openMessageData = null;
  replyingToThreadId = null;
  replyDraft = "";
  showInboxFocusEmpty();
}
function selectInboxItem(kind, item) {
  const focus = $("inbox-focus");
  if (!focus || focus.querySelector(".hold.is-holding, .is-deciding")) return;
  cancelSelectedInboxStatus();
  selectedInboxItem = { kind, item, status: { state: "pending", lastOkAt: 0 } };
  focus.replaceChildren(kind === "approval" ? clearanceStrip(item)
    : kind === "mention" ? renderAwarenessItem(item)
    : messageFocus(item));
  if (kind === "message") void refreshSelectedInboxStatus();
  else if (kind === "mention") syncSelectedMention();
  for (const row of document.querySelectorAll("#clearances .strip, #inbox-list .strip, #inbox-mentions .strip")) {
    row.classList.toggle("is-selected", row.dataset.inboxId === String(item.id ?? item.seq));
  }
}
// A selected thread has its own participant-authorized status read. The unread window cannot
// delete a consumed body, and a status refresh updates metadata in place without replacing a draft.
let selectedInboxStatusFlight = null;
function cancelSelectedInboxStatus() {
  selectedInboxStatusFlight?.scope.cancel();
  selectedInboxStatusFlight = null;
}
function paintSelectedMessageStatus(selection) {
  if (selection !== selectedInboxItem) return;
  const article = $("inbox-focus")?.querySelector(".inbox-focus-message");
  if (!article) return;
  const status = selection.status;
  const node = article.querySelector("[data-message-status]");
  node.dataset.state = status.state;
  const row = status.message;
  node.textContent = status.state === "current"
    ? [row?.delivered_at ? "Delivered " + ago(row.delivered_at) : "Delivery not recorded", row?.read_at ? "Read " + ago(row.read_at) : "Read not recorded", status.replies ? status.replies + " replies in this thread" : null].filter(Boolean).join(" · ")
    : status.state === "pending" ? "Checking thread status…" : "Thread status unavailable" + (status.lastOkAt ? " · last checked " + clockTime(status.lastOkAt) : "") + ". Reply is unavailable until status can be checked.";
  const send = article.querySelector("button[type=submit]");
  send.disabled = status.state !== "current" || Boolean(selection.sending);
}
function withdrawSelectedMessage(selection) {
  if (selection !== selectedInboxItem) return;
  const thread = selection.item.thread_id;
  if (openMessageData?.thread_id === thread) { openMessageData = null; openMessageId = null; }
  if (replyingToThreadId === thread) { replyingToThreadId = null; replyDraft = ""; }
  lastInboxMessages = lastInboxMessages.filter(m => m.thread_id !== thread);
  selectedInboxItem = null;
  $("inbox-focus").replaceChildren(el("div", { class: "empty" }, "This thread is no longer available to you."));
  renderInbox(lastInboxMessages);
}
async function refreshSelectedInboxStatus() {
  const selection = selectedInboxItem;
  if (activeTab !== "inbox" || selection?.kind !== "message" || !$("inbox-focus")?.querySelector(".inbox-focus-message") || !me) return;
  if (selectedInboxStatusFlight?.selection === selection) { selectedInboxStatusFlight.queued = true; return selectedInboxStatusFlight.promise; }
  cancelSelectedInboxStatus();
  const flight = { selection, generation: consoleGeneration, queued: false, scope: null, promise: null };
  selectedInboxStatusFlight = flight;
  const owns = () => selectedInboxStatusFlight === flight && flight.generation === consoleGeneration && selection === selectedInboxItem && activeTab === "inbox";
  flight.promise = (async () => {
    do {
      flight.queued = false;
      const scope = flight.scope = createRefreshReadScope({ settleOnCancel: true });
      try {
        const data = await scope.wait(api("/v1/messages/" + encodeURIComponent(selection.item.thread_id) + "/status", { refreshReadScope: scope, owns }));
        if (!owns() || scope.disposed || scope.timedOut) break;
        const receivedAt = Date.now();
        const row = data.messages?.find(m => m.id === selection.item.id);
        if (row) {
          selection.status = { state: "current", receivedAt, lastOkAt: selection.status.lastOkAt, message: row, replies: data.messages.filter(m => m.kind === "reply").length };
          paintSelectedMessageStatus(selection);
          selection.status.lastOkAt = Date.now();
        } else {
          // A missing item is an unknown status, not authority to erase a consumed body.
          selection.status = { ...selection.status, state: "stale", receivedAt };
          paintSelectedMessageStatus(selection);
        }
      } catch (err) {
        if (!owns() || err instanceof RefreshReadCancelledError) break;
        if (err?.status === 403 || err?.status === 404) { withdrawSelectedMessage(selection); break; }
        selection.status = { ...selection.status, state: "stale" };
        paintSelectedMessageStatus(selection);
      } finally { scope.dispose(); }
    } while (flight.queued && owns());
  })().finally(() => { if (selectedInboxStatusFlight === flight) selectedInboxStatusFlight = null; });
  return flight.promise;
}
function messageFocus(m) {
  const selection = selectedInboxItem;
  const question = m.kind === "question";
  const text = el("textarea", { rows: 4, maxlength: 4000, "aria-label": (question ? "Answer" : "Reply to") + " " + m.from_agent_name,
    placeholder: (question ? "Answer " : "Reply to ") + m.from_agent_name + "…" });
  const send = el("button", { class: "btn btn-ink btn-sm", type: "submit", disabled: "" }, question ? "Send answer" : "Send reply");
  const form = el("form", { class: "inbox-focus-reply", onsubmit: async e => {
    e.preventDefault();
    const body = text.value.trim();
    const owns = () => selection === selectedInboxItem && form.isConnected;
    if (!body || !owns() || selection.sending) return;
    if (selection.status.state !== "current") { void refreshSelectedInboxStatus(); return; }
    selection.sending = true;
    send.disabled = true;
    try {
      await api("/v1/messages/" + encodeURIComponent(m.thread_id) + "/reply", { method: "POST", body: { body }, owns });
      if (!owns()) return;
      text.value = "";
      toast(question ? "Answer sent." : "Reply sent.");
      void refreshSelectedInboxStatus();
      refresh();
    } catch (err) { if (owns()) toast("Reply failed: " + err.message); }
    finally { if (owns()) { selection.sending = false; paintSelectedMessageStatus(selection); } }
  } }, text, send);
  return el("article", { class: "inbox-focus-message" },
    el("span", { class: "row-kind" + (question ? " is-question" : "") }, question ? "Question" : m.kind === "reply" ? "Reply" : "Message"),
    el("h3", {}, m.from_agent_name),
    el("p", { class: "inbox-focus-meta" }, "Sent " + ago(m.created_at) + (m.priority === "high" ? " · high priority" : "")),
    el("p", { class: "inbox-focus-status", dataset: { messageStatus: "", state: "pending" } }, "Checking thread status…"),
    el("p", { class: "inbox-focus-body" }, m.body), form);
}
// Mail sent to this agent (hub alerts, clearance-bypass notices, teammate messages). GET /v1/messages
// with no `since` and peek=true returns only *unread* mail, so a message simply drops out of this
// list once POST /v1/messages/consume marks it read -- that's the whole "inbox -> read" lifecycle.
let inboxLoaded = false;
let lastInboxMessages = [];
let openMessageId = null;
let openMessageData = null; // kept so the open message doesn't vanish mid-read once consume() removes
// it from the next unread fetch; cleared when the user closes it.
let replyingToThreadId = null;
let replyDraft = ""; // in-progress reply text for replyingToThreadId, preserved across rebuilds

function truncateBody(body, max = 220) {
  return body.length > max ? `${body.slice(0, max).trimEnd()}…` : body;
}

function renderInboxError() {
  $("inbox-mark-all-read").hidden = true;
  $("inbox-list").replaceChildren(el("div", { class: "empty empty-page" }, el("strong", {}, "Couldn't load your inbox"), "Retrying automatically."));
}

function renderInbox(messages) {
  inboxLoaded = true;
  lastInboxMessages = messages;
  // The open message may have just been consumed (so a fresh fetch no longer includes it) -- show
  // our own, possibly newer, copy of it instead of whatever this fetch says, so it doesn't reset to
  // "unread" or vanish mid-read. openMessageData is always at least as fresh as anything in `messages`.
  // Replaced in place, not appended: appended, the open one won every same-second tie below and jumped to the top of
  // the list the moment it was clicked (seen on the live Inbox).
  const display = openMessageId && openMessageData
    ? (messages.some((m) => m.id === openMessageId)
      ? messages.map((m) => (m.id === openMessageId ? openMessageData : m))
      : [...messages, openMessageData])
    : messages;
  // created_at has only second-level precision, so a burst of alerts (the exact case this feature
  // exists for) commonly ties; break ties by original (server: oldest-first) index, reversed, so the
  // later-arriving of two same-second messages still sorts first instead of falling back to
  // whatever order Array.sort's stability happens to preserve.
  const sorted = display
    .map((m, i) => ({ m, i }))
    .sort((a, b) => new Date(b.m.created_at).getTime() - new Date(a.m.created_at).getTime() || b.i - a.i)
    .map(({ m }) => m);

  // Message-only count, for callers (and this file's own tests) that exercise renderInbox() in
  // isolation. refresh() always calls updateInboxBadge() right after this, which overwrites the
  // badge with the real combined total (approvals + unread messages + mentions, 2.4) -- this is
  // just the badge's correct *intermediate* state, not stale, since nothing reads it in between.
  const unreadCount = display.filter((m) => !m.read_at).length;
  const badge = $("inbox-badge");
  badge.hidden = unreadCount === 0;
  badge.textContent = String(unreadCount);
  syncBadgeMobile("inbox-badge");

  $("inbox-mark-all-read").hidden = messages.length === 0;
  const list = $("inbox-list");
  if (sorted.length === 0) {
    list.replaceChildren(el("div", { class: "empty empty-first-visit empty-page empty-state" }, emptyMark("check"), el("p", { class: "empty-line" }, el("strong", {}, "All caught up")),
      el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => selectTab("timeline") }, "View activity")));
    return;
  }
  // The rebuild below replaces the reply textarea with a new node every poll (every few seconds). The draft text is
  // carried in replyDraft, but focus and the caret are not, so a person typing a longer reply lost the keyboard each
  // tick. Remember them from the live node and put them back on its replacement (same id). Only when the reply box
  // had focus: a re-render must never pull focus into it from elsewhere.
  const active = document.activeElement;
  const replyFocus = active instanceof HTMLTextAreaElement && active.id.startsWith("inbox-reply-") && list.contains(active)
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection, scroll: active.scrollTop }
    : null;
  list.replaceChildren(...sorted.map(inboxStrip));
  if (replyFocus) {
    const textarea = document.getElementById(replyFocus.id);
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(replyFocus.start, replyFocus.end, replyFocus.dir);
      textarea.scrollTop = replyFocus.scroll;
    }
  }
}

function inboxStrip(m) {
  const isOpen = m.id === openMessageId;
  const isRead = Boolean(m.read_at);
  const vendor = vendorOfAgent(m.from_agent_id);
  const needsExpand = m.body.length > 220;

  const openBtn = el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => openMessage(m) }, isOpen ? "Close" : "Open");
  const replyBtn = el("button", { class: "btn btn-sm", type: "button", onclick: () => toggleReply(m.thread_id) }, "Reply");

  // Independent of isOpen: replying to a message you haven't expanded is a normal thing to do
  // (you already saw the preview), and gating the form on isOpen too just made Reply silently do
  // nothing when clicked from a collapsed message.
  let replyForm = null;
  if (replyingToThreadId === m.thread_id) {
    // renderInbox() fully rebuilds this form on every poll/push (every few seconds), which would
    // otherwise silently wipe whatever the user is mid-typing; restore the draft into the new
    // textarea, and keep saving it on input so the NEXT rebuild has the latest text too.
    const textarea = el("textarea", {
      id: `inbox-reply-${m.id}`, rows: "3", placeholder: `Reply to ${m.from_agent_name}…`, required: "",
      oninput: (e) => { replyDraft = e.target.value; },
    });
    textarea.value = replyDraft;
    replyForm = el("form", { class: "inbox-reply-form", onsubmit: (e) => sendInboxReply(e, m.thread_id, m.id) },
      textarea,
      el("div", { class: "inbox-reply-actions" },
        el("button", { class: "btn btn-ink btn-sm", type: "submit" }, "Send reply"),
        el("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => { replyingToThreadId = null; replyDraft = ""; rerenderInbox(); } }, "Cancel")));
  }

  const node = el("article", { class: `strip inbox-message${m.priority === "high" ? " inbox-message-high" : ""}${isRead ? " inbox-message-read" : ""}${selectedInboxItem?.kind === "message" && selectedInboxItem.item.id === m.id ? " is-selected" : ""}`, dataset: { vendor, inboxId: m.id, vendorAgentId: m.from_agent_id ?? "" } },
    el("div", {},
      el("span", { class: "vendor-tag" }, m.kind === "reply" ? "Reply" : m.kind === "question" ? "Question" : "Message"),
      el("p", { class: "callsign" }, vendorLogo(vendor), m.from_agent_name)),
    m.priority === "high" ? el("span", { class: "risk risk-high" }, "high priority") : el("span", { "aria-hidden": "true" }),
    el("p", { class: "strip-body" }, isOpen ? m.body : truncateBody(m.body)),
    el("div", { class: "strip-meta" },
      el("span", {}, ago(m.created_at)),
      isRead ? el("span", { class: "read-mark", title: "Read" }, el("span", { class: "visually-hidden" }, "Read"), el("span", { "aria-hidden": "true" }, "✓")) : null,
      !isOpen && needsExpand ? el("span", { class: "read-more", "aria-hidden": "true" }, "›") : null,
      openBtn,
      replyBtn),
    replyForm);
  node.addEventListener("click", (e) => { if (!e.target.closest("button, form")) { selectInboxItem("message", m); if (openMessageId !== m.id) openMessage(m); } });
  node.tabIndex = 0;
  node.addEventListener("keydown", (e) => { if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectInboxItem("message", m); if (openMessageId !== m.id) openMessage(m); } });
  return node;
}

function rerenderInbox() {
  renderInbox(lastInboxMessages);
}

// Every directed checkpoint item stays actionable in Inbox, including P2. Ambient updates live in Activity.
function renderInboxMentions(digest) {
  const container = $("inbox-mentions");
  if (!container) return;
  const directed = directedItems(digest, lastInboxMessages);
  syncSelectedMention(digest);
  lastInboxMentions = directed;
  container.replaceChildren(...directed.map((item) => {
    const node = renderAwarenessItem(item);
    node.dataset.inboxId = String(item.seq);
    node.classList.toggle("is-selected", selectedInboxItem?.kind === "mention" && selectedInboxItem.item.seq === item.seq);
    node.tabIndex = 0;
    node.addEventListener("click", (e) => { if (!e.target.closest("button")) selectInboxItem("mention", item); });
    node.addEventListener("keydown", (e) => { if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectInboxItem("mention", item); } });
    return node;
  }));
}

// A digest is a bounded window. Absence qualifies the selected item; it cannot delete its body.
function syncSelectedMention(digest = homeSources.awareness.data) {
  const selection = selectedInboxItem;
  if (selection?.kind !== "mention") return;
  const article = $("inbox-focus")?.querySelector("article");
  if (!article) return;
  let status = article.querySelector("[data-mention-status]");
  if (!status) { status = el("p", { class: "muted", dataset: { mentionStatus: "" } }); article.append(status); }
  const current = homeSources.awareness.status === "ok" ? digest?.items?.find(item => item.seq === selection.item.seq) : null;
  if (current) {
    selection.item = current;
    selection.status.state = "current";
    article.querySelector(".strip-body").textContent = awarenessQuestionBody(current) ?? humanizeAwarenessSummary(current.summary);
    let reason = article.querySelector(".strip-meta");
    if (!reason && current.reason) { reason = el("div", { class: "strip-meta" }); article.insertBefore(reason, article.querySelector(".ack-actions")); }
    if (reason) { reason.textContent = current.reason ?? ""; reason.hidden = !current.reason; }
    status.dataset.state = "current";
    status.textContent = "Checked in the current updates";
  } else {
    selection.status.state = "unknown";
    status.dataset.state = "unknown";
    status.textContent = "This item is not in the current checked updates. Its earlier summary is kept; action status is unknown.";
  }
  for (const button of article.querySelectorAll(".ack-actions button")) button.disabled = !current || article.classList.contains("is-acked");
}

// One badge counts pending approvals, unread messages and every directed update.
function updateInboxBadge(approvals, messages, awarenessDigest) {
  const unreadMessages = messages.filter((m) => !m.read_at).length;
  const mentions = directedItems(awarenessDigest, messages).length;
  const total = approvals.length + unreadMessages + mentions;
  const badge = $("inbox-badge");
  badge.hidden = total === 0;
  badge.textContent = String(total);
  syncBadgeMobile("inbox-badge");
}

let inboxFilter = "all"; // "all" | "approvals" | "messages" | "mentions"
function applyInboxFilter() {
  for (const section of document.querySelectorAll("[data-inbox-section]")) {
    section.hidden = inboxFilter !== "all" && section.dataset.inboxSection !== inboxFilter;
  }
  for (const chip of document.querySelectorAll("#inbox-filter-bar .filter-chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === inboxFilter));
  }
}
for (const chip of document.querySelectorAll("#inbox-filter-bar .filter-chip")) {
  chip.addEventListener("click", () => { inboxFilter = chip.dataset.filter; applyInboxFilter(); });
}

let inboxView = "queue"; // "queue" | "history"
function applyInboxView() {
  $("inbox-queue-view").hidden = inboxView !== "queue";
  $("inbox-history-view").hidden = inboxView !== "history";
  for (const tab of document.querySelectorAll(".inbox-view-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.inboxView === inboxView));
  }
  if (inboxView === "history" && activeTab === "inbox" && isSignedIn()) refresh();
}
for (const tab of document.querySelectorAll(".inbox-view-tab")) {
  tab.addEventListener("click", () => {
    inboxView = tab.dataset.inboxView;
    applyInboxView();
    const address = inboxView === "history" ? "#/inbox/history" : "#/inbox";
    if (location.hash !== address) history.pushState(null, "", address);
  });
}
const inboxViewFromHash = () => (/^#\/inbox\/history\b/.test(location.hash) ? "history" : "queue");
// History leaves out notify-only "noted" records (commands a gate reported without asking) unless this is pressed: the
// hub hides them by default (board task cf34b4c2), so a few hundred of them no longer push every decision off the list.
let historyShowNoted = false;
$("history-show-noted")?.addEventListener("click", () => {
  historyShowNoted = !historyShowNoted;
  $("history-show-noted").setAttribute("aria-pressed", String(historyShowNoted));
  if (activeTab === "inbox" && inboxView === "history" && isSignedIn()) refresh();
});

async function openMessage(m) {
  if (openMessageId === m.id) {
    openMessageId = null;
    openMessageData = null;
    replyingToThreadId = null;
    rerenderInbox();
    return;
  }
  openMessageId = m.id;
  openMessageData = m;
  rerenderInbox();
  if (m.read_at) return; // already read (kept visible from a prior open); nothing to consume
  try {
    await api("/v1/messages/consume", { method: "POST", body: { messageIds: [m.id] } });
    // Reflect the read state right away rather than waiting for the next poll: only if this
    // message is still the open one (the user may have already closed it while this was in flight).
    if (openMessageId === m.id) {
      openMessageData = { ...openMessageData, read_at: new Date().toISOString() };
      rerenderInbox();
    }
  } catch (err) {
    toast(`Couldn't mark the message read: ${err.message}`);
  }
}

function toggleReply(threadId) {
  replyingToThreadId = replyingToThreadId === threadId ? null : threadId;
  replyDraft = "";
  rerenderInbox();
}

async function sendInboxReply(e, threadId, messageId) {
  e.preventDefault();
  const textarea = $(`inbox-reply-${messageId}`);
  const body = textarea?.value.trim();
  if (!body) return;
  try {
    await api(`/v1/messages/${threadId}/reply`, { method: "POST", body: { body } });
    toast("Reply sent.");
    replyingToThreadId = null;
    replyDraft = "";
    rerenderInbox();
  } catch (err) {
    toast(`Reply failed: ${err.message}`);
  }
}

$("inbox-mark-all-read").addEventListener("click", async () => {
  const unreadIds = lastInboxMessages.filter((m) => !m.read_at).map((m) => m.id);
  if (!unreadIds.length) return;
  try {
    await api("/v1/messages/consume", { method: "POST", body: { messageIds: unreadIds } });
    toast(unreadIds.length === 1 ? "Marked 1 message read." : `Marked ${unreadIds.length} messages read.`);
    openMessageId = null;
    openMessageData = null;
    refresh();
  } catch (err) {
    toast(`Couldn't mark all read: ${err.message}`);
  }
});

// ---------- connect a computer ----------
// One computer credential sets up every supported tool it finds; each chat in any of them becomes
// its own session agent automatically (Session Model v1, docs/design/SESSION_MODEL.md). This is the
// Connect tab's one primary action -- the old per-tool connect-code flow is retired in its favor.
let computerTimerInterval = null;
let computerStatusPollInterval = null;

// Hub device statuses that will not move again: a poller that sees one must stop, because nothing
// else is coming. The vocabulary is the hub's own (DeviceStatus in src/devices.ts); `waiting` is
// deliberately absent, because a waiting device may still connect. Both pollers below share this one
// set so a status cannot be terminal on one surface and invisible to the other -- which is exactly
// what `revoked` was: terminal at the hub and in the fleet list, and matched by NEITHER poller, so a
// computer removed from the workspace left the first-run card asking /v1/org/devices every 3 seconds
// for the life of the page load.
const DEVICE_TERMINAL_STATUSES = new Set(["connected", "merged", "expired", "revoked"]);

// What to say once a poller has given up, in each surface's own words (the Connect tab offers the
// add form again; the first-run card hands back its "Get a command" button). Keyed by status, so a
// status the hub adds later still gets the fallback sentence below rather than a stale "Waiting…".
const CONNECT_STOP_COPY = {
  expired: "Code expired — add the computer again",
  revoked: "That computer was removed — add it again",
};
const FIRST_RUN_STOP_COPY = {
  expired: "Code expired — get a new command",
  revoked: "That computer was removed — get a new command",
};

// What to paste into an AI agent that's running this on the user's behalf: agents summarize away
// required next steps (an agent dropped Codex's scheduled-task message during a live timed run), so
// this spells out, in the second person, exactly what the agent must do and must show verbatim. The
// command itself is embedded (not "run the command above" -- the agent it's pasted into can't see the
// page), so this is the one thing the user copies and pastes. No key in it. Generic on purpose: the
// computer may set up more than one tool, so there's no single "client" to name here.
function agentPasteInstructions(command) {
  return `You're an AI agent connecting me to OpenCadre. Run this command in this folder, exactly as written:\n\n${command}\n\nThen show me its "Next steps" and any setup message word for word — do not summarize or paraphrase them. Finally, tell me to open a new session or chat in this folder.`;
}

async function copyToClipboard(text, label = "Command") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied to clipboard!`);
  } catch {
    toast("Copy failed. Please select text manually.");
  }
}

$("add-computer-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("computer-name").value.trim();
  const errEl = $("computer-error");
  if (errEl) errEl.hidden = true;
  // Guards against a double-click or repeated Enter firing the request twice while it's in flight
  // (found live: the operator got 3 connect codes from one burst of clicks).
  const submitBtn = $("btn-add-computer");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await api("/v1/org/devices", { method: "POST", body: { name } });
    showComputerOutput(result);
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

// The parts of the connect card that only make sense while the command can still be redeemed: the
// "Run this command on the computer, once:" heading with its countdown, the command box, and the
// agent prompt. On a terminal status the code can never work, so they come off screen and the status
// bar is left saying why -- the same thing the first-run card does with its own command (hidden at
// :2512, re-shown on a new command at :2472). One list, toggled in BOTH directions, so "show a new
// command" cannot forget to undo the dead state (showComputerOutput is the only thing that re-opens
// this card, and it un-hides these first).
const CONNECT_DEAD_COMMAND_NODES = [".connect-card-head", ".connect-cmd-box", ".connect-agent-prompt"];
function setConnectDeadCommand(output, dead) {
  if (!output) return;
  for (const selector of CONNECT_DEAD_COMMAND_NODES) {
    output.querySelectorAll(selector).forEach((node) => { node.hidden = dead; });
  }
}

function showComputerOutput(data) {
  const output = $("computer-output");
  const cmdText = $("computer-cmd-text");
  const timerEl = $("computer-timer");
  const statusChip = $("computer-status-chip");
  if (!output || !cmdText) return;

  cmdText.textContent = data.command;
  output.hidden = false;
  const codeEl = $("computer-code");
  if (codeEl) codeEl.textContent = data.code ?? data.command.match(/--code (\S+)/)?.[1] ?? "";
  setWizardStep("run", data.name ?? $("computer-name")?.value.trim());
  if ($("wizard-dead")) $("wizard-dead").hidden = true;
  if (statusChip) statusChip.hidden = false;
  // A fresh command is live again: undo whatever the previous one's terminal state left hidden.
  setConnectDeadCommand(output, false);
  const promptText = $("computer-agent-prompt-text");
  if (promptText) promptText.textContent = agentPasteInstructions(data.command);
  if (statusChip) {
    statusChip.className = "status-chip chip-waiting";
    statusChip.textContent = "Waiting for computer to connect…";
  }

  clearInterval(computerTimerInterval);
  const expiresAt = new Date(data.expiresAt).getTime();
  const updateTimer = () => {
    const sec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (timerEl) timerEl.textContent = sec > 0 ? `Expires in ${m}:${s < 10 ? "0" : ""}${s}` : "Code expired";
    if (sec <= 0) clearInterval(computerTimerInterval);
  };
  updateTimer();
  computerTimerInterval = setInterval(updateTimer, 1000);

  // Poll the device list (there's no per-code status route) for this device's own status to move
  // past "waiting" -- driven by the same DeviceStatus the Fleet "by computer" view renders from.
  clearInterval(computerStatusPollInterval);
  computerStatusPollInterval = setInterval(async () => {
    try {
      const devicesData = await api("/v1/org/devices");
      const device = (devicesData.devices ?? []).find((d) => d.deviceId === data.deviceId);
      if (!device || !statusChip) return;
      if (device.status === "connected") {
        statusChip.className = "status-chip chip-online";
        statusChip.textContent = "Computer connected ✓";
        setWizardStep("chat", null, device);
      } else if (device.status === "merged") {
        // The command ran on a computer that was already connected: the hub updated that one instead of adding another.
        const existing = (devicesData.devices ?? []).find((d) => d.deviceId === device.mergedIntoDeviceId);
        statusChip.className = "status-chip chip-online";
        statusChip.textContent = `Connected: updated ${existing?.name ?? "an existing computer"}`;
        setWizardStep("chat", null, existing ?? device);
      } else if (DEVICE_TERMINAL_STATUSES.has(device.status)) {
        // Terminal: the hub will not move this device again, so stop asking. A status with no line in
        // CONNECT_STOP_COPY still stops the poller and says the command is spent -- which is true of
        // every status in the set -- rather than falling through to another 3-second tick.
        statusChip.className = "status-chip chip-limited";
        statusChip.textContent = CONNECT_STOP_COPY[device.status] ?? "This command can no longer be used — add the computer again";
        // Stop the countdown too, and take the spent command off screen. Left alone, "Expires in
        // 14:44" ticks beside "add it again" for up to 15 minutes -- the same defect one interval
        // over: an interval still running for a status the hub will never move, counting down a code
        // that can no longer work. (computerTimerInterval is otherwise cleared only when a FRESH
        // command arrives at :1845, or by itself at :1852 when sec <= 0.)
        clearInterval(computerTimerInterval);
        setConnectDeadCommand(output, true);
        showConnectDead(statusChip.textContent);
      } else {
        return; // still "waiting": keep polling until it connects or the code expires
      }
      clearInterval(computerStatusPollInterval);
      refresh();
    } catch { /* ignore, try again next tick */ }
  }, 3000);

  const copyBtn = $("computer-copy-btn");
  if (copyBtn) copyBtn.onclick = () => copyToClipboard(data.command);
  const promptCopyBtn = $("computer-agent-prompt-copy-btn");
  if (promptCopyBtn) promptCopyBtn.onclick = () => copyToClipboard(agentPasteInstructions(data.command), "Prompt");
}

// ---------- fleet: Computer -> Tool -> Project -> Session (Session Model v1) ----------
// Wired to the real hub (PR #142, src/devices.ts) and mocked ahead of the Computer/Project console
// contract (field names may shift when that hub PR lands): GET /v1/org/sessions rows carry `online`
// straight from the hub's own 2-minute heartbeat TTL (idle is never recomputed here), plus `tool`,
// `projectKey`/`projectName` and `deviceName`; GET /v1/org/devices rows carry `tools: string[]` and
// `status`. Live session rows can be renamed and removed (the same DELETE /v1/org/agents/:agentId as
// Other agents, via removeAction/removeAgent above); End/Promote land in a later PR.
const TOOL_LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", gemini: "Gemini CLI", opencode: "OpenCode", qwen: "Qwen Code", amp: "Amp", kilo: "Kilo Code", cline: "Cline", devin: "Devin", droid: "Factory Droid", crush: "Crush", vibe: "Mistral Vibe", grok: "Grok Build", goose: "Goose", copilot: "Copilot CLI", windsurf: "Windsurf" };
const DEVICE_STATUS_LABEL = { waiting: "Waiting to connect", expired: "Code expired" };
let fleetViewMode = "project"; // "project" | "computer" -- which of the two groupings is on screen
let lastFleetDevices = [];
let lastFleetSessions = [];
let fleetAgentById = new Map();
let lastUnlinkedAgents = [];
let pendingFleetGroups = null; // {devicesData, liveData} held back while a remove-confirm is open

function closeFleetMenus(except = null, restoreFocus = false) {
  let restore = null;
  let restoreAgentId = null;
  for (const menu of document.querySelectorAll(".row-menu[open]")) {
    if (menu === except) continue;
    if (!restore && restoreFocus) {
      restore = menu.querySelector("summary");
      restoreAgentId = menu.closest(".row-fleet")?.dataset.agentId ?? null;
    }
    menu.open = false;
  }
  if (restoreFocus) {
    applyPendingFleetGroups();
    if (!restore?.isConnected && restoreAgentId) {
      restore = Array.from(document.querySelectorAll(".row-fleet[data-agent-id]"))
        .find((row) => row.dataset.agentId === restoreAgentId)?.querySelector(".row-menu summary") ?? null;
    }
    if (restore?.isConnected) restore.focus();
  }
}

document.addEventListener("click", (event) => {
  if (!event.target?.closest?.(".row-menu")) closeFleetMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".row-menu[open]")) closeFleetMenus(null, true);
});

function cacheFleetGroups(devicesData, liveData, agentsData) {
  fleetAgentById = new Map((agentsData ?? []).map((a) => [a.id, a]));
  lastFleetDevices = (devicesData.devices ?? []).filter((d) => d.status !== "merged" && !(d.status === "revoked" && !d.lastSeenAt));
  lastFleetSessions = (liveData.sessions ?? []).filter((s) => !s.endedAt);
  lastUnlinkedAgents = unlinkedAgents(agentsData);
}

function applyPendingFleetGroups() {
  const pending = pendingFleetGroups;
  const container = $("fleet-groups");
  if (!pending || pending.generation !== consoleGeneration || !container ||
      container.querySelector(".remove-confirm, .rename-form, .message-form, .row-menu[open]")) return;
  pendingFleetGroups = null;
  renderFleetGroups(pending.devicesData, pending.liveData, pending.agentsData);
}

// Agents' views are subpages with their own address: #/agents (by project), #/agents/computers, #/agents/named.
const AGENTS_SUBPAGES = { project: "", computer: "computers", agents: "named" };
function agentsViewFromHash() {
  const sub = location.hash.match(/^#\/agents\/([a-z]+)/)?.[1];
  return Object.keys(AGENTS_SUBPAGES).find((k) => AGENTS_SUBPAGES[k] === sub) ?? (sub ? null : "project");
}
function setAgentsView(view, { record = true } = {}) {
  const btn = document.querySelector(`.view-toggle-btn[data-view="${view}"]`);
  if (!btn) return;
  applyAgentsView(btn);
  const address = AGENTS_SUBPAGES[view] ? `#/agents/${AGENTS_SUBPAGES[view]}` : "#/agents";
  if (record && location.hash !== address) history.pushState(null, "", address);
}
document.querySelectorAll(".view-toggle-btn").forEach((btn) => btn.addEventListener("click", () => setAgentsView(btn.dataset.view)));
function applyAgentsView(btn) {
  fleetViewMode = btn.dataset.view;
  document.querySelectorAll(".view-toggle-btn").forEach((b) => {
    b.classList.toggle("is-active", b === btn);
    b.setAttribute("aria-pressed", String(b === btn));
  });
  // Agents (docs/design/HUB_REDESIGN.md 5.5) is a third segment, not a separately-scrolled-to
  // section below the live sessions -- one click switches between them, same as project/computer.
  $("fleet-sessions-view").hidden = fleetViewMode === "agents";
  $("fleet-agents-view").hidden = fleetViewMode !== "agents";
  renderCachedFleetGroups();
}

/** Called from refresh() with the two session-scoped responses (either can be null: a non-operator,
 * or a hub that doesn't have these routes yet -- either way this falls back quietly, no error toast,
 * since it fires on every poll tick). Caches devices/live sessions so the view toggle can re-render
 * without another round trip (see renderCachedFleetGroups). */
function renderFleetGroups(devicesData, liveData, agentsData = []) {
  const container = $("fleet-groups");
  if (!container) return;
  const refused = !devicesData || !liveData;
  const held = !refused && container.querySelector(".remove-confirm, .rename-form, .message-form, .row-menu[open]");
  if (refused) {
    // A refused source is not a poll: its rows, and any menu or form on them, go now.
    pendingFleetGroups = null;
  } else {
    cacheFleetGroups(devicesData, liveData, agentsData);
  }
  if (held) {
    pendingFleetGroups = { devicesData, liveData, agentsData, generation: consoleGeneration };
    patchVisibleFleetRows();
    return;
  }
  pendingFleetGroups = null;
  if (refused) {
    // No copy is kept for the view toggle to paint back (renderCachedFleetGroups).
    fleetAgentById = new Map();
    const focused = container.contains(document.activeElement);
    lastFleetDevices = null;
    lastFleetSessions = [];
    lastUnlinkedAgents = [];
    renderConnectorBanner(null);
    renderCachedFleetGroups();
    // Focus was on a row that is gone: it lands on the note that replaced it, not on the page.
    if (focused) container.firstChild.focus();
    return;
  }
  renderConnectorBanner(lastFleetDevices);
  renderCachedFleetGroups();
}

function mergedFleetSession(s) {
  const roster = fleetAgentById.get(s.agentId);
  return {
    ...roster,
    ...s,
    current_task: s.currentTask ?? s.current_task ?? roster?.current_task,
    online: s.online ?? roster?.online,
    phase: s.phase ?? roster?.phase,
    state: s.state ?? roster?.state,
    state_reason: s.state_reason ?? roster?.state_reason,
    editing_files_parsed: s.editing_files_parsed ?? roster?.editing_files_parsed,
  };
}

function patchVisibleFleetRows() {
  const byId = new Map(lastFleetSessions.map((s) => [s.agentId, s]));
  for (const row of $("fleet-groups")?.querySelectorAll(".row-fleet[data-agent-id]") ?? []) {
    const session = byId.get(row.dataset.agentId);
    if (session) patchFleetRow(row, session);
  }
  const agentsById = new Map(lastUnlinkedAgents.map((agent) => [agent.id, agent]));
  for (const row of $("fleet-groups")?.querySelectorAll(".unlinked-agent-row[data-agent-id]") ?? []) {
    const agent = agentsById.get(row.dataset.agentId);
    if (agent) patchFleetRow(row, agent);
  }
}

function patchFleetRow(strip, session) {
  const row = mergedFleetSession(session);
  const namedAgent = strip.classList.contains("unlinked-agent-row");
  const idle = !namedAgent && !row.online;
  const pending = !namedAgent && !idle && row.liveness === "process";
  const state = idle ? "idle" : agentState(row);
  strip.classList.remove("strip--working", "strip--waiting", "strip--blocked", "strip--online", "strip--idle", "strip--offline");
  strip.classList.add(`strip--${state}`);
  strip.classList.toggle("is-pending", pending);

  const task = strip.querySelector(".strip-body");
  const taskText = pending ? "Waiting for its first action" : namedAgent && !row.online && !row.current_task
    ? "Not connected" : row.currentTask || row.current_task || "No task announced";
  if (task) { task.textContent = taskText; task.title = taskText; }

  const nextState = idle ? idleIndicator(session.lastHeartbeatAt ?? session.last_heartbeat_at ?? row.last_heartbeat_at) : stateIndicator(row);
  const stateChip = strip.querySelector(".state-chip");
  if (stateChip) {
    stateChip.className = nextState.className;
    stateChip.title = nextState.title;
    stateChip.setAttribute("aria-label", nextState.getAttribute("aria-label") || "");
    stateChip.replaceChildren(...Array.from(nextState.childNodes));
  }

  const meta = strip.querySelector(".strip-meta");
  if (!meta) return;
  const phase = row.phase ? el("span", { class: "phase-chip" }, row.phase) : null;
  const role = roleTag(row);
  patchMetaText(meta, ".phase-chip", phase);
  patchMetaText(meta, ".role-tag", role);

  const rawFiles = row.editing_files_parsed ?? row.editingFiles ?? [];
  const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
  const existingFiles = meta.querySelector(".files-count");
  if (!files.length || !files[0]) existingFiles?.remove();
  else if (existingFiles) {
    existingFiles.querySelector("summary").textContent = `✎ ${files.length} file${files.length === 1 ? "" : "s"}`;
    existingFiles.querySelector("ul").replaceChildren(...files.map((file) => el("li", {}, file)));
  } else {
    meta.insertBefore(filesChip(row), meta.firstChild);
  }
  const seen = meta.querySelector(".named-last-seen");
  if (seen) seen.textContent = lastSeen(row.last_heartbeat_at);
}

function patchMetaText(meta, selector, next) {
  const current = meta.querySelector(selector);
  if (!next) { current?.remove(); return; }
  if (current) current.textContent = next.textContent;
  else meta.insertBefore(next, meta.firstChild);
}

/** Re-renders #fleet-groups from lastFleetDevices/lastFleetSessions alone -- what the view-mode
 * toggle calls, since switching between "by project" and "by computer" needs no new data. */
function renderCachedFleetGroups() {
  const container = $("fleet-groups");
  if (!container) return;
  if (!lastFleetDevices) return container.replaceChildren(el("div", { class: "empty empty-state", tabindex: "-1" }, emptyMark("lock"), el("p", { class: "empty-line" }, "Operators only", el("span", { class: "visually-hidden" }, " Sign in as an operator.")), el("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => $("signout")?.click() }, "Switch account")));
  if (lastFleetDevices.length === 0) {
    container.replaceChildren(el("div", { class: "empty empty-first-visit empty-page empty-state" },
      emptyMark("laptop"),
      el("div", { class: "ui-vignette", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
      el("p", { class: "empty-line" }, el("strong", {}, "No computers yet")),
      "Add a computer to start.",
      me?.role === "operator" ? el("div", { class: "empty-actions" },
        el("button", { class: "btn btn-ink btn-sm", type: "button", onclick: () => selectTab("connect") }, "Connect a computer")) : null));
    return;
  }
  container.replaceChildren(fleetViewMode === "computer" ? renderByComputer() : renderByProject());
}

// Fleet session state vocabulary. The hub may add `state`/`state_reason` to session
// payloads; until then the current `online` heartbeat remains the safe fallback.
const AGENT_STATES = { working: "working", waiting: "waiting", blocked: "blocked", online: "online", idle: "idle", offline: "offline" };
const STATE_LABEL = { working: "working", waiting: "waiting", blocked: "blocked", online: "online", idle: "idle", offline: "offline" };
function agentState(a) {
  return a.state && AGENT_STATES[a.state] ? a.state : (a.online ? "online" : "offline");
}
function stateIndicator(a) {
  const state = agentState(a);
  const label = STATE_LABEL[state];
  return el("span", {
    class: "state-chip",
    title: a.state_reason || a.stateReason || label,
    "aria-label": (a.state_reason || a.stateReason) ? `${label}: ${a.state_reason || a.stateReason}` : label,
  },
    el("span", { class: `state-dot state-dot--${state}`, "aria-hidden": "true" }),
    el("span", { class: "state-word" }, label));
}
/** A LIVE session (not ended) with no heartbeat inside the hub's 2-minute window is idle, not offline: the chat is still
 * open (Cursor, for one, sends no heartbeat while idle). It reads "idle 12m" on every page that lists live sessions
 * (Home, By computer, By project); "offline" is only for what is not live. The hub's roster says "offline" for such a
 * session (agent-state.ts knows nothing of sessions), so this wins over it. */
function idleIndicator(lastHeartbeatAt) {
  const chip = stateIndicator({ state: "idle", state_reason: "The chat is open but has not checked in for a while." });
  const idleFor = lastHeartbeatAt ? ago(lastHeartbeatAt).replace(/ ago$/, "").replace(/^just now$/, "") : "";
  if (idleFor) chip.querySelector(".state-word").textContent = `idle ${idleFor}`;
  return chip;
}
function phaseChip(a) {
  if (!a.phase) return null;
  return el("span", { class: "phase-chip" }, a.phase);
}
function roleTag(a) {
  return a.role === "operator" ? el("span", { class: "role-tag" }, "operator") : null;
}
function filesChip(a) {
  const rawFiles = a.editing_files_parsed ?? a.editingFiles ?? [];
  const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
  if (!files.length || !files[0]) return null;
  return el("details", { class: "files-count" },
    el("summary", {}, `✎ ${files.length} file${files.length === 1 ? "" : "s"}`),
    el("ul", { class: "files-list" }, ...files.map((f) => el("li", {}, f))));
}
function taskLine(a) {
  // Never "Idle" here: a quiet live session says so in its state ("idle 12m"), and an agent that is not connected is not idle.
  const text = a.currentTask || a.current_task || "No task announced";
  return el("p", { class: "strip-body row-truncate", title: text }, text);
}

// ---------- projects (opt-in): a computer joins sessions only in projects the workspace enabled ----------
// GET /v1/org/projects -> {projects: [{projectKey, name, enabled, firstSeenAt, lastSeenAt, sessionCount}]}
// PUT /v1/org/projects {projectKey, enabled}.
//
// Every row is a project someone MEANT: `opencadre connect` in that folder, or an operator adding its remote here.
// The hub no longer records folders a computer merely had open (no sightings), so there is no "seen, not enabled"
// list and no Fleet nudge counting one; a disabled row is a project that was enabled and then switched off.
let lastFleetProjectsData = null;
let pendingFleetProjectsData = null;
const settingsProjectRows = new Map();

function renderProjectsSection(projectsData, sourceKind) {
  // A transient read cannot erase the last complete authorized answer. A refusal must.
  if (me?.role === "operator" && sourceKind !== "forbidden" && (sourceKind === "failed" || projectsData === undefined)) return;
  if (me?.role !== "operator" || sourceKind === "forbidden") projectsData = null;
  if (projectsData && !Array.isArray(projectsData.projects)) return;
  lastFleetProjectsData = projectsData;
  renderWizardProjects(projectsData);
  // Revoke hidden controls before another renderer can fail or replay older row data.
  if (!projectsData) renderSettingsProjects(null);
  renderTaskProjectOptions(projectsData);
  if (isolationState) renderIsolation(); // the isolation GETs can land first (Codex-OpenCadre-f46c on 0615d4f)
  renderSettingsProjects(projectsData);
}

/** Add a computer, step 3: which projects chats join from, as state. Only chats in enabled projects join
 * (src/devices.ts), and `opencadre connect` enables the folder it runs in. Someone who can't read the workspace's
 * projects (not an operator) gets that much, and no link to a Settings page they don't have. */
function renderWizardProjects(projectsData) {
  const list = $("wizard-projects-list");
  if (!list) return;
  const operator = me?.role === "operator";
  const link = $("wizard-projects-link");
  if (link) link.hidden = !operator;
  if (!operator || !projectsData) { list.textContent = "the folder you connect from"; return; }
  const names = projectsData.projects.filter((p) => p.enabled).map((p) => p.name || projectLabel(p.projectKey));
  list.textContent = !names.length ? "none yet (the folder you connect from is enabled for you)"
    : names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

function renderSettingsProjects(projectsData) {
  const card = $("projects-card");
  const list = $("settings-projects");
  if (!card || !list) return;
  const operator = me?.role === "operator";
  card.hidden = !operator || !projectsData;
  if (!operator || !projectsData) {
    settingsProjectRows.clear();
    pendingFleetProjectsData = null;
    list.replaceChildren();
    return;
  }
  pendingFleetProjectsData = projectsData;
  const projects = projectsData.projects ?? [];
  const keys = new Set(projects.map((p) => p.projectKey));
  for (const key of settingsProjectRows.keys()) if (!keys.has(key)) settingsProjectRows.delete(key);
  if (projects.length === 0) {
    list.replaceChildren(el("div", { class: "empty empty-state" }, emptyMark("folder"), el("p", { class: "empty-line" }, "No projects yet"),
      el("button", { class: "btn btn-ink btn-sm", type: "button", onclick: () => $("project-add-key")?.focus() }, "Add project")));
    return;
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const enabled = projects.filter((p) => p.enabled).sort(byName);
  const disabled = projects.filter((p) => !p.enabled).sort(byName);
  const nodes = enabled.map(projectRow);
  if (disabled.length > 0) {
    nodes.push(el("h4", { class: "session-group-title" }, "Switched off"));
    nodes.push(...disabled.map(projectRow));
  }
  reconcileListNodes(list, nodes);
}

/** Settings › Projects › Add: an operator enables a project by its git remote before any computer has used it. The hub
 * normalizes every spelling (https, ssh, scp-style) to host/owner/repo and answers 400 for anything that isn't one. */
$("project-add-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("project-add-key");
  const errEl = $("project-add-error");
  const projectKey = input.value.trim();
  errEl.hidden = true;
  if (!projectKey) return;
  const btn = $("project-add-form").querySelector("button");
  btn.disabled = true;
  try {
    const { project } = await api("/v1/org/projects", { method: "PUT", body: { projectKey, enabled: true } });
    input.value = "";
    toast(`${project?.name ?? projectKey} added.`);
    refresh();
  } catch (err) {
    errEl.textContent = `Couldn't add ${projectKey}: ${err.message}`;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function projectRow(p) {
  let record = settingsProjectRows.get(p.projectKey);
  if (record && record.generation === consoleGeneration) {
    record.p = p;
    if ((record.action?.kind === "disable" && !p.enabled) || (record.action?.kind === "enable" && p.enabled)) {
      if (record.action.kind === "disable") record.action.node.remove();
      record.action = null;
      record.toggle.hidden = false;
      record.toggle.disabled = false;
    }
    if (record.action?.kind !== "rename") record.name.textContent = p.name;
    updateProjectRow(record);
    return record.row;
  }
  record = { p, generation: consoleGeneration, action: null };
  const toggleBtn = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, p.enabled ? "Disable" : "Enable");
  toggleBtn.addEventListener("click", () => {
    if (!currentProjectRow(record) || record.action) return;
    if (!record.p.enabled) return setProjectEnabled(record, true);
    // Disabling is reversible (Enable brings it right back) but stops live sessions at once, so it
    // gets the same inline warning-row treatment as Remove -- just a plain confirm, no hold, since
    // nothing here is as final as retiring an agent or a device.
    const strip = toggleBtn.closest(".strip");
    if (!strip || strip.querySelector(".remove-confirm")) return;
    const action = { kind: "disable", node: null, busy: false };
    const close = () => {
      if (!currentProjectAction(record, action)) return;
      row.remove(); toggleBtn.hidden = false; toggleBtn.disabled = false; record.action = null;
    };
    const confirmBtn = el("button", { class: "btn btn-sm btn-halt", type: "button" },
      "Disable");
    confirmBtn.addEventListener("click", () => setProjectEnabled(record, false, close, action));
    const cancel = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => {
      if (!currentProjectAction(record, action)) return;
      close();
      if (pendingFleetProjectsData) renderSettingsProjects(pendingFleetProjectsData);
    });
    const row = el("div", { class: "remove-confirm", role: "group", "aria-label": `Disable ${p.name}` },
      el("p", { class: "remove-warning" }, "Sessions in this project stop working now."), confirmBtn, cancel);
    toggleBtn.hidden = true;
    action.node = row;
    record.action = action;
    strip.append(row);
  });
  const count = p.sessionCount ?? 0;
  const nameEl = el("p", { class: "callsign" }, p.name);
  // Renaming changes only what people see: the project key (its git remote) stays, so every session keeps its project.
  const renameBtn = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Rename");
  renameBtn.addEventListener("click", () => startRenameProject(record));
  const countEl = el("span", {}, `${count} session${count === 1 ? "" : "s"}`);
  const usedEl = el("span", {}, p.lastSeenAt ? `last used ${ago(p.lastSeenAt)}` : "");
  const status = el("span", { class: `status-chip ${p.enabled ? "chip-online" : "chip-waiting"}` }, p.enabled ? "Enabled" : "Disabled");
  const row = el("article", { class: "strip" },
    el("div", {}, nameEl),
    status,
    el("div", { class: "strip-meta" },
      countEl,
      // Refreshed only while the project is enabled (src/projects.ts isProjectEnabled), so it reads as last USE.
      usedEl,
      renameBtn,
      toggleBtn));
  Object.assign(record, { row, name: nameEl, status, count: countEl, used: usedEl, rename: renameBtn, toggle: toggleBtn });
  settingsProjectRows.set(p.projectKey, record);
  updateProjectRow(record);
  return row;
}

function currentProjectRow(record) {
  return record.generation === consoleGeneration && me?.role === "operator" && record.row.isConnected
    && settingsProjectRows.get(record.p.projectKey) === record
    && lastFleetProjectsData?.projects.some((p) => p.projectKey === record.p.projectKey);
}
function currentProjectAction(record, action) {
  const subject = lastFleetProjectsData?.projects.find((p) => p.projectKey === record.p.projectKey);
  return currentProjectRow(record) && record.action === action && action.node.isConnected
    && (action.kind !== "disable" || subject.enabled) && (action.kind !== "enable" || !subject.enabled);
}
function updateProjectRow(record) {
  const p = record.p, count = p.sessionCount ?? 0;
  record.status.textContent = p.enabled ? "Enabled" : "Disabled";
  record.status.className = `status-chip ${p.enabled ? "chip-online" : "chip-waiting"}`;
  record.count.textContent = `${count} session${count === 1 ? "" : "s"}`;
  record.used.textContent = p.lastSeenAt ? `last used ${ago(p.lastSeenAt)}` : "";
  record.used.hidden = !p.lastSeenAt;
  record.toggle.textContent = p.enabled ? "Disable" : "Enable";
}

/** Display rename sends only {projectKey, name}; restating enabled would overwrite another operator's switch. */
function startRenameProject(record) {
  if (!currentProjectRow(record) || record.action) return;
  const { p, name: nameEl, rename: renameBtn } = record;
  const input = el("input", { type: "text", value: p.name, maxlength: 80, "aria-label": `Rename ${p.name}` });
  const save = el("button", { class: "btn btn-sm btn-ink", type: "button" }, "Save");
  const cancel = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Cancel");
  const form = el("span", { class: "rename-form" }, input, save, cancel);
  const action = { kind: "rename", node: form, busy: false };
  record.action = action;
  const close = () => {
    if (!currentProjectAction(record, action)) return;
    form.replaceWith(nameEl);
    renameBtn.hidden = false;
    record.action = null;
  };
  const cancelEdit = () => {
    if (!currentProjectAction(record, action)) return;
    close();
    if (pendingFleetProjectsData) renderSettingsProjects(pendingFleetProjectsData);
  };
  cancel.onclick = cancelEdit;
  save.onclick = async () => {
    if (!currentProjectAction(record, action) || action.busy) return;
    const name = input.value.trim();
    if (!name || name === record.p.name) return cancelEdit();
    action.busy = true;
    save.disabled = true;
    try {
      // Name only: restating `enabled` from the row this form opened with would undo a switch another operator made
      // meanwhile (Codex-OpenCadre-f46c on 5511d8f). The hub treats a name without `enabled` as a rename only.
      await api("/v1/org/projects", { method: "PUT", body: { projectKey: p.projectKey, name } });
      if (!currentProjectAction(record, action)) return;
      nameEl.textContent = name;
      toast(`Renamed to ${name}.`);
      close();
      refresh();
    } catch (err) {
      if (!currentProjectAction(record, action)) return;
      toast(`Couldn't rename ${p.name}: ${err.message}`);
      save.disabled = false;
      action.busy = false;
    }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); if (e.key === "Escape") cancelEdit(); });
  nameEl.replaceWith(form);
  renameBtn.hidden = true;
  input.focus();
  input.select();
}

async function setProjectEnabled(record, enabled, onDone, action = null) {
  if (!currentProjectRow(record) || (action ? !currentProjectAction(record, action) || action.busy : record.action) || record.p.enabled === enabled) return;
  if (!action) record.action = action = { kind: "enable", node: record.row, busy: false };
  const current = () => currentProjectAction(record, action);
  const p = record.p;
  if (action) action.busy = true;
  record.toggle.disabled = true;
  try {
    await api("/v1/org/projects", { method: "PUT", body: { projectKey: p.projectKey, enabled } });
    if (!current()) return;
    record.toggle.disabled = false;
    action.busy = false;
    if (action.kind === "enable") record.action = null;
    toast(enabled ? `${p.name} enabled.` : `${p.name} disabled.`);
    onDone?.();
    refresh();
  } catch (err) {
    if (!current()) return;
    record.toggle.disabled = false;
    action.busy = false;
    if (action.kind === "enable") record.action = null;
    toast(`Couldn't update ${p.name}: ${err.message}`);
  }
}

/** projectKey is the stable grouping id (a git remote, or "local:Name"); projectName is what's shown.
 * Sessions with no project share one "No project" bucket, sorted after every real project. */
function groupSessionsByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = s.projectKey || "none";
    const name = s.projectKey ? (s.projectName || s.projectKey) : "No project";
    if (!groups.has(key)) groups.set(key, { projectName: name, sessions: [] });
    groups.get(key).sessions.push(s);
  }
  return [...groups.entries()].sort(([aKey, a], [bKey, b]) =>
    (aKey === "none") - (bKey === "none") || a.projectName.localeCompare(b.projectName));
}

function renderByProject() {
  const groups = groupSessionsByProject(lastFleetSessions);
  if (groups.length === 0) return el("p", { class: "muted empty-state" }, emptyMark("pulse"), "No live sessions.");
  return el("div", { class: "fleet-groups" }, ...groups.map(([, { projectName, sessions }]) =>
    el("div", { class: "project-card" },
      el("h3", { class: "project-card-title" }, projectName),
      el("div", { class: "strips" }, ...[...sessions].sort((a, b) =>
        Number(b.liveness !== "process") - Number(a.liveness !== "process") || a.agentName.localeCompare(b.agentName))
        .map((s) => sessionStrip(s, false, { showDevice: true }))))));
}

// A device that's revoked and never connected (no lastSeenAt: last_seen_at is set only on a real
// request, never on creation) never had anything to show -- it shouldn't appear at all, not even
// collapsed. A device that connected before it was removed still has history worth keeping
// reachable, so it goes behind a collapsed "Removed (N)" line instead of cluttering the main list.
function renderByComputer() {
  const card = (d) => computerCard(d, lastFleetSessions.filter((s) => s.deviceId === d.deviceId));
  const active = lastFleetDevices.filter((d) => d.status !== "revoked");
  const removed = lastFleetDevices.filter((d) => d.status === "revoked");
  const cards = [...active.map(card), unlinkedAgentsCard(lastUnlinkedAgents)].filter(Boolean);
  if (removed.length === 0) return el("div", { class: "fleet-groups" }, ...cards);
  return el("div", { class: "fleet-groups" }, ...cards,
    el("details", { class: "fleet-removed" },
      el("summary", {}, `Removed (${removed.length})`),
      el("div", { class: "fleet-groups" }, ...removed.map(card))));
}

/** By computer's last group: agents with no computer linked to them (unlinkedAgents). Live ones first; offline ones
 * apart, under their own label. Every row says when it was last seen. Managing their keys lives in the view of the
 * same name. */
function unlinkedAgentsCard(agents) {
  if (!agents.length) return null;
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const online = sorted.filter((a) => a.online);
  const offline = sorted.filter((a) => !a.online);
  const row = (a) => el("article", { class: `strip row-fleet unlinked-agent-row strip--${agentState(a)}`, dataset: { agentId: a.id } },
    el("div", { class: "strip-id" }, el("p", { class: "callsign", title: a.name }, a.name)),
    // "Idle" is a live agent with nothing to do; an agent that is not connected is not that.
    a.online || a.current_task ? taskLine(a) : el("p", { class: "strip-body row-truncate" }, "Not connected"),
    el("span", { class: "row-where" }, ""),
    stateIndicator(a),
    el("div", { class: "strip-meta" }, filesChip(a), phaseChip(a), el("span", { class: "named-last-seen" }, lastSeen(a.last_heartbeat_at))));
  return el("div", { class: "project-card unlinked-agents" },
    el("div", { class: "computer-card-head" }, el("h3", { class: "project-card-title" }, "Agents without a linked computer")),
    // Why they sit here, in sight beside the key icon: they connect with their own key, so the hub can't place them.
    el("span", { class: "unlinked-note" },
      svgEl("svg", { class: "field-label-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" },
        svgEl("circle", { cx: "6", cy: "8", r: "2.2", fill: "none", stroke: "currentColor", "stroke-width": "1.4" }),
        svgEl("path", { d: "M8 8h6.2M12.2 8v2", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round" })),
      "Own key · computer unknown"),
    online.length ? el("div", { class: "strips" }, ...online.map(row)) : null,
    offline.length ? el("div", { class: "session-device-group" },
      el("p", { class: "session-device-label" }, "Offline"),
      el("div", { class: "strips" }, ...offline.map(row))) : null);
}
// PR-E1b (PLAN-PR-E addendum §4.2, amendment 2 §4.1): each label says what the evidence shows and nothing more. A
// different digest is an "optional update", never "unsupported"; only a reviewed `required` policy entry may say
// "required"; missing telemetry is "no recent report", never "too old"; refusal counts are observed reasons, never
// "broken".
const CONNECTOR_LABELS = {
  "reported-current": "Connector: reported current",
  "update-available": "Connector: optional update available",
  "check-installation": "Connector: check installation",
  "no-recent-report": "Connector: no recent report",
  "security-update-required": "Connector: security update required",
};
function connectorBuildLabel(d) {
  const c = d.connector;
  const status = c?.status;
  const text = status === "security-update-required" && c.requiredFeature
    ? `${CONNECTOR_LABELS[status]} (${c.requiredFeature})`
    : CONNECTOR_LABELS[status] ?? "Connector: version unknown";
  const node = el("a", { href: "#add-computer", class: "muted connector-build", title: "Self-reported, 24 h. This does not verify every running process." }, text);
  node.addEventListener("click", (e) => { e.preventDefault(); selectTab("connect"); });
  return node;
}
/** What the connector label alone cannot say: why a report is missing, which known cohort the helpers are, and the
 * refusals the hub observed in the last 24 hours. Null when there is nothing to add. */
function connectorNotes(d) {
  const c = d.connector;
  if (!c) return null;
  const lines = [];
  // Every chip says what it means in its own text: nothing is kept in a tooltip. Missing telemetry is neutral, not a warning.
  if (c.status === "no-recent-report") lines.push(el("span", { class: "connector-chip connector-note" }, "No report · 24 h"));
  if (c.cohort?.id && new URLSearchParams(location.search).has("debug")) lines.push(el("p", { class: "muted connector-note" }, `Reported helpers: cohort ${c.cohort.id}`));
  const r = c.refusals;
  if (r) {
    // Each reason the hub refused for, by name. "Duplicate session" (more than one live session; the hub won't guess)
    // is the one a person can act on, by closing the duplicate chat.
    const seen = [];
    if (r.noSession) seen.push(`${r.noSession} no session`);
    if (r.ambiguousSession) seen.push(`${r.ambiguousSession} duplicate session${r.ambiguousSession === 1 ? "" : "s"}`);
    const refusalCount = (r.noSession || 0) + (r.ambiguousSession || 0);
    if (seen.length) lines.push(el("span", { class: "connector-chip connector-note connector-refusals" }, `Hub refused ${refusalCount} · 24 h: ${seen.join(", ")}`));
    if (r.selfReportedStamp?.count) {
      const n = r.selfReportedStamp.count;
      const why = r.selfReportedStamp.reason ? ` (${r.selfReportedStamp.reason})` : "";
      lines.push(el("span", { class: "connector-chip connector-note connector-refusals" }, `Computer reports ${n} stamp refusal${n === 1 ? "" : "s"}${why}`));
    }
  }
  return lines.length ? el("div", { class: "connector-notes" }, ...lines) : null;
}
/** The Agents page banner (addendum §4.2): only when a computer reports helpers a reviewed `required` entry names. It
 * gives the count and the feature, never a machine path. Refusal counts never raise it. */
function renderConnectorBanner(devices) {
  const banner = $("fleet-connector-banner");
  if (!banner) return;
  const required = (devices ?? []).filter((d) => d.status !== "revoked" && d.status !== "merged" && d.connector?.status === "security-update-required");
  banner.hidden = required.length === 0;
  if (!required.length) { banner.textContent = ""; return; }
  const features = [...new Set(required.map((d) => d.connector.requiredFeature).filter(Boolean))];
  banner.textContent = `${required.length === 1 ? "1 computer reports" : `${required.length} computers report`} OpenCadre helpers that need a security update${features.length ? ` (${features.join("; ")})` : ""}. See each computer's card for the upgrade command.`;
}
function computerCard(d, sessions) {
  const revoked = d.status === "revoked";
  const tools = d.tools ?? [];
  const hold = revoked ? null : holdButton(() => removeComputer(d, hold), {
    label: "Remove", holdingLabel: "Hold to remove…", doneLabel: "Removing…", variant: "quiet-halt",
  });
  if (hold) hold.setAttribute("aria-label", `Hold to remove ${d.name}`);
  const byTool = new Map();
  for (const s of sessions) {
    const tool = s.tool || "other";
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(s);
  }
  // A single-tool computer already names that tool in the header badge above -- repeating it as
  // a group heading right below said "Claude Code" twice for no reason (the operator's finding).
  // With more than one tool, the per-group heading still earns its place: it's what tells you
  // which sessions belong to which tool as you scan down the card.
  //
  // Based on `tools` (the header's own historical union), not `byTool.size` (only currently-live
  // sessions): a computer that's used two tools at different points but has a live session in only
  // one right now would otherwise show two badges up top with zero tool label anywhere in the body
  // (showTool is unconditionally false on every strip below) -- caught in review.
  const singleTool = tools.length <= 1;
  return el("div", { class: `project-card${revoked ? " is-revoked" : ""}` },
    el("div", { class: "computer-card-head" },
      el("h3", { class: "project-card-title" }, d.name),
      el("div", { class: "tool-badges" }, tools.length
        ? tools.map((t) => el("span", { class: "vendor-tag" }, vendorLogo(vendorOfTool(t)), TOOL_LABEL[t] ?? t))
        : [el("span", { class: revoked ? "muted" : "connector-chip" }, revoked ? "Removed" : (DEVICE_STATUS_LABEL[d.status] ?? "No sessions"))]),
      hold),
    revoked ? null : connectorBuildLabel(d),
    revoked ? null : connectorNotes(d),
    ...[...byTool.entries()].map(([tool, toolSessions]) => el("div", { class: "session-device-group" },
      singleTool ? null : el("p", { class: "session-device-label" }, vendorLogo(vendorOfTool(tool)), TOOL_LABEL[tool] ?? tool),
      el("div", { class: "strips" }, ...toolSessions.map((s) => sessionStrip(s, false, { showDevice: false, showTool: false }))))));
}

async function removeComputer(d, holdBtn) {
  try {
    await api(`/v1/org/devices/${encodeURIComponent(d.deviceId)}`, { method: "DELETE" });
    toast(`${d.name} removed. Its sessions have ended.`);
    refresh();
  } catch (err) {
    holdBtn?.resetHold();
    toast(`Remove failed: ${err.message}`);
  }
}

/** Pure function of a session row: `online` comes straight from the hub (its own 2-minute heartbeat
 * TTL, the same one Fleet uses), so a live-but-stale session reads as Idle without recomputing anything
 * here. Ended sessions always read as Ended, regardless of `online`. */
function sessionChip(session, isEnded) {
  if (isEnded) return { cls: "chip-limited", text: "Ended" };
  return session.online ? { cls: "chip-online", text: "Live" } : { cls: "chip-waiting", text: "Idle" };
}

// `showTool` is false inside a computer card's per-tool group (computerCard below): the
// group's own heading already names the tool, so repeating it on every strip in the group
// said the same tool name twice over -- the operator's "the tool name appears twice in By
// computer" report.
function sessionStrip(s, isEnded, { showDevice = false, showTool = true, manage = true } = {}) {
  const chip = sessionChip(s, isEnded);
  const row = mergedFleetSession(s);
  const vendor = vendorOfTool(s.tool);
  const tool = TOOL_LABEL[s.tool] ?? s.tool ?? "Agent";
  // The full name is the title: a long one ends in an ellipsis in the row (console-v2.css). The logo is decorative
  // beside the tool word (showTool); without one (a computer card's group), it is an image named for the tool.
  const nameEl = el("p", { class: "callsign", title: s.agentName }, vendorLogo(vendor, { label: showTool ? null : tool }), s.agentName);
  const renameBtn = isEnded || !manage ? null : el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Rename");
  const messageBtn = isEnded || !manage ? null : el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Message");
  const idle = !isEnded && !row.online;
  const rowState = isEnded ? "offline" : idle ? "idle" : agentState(row);
  const pending = !isEnded && !idle && s.liveness === "process";
  const removal = manage && !isEnded && canRemoveAgent(s.agentId) ? removeAction({ id: s.agentId, name: s.agentName }, {
    onCancel: () => applyPendingFleetGroups(),
  }) : null;
  const actions = [messageBtn, renameBtn, removal].filter(Boolean);
  const menu = actions.length
    ? el("details", { class: "row-menu", name: "fleet-actions" }, el("summary", { "aria-label": `Actions for ${s.agentName}` }, "Actions"),
      el("div", { class: "row-menu-list" }, ...actions))
    : null;
  if (renameBtn) renameBtn.onclick = () => {
    if (menu?.isConnected) menu.open = false;
    startRenameSession(s, nameEl, renameBtn);
  };
  const menuGeneration = consoleGeneration;
  menu?.addEventListener("toggle", () => {
    if (menuGeneration !== consoleGeneration || !menu.isConnected) return;
    if (menu.open) closeFleetMenus(menu);
    else applyPendingFleetGroups();
  });
  const strip = el("article", { class: `strip row-fleet strip--${rowState}${pending ? " is-pending" : ""}`, dataset: { vendor, agentId: s.agentId } },
    el("div", { class: "strip-id" },
      nameEl,
      showTool ? el("span", { class: "vendor-tag" }, tool) : null),
    isEnded ? el("p", { class: "strip-body row-task is-idle" }, "Ended") : taskLine(pending ? { ...row, current_task: "Waiting for its first action" } : row),
    el("span", { class: "row-where" }, showDevice && s.deviceName ? s.deviceName : ""),
    isEnded ? el("span", { class: `status-chip ${chip.cls}` }, chip.text) : idle ? idleIndicator(s.lastHeartbeatAt) : stateIndicator(row),
    el("div", { class: "strip-meta" },
      isEnded ? null : phaseChip(row),
      isEnded ? null : roleTag(row),
      isEnded ? null : filesChip(row),
      ...trustChips(s.agentId)),
    menu);
  if (messageBtn) messageBtn.onclick = () => startMessageAgent(s, strip, menu);
  if (manage && !isEnded && s.namePromptDue) strip.append(namePrompt(s, nameEl));
  return strip;
}

/** Writes to an agent that hasn't written first (F1: POST /v1/messages with toAgent). Opens in the row, like Rename. */
function startMessageAgent(s, strip, menu) {
  if (strip.querySelector(".message-form")) return;
  const generation = consoleGeneration;
  if (menu) menu.open = false;
  const text = el("textarea", { rows: 2, maxlength: 4000, "aria-label": `Message to ${s.agentName}`, placeholder: `Message ${s.agentName}` });
  const send = el("button", { class: "btn btn-sm btn-ink", type: "button" }, "Send");
  const cancel = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Cancel");
  const form = el("div", { class: "message-form", role: "group", "aria-label": `Message ${s.agentName}` }, text,
    el("div", { class: "message-form-actions" }, send, cancel));
  const close = () => {
    if (generation !== consoleGeneration) return;
    form.remove();
    applyPendingFleetGroups();
  };
  cancel.onclick = close;
  send.onclick = async () => {
    const body = text.value.trim();
    if (!body) return text.focus();
    send.disabled = true;
    try {
      await api("/v1/messages", { method: "POST", body: { toAgent: s.agentName, body } });
      if (generation !== consoleGeneration) return;
      toast(`Sent to ${s.agentName}.`);
      close();
    } catch (err) {
      if (generation !== consoleGeneration) return;
      toast(`Couldn't send to ${s.agentName}: ${err.message}`);
      send.disabled = false;
    }
  };
  strip.append(form);
  text.focus();
}

/** Names a chat (sessions PR1): the person types a lasting name like "Atlas", and the chat answers as "Atlas #1" (a second
 * chat given the same name becomes "Atlas #2"). Only the name changes: its mail, claims and history stay with it. */
function startRenameSession(s, nameEl, renameBtn, { onDone } = {}) {
  const generation = consoleGeneration;
  const input = el("input", {
    type: "text", value: s.profileName ?? "", maxlength: 60, placeholder: "Atlas",
    "aria-label": `Name ${s.agentName}`,
  });
  const save = el("button", { class: "btn btn-sm btn-ink", type: "button" }, "Save");
  const cancel = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Cancel");
  const wrap = el("span", { class: "rename-form" }, input, save, cancel);
  if (renameBtn) renameBtn.hidden = true;
  nameEl.replaceWith(wrap);
  input.focus();
  input.select();
  const finish = () => {
    if (generation !== consoleGeneration) return;
    wrap.replaceWith(nameEl);
    if (renameBtn) renameBtn.hidden = false;
    onDone?.();
    applyPendingFleetGroups();
  };
  cancel.onclick = finish;
  save.onclick = async () => {
    const name = input.value.trim();
    if (!name || name === s.profileName) return finish();
    try {
      const named = await api(`/v1/org/sessions/${encodeURIComponent(s.agentId)}`, { method: "PATCH", body: { name } });
      if (generation !== consoleGeneration) return;
      // The hub's note says what the old name no longer reaches (an approver config, a script): shown, never dropped.
      toast(`Now ${named?.agentName ?? name}. ${named?.note ?? ""}`.trim());
      finish();
      refresh();
    } catch (err) {
      if (generation !== consoleGeneration) return;
      toast(`Rename failed: ${err.message}`);
      finish();
    }
  };
}

/** The one-time prompt for a chat still carrying an automatic <Tool>-<Project>-<4hex> name (sessions PR1). Asked once:
 * naming it or keeping the name both answer it for good. Never shown for an agent someone named on purpose. */
function namePrompt(s, nameEl) {
  const generation = consoleGeneration;
  const nameIt = el("button", { class: "btn btn-sm btn-ink", type: "button" }, "Name it");
  const keep = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Keep this name");
  const box = el("div", { class: "name-prompt", role: "group", "aria-label": `Name ${s.agentName}` },
    el("p", { class: "name-prompt-text" }, "This chat has an automatic name. Give it one that's easy to remember?"),
    el("div", { class: "name-prompt-actions" }, nameIt, keep));
  nameIt.onclick = () => {
    box.hidden = true;
    startRenameSession(s, nameEl, null, { onDone: () => { box.hidden = false; } });
  };
  keep.onclick = async () => {
    keep.disabled = true;
    try {
      await api(`/v1/org/sessions/${encodeURIComponent(s.agentId)}/keep-name`, { method: "POST" });
      if (generation !== consoleGeneration) return;
      box.remove();
      refresh();
    } catch (err) {
      if (generation !== consoleGeneration) return;
      toast(`Couldn't keep the name: ${err.message}`);
      keep.disabled = false;
    }
  };
  return box;
}

function renderEndedSessions(allEnded) {
  const endedDetails = $("sessions-ended");
  if (!endedDetails) return;
  // The last day only (bug B2). The hub filters with ?since=, and this repeats it for a hub that predates that.
  const dayAgo = Date.now() - 86_400_000;
  const ended = allEnded.filter((s) => !s.endedAt || parseTime(s.endedAt).getTime() >= dayAgo);
  if (ended.length === 0) {
    endedDetails.hidden = true;
    $("sessions-ended-list")?.replaceChildren();
    const summary = $("sessions-ended-summary");
    if (summary) summary.textContent = "";
    return;
  }
  endedDetails.hidden = false;
  const summary = $("sessions-ended-summary");
  if (summary) summary.textContent = `${ended.length} ended in the last 24 hours`;
  const list = $("sessions-ended-list");
  if (list) {
    list.replaceChildren(...ended.map((s) => el("li", {},
      el("span", { class: "ended-name" }, s.agentName),
      el("span", { class: "muted" }, `${s.projectName || "No project"} · ${s.deviceName || "Unknown computer"} · ended ${s.endedAt ? ago(s.endedAt) : "recently"}`))));
  }
}

// ---------- connect ----------
// Operators create keys with their own session; everyone else still needs the org key.
function applyRole() {
  $("create-agent-key-details").hidden = !me;
  const operator = me?.role === "operator";
  $("org-key-field").hidden = operator;
  $("org-key").required = !operator;
  $("agent-form-note").textContent = operator
    ? "Name the agent and create its key. Each agent gets its own key."
    : "For manual setup without the CLI, generate a key with your organization key:";
  $("policy-card").hidden = !operator;
  const canPause = operator && isOwnerLevel();
  $("killswitch-card").hidden = !canPause;
  if (canPause) {
    lastKnownPaused = Boolean(me?.workspace?.paused);
    renderKillSwitch();
  }
  // Members: owner/admin (session sign-in), or an Operator key during the transition (ACCOUNTS.md).
  const membersVisible = ["owner", "admin"].includes(currentWorkspaceRole) || (authMode === "key" && operator);
  $("members-card").hidden = !membersVisible;
  // First-run decides before the checklist does: whichever of the two is showing, the other defers
  // (renderFirstRun hides the card it supersedes, and refreshOnboarding checks that one's own flag).
  renderFirstRun();
  // A device belongs to a signed-in person (requirePerson), so this only makes sense in session mode.
  if (authMode !== "session") $("push-card").hidden = true;
  layoutSettingsGrid();
}

// Settings is one column (docs/design/CONSOLE-V2.md V8), so there is no half-empty row to fill any more. This still runs
// wherever a section appears or disappears (role, push support), which is exactly when the section index must follow.
function layoutSettingsGrid() {
  renderSettingsIndex();
}

// ---------- self-serve first run ----------
// A stranger who signs up with no waitlist creates a workspace and is handed a working operator key
// in the same round trip (src/accounts.ts createWorkspace, when the hub runs OPENCADRE_SIGNUP=open),
// precisely so they are not "left holding a session cookie and nothing to connect an agent with"
// (ACCOUNTS.md §2.3). The console's job is to spend that key in under five minutes: show the key
// once, hand over ONE command, then show the agents appearing as chats connect.
//
// The flag is that response's top-level `agent` -- the hub's own statement that self-serve is on --
// never a guess at whether a hub "looks self-serve" (/v1/auth/config reports sign-in methods, not
// signup mode, so it cannot answer this). It is remembered per workspace, so a waitlist workspace
// and every workspace created before self-serve render byte-for-byte as they always did. The minted
// key is deliberately memory-only: the hub keeps a hash and says recovery is rotate, not re-read, so
// the console must not keep a second copy on disk either.
let selfServe = null; // { orgId, key, agentName } for this page load only; `key` is never persisted
let firstRunDevice = null; // { deviceId } once the user has asked for the command
let firstRunPoll = null;
let firstRunConnected = false; // this page load saw the connection land

const selfServeFlagKey = (orgId) => `opencadre.selfserve.${orgId}`;
const firstRunHideKey = (orgId) => `opencadre.firstrun.hidden.${orgId}`;
const flagOn = (key) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };

/** Called with the workspace-create response: records that this workspace is self-serve, and holds
 *  the minted key for this page load. The key itself is never written anywhere. */
function rememberSelfServe(orgId, agent) {
  if (!orgId || !agent?.apiKey) return;
  selfServe = { orgId, key: agent.apiKey, agentName: agent.agentName || "your first agent" };
  try { localStorage.setItem(selfServeFlagKey(orgId), "1"); } catch { /* private mode: this page load only */ }
}

function setFirstRunStep(id, done, detail) {
  const step = $(id);
  if (!step) return;
  step.classList.toggle("is-done", done);
  const check = step.querySelector(".onboarding-step-check");
  if (check) check.textContent = done ? "✓" : "";
  if (detail) step.querySelector(".onboarding-step-label").textContent = detail;
}

async function renderFirstRun() {
  const card = $("first-run-card");
  if (!card) return;
  const orgId = me?.orgId;
  if (!orgId) return void (card.hidden = true);
  // Default OFF, on the marker the create round trip writes (rememberSelfServe), for a workspace the
  // user has not dismissed. What that marker guarantees is narrower than "the hub minted a key here":
  // it is WRITTEN only by the round trip that held a key, but a marker set any other way (hand-edited
  // storage, a future writer) still renders this card -- and can only ever render one with no key to
  // reveal, because the key lives in memory for this page load and is never persisted. The sentence
  // above the value row is then inapplicable to such a workspace, not a leak.
  if (!flagOn(selfServeFlagKey(orgId)) || flagOn(firstRunHideKey(orgId))) return void (card.hidden = true);

  let devices = [];
  const generation = consoleGeneration; // an answer for a previous workspace or person is dropped
  try { devices = (await api("/v1/org/devices")).devices ?? []; } catch { /* keep the card up: it is still useful */ }
  if (generation !== consoleGeneration) return;
  const settled = devices.some((d) => d.status === "connected" || d.status === "merged");
  // Connected on an earlier visit: the first run is over, stop taking up the page. On the page where
  // it actually happened we keep the card up instead, to show the payoff once.
  if (settled && !firstRunConnected) return void (card.hidden = true);

  card.hidden = false;
  // Supersedes the generic "Get your fleet running" checklist while it is up: for a brand new
  // self-serve workspace the two overlap on the connect steps, and the checklist's version of them is
  // only a navigation. The checklist comes back the moment the first run is over, carrying the steps
  // this card doesn't cover (first message, first clearance).
  $("onboarding-card").hidden = true;
  setFirstRunStep("first-run-step-workspace", true,
    `${me?.orgName || "This workspace"} is ready — its first agent key is already in it`);
  renderFirstRunKey();
  if (firstRunConnected) {
    setFirstRunStep("first-run-step-command", true, "Command copied and run");
    setFirstRunStep("first-run-step-agents", true);
    $("first-run-get-command").hidden = true;
    $("first-run-cmd").hidden = true;
    const status = $("first-run-status");
    status.hidden = false;
    status.className = "status-chip chip-online";
    status.textContent = "Connected ✓";
    // The payoff, and where it stops: only chats in enabled projects join, so say where those are turned on.
    $("first-run-projects").hidden = me?.role !== "operator";
    return await renderFirstRunAgents();
  }
  // A command already on screen stays on screen: applyRole re-runs on every refresh, and re-rendering
  // it away would make the one thing the user was told to copy disappear under them.
  if (!firstRunDevice) {
    $("first-run-get-command").hidden = false;
    $("first-run-cmd").hidden = true;
    $("first-run-status").hidden = true;
  }
  await renderFirstRunAgents();
}

// The minted first key. The hub returns it once and stores only a hash, so on a later page load there
// is nothing to re-show -- say that plainly and point at the way back in, rather than an empty box.
function renderFirstRunKey() {
  const row = $("first-run-key");
  if (!row) return;
  row.hidden = false;
  const title = $("first-run-key-title");
  const value = $("first-run-key-value");
  const copy = $("first-run-key-copy");
  const note = $("first-run-key-note");
  const key = selfServe?.key;
  const go = $("first-run-key-go");
  if (go) go.hidden = Boolean(key);
  if (!key) {
    title.textContent = "Your first agent key was shown when you created this workspace";
    value.hidden = true;
    copy.hidden = true;
    // The real path, and a button that walks it: Rotate key lives on each named agent's row (renderOtherAgents).
    note.textContent = `The hub keeps only a hash of it, so it cannot be shown twice. To get a new one, go to Agents → Agents without a linked computer → ${FIRST_AGENT_NAME} → Rotate key.`;
    if (go) go.onclick = () => openAgentRow(FIRST_AGENT_NAME);
    return;
  }
  title.textContent = `Your first agent key (${selfServe.agentName})`;
  value.hidden = false;
  copy.hidden = false;
  value.textContent = key;
  note.textContent = "Copy it now if you want to connect by hand — this is the one time it is shown.";
  copy.onclick = () => copyToClipboard(key, "Key");
}

// The sprint's payoff line. Deliberately does NOT tick the step from the count: the workspace already
// holds the first agent and the person's own member row, so a non-zero count is not evidence that a
// chat connected. The connect event below is the honest signal; this only reports the live number.
async function renderFirstRunAgents() {
  const label = $("first-run-agents-label");
  if (!label) return;
  const generation = consoleGeneration;
  try {
    const agents = (await api("/v1/agents")).agents ?? [];
    if (generation !== consoleGeneration || !agents.length) return;
    label.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"} in this workspace — each chat you open in an enabled project adds its own.`;
  } catch { /* leave the default copy */ }
}

$("first-run-get-command").addEventListener("click", async () => {
  const btn = $("first-run-get-command");
  btn.disabled = true;
  try {
    const result = await api("/v1/org/devices", { method: "POST", body: { name: "My computer" } });
    firstRunDevice = { deviceId: result.deviceId };
    $("first-run-cmd-text").textContent = result.command;
    $("first-run-cmd").hidden = false;
    btn.hidden = true;
    const status = $("first-run-status");
    status.hidden = false;
    status.className = "status-chip chip-waiting";
    status.textContent = "Waiting for this computer to connect…";
    $("first-run-copy").onclick = () => copyToClipboard(result.command);
    watchFirstRunDevice(result.deviceId, status);
  } catch (err) {
    toast(`Couldn't create the command: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// The hub has no per-code status route, so watch this device in the workspace's device list.
// Deliberately not reusing showComputerOutput()'s poller: that one writes the Connect tab's elements
// and never marks the chat as having appeared, which is the whole point of this card.
function watchFirstRunDevice(deviceId, status) {
  clearInterval(firstRunPoll);
  firstRunPoll = setInterval(async () => {
    try {
      const devices = (await api("/v1/org/devices")).devices ?? [];
      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      if (device.status === "connected" || device.status === "merged") {
        clearInterval(firstRunPoll);
        firstRunPoll = null;
        firstRunConnected = true;
        renderFirstRun();
        refresh();
      } else if (DEVICE_TERMINAL_STATUSES.has(device.status)) {
        // Terminal: stop asking, and offer the way to get a new command. Same set as the Connect
        // tab's poller, which is the point -- `revoked` used to fall off the end of this chain and
        // leave the interval running for the life of the page load.
        clearInterval(firstRunPoll);
        firstRunPoll = null;
        firstRunDevice = null;
        status.className = "status-chip chip-limited";
        status.textContent = FIRST_RUN_STOP_COPY[device.status] ?? "This command can no longer be used — get a new command";
        $("first-run-cmd").hidden = true;
        $("first-run-get-command").hidden = false;
      }
    } catch { /* hub hiccup: try again next tick */ }
  }, 3000);
}

$("first-run-hide").addEventListener("click", () => {
  if (me?.orgId) localStorage.setItem(firstRunHideKey(me.orgId), "1");
  clearInterval(firstRunPoll);
  firstRunPoll = null;
  $("first-run-card").hidden = true;
});

// ---------- first-run checklist (R5) ----------
// GET /v1/onboarding is computed from what actually exists in the workspace, so there's no
// per-step dismiss state on the server -- only "hide the whole card" is a client preference.
const ONBOARDING_STEPS = {
  first_agent: { label: "Connect your first agent", action: "Go to Connect", tab: "connect" },
  second_agent: { label: "Connect a second agent", action: "Go to Connect", tab: "connect" },
  first_message: { label: "Have two agents message each other", action: "See activity", tab: "timeline" },
  first_clearance: { label: "See your first approval request", action: "Open Inbox", tab: "inbox" },
};
const onboardingHideKey = (orgId) => `opencadre.onboarding.hidden.${orgId}`;

async function refreshOnboarding(options = {}) {
  const card = $("onboarding-card");
  const orgId = me?.orgId;
  if (!orgId) return void (card.hidden = true);
  // While the self-serve first-run card is up it says everything this one would, and says the connect
  // steps better (see renderFirstRun).
  const firstRun = $("first-run-card");
  if (firstRun && !firstRun.hidden) return void (card.hidden = true);
  if (localStorage.getItem(onboardingHideKey(orgId)) === "1") return void (card.hidden = true);
  // Every step here needs a connected computer, which needs the plan: Home's next action covers this state.
  if (me?.billing?.awaitingPlan) return void (card.hidden = true);
  return runVisibleReader("onboarding", read => read("/v1/onboarding"), progress => {
  // Checked again: renderFirstRun can show its card while this request was out, and a new workspace then got both.
  if (firstRun && !firstRun.hidden) return void (card.hidden = true);
  const done = Number(progress?.completed);
  const total = Number(progress?.total);
  if (!Number.isFinite(done) || !Number.isFinite(total) || done >= total) return void (card.hidden = true);
  card.hidden = false;
  const dots = $("onboarding-progress-text");
  dots.textContent = "";
  dots.replaceChildren(el("span", { class: "visually-hidden" }, `${done}/${total}`), ...Array.from({ length: Math.min(total, 6) }, (_, i) => el("i", { class: i < done ? "is-on" : "" })));
  const list = $("onboarding-steps");
  reconcileReaderRows(list, progress.steps, step => step.id, step => {
      const meta = ONBOARDING_STEPS[step.id];
      return el(
        "li",
        { class: `onboarding-step${step.done ? " is-done" : ""}` },
        el("span", { class: "onboarding-step-check", "aria-hidden": "true" }, step.done ? "✓" : ""),
        el("span", { class: "onboarding-step-label" }, step.done && step.detail ? `${meta.label} — ${step.detail}` : meta.label),
        !step.done && el("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => selectTab(meta.tab) }, meta.action),
      );
    });
  }, options);
}
$("onboarding-hide").addEventListener("click", () => {
  if (me?.orgId) localStorage.setItem(onboardingHideKey(me.orgId), "1");
  $("onboarding-card").hidden = true;
});

// Unambiguous characters only (no 0/O, 1/I/L), so a name read aloud or retyped survives.
const NAME_SUFFIX_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateAgentName(prefix = "") {
  const word = prefix.match(/^[A-Za-z]+/)?.[0] ?? "Agent";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${word}-${Array.from(bytes, (b) => NAME_SUFFIX_CHARS[b % NAME_SUFFIX_CHARS.length]).join("")}`;
}
$("generate-agent-name").addEventListener("click", () => {
  $("agent-name").value = generateAgentName($("agent-name").value.trim());
});

$("agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("agent-name").value.trim();
  const errorEl = $("agent-error");
  errorEl.hidden = true;
  if (me?.role === "operator") {
    try {
      const data = await api("/v1/org/agents", { method: "POST", body: { name } });
      showSnippets(data.agentName, data.apiKey);
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
    return;
  }
  const orgKey = $("org-key").value.trim();
  const generation = consoleGeneration; // the one request here that does not go through api(), so it checks itself
  try {
    const res = await fetch("/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${orgKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (generation !== consoleGeneration) return; // a key minted for the previous workspace or person never shows here
    if (!res.ok) throw new Error(res.status === 401 ? "That organization key isn't valid." : data.error || `Request failed (${res.status})`);
    $("org-key").value = "";
    showSnippets(name, data.apiKey);
    refresh();
  } catch (err) {
    if (generation !== consoleGeneration) return;
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function showSnippets(name, key) {
  const mcpUrl = `${hubBase()}/mcp`;
  const snippets = [
    ["Claude Code", `claude mcp add --transport http opencadre ${mcpUrl} --header "Authorization: Bearer ${key}" -s user`],
    ["Antigravity · mcp_config.json", JSON.stringify({ mcpServers: { opencadre: { serverUrl: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)],
    ["Cursor · .cursor/mcp.json", JSON.stringify({ mcpServers: { opencadre: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)],
    ["Codex · ~/.codex/config.toml", `[mcp_servers.opencadre]\nurl = "${mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }\ntool_timeout_sec = 300`],
    ["Codex · shell environment (config.toml)", `[shell_environment_policy.set]\nOPENCADRE_URL = "${hubBase()}"\nOPENCADRE_KEY = "${key}"`],
    ["Gemini CLI · settings.json", JSON.stringify({ mcpServers: { opencadre: { httpUrl: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)],
    [`Key for ${name}`, key],
  ];
  const picker = el("div", { class: "snippet-picker", role: "tablist", "aria-label": "Tool" },
    ...snippets.map(([title], i) => el("button", { type: "button", role: "tab", "aria-selected": String(i === 0), onclick: () => pickSnippet(i) }, title.split(" · ")[0])));
  const pickSnippet = (index) => {
    picker.querySelectorAll("[role=tab]").forEach((b, i) => b.setAttribute("aria-selected", String(i === index)));
    $("snippets").querySelectorAll(".snippet").forEach((node, i) => { node.hidden = i !== index; });
  };
  $("snippets").replaceChildren(picker, ...snippets.map(([title, text], i) => el("div", { class: "snippet", hidden: i !== 0 },
    el("div", { class: "snippet-head" },
      el("h3", {}, title),
      el("button", { class: "btn btn-quiet", type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(text); toast(`Copied ${title}.`); } catch { toast("Copy failed. Select the text instead."); }
      } }, "Copy")),
    el("pre", {}, text))));
  $("connect-output").hidden = false;
}

// ---------- settings ----------
let webhookEdited = false;

function renderSettings() {
  if (me) {
    const orgNameEl = $("settings-org-name");
    const orgIdEl = $("settings-org-id");
    const hubUrlEl = $("settings-hub-url");
    const sessionNameEl = $("settings-session-name");
    if (orgNameEl) orgNameEl.textContent = me.orgName || "—";
    if (orgIdEl) orgIdEl.textContent = me.orgId || "—";
    if (hubUrlEl) hubUrlEl.textContent = hubBase();
    if (sessionNameEl) sessionNameEl.textContent = me.agentName || "—";

    const webhookInput = $("webhook-url");
    const webhookAuth = $("webhook-auth");
    if (webhookInput && !webhookEdited) {
      webhookInput.value = me.webhook_url || "";
      if (webhookAuth) {
        webhookAuth.placeholder = me.webhook_auth_set ? "(Configured — leave blank to keep)" : "Bearer secret-token";
      }
    }
  }

  // The fleet numbers that used to repeat here live on Home's status line (docs/design/CONSOLE-V2.md V8).
  renderSettingsIndex();
  // An address naming a section (#/settings/billing) opens at that section, once the sections exist.
  // The cards a person may see are known now: show the page in the address, else the one already open.
  scrollToSettingsSection(location.hash.match(/^#\/settings\/([a-z]+)/)?.[1] ?? settingsPage, { record: false, refreshReaders: false });
}

// ---------- workspace: paused banner ----------
function renderWorkspaceBanner(pausedFallbackMessage) {
  const banner = $("paused-banner");
  const ws = me?.workspace;
  if (!ws?.paused) {
    banner.hidden = true;
    return;
  }
  const meta = $("paused-banner-meta");
  meta.textContent = ws.pausedBy
    ? `Paused by ${ws.pausedBy}${ws.pausedAt ? ` · ${ago(ws.pausedAt)}` : ""}. Nothing runs until an operator resumes it.`
    : pausedFallbackMessage || "Nothing runs until an operator resumes it.";
  $("resume-btn").hidden = me?.role !== "operator";
  banner.hidden = false;
}

$("resume-btn").addEventListener("click", async () => {
  const btn = $("resume-btn");
  btn.disabled = true;
  try {
    await api("/v1/org/resume", { method: "POST" });
    toast("Workspace resumed.");
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- settings: clearance policy ----------
const MODE_MEANING = {
  off: "each machine's own setting decides",
  notify: "records it, never blocks",
  ask: "holds until someone approves",
  strict: "ask, with no exemptions",
};
const titleCase = (s) => s[0].toUpperCase() + s.slice(1);
let policyLoaded = false;
let policySignature = null;

async function refreshClearancePolicy(options = {}) {
  const loading = $("policy-loading");
  const errorEl = $("policy-error");
  const list = $("policy-list");
  const form = $("policy-add-form");
  if (!readerAdmin()) return;
  return runVisibleReader("policy", read => read("/v1/clearance-policies"), ({ policies }) => {
    policyLoaded = true;
    errorEl.hidden = true;
    loading.hidden = true;
    form.hidden = false;
    renderClearancePolicy(policies);
  }, options);
}

function renderClearancePolicy(policies) {
  const list = $("policy-list");
  const byProject = new Map(policies.map((p) => [p.project, p]));
  const workspaceDefault = byProject.get("") ?? { project: "", mode: "off", source: "default", updatedBy: null, updatedAt: null };
  const projectRows = policies.filter((p) => p.project !== "").sort((a, b) => a.project.localeCompare(b.project));

  list.hidden = false;
  reconcileReaderRows(list, [workspaceDefault, ...projectRows], p => p.project, p => policyRow(p, p.project === ""));
  if (!projectRows.length) list.append(el("p", { class: "policy-empty empty-state" }, emptyMark("shield"), "No overrides"));
}

function policyRow(policy, isWorkspaceDefault) {
  const select = el("select", { "aria-label": `Clearance mode for ${isWorkspaceDefault ? "the workspace default" : policy.project}`, dataset: { original: policy.mode } },
    ...Object.keys(MODE_MEANING).map((m) => el("option", { value: m, selected: m === policy.mode || undefined }, `${titleCase(m)} — ${MODE_MEANING[m]}`)));
  select.value = policy.mode;

  const saveBtn = el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: async () => {
    const mode = select.value;
    saveBtn.disabled = true;
    invalidateVisibleReader("policy");
    try {
      await api("/v1/clearance-policy", { method: "PUT", body: { project: policy.project, mode } });
      select.dataset.original = mode; // this row is no longer "dirty" now that the save landed
      toast(`Set ${isWorkspaceDefault ? "the workspace default" : policy.project} to ${titleCase(mode)}.`);
      refreshClearancePolicy();
    } catch (err) {
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  } }, "Save");

  const removeBtn = isWorkspaceDefault || policy.source !== "project" ? null : el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: async () => {
    invalidateVisibleReader("policy");
    try {
      await api(`/v1/clearance-policy?project=${encodeURIComponent(policy.project)}`, { method: "DELETE" });
      toast(`Removed the override for ${policy.project}; it now follows the workspace default.`);
      refreshClearancePolicy();
    } catch (err) {
      toast(err.message);
    }
  } }, "Remove");

  return el("div", { class: "policy-row" },
    el("div", { class: "policy-row-name" },
      el("span", { class: "policy-project" }, isWorkspaceDefault ? "Workspace default" : policy.project),
      policy.updatedBy ? el("span", { class: "policy-meta" }, `set by ${policy.updatedBy}${policy.updatedAt ? ` · ${ago(policy.updatedAt)}` : ""}`) : null),
    el("div", { class: "policy-row-controls" }, select, saveBtn, removeBtn));
}

$("policy-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const project = $("policy-add-project").value.trim();
  const mode = $("policy-add-mode").value;
  invalidateVisibleReader("policy");
  try {
    await api("/v1/clearance-policy", { method: "PUT", body: { project, mode } });
    toast(`Set ${project || "the workspace default"} to ${titleCase(mode)}.`);
    $("policy-add-project").value = "";
    refreshClearancePolicy();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- settings: kill switch ----------
function renderKillSwitch() {
  const body = $("killswitch-body");
  const ws = me?.workspace;
  if (!ws) { body.replaceChildren(el("p", { class: "policy-empty" }, "Loading…")); return; }

  if (ws.paused) {
    body.replaceChildren(
      el("p", { class: "killswitch-status" },
        el("strong", {}, "Paused"), ` by ${ws.pausedBy || "an operator"}${ws.pausedAt ? ` · ${ago(ws.pausedAt)}` : ""}.`),
      el("button", { class: "btn btn-ink", type: "button", onclick: async (e) => {
        e.target.disabled = true;
        try { await api("/v1/org/resume", { method: "POST" }); toast("Workspace resumed."); refresh(); }
        catch (err) { toast(err.message); }
        finally { e.target.disabled = false; }
      } }, "Resume the workspace"));
    return;
  }

  // A deliberate hold, as on main: a tap never pauses the workspace, and no browser dialog stands in for it.
  const pauseBtn = holdButton(async () => {
    try {
      const result = await api("/v1/org/pause", { method: "POST" });
      toast(result.changed ? `Paused. ${result.agentsCutOff} agent${result.agentsCutOff === 1 ? "" : "s"} disconnected.` : "Already paused.");
      refresh();
    } catch (err) {
      toast(err.message);
      pauseBtn.resetHold();
    }
  }, { label: "Hold to pause the workspace", holdingLabel: "Keep holding to pause…", doneLabel: "Pausing…", variant: "halt" });

  // The state, then what pausing does (src/kill-switch.ts pauseWorkspace: non-operator keys refused, operator keys kept, live connections
  // closed, waiting requests ended), beside the control that does it.
  body.replaceChildren(
    el("p", { class: "killswitch-status" }, el("strong", {}, "Running")),
    el("p", { class: "killswitch-effect" }, "Agents stop: no mail, no claims, no commands. Operator keys keep access. Waiting requests end."),
    pauseBtn);
}

// ---------- settings: members ----------
const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" };
let membersLoaded = false;

// Session mode scopes to currentWorkspace (set by enterWorkspace); key mode has no workspace picker,
// so its Operator key acts on its own org, exactly like every other org-scoped route already does.
const workspaceId = () => currentWorkspace || me?.orgId;

async function refreshMembers(options = {}) {
  const orgId = workspaceId();
  if (!orgId) return;
  if (!readerAdmin()) return;
  return runVisibleReader("members", read => read(`/v1/workspaces/${orgId}/members`), ({ members, invites }) => {
    membersLoaded = true;
    renderMembers(members, invites);
  }, options);
}

// A session owner, or a key-mode Operator (the transition claim path, ACCOUNTS.md), can touch ownership;
// applyRole() already restricts key-mode's Members card to operators, so authMode==="key" here means one.
const isOwnerLevel = () => currentWorkspaceRole === "owner" || authMode === "key";

/** The caller's effective workspace role, mirroring src/permissions.ts roleFor() -- which is what the
 * REST routes actually gate on. In session mode the person's memberRole WINS over their member agent's
 * role (accounts.ts agentRoleFor maps both owners AND admins to agents.role="operator", so me.role can
 * say "operator" for an admin); in key mode an Operator key is owner-equivalent by the bootstrap
 * exception, and a plain agent key is just "agent". Gates for owner-only actions (rotate key, remove
 * agent -- permissions.ts "agents.rotateKey"/"agents.delete") must ask this, not me.role, or a session
 * admin sees affordances the API refuses with 403 "Only an owner can do this." */
const effectiveRole = () => {
  if (authMode === "session") return currentWorkspaceRole ?? "agent";
  return me?.role === "operator" ? "owner" : "agent";
};
const canManageAgents = () => effectiveRole() === "owner";
const canCreateInvite = () => authMode === "session" && readerAdmin();
function clearInviteResult() {
  $("invite-link-result").hidden = true;
  $("invite-link-result").replaceChildren();
}
function withdrawInviteRevokes() {
  for (const flight of inviteRevokeFlights.values()) flight.button.disabled = false;
  inviteRevokeFlights.clear();
}
function membersActionOwner() {
  const generation = consoleGeneration, epoch = membersActionEpoch, orgId = workspaceId();
  const mode = authMode, personId = person?.id ?? null, source = visibleReaders.get("members");
  return () => generation === consoleGeneration && epoch === membersActionEpoch && orgId === workspaceId()
    && mode === authMode && personId === (person?.id ?? null) && visibleReaderEligible("members")
    && source && source === visibleReaders.get("members") && source.data && source.status !== "forbidden";
}

function renderMembers(members, invites) {
  const orgId = workspaceId();
  const ownerLevel = isOwnerLevel();
  const assignable = ownerLevel ? ["owner", "admin", "member"] : ["admin", "member"];
  reconcileReaderRows($("members-list"), members, m => m.personId, m => {
    const isSelf = person && m.personId === person.id;
    const isLastOwner = m.role === "owner" && members.filter((x) => x.role === "owner").length === 1;
    const canManage = !isSelf && !isLastOwner && ownerLevel;
    const select = canManage ? el("select", { "aria-label": `Role for ${m.name}`, dataset: { original: m.role } },
      ...assignable.map((r) => el("option", { value: r, selected: r === m.role || undefined }, ROLE_LABEL[r]))) : null;
    if (select) select.value = m.role;
    const saveBtn = select && el("button", { class: "btn btn-sm btn-ink", type: "button", onclick: async () => {
      invalidateVisibleReader("members");
      try {
        await api(`/v1/workspaces/${orgId}/members/${m.personId}`, { method: "PATCH", body: { role: select.value } });
        toast(`${m.name} is now ${ROLE_LABEL[select.value]}.`);
        select.dataset.original = select.value;
        refreshMembers();
      } catch (err) { toast(err.message); }
    } }, "Save");
    const removeBtn = (canManage || isSelf) && !isLastOwner ? el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: async () => {
      if (!confirm(isSelf ? "Leave this workspace?" : `Remove ${m.name} from this workspace?`)) return;
      invalidateVisibleReader("members");
      try {
        await api(`/v1/workspaces/${orgId}/members/${m.personId}`, { method: "DELETE" });
        toast(isSelf ? "You left the workspace." : `Removed ${m.name}.`);
        // Leaving doesn't end the session: re-run boot() so a person in other workspaces lands on
        // the picker (or straight into the one they have left) instead of being signed out entirely.
        if (isSelf) { clearTimeout(pollTimer); disconnectLiveWs(); boot(); }
        else refreshMembers();
      } catch (err) { toast(err.message); }
    } }, isSelf ? "Leave" : "Remove") : null;

    return el("div", { class: "member-row" },
      el("div", {},
        el("span", { class: "member-row-name" }, m.name),
        isSelf ? el("span", { class: "member-row-you" }, " (you)") : null),
      el("div", { class: "member-row-controls" },
        select ?? el("span", { class: "workspace-item-role" }, ROLE_LABEL[m.role] ?? m.role),
        saveBtn, removeBtn));
  });

  const canInvite = canCreateInvite();
  $("invite-form").hidden = !canInvite;
  // Admins can invite members/admins but never owners (the backend rejects it); only owner-level can.
  const inviteChoice = $("invite-role-select").value;
  const inviteRoles = ownerLevel ? ["member", "admin", "owner"] : ["member", "admin"];
  if ([...$("invite-role-select").options].map(o => o.value).join() !== inviteRoles.join()) $("invite-role-select").replaceChildren(
    ...(ownerLevel ? ["member", "admin", "owner"] : ["member", "admin"]).map((r) => el("option", { value: r, selected: r === "member" || undefined }, ROLE_LABEL[r])));
  if (inviteRoles.includes(inviteChoice)) $("invite-role-select").value = inviteChoice;
  reconcileReaderRows($("invites-list"), invites, inv => inv.id, inv => {
    const revoke = readerAdmin() ? el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: async () => {
      // A keyed button can survive navigation. Capture action ownership at invocation, but never
      // let a detached node regain authority when a later read returns the same invitation id.
      const ownsSource = membersActionOwner();
      const owns = () => revoke.isConnected && ownsSource()
        && readerState("members").data.invites.some(item => item.id === inv.id);
      if (!owns() || inviteRevokeFlights.get(inv.id)?.ownsSource()) return;
      const flight = { button: revoke, ownsSource };
      inviteRevokeFlights.set(inv.id, flight);
      revoke.disabled = true;
      invalidateVisibleReader("members");
      try {
        await api(`/v1/workspaces/${orgId}/invites/${inv.id}`, { method: "DELETE", owns });
        if (!owns()) return;
        toast("Invite revoked.");
        await refreshMembers();
      } catch (err) { if (owns()) toast(err.message); }
      finally {
        // A withdrawn action must not release the busy state of a newer action on a retained node.
        if (inviteRevokeFlights.get(inv.id) === flight) {
          inviteRevokeFlights.delete(inv.id);
          if (owns()) revoke.disabled = false;
        }
      }
    } }, "Revoke") : null;
    return el("div", { class: "invite-row" },
    el("div", {},
      el("span", {}, inv.email || "Invite link"), " ",
      // GET .../members returns workspace_invites rows straight from SQLite (snake_case); everywhere
      // else in this API is camelCase (e.g. the POST .../invites response). Read both until that's fixed.
      el("span", { class: "invite-row-meta" }, `${ROLE_LABEL[inv.role] ?? inv.role} · expires ${fromNow(inv.expiresAt ?? inv.expires_at)}`)),
    revoke ? el("div", { class: "invite-row-controls" }, revoke) : null);
  });
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ownsSource = membersActionOwner();
  if (!canCreateInvite() || !ownsSource()) return;
  const ticket = ++inviteCreateTicket, orgId = workspaceId();
  const owns = () => ticket === inviteCreateTicket && canCreateInvite() && ownsSource();
  const role = $("invite-role-select").value;
  const email = $("invite-email-input").value.trim() || undefined;
  const resultEl = $("invite-link-result");
  clearInviteResult();
  invalidateVisibleReader("members");
  try {
    const { url } = await api(`/v1/workspaces/${orgId}/invites`, { method: "POST", body: { role, email }, owns });
    if (!owns()) return;
    resultEl.hidden = false;
    resultEl.replaceChildren(
      "Invite link: ",
      el("code", {}, url),
      " ",
      el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: async () => {
        if (!owns()) return;
        try { await navigator.clipboard.writeText(url); if (owns()) toast("Copied invite link."); }
        catch { if (owns()) toast("Copy failed. Select the text instead."); }
      } }, "Copy"));
    $("invite-email-input").value = "";
    refreshMembers();
  } catch (err) {
    if (owns()) toast(err.message);
  }
});

$("webhook-url")?.addEventListener("input", () => { webhookEdited = true; });
$("webhook-auth")?.addEventListener("input", () => { webhookEdited = true; });

$("settings-copy-org-id")?.addEventListener("click", async () => {
  if (!me?.orgId) return;
  try {
    await navigator.clipboard.writeText(me.orgId);
    toast("Copied Organization ID.");
  } catch {
    toast("Copy failed. Select the text instead.");
  }
});

$("settings-copy-hub-url")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(hubBase());
    toast("Copied Hub URL.");
  } catch {
    toast("Copy failed. Select the text instead.");
  }
});

$("webhook-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("webhook-url").value.trim() || null;
  const authHeader = $("webhook-auth").value.trim() || null;
  const statusEl = $("webhook-status");
  try {
    await api("/v1/webhook", { method: "POST", body: { url, authHeader } });
    webhookEdited = false;
    if (statusEl) {
      statusEl.className = "status-msg status-success";
      statusEl.textContent = url ? "Webhook endpoint saved successfully." : "Webhook cleared.";
      statusEl.hidden = false;
    }
    toast(url ? "Webhook saved." : "Webhook cleared.");
    refresh();
  } catch (err) {
    if (statusEl) {
      statusEl.className = "status-msg status-error";
      statusEl.textContent = `Failed to save webhook: ${err.message}`;
      statusEl.hidden = false;
    }
  }
});

$("webhook-clear-btn")?.addEventListener("click", async () => {
  const statusEl = $("webhook-status");
  try {
    await api("/v1/webhook", { method: "POST", body: { url: null } });
    $("webhook-url").value = "";
    $("webhook-auth").value = "";
    webhookEdited = false;
    if (statusEl) {
      statusEl.className = "status-msg status-success";
      statusEl.textContent = "Webhook cleared.";
      statusEl.hidden = false;
    }
    toast("Webhook cleared.");
    refresh();
  } catch (err) {
    if (statusEl) {
      statusEl.className = "status-msg status-error";
      statusEl.textContent = `Failed to clear webhook: ${err.message}`;
      statusEl.hidden = false;
    }
  }
});

// ---------- phone notifications (Web Push, R4) ----------
// A person's browser subscribes once (POST /v1/push/devices); the hub encrypts every push end to
// end to that device (src/web-push.ts) and the console's service worker (sw.js) shows it and opens
// the deep link below on tap. This section only turns it on/off and lists devices.

function urlBase64ToUint8Array(base64) {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/app/sw.js");
  } catch {
    return null;
  }
}

async function currentPushSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/app/");
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

async function refreshPushCard(options = {}) {
  const card = $("push-card");
  if (!card) return;
  return runVisibleReader("push", async (read, scope) => {
    const data = await read("/v1/push/devices", { session: true, workspace: null });
    const subscription = data.enabled ? await scope.wait(currentPushSubscription()) : null;
    return { data, subscribed: Boolean(subscription) };
  }, ({ data, subscribed }) => {
  if (!data.enabled) {
    card.hidden = true;
    $("push-devices-list").replaceChildren();
    layoutSettingsGrid();
    return;
  }
  card.hidden = false;
  layoutSettingsGrid();
  $("push-enable-btn").hidden = subscribed;
  $("push-devices").hidden = data.devices.length === 0;
  reconcileReaderRows($("push-devices-list"), data.devices, d => d.endpoint, pushDeviceRow);
  }, options);
}

function pushDeviceRow(d) {
  const meta = [d.deviceLabel || d.service, `added ${ago(d.createdAt)}`];
  if (d.lastSuccessAt) meta.push(`last notified ${ago(d.lastSuccessAt)}`);
  if (d.failing) meta.push("not delivering");
  return el("div", { class: `push-device-row${d.failing ? " push-device-row-failing" : ""}` },
    el("span", { class: "push-device-meta" }, meta.join(" · ")),
    el("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => removePushDevice(d.endpoint) }, "Remove"));
}

async function removePushDevice(endpoint) {
  invalidateVisibleReader("push");
  try {
    await api("/v1/push/devices", { method: "DELETE", body: { endpoint }, session: true });
    toast("Device removed.");
    refreshPushCard();
  } catch (err) {
    toast(`Couldn't remove device: ${err.message}`);
  }
}

// A rough, friendly label; the endpoint's own host (shown as `service`) already identifies the push
// service, so this is just enough to tell two phones on the list apart.
function guessDeviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return [browser, os].filter(Boolean).join(" on ");
}

$("push-enable-btn")?.addEventListener("click", async () => {
  const statusEl = $("push-status");
  statusEl.hidden = true;
  if (!("PushManager" in window) || !("Notification" in window)) {
    statusEl.className = "status-msg status-error";
    statusEl.textContent = "This browser doesn't support push notifications.";
    statusEl.hidden = false;
    return;
  }
  try {
    const reg = await registerServiceWorker();
    if (!reg) throw new Error("Couldn't register the service worker.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const { publicKey } = await api("/v1/push/devices", { session: true });
    if (!publicKey) throw new Error("Phone notifications aren't set up on this hub yet.");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const json = sub.toJSON();
    await api("/v1/push/devices", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys, deviceLabel: guessDeviceLabel() }, session: true });
    toast("Phone notifications turned on. Your lock screen will show the command.");
    refreshPushCard();
  } catch (err) {
    statusEl.className = "status-msg status-error";
    statusEl.textContent = err.message || "Couldn't turn on notifications.";
    statusEl.hidden = false;
  }
});

$("push-test-btn")?.addEventListener("click", async () => {
  const statusEl = $("push-status");
  statusEl.hidden = true;
  try {
    const outcome = await api("/v1/push/test", { method: "POST", session: true });
    statusEl.className = "status-msg status-success";
    statusEl.textContent = outcome.sent ? "Test sent. Check your device." : "No device could be reached. Try turning notifications on again.";
    statusEl.hidden = false;
  } catch (err) {
    statusEl.className = "status-msg status-error";
    statusEl.textContent = err.message;
    statusEl.hidden = false;
  }
});

/** Called from signOut(), before the session that owns it is invalidated: a shared computer must
 * stop getting the previous person's notifications. Never blocks or fails sign-out. */
async function removeThisDevicePush(workspace) {
  try {
    const sub = await currentPushSubscription();
    if (sub) await api("/v1/push/devices", { method: "DELETE", body: { endpoint: sub.endpoint }, session: true, workspace, owns: () => true }).catch(() => {});
  } catch { /* best effort */ }
}

// ---------- focused approval (phone notification deep link) ----------
// /app/?workspace=<orgId>#approval-<id> opens straight to one approval card instead of the console,
// so tapping a phone notification goes straight to a decision. enterConsole() shows this once the
// normal console underneath is live, so it decides through the same api()/refresh() as everything else.
function approvalDeepLink() {
  const workspaceId = new URLSearchParams(location.search).get("workspace");
  const match = location.hash.match(/^#approval-(.+)$/);
  return workspaceId && match ? { workspaceId, approvalId: decodeURIComponent(match[1]) } : null;
}

// Only the latest showFocusedApproval() may paint: an older one's answer, or its failure, arriving after a newer one began
// (or after the card was closed) is dropped. `owns` lets the caller withdraw too (a notification that a newer one replaced).
let focusedApprovalSeq = 0;
let focusedApprovalSubject = null;

function closeFocusedApproval() {
  focusedApprovalSeq++;
  focusedApprovalSubject = null;
  const overlay = $("focused-approval-overlay");
  overlay.hidden = true;
  overlay.replaceChildren();
  history.replaceState(null, "", "/app/");
}

async function showFocusedApproval(approvalId, owns = () => true) {
  if (!owns()) return; // withdrawn before it began: it does not even paint "Loading"
  const seq = ++focusedApprovalSeq;
  const current = () => seq === focusedApprovalSeq && owns();
  const subject = { id: approvalId, current, notPending: false };
  focusedApprovalSubject = subject;
  const overlay = $("focused-approval-overlay");
  overlay.hidden = false;
  overlay.replaceChildren(el("div", { class: "focused-approval-card" }, el("p", { class: "muted" }, "Loading…")));
  let approval;
  try {
    ({ approval } = await api(`/v1/approvals/${encodeURIComponent(approvalId)}`));
  } catch (err) {
    if (!current()) return;
    // The route's own 404 message ("No approval request found matching ...") is already clear and
    // specific -- no need to guess at "expired vs. wrong workspace" ourselves.
    overlay.replaceChildren(focusedApprovalMessage("Couldn't open this approval.", err.message));
    return;
  }
  if (!current()) return;
  if (subject.notPending && approval.status === "pending") return; // an older single-record read cannot revive this card
  if (approval.status !== "pending") {
    const who = decidedBy(approval) ? ` by ${decidedBy(approval)}` : "";
    overlay.replaceChildren(focusedApprovalMessage(`Already ${approval.status}${who}.`, approval.decision_note || null));
    return;
  }
  overlay.replaceChildren(focusedApprovalCard(approval));
}

function focusedApprovalMessage(title, detail) {
  return el("div", { class: "focused-approval-card" },
    el("h2", {}, title),
    detail ? el("p", { class: "muted" }, detail) : null,
    el("button", { class: "btn btn-ink", type: "button", onclick: closeFocusedApproval }, "Go to console"));
}

// decide() (clearances, above) removes `node` from the DOM only when the decision actually went
// through; if it's still attached afterwards, decide() hit an error (already toasted) and the card
// should stay up so the person can see it and retry, rather than silently bouncing to the console.
async function decideAndClose(a, node, decision, grantMinutes) {
  const seq = focusedApprovalSeq; // the card this decision belongs to
  const succeeded = await decide(a, node, decision, grantMinutes);
  // Closes only its own card: a newer notification's card that replaced it meanwhile is not this decision's to close.
  if (succeeded && seq === focusedApprovalSeq) closeFocusedApproval();
}

function focusedApprovalCard(a) {
  const vendor = vendorOfAgent(a.requested_by_agent_id);
  let scope = null;
  const hold = holdButton(() => decideAndClose(a, node, "approve", scope ? scope.minutes() : 0), { label: "Hold to approve once" });
  scope = a.category ? approvalScopeControl(a, hold) : null;

  const node = el("article", { class: "focused-approval-card", dataset: { vendor, vendorAgentId: a.requested_by_agent_id ?? "" } },
    el("button", { class: "btn btn-quiet btn-sm focused-approval-close", type: "button", onclick: closeFocusedApproval }, "Console →"),
    el("span", { class: "vendor-tag" }, vendorLogo(vendor), `${vendorLabel(vendor)} · ${a.category ?? "request"}`),
    el("p", { class: "callsign" }, a.requested_by_agent_name),
    el("span", { class: `risk risk-${a.risk}` }, riskLabel(a.risk)),
    el("pre", { class: "command" }, a.action),
    a.details ? el(typeof a.details === "object" ? "pre" : "p", { class: "strip-body" }, typeof a.details === "object" ? JSON.stringify(a.details, null, 2) : a.details) : null,
    el("div", { class: "strip-meta" }, el("span", {}, `asked ${ago(a.created_at)}`), el("span", {}, until(a.expires_at))),
    el("div", { class: "focused-approval-decide" },
      scope?.node,
      el("button", { class: "btn btn-halt", type: "button", onclick: () => decideAndClose(a, node, "deny") }, "Deny"),
      hold));
  return node;
}

// ---------- a notification tap on a window that is already open ----------
// The service worker (sw.js) never opens a second console window while one exists: it focuses the best one and posts
// { type: "opencadre:open", url } here. The url is the notification's own deep link, /app/?workspace=<orgId>#approval-<id>,
// and reaches the same places boot() sends it: the approval card for the workspace on screen, enterWorkspace(ws,
// { approvalId }) for another workspace this person belongs to. Only the workspace and approval id are read from it.
// Nobody signed in, or a sign-out still pending (the quarantine), means nothing happens beyond the focus the worker gave:
// a notification never signs anyone in or opens a workspace with a cookie that is being retired.
const DEEP_LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** {workspaceId, approvalId} from a notification's deep link, or null for anything else. The worker already checked the url,
 * and this checks it again: exactly /app/ on this origin, no credentials, one `workspace` parameter and nothing else in
 * the query, a fragment that is exactly #approval-<id>. Nothing but those two ids is used, so no other field, route or
 * origin can steer the console. */
function notificationTarget(raw) {
  if (typeof raw !== "string") return null;
  let url;
  try { url = new URL(raw, location.origin); } catch { return null; }
  if (url.origin !== location.origin || url.pathname !== "/app/" || url.username || url.password) return null;
  const params = [...url.searchParams.keys()];
  if (params.length !== 1 || params[0] !== "workspace" || url.searchParams.getAll("workspace").length !== 1) return null;
  const match = url.hash.match(/^#approval-(.+)$/);
  let approvalId = null;
  try { approvalId = match ? decodeURIComponent(match[1]) : null; } catch { return null; }
  const workspaceId = url.searchParams.get("workspace");
  return DEEP_LINK_ID.test(workspaceId ?? "") && DEEP_LINK_ID.test(approvalId ?? "") ? { workspaceId, approvalId } : null;
}

// Latest click wins. The acknowledgement only says a listener exists, so several notifications can be in flight at once;
// each takes the next token, and only the one holding the latest may enter a workspace, paint an approval or show a failure.
let notificationToken = 0;

async function openNotificationTarget(target) {
  const mine = ++notificationToken;
  const wanted = () => mine === notificationToken;
  if (readQuarantine()) return;
  const consoleShowing = !$("console").hidden;
  // An accepted member identity is needed for this card; a staged session still has its authenticated person below.
  if (consoleShowing && me?.orgId === target.workspaceId && (currentWorkspace ?? me.orgId) === target.workspaceId) {
    // An entry begun meanwhile (a new identity ticket) also withdraws this card, as a newer notification does.
    const entryTicket = identityTicket;
    showFocusedApproval(target.approvalId, () => wanted() && entryTicket === identityTicket);
    return;
  }
  // Another workspace needs the cookie's person: on screen in a session console, or at the workspace picker.
  const cookiePerson = person && (consoleShowing ? authMode === "session" : !$("workspace-picker").hidden);
  if (!cookiePerson) return;
  const ticket = identityTicket; // a sign-in or workspace entry started meanwhile wins over this one
  let identity;
  try { identity = await api("/v1/auth/me", { session: true, owns: ownedBy(ticket) }); } catch { return; }
  if (ticket !== identityTicket || !wanted() || readQuarantine()) return;
  if (!identity.workspaces?.some((w) => w.orgId === target.workspaceId)) return;
  await enterWorkspace(target.workspaceId, { approvalId: target.approvalId, wanted }).catch((err) => {
    if (!wanted()) return; // a newer notification replaced this one: its failure is nothing to show
    if (err instanceof AuthError && readSignedOut()?.pending) return leaveSignedOutElsewhere();
    toast(err.message);
  });
}

function onServiceWorkerMessage(event) {
  const data = event?.data;
  if (data?.type !== "opencadre:open") return;
  // The worker waits for this to know the page has a listener; without it, it would reload the page onto the link.
  try { event.ports?.[0]?.postMessage("ack"); } catch { /* the worker falls back on its own */ }
  const target = notificationTarget(data.url);
  if (target) openNotificationTarget(target).catch(() => {});
}

if (typeof navigator.serviceWorker?.addEventListener === "function") {
  navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
}

// ---------- boot ----------
boot();


// ---------- plan & usage (docs/design/CONSOLE-V2.md §5) ----------
// Everything here comes from the hub: /v1/me's `billing` (plan name, read-only state, trial clock, limits) and the
// counts the enforced limits are measured against. A limit of null is unlimited. The console only reads this object;
// it never sells or changes a plan.
const USAGE_ROWS = [
  // The limit counts every live agent (countLiveAgents) but the console sees only this viewer's roster, so that row has
  // no gauge (complete: false; 049a, 2026-10-01). Computers and projects are read workspace-wide.
  { key: "agents", label: "Live agents", limit: "maxAgents", perSeat: true, complete: false, noun: "live agents", counted: (n) => `${n} online that you can see` },
  { key: "computers", label: "Computers", limit: "maxMachines", perSeat: true, complete: true, noun: "computers", counted: (n) => `${n} connected` },
  { key: "projects", label: "Projects", limit: "maxProjects", complete: true, noun: "projects", counted: (n) => `${n} turned on` },
];
/** What the workspace may use of one limit. Per-seat limits (machines, live agents) are pooled across the seats the
 * hub enforces (billing.seats, src/billing.ts enforcedSeats), so a workspace with 10 seats shows ten seats' worth,
 * exactly as the hub allows. A hub without the field counts one seat. Null stays unlimited. */
function allowanceOf(b, limit, perSeat) {
  const stored = b?.limits?.[limit] ?? null;
  if (stored === null) return null;
  return perSeat ? stored * Math.max(1, Math.floor(Number(b?.seats) || 1)) : stored;
}
const daysUntil = (iso) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
const onTrial = (b) => b?.limits?.trialDays != null && Boolean(b?.trialEndsAt);
/** "6 Oct", in UTC like every date the hub sends. */
const shortDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The plan in one line: its name and the one fact about its state that matters now. */
function planLine(b) {
  if (!b) return "—";
  if (b.awaitingPlan) return "No plan yet";
  if (b.readOnly) return `${b.planName} · read-only because ${b.reason}`;
  if (b.graceEndsAt) return `${b.planName} · grace period until ${b.graceEndsAt.slice(0, 10)}, everything keeps working`;
  if (onTrial(b)) {
    const days = daysUntil(b.trialEndsAt);
    return `${b.planName} · ${days <= 0 ? "ends today" : days === 1 ? "1 day left" : `${days} days left`}`;
  }
  return b.planName;
}

function renderBilling({ agents, devices, projects, forbidden } = {}) {
  const b = me?.billing;
  const card = $("billing-card");
  if (!card) return;
  $("billing-plan").textContent = planLine(b);
  // Before a plan there are no limits to measure against (every one is 0 by design), so there are no meters: a row of
  // "1 of 0" in red read as something broken on a new owner's first screen.
  const usage = $("billing-usage");
  usage.hidden = Boolean(b?.awaitingPlan);
  $("billing-usage-note").hidden = usage.hidden;
  // Home's rows (planRows); a limit of 0 is "not included", not full.
  usage.replaceChildren(...(b?.awaitingPlan ? [] : [...planRows(b, planUsage({ agents, devices, projects, forbidden })).flatMap((r) => [
    el("dt", {}, r.label),
    el("dd", { class: r.level ? `is-${r.level}` : "" },
      el("span", { class: "usage-count" }, r.gauge ? `${r.used} of ${r.max}` : [r.limitText, r.note].filter(Boolean).join(" · ")),
      r.gauge ? el("span", { class: `usage-meter${r.level === "full" ? " is-full" : ""}`, role: "img", "aria-label": r.valueText }, meterFill(r.used / r.max)) : null),
  ]), el("dt", {}, "History kept"), el("dd", {}, b?.limits?.retentionDays ? `${b.limits.retentionDays} days` : "Unlimited")]));
  const note = $("billing-note");
  note.textContent = b?.plan === "internal" ? "Internal plan: no limits." : b?.awaitingPlan ? "This workspace has no plan, so its limits are 0 until one is assigned." : "";
  note.hidden = !note.textContent;
}

/** The hub's CSP forbids inline style attributes, so a meter's width is set through the DOM, which it allows. */
function meterFill(ratio) {
  const fill = el("span", { class: "usage-meter-fill" });
  fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  return fill;
}

/** One banner for the plan's state, most urgent first: no plan, read-only, then a refused action, a grace period, and
 * a trial in its last three days. Nothing shows while the plan is simply fine. States the limit; sells nothing. */
function renderBillingBanner() {
  const banner = $("billing-banner");
  if (!banner) return;
  renderHomeNext(); // the same state, on Home; kept in step here because the answer can arrive between polls
  const b = me?.billing;
  let title = null;
  let meta = "";
  let tone = "warn";
  if (b?.awaitingPlan) {
    // Not a lapse: nothing has started yet.
    tone = "setup";
    title = "No plan yet";
    meta = "This workspace has no plan, so its limits are 0 and no computer or agent can connect until one is assigned.";
  } else if (b?.readOnly) {
    title = "This workspace is read-only";
    meta = `Because ${b.reason}. Everything is kept and agents can still read.`;
    tone = "risk";
  } else if (planRefusal && Date.now() - planRefusal.at < 10 * 60_000) {
    // The hub says which: PLAN_LIMIT is a cap reached; TRIAL_EXPIRED is its code for any read-only refusal (a trial
    // ended or a subscription lapsed), which may arrive before this poll's billing does.
    const readOnly = planRefusal.code === "TRIAL_EXPIRED";
    title = readOnly ? "This workspace is read-only" : planRefusal.code === "PLAN_LIMIT" ? "Your plan's limit was reached" : "Your plan doesn't allow this";
    meta = planRefusal.message;
    if (readOnly) tone = "risk";
  } else if (b?.graceEndsAt) {
    title = "Grace period";
    meta = `Everything keeps working until ${b.graceEndsAt.slice(0, 10)}.`;
  } else if (onTrial(b) && daysUntil(b.trialEndsAt) <= 3) {
    const days = daysUntil(b.trialEndsAt);
    title = days <= 0 ? "Your trial ends today" : `Your trial ends in ${days} day${days === 1 ? "" : "s"}`;
    meta = "After it ends the workspace becomes read-only: everything is kept and agents can still read.";
  }
  if (!title) {
    banner.hidden = true;
    return;
  }
  banner.dataset.tone = tone;
  $("billing-banner-title").textContent = title;
  $("billing-banner-meta").textContent = meta;
  $("billing-banner-action").textContent = "View plan";
  banner.hidden = false;
}
$("billing-banner-action")?.addEventListener("click", () => selectTab("settings"));


// ---------- signup (docs/design/CONSOLE-V2.md S6/S7) ----------
// S7: in open signup the sign-in page is also where an account is created, so it says so. There is no waitlist (the
// operator removed it): a person with no workspace either creates one or is told to ask for an invite.
let signupMode = null;
function applySignupWording(mode, hasAccountSignIn = true) {
  signupMode = mode ?? null;
  // An account can only be created through a hosted sign-in method; an agent key can't make one. A hub in open mode
  // with no method configured must not invite a stranger to "continue with any option below" when the only option
  // below is a key they don't have.
  const open = mode === "open" && hasAccountSignIn;
  const title = $("signin-title");
  const lede = $("signin-lede");
  if (title) title.textContent = open ? "Sign in or create an account" : "Sign in";
  if (lede && open) lede.textContent = "New here? Continue with any option below and your workspace is ready in a minute.";
}


// ---------- settings sections (docs/design/CONSOLE-V2.md V8) ----------
// A short index over one column of sections. Each link has its own address (#/settings/billing) so a section can be
// linked to, and a link whose section this viewer can't see is hidden with it.
const SETTINGS_SECTIONS = { billing: "billing-card", workspace: "settings-org-card", people: "members-card", projects: "projects-card", safety: "policy-card", notifications: "webhook-card" };
function renderSettingsIndex() {
  let tabsChanged = false;
  for (const link of document.querySelectorAll("#settings-index [data-settings-section]")) {
    const target = $(link.dataset.settingsSection);
    const hide = !target || target.hidden;
    if (link.hidden !== hide) { link.hidden = hide; tabsChanged = true; }
  }
  // Tabs appearing or leaving move the open one (the first poll learns which pages this person sees), so it is brought
  // back into view then; a re-render with nothing new leaves the strip where the person scrolled it.
  if (tabsChanged) revealSettingsTab($("settings-index"), document.querySelector('#settings-index [aria-current="page"]'));
  else syncSettingsStripFade();
}
// On a phone the index is one row that scrolls sideways. The open page's tab is brought into view (the strip scrolls,
// never the page), and an edge fade (data-more, a mask in console-v2.css) shows on whichever side there is more.
function revealSettingsTab(strip, link) {
  if (!strip || !link || strip.scrollWidth <= strip.clientWidth) { syncSettingsStripFade(); return; }
  const gutter = parseFloat(getComputedStyle(strip).paddingRight) || 16;
  const left = link.offsetLeft;
  const right = left + link.offsetWidth;
  if (left - gutter < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - gutter);
  else if (right + gutter > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + gutter - strip.clientWidth;
  syncSettingsStripFade();
}
function syncSettingsStripFade() {
  const strip = $("settings-index");
  if (!strip) return;
  const max = strip.scrollWidth - strip.clientWidth;
  const more = max <= 1 ? "" : strip.scrollLeft <= 1 ? "end" : strip.scrollLeft >= max - 1 ? "start" : "both";
  // Scroll events fire many times a second: write only when the side with more changes.
  if (more === (strip.dataset.more ?? "")) return;
  if (more) strip.dataset.more = more; else delete strip.dataset.more;
}
$("settings-index")?.addEventListener("scroll", syncSettingsStripFade, { passive: true });
window.addEventListener("resize", syncSettingsStripFade);
// Settings is one PAGE per section (the operator: "each setting has their own page instead of being one continuous page"),
// at #/settings/<page>. Each page shows its own cards, title and description. The name scrollToSettingsSection is kept
// because every caller (the sidebar list, Find, deep links, the plan alert) means "take me to that setting".
const SETTINGS_PAGES = {
  billing: { title: "Plan & usage", cards: ["billing-card"] },
  workspace: { title: "Workspace", cards: ["settings-org-card"] },
  people: { title: "People", cards: ["members-card"] },
  projects: { title: "Projects", cards: ["projects-card"] },
  safety: { title: "Safety", cards: ["policy-card", "killswitch-card"] },
  notifications: { title: "Notifications", cards: ["webhook-card", "push-card"] },
};
let settingsPage = "billing";
const settingsPageAvailable = (key) => SETTINGS_PAGES[key]?.cards.some((id) => $(id) && !$(id).hidden);
// `reveal` brings the open page's tab into view in the phone strip even when the page did not change: selectTab passes it
// when Settings opens (display:none reset the strip's scroll). A re-render on the same page (renderSettings, every poll)
// leaves the strip where the person scrolled it.
function scrollToSettingsSection(key, { record = true, reveal = false, refreshReaders = true } = {}) {
  // A page this person can't see (People for a member) falls back to the first one they can.
  const page = settingsPageAvailable(key) ? key : Object.keys(SETTINGS_PAGES).find(settingsPageAvailable) ?? "billing";
  const changed = page !== settingsPage;
  settingsPage = page;
  const panel = document.querySelector('.panel[data-panel="settings"]');
  if (panel) panel.dataset.settingsPage = page;
  for (const [k, def] of Object.entries(SETTINGS_PAGES)) {
    for (const id of def.cards) {
      const card = $(id);
      if (!card) continue;
      card.classList.toggle("is-current", k === page);
      const heading = card.querySelector(":scope > h3");
      card.classList.toggle("title-is-page", Boolean(heading) && heading.textContent.trim() === def.title);
    }
  }
  const title = $("h-settings");
  if (title) title.textContent = SETTINGS_PAGES[page].title;
  for (const link of document.querySelectorAll("#settings-index [data-settings-section], #settings-subnav [data-settings-section]")) {
    if (link.dataset.settingsSection === SETTINGS_SECTIONS[page]) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  if (changed || reveal) revealSettingsTab($("settings-index"), document.querySelector(`#settings-index [data-settings-section="${SETTINGS_SECTIONS[page]}"]`));
  else syncSettingsStripFade();
  // A page is an address: a new page is a new history entry, so Back returns to the previous setting.
  if (record && location.hash !== `#/settings/${page}`) history.pushState(null, "", `#/settings/${page}`);
  // Entering Settings (a bare #/settings, or a page this person can't see) names the page it opened in place, so a
  // reload or a copied link returns here, and Back still leaves Settings in one step (f46c on 6adf9f3).
  else if (!record && /^#\/settings(\/|$)/.test(location.hash) && location.hash !== `#/settings/${page}`) history.replaceState(null, "", `#/settings/${page}`);
  if (changed && record) window.scrollTo?.(0, 0);
  if (changed) {
    withdrawHiddenReaderFlights();
    if (activeTab === "settings" && isSignedIn() && refreshReaders) refresh();
  }
}
for (const link of document.querySelectorAll("#settings-index [data-settings-section]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const key = Object.keys(SETTINGS_SECTIONS).find((k) => SETTINGS_SECTIONS[k] === link.dataset.settingsSection);
    if (key) scrollToSettingsSection(key);
  });
}
/** A link to one setting from another view ("Settings → Projects" on Add a computer). The address is set first, so
 * selectTab keeps it and opens Settings on that page: one history entry, and a copied link lands on the same page. */
function openSettingsPage(key) {
  if (location.hash !== `#/settings/${key}`) history.pushState(null, "", `#/settings/${key}`);
  selectTab("settings");
}
for (const link of document.querySelectorAll("a[data-settings-link]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openSettingsPage(link.dataset.settingsLink);
  });
}


// ---------- Add a computer: the plan's computer limit, where a computer is added ----------
// A computer counts toward the plan's machine limit (the hub refuses the one past it), so the page that adds one says
// where the workspace stands, with the same count Plan & usage uses: computers that have connected.
function renderConnectPlanNote(devices) {
  const note = $("connect-plan-note");
  if (!note) return;
  const max = allowanceOf(me?.billing, "maxMachines", true);
  if (max === null || !devices) {
    note.hidden = true;
    return;
  }
  const used = devices.filter((d) => d.status === "connected").length;
  note.textContent = used >= max
    ? `Your plan allows ${max} computer${max === 1 ? "" : "s"}, and all of them are in use. Remove one on the Agents page.`
    : `${used} of ${max} computers on your plan are in use.`;
  note.classList.toggle("is-full", used >= max);
  note.hidden = false;
}


// ---------- file locks (F4: GET /v1/resources) ----------
// A lock is an agent's claim on a file (or any resource key) while it edits, with a lease that runs out on its own.
// Shown so a person can see why an agent is waiting, or who is sitting on a file. Read-only here: releasing is the
// holder's call (the hub lets only the holder release), and a stale claim expires by itself.
let fileLocksRequest = 0;
let fileLocksFlight = null;
let fileLocksSource = newSource();
function cancelFileLocks() {
  fileLocksRequest++;
  fileLocksFlight?.scope.cancel();
  fileLocksFlight = null;
  fileLocksSource = newSource();
}
async function refreshFileLocks() {
  if (!isSignedIn() || activeTab !== "fleet" || !me) return;
  if (fileLocksFlight?.generation === consoleGeneration) { fileLocksFlight.queued = true; return fileLocksFlight.promise; }
  const flight = { generation: consoleGeneration, queued: false, scope: null, promise: null };
  fileLocksFlight = flight;
  flight.promise = (async () => {
    do {
      flight.queued = false;
      const request = ++fileLocksRequest;
      const scope = flight.scope = createRefreshReadScope({ settleOnCancel: true });
      const owns = () => flight.generation === consoleGeneration && request === fileLocksRequest && activeTab === "fleet";
      try {
        const data = await scope.wait(api("/v1/resources", { refreshReadScope: scope, owns }));
        if (!owns() || scope.disposed || scope.timedOut) break;
        const receivedAt = Date.now();
        renderFileLocks(data.locks ?? []);
        fileLocksSource = { status: "ok", data, receivedAt, lastOkAt: Date.now() };
      } catch (err) {
        if (!owns() || err instanceof RefreshReadCancelledError) break;
        fileLocksSource = applySource(fileLocksSource, { ok: false, kind: err?.status === 403 ? "forbidden" : "failed" });
        if (fileLocksSource.status === "forbidden") renderFileLocks(null);
        else {
          const section = $("fleet-locks");
          section.hidden = false;
          $("fleet-locks-summary").textContent = fileLocksSource.lastOkAt ? "Couldn't refresh · showing locks from " + clockTime(fileLocksSource.lastOkAt) : "Couldn't load file locks";
        }
      } finally { scope.dispose(); }
    } while (flight.queued && flight.generation === consoleGeneration && activeTab === "fleet");
  })().finally(() => { if (fileLocksFlight === flight) fileLocksFlight = null; });
  return flight.promise;
}
function renderFileLocks(locks) {
  const section = $("fleet-locks");
  if (!section) return;
  section.hidden = !locks || locks.length === 0;
  if (!locks || locks.length === 0) {
    $("fleet-locks-list")?.replaceChildren();
    const summary = $("fleet-locks-summary");
    if (summary) summary.textContent = "";
    return;
  }
  // The hub keeps a lapsed claim on the list (it explains a takeover), but it is not held: the live fleet showed a
  // claim that ran out 4 days ago as "held" and "expiring". Held ones first; lapsed ones say so, dimmed.
  const lapsed = (l) => { const t = parseTime(l.lease_expires_at); return Boolean(t) && t.getTime() <= Date.now(); };
  const held = locks.filter((l) => !lapsed(l));
  const gone = locks.filter(lapsed);
  $("fleet-locks-summary").textContent = [held.length ? `${held.length} held` : "none held", gone.length ? `${gone.length} lapsed` : ""].filter(Boolean).join(" · ");
  $("fleet-locks-list").replaceChildren(...[...held, ...gone].map((l) => el("article", { class: `strip row-lock${lapsed(l) ? " is-lapsed" : ""}`, dataset: { vendor: vendorOfAgent(l.holder_agent_id) } },
    el("code", { class: "row-command", title: l.resource_key }, l.resource_key),
    el("p", { class: "row-main", title: l.note ?? "" }, l.note ? plainText(l.note) : "No note"),
    el("span", { class: "row-who" }, vendorLogo(vendorOfAgent(l.holder_agent_id)), `${l.holder_agent_name} · since ${ago(l.acquired_at)}`),
    el("span", { class: "row-seen" }, lapsed(l) ? `lapsed ${ago(l.lease_expires_at)}` : leaseLeft(l.lease_expires_at)))));
}
function leaseLeft(expiresAt) {
  const t = parseTime(expiresAt);
  if (!t) return "";
  const min = Math.round((t.getTime() - Date.now()) / 60_000);
  return min <= 0 ? "expiring" : min < 60 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}


// ---------- sidebar v3: workspace switcher, Find, plan alert, account menu, theme, Settings list ----------
const initial = (text) => (String(text ?? "").trim().match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();

/** The workspace at the top and the person at the bottom, refreshed with everything else. */
function renderSidebarIdentity() {
  $("ws-avatar").textContent = initial(me?.orgName);
  $("user-avatar").textContent = initial(person?.name || me?.agentName);
  $("whoami").textContent = person?.name || me?.agentName || "";
  $("user-menu-name").textContent = person?.name || me?.agentName || "";
  $("user-menu-email").textContent = person?.email || (authMode === "key" ? "Signed in with an agent key" : "");
  const b = me?.billing;
  const plan = $("ws-plan");
  const paused = Boolean(me?.workspace?.paused);
  plan.hidden = !b && !paused;
  // A workspace with no plan yet is read-only at the hub, but nothing has lapsed: it is the first step of setup, so it
  // reads as that, in the neutral tone. Red "Read-only" is for a plan that ended or a payment that failed.
  plan.textContent = paused ? "Paused" : b?.awaitingPlan ? "No plan yet" : b?.readOnly ? "Read-only" : b?.planName ?? "";
  plan.dataset.tone = paused || (b?.readOnly && !b?.awaitingPlan) ? "risk" : "plain";
}

// The switcher opens the workspace list for a person with more than one; with an agent key there is only one.
$("workspace-switcher-btn")?.addEventListener("click", async () => {
  if (authMode !== "session") return toast("Signed in with an agent key: this key belongs to one workspace.");
  try {
    renderWorkspacePicker(await api("/v1/auth/me", { key: "", session: true }));
  } catch (err) { toast(err.message); }
});

// The plan alert (Vercel's "Deployments paused" card): the same state as the billing banner, in the sidebar.
function renderSidebarAlert() {
  const card = $("sidebar-alert");
  const banner = $("billing-banner");
  if (!card || !banner) return;
  card.hidden = banner.hidden;
  if (banner.hidden) return;
  card.dataset.tone = banner.dataset.tone || "warn";
  $("sidebar-alert-title").textContent = $("billing-banner-title").textContent;
  $("sidebar-alert-meta").textContent = $("billing-banner-meta").textContent;
  $("sidebar-alert-action").textContent = $("billing-banner-action").textContent;
  $("sidebar-alert-action").hidden = $("billing-banner-action").hidden;
}
$("sidebar-alert-action")?.addEventListener("click", () => { selectTab("settings"); scrollToSettingsSection("billing"); });

// ---- Account menu ----
function setUserMenu(open) {
  $("user-menu").hidden = !open;
  $("user-menu-btn").setAttribute("aria-expanded", String(open));
  if (open) renderSidebarIdentity();
}
$("user-menu-btn")?.addEventListener("click", (e) => { e.stopPropagation(); setUserMenu($("user-menu").hidden); });
document.addEventListener("click", (e) => { if (!e.target.closest?.("#user-menu, #user-menu-btn")) setUserMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("user-menu").hidden) setUserMenu(false); });

// ---- Theme: System, Light or Dark ----
// Every dark rule in the console lives in an @media (prefers-color-scheme: dark) block. Rather than copy them all under
// a class, a choice rewrites those blocks' conditions through the CSS object model (which the hub's CSP allows):
// "all" forces dark, "not all" forces light, and the original condition follows the system again.
const THEME_KEY = "opencadre.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
// Once rewritten, a rule no longer names prefers-color-scheme, so every rule found is remembered for the next choice.
const knownDarkRules = new Set();
function darkRules() {
  const found = knownDarkRules;
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.media && rule.media.mediaText.includes("prefers-color-scheme: dark")) found.add(rule);
      else if (rule.styleSheet) { try { walk(rule.styleSheet.cssRules); } catch { /* another origin's sheet */ } }
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* another origin's sheet */ } }
  return found;
}
function applyTheme(choice) {
  const media = choice === "dark" ? "all" : choice === "light" ? "not all" : DARK_QUERY;
  for (const rule of darkRules()) {
    if (rule.media.mediaText !== media) { rule.media.mediaText = media; }
  }
  document.documentElement.style.colorScheme = choice === "system" ? "" : choice;
  document.documentElement.dataset.theme = choice;
  for (const btn of document.querySelectorAll("[data-theme-choice]")) btn.setAttribute("aria-checked", String(btn.dataset.themeChoice === choice));
}
function storedTheme() {
  try { return ["light", "dark"].includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : "system"; } catch { return "system"; }
}
for (const btn of document.querySelectorAll("[data-theme-choice]")) {
  btn.addEventListener("click", () => {
    const choice = btn.dataset.themeChoice;
    try { choice === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, choice); } catch { /* not remembered */ }
    applyTheme(choice);
  });
}
applyTheme(storedTheme());

// ---- Settings has its own list in the sidebar ----
function syncSidebarMode() {
  const inSettings = activeTab === "settings";
  $("tabs-nav").hidden = inSettings;
  $("settings-subnav").hidden = !inSettings;
  if (!inSettings) return;
  const section = location.hash.match(/^#\/settings\/([a-z]+)/)?.[1] ?? "billing";
  for (const link of document.querySelectorAll("#settings-subnav [data-settings-section]")) {
    const target = $(link.dataset.settingsSection);
    link.hidden = !target || target.hidden;
    const key = Object.keys(SETTINGS_SECTIONS).find((k) => SETTINGS_SECTIONS[k] === link.dataset.settingsSection);
    if (key === section) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
}
$("settings-back")?.addEventListener("click", () => selectTab("overview"));
for (const link of document.querySelectorAll("#settings-subnav [data-settings-section]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const key = Object.keys(SETTINGS_SECTIONS).find((k) => SETTINGS_SECTIONS[k] === link.dataset.settingsSection);
    if (key) { scrollToSettingsSection(key); syncSidebarMode(); }
  });
}

// ---- Find: jump to a page, a Settings section or an agent ----
function findEntries() {
  const pages = [["Home", "overview"], ["Inbox", "inbox"], ["Agents", "fleet"], ["Tasks", "tasks"], ["Activity", "timeline"], ["Add a computer", "connect"], ["Settings", "settings"]]
    .map(([label, tab]) => ({ label, hint: "Page", go: () => selectTab(tab) }));
  const sections = [["Plan & usage", "billing"], ["Workspace", "workspace"], ["People", "people"], ["Projects", "projects"], ["Approval policy", "safety"], ["Notifications", "notifications"]]
    .map(([label, key]) => ({ label, hint: "Settings", go: () => { selectTab("settings"); scrollToSettingsSection(key); } }));
  const agents = [...new Map([...lastFleetSessions.map((x) => [x.agentName, x]), ...[...fleetAgentById.values()].map((a) => [a.name, a])]).keys()]
    .filter(Boolean).map((name) => ({ label: name, hint: "Agent", go: () => { selectTab("fleet"); showAgentRow(name); } }));
  return [...pages, ...sections, ...agents];
}
function openFind() {
  if ($("find-dialog")) return;
  const input = el("input", { type: "search", placeholder: "Find…", "aria-label": "Find", autocomplete: "off" });
  const list = el("ul", { class: "find-list", role: "listbox", "aria-label": "Results", tabindex: "0" });
  let items = [];
  let index = 0;
  const close = () => dialog.remove();
  const choose = (item) => { close(); item?.go(); };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = findEntries().filter((e) => !q || e.label.toLowerCase().includes(q)).slice(0, 12);
    index = Math.min(index, Math.max(items.length - 1, 0));
    list.replaceChildren(...(items.length ? items.map((item, i) => {
      const li = el("li", { role: "option", "aria-selected": String(i === index), class: i === index ? "is-active" : "" }, el("span", {}, item.label), el("span", { class: "find-hint" }, item.hint));
      li.addEventListener("click", () => choose(item));
      return li;
    }) : [el("li", { class: "find-empty empty-state" }, emptyMark("pulse"), "No results")]));
  };
  input.addEventListener("input", () => { index = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(index + 1, items.length - 1); render(); list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(index - 1, 0); render(); list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[index]); }
    else if (e.key === "Escape") close();
  });
  const dialog = el("div", { id: "find-dialog", class: "find-backdrop", role: "dialog", "aria-modal": "true", "aria-label": "Find" },
    el("div", { class: "find-panel" }, input, list));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  document.body.append(dialog);
  render();
  input.focus();
}
$("find-btn")?.addEventListener("click", openFind);
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f" && !$("console")?.hidden) { e.preventDefault(); openFind(); }
});

// ---------- Add a computer: the computers already connected ----------
const CONNECT_STATUS = { connected: "Connected", waiting: "Waiting to connect", expired: "Code expired" };
/** One row per computer (not removed, not merged into another): its name, tools, state, open chats and last contact. */
function renderConnectComputers(devices, sessions) {
  const section = $("connect-computers");
  if (!section) return;
  const list = (devices ?? []).filter((d) => d.status !== "merged" && d.status !== "revoked");
  section.hidden = list.length === 0;
  $("connect-computers-list").replaceChildren(...list.map((d) => {
    const chats = (sessions ?? []).filter((s) => s.deviceId === d.deviceId && s.liveness !== "process").length;
    const tools = (d.tools ?? []).flatMap((t, i) => [i ? ", " : null, vendorLogo(vendorOfTool(t)), TOOL_LABEL[t] ?? t]);
    return el("div", { class: "strip computer-row", dataset: { status: d.status } },
      el("div", { class: "computer-row-primary" }, el("p", { class: "computer-row-name", title: d.name }, d.name), d.status === "connected" ? connectorBuildLabel(d) : null, d.status === "connected" ? connectorNotes(d) : null),
      el("p", { class: "computer-row-tools muted" }, tools.length ? tools : "No tools yet"),
      el("p", { class: "computer-row-status" }, el("span", { class: "status-dot", "aria-hidden": "true" }), CONNECT_STATUS[d.status] ?? d.status),
      el("p", { class: "computer-row-chats muted" }, chats === 1 ? "1 chat open" : `${chats} chats open`),
      el("p", { class: "computer-row-seen muted" }, d.lastSeenAt ? ago(d.lastSeenAt) : "never"));
  }));
}
$("connect-computers-manage")?.addEventListener("click", () => selectTab("fleet"));

// The phone has no sidebar: its More drawer carries Find and Sign out.
$("find-btn-mobile")?.addEventListener("click", () => { $("more-drawer-close")?.click(); openFind(); });
$("signout-mobile")?.addEventListener("click", () => $("signout").click());

// ---------- Add a computer: the three-step guide ----------
/** Marks the steps before `step` done, `step` current and the rest upcoming, and fills in what each finished step decided. */
function setWizardStep(step, name, device) {
  const order = ["name", "run", "chat"];
  const at = order.indexOf(step);
  order.forEach((id, i) => {
    const node = $(`wizard-step-${id}`);
    if (node) node.dataset.state = i < at ? "done" : i === at ? "current" : "upcoming";
  });
  if (name) {
    $("wizard-name-done").textContent = name;
  }
  $("add-computer-form").hidden = at > 0;
  $("wizard-name-done").hidden = at === 0;
  if (step === "chat") {
    const connectedTools = device?.tools ?? [];
    const tools = connectedTools.map((t) => TOOL_LABEL[t] ?? t);
    $("wizard-chat-hint").textContent = `${device?.name ?? "The computer"} connected. Only chats in a project you've enabled can join. Finish ${tools.length ? tools.join(" and ") : "your tool"}. A computer connection does not confirm hook trust or a working chat.`;
    const chip = $("computer-status-chip");
    if (chip && !String(chip.textContent).startsWith("Connected:")) { chip.hidden = false; chip.className = "status-chip chip-online"; chip.textContent = "Connected"; }
    for (const row of document.querySelectorAll("[data-connect-client]")) {
      row.hidden = connectedTools.length > 0 && !connectedTools.includes(row.dataset.connectClient);
    }
    $("wizard-go-agents").hidden = false;
    // Only chats in enabled projects join (src/devices.ts), so the success state points at where projects are turned on.
    // Settings → Projects is an operator's page (renderSettingsProjects); anyone else would land on a different setting.
    $("wizard-go-projects").hidden = me?.role !== "operator";
  }
}
$("wizard-name-done")?.addEventListener("click", () => {
  clearInterval(computerTimerInterval);
  clearInterval(computerStatusPollInterval);
  $("computer-output").hidden = true;
  $("computer-status-chip").hidden = true;
  $("wizard-go-agents").hidden = true;
  $("wizard-go-projects").hidden = true;
  setWizardStep("name");
  $("computer-name").focus();
});
$("wizard-go-agents")?.addEventListener("click", () => selectTab("fleet"));
// One string: the button copies exactly the check the step shows.
$("wizard-copy-check")?.addEventListener("click", () => navigator.clipboard?.writeText($("wizard-chat-check")?.querySelector("code")?.textContent ?? ""));
/** Two or more ARIA tabs, one shown at a time: one tab stop; arrows, Home and End move selection and focus. */
function wireTabs(tabs, onSelect) {
  const select = (selected) => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute("aria-controls")).hidden = !active;
    }
    onSelect?.(selected);
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(tabs[next]);
      tabs[next].focus();
    });
  }
  return select;
}
wireTabs([$("connect-mode-self"), $("connect-mode-agent")].filter(Boolean));

// ---------- Add a computer: connect an app (easy onboarding, Slice 4a) ----------
// One card per app: what it gets and its one way in. Approvals and wake come only from the hooks the connect command
// installs (cli/lib/session-hooks.mjs, device.mjs), so the cards share one link back to the computer guide; Grok Bot
// wakes through a routine webhook set on Agents (Slice 1). No key anywhere: each app signs in to OpenCadre itself.
// Sources, read 2026-10-31:
// - claude.ai prefill link: https://claude.com/docs/connectors/building/directory-vs-custom
// - VS Code: https://code.visualstudio.com/api/extension-guides/ai/mcp, "Create an MCP installation URL":
//   `vscode:mcp/install?${encodeURIComponent(JSON.stringify(obj))}`. The vscode.dev/redirect install form is not there
//   (that page names vscode.dev/redirect only as an OAuth redirect), so the documented scheme link is used.
// - Devin CLI: https://docs.devin.ai/cli/extensibility/mcp/configuration.md (`devin mcp add -s user <name> --url`,
//   `devin mcp login`). No Devin page says Devin Desktop ships the `devin` binary, so the card is the CLI. Its Approvals
//   badge is connect's Devin gate, run live against devin 3000.6.11 (docs/qa/HARNESS-MEASUREMENT.md §13).
// `agent` is not shown on the card: it is what /agents.md (src/site-agents.ts) tells an AI agent to do in that app, set
// above the card's command, config, link and steps. tests/site-agents.test.ts holds each app's section of the page to
// exactly this, so the page cannot tell an agent anything the cards don't.
function connectApps(mcpUrl) {
  const hooks = ["Tools", "Approvals"];
  const run = "Run these. The login waits until your person approves (step 2):";
  return [
    { id: "grok-bot", name: "Grok Bot", vendor: "grok", caps: ["Tools", "Wake"],
      agent: "This is the prompt the console gives your person to paste into you. Do what it says. If you can't add the connector yourself, ask your person to.",
      copy: ["prompt", `Add a custom MCP connector named OpenCadre with the URL ${mcpUrl}. It uses OAuth sign-in and needs no key. Start the sign-in so I can approve it, then list its tools to confirm it works. If sign-in fails, tell me the exact error.`],
      // The routine's URL and key go from its panel straight into OpenCadre (Agents, Wake), never through the chat.
      wake: "Create a routine with a webhook trigger that checks OpenCadre for new messages and tasks and acts on them. Don't show its URL or key in this chat; tell me where in the routine's panel to copy them. I'll paste the URL and 'Bearer <key>' into OpenCadre." },
    { id: "claude-ai", name: "claude.ai", vendor: "claude", caps: ["Tools"],
      agent: "You can't add it from a chat. Ask your person to open this link and add the connector:", link: ["Add to Claude", `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=OpenCadre&connectorUrl=${encodeURIComponent(mcpUrl)}`] },
    { id: "chatgpt", name: "ChatGPT", caps: ["Tools"], agent: "You can't add it from a chat. Ask your person to do these steps with this URL:", copy: ["URL", mcpUrl],
      steps: ["Plugins → + → Add custom MCP server.", "Name OpenCadre, paste the URL, choose OAuth.", "Accept the warning, then Create as a plugin.", "Approve in OpenCadre, then install the plugin and pick it with @ in a chat."] },
    // Some Cursor versions broke the deeplink, so the mcp.json waits behind it.
    { id: "cursor", name: "Cursor", vendor: "cursor", caps: hooks,
      agent: "Merge the first block into `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project), keeping the servers already there. Then ask your person to sign in to opencadre in Cursor's MCP settings. Or give your person the link in the second block instead.",
      link: ["Add to Cursor", `cursor://anysphere.cursor-deeplink/mcp/install?name=opencadre&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`],
      more: ["mcp.json", JSON.stringify({ mcpServers: { opencadre: { url: mcpUrl } } })] },
    { id: "claude-code", name: "Claude Code", vendor: "claude", caps: [...hooks, "Wake"], agent: run, copy: ["commands", `claude mcp add --transport http --scope user opencadre ${mcpUrl}\nclaude mcp login opencadre`] },
    { id: "codex", name: "Codex", vendor: "codex", caps: [...hooks, "Wake"], agent: run, copy: ["commands", `codex mcp add opencadre --url ${mcpUrl}\ncodex mcp login opencadre`] },
    { id: "vscode", name: "VS Code / Copilot", caps: ["Tools"], agent: "Ask your person to open this link in VS Code:", link: ["Add to VS Code", `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "opencadre", type: "http", url: mcpUrl }))}`] },
    { id: "gemini", name: "Gemini CLI", vendor: "gemini", caps: hooks,
      agent: "Run this, then ask your person to run `/mcp auth opencadre` in Gemini CLI to sign in:", copy: ["command", `gemini mcp add --transport http -s user opencadre ${mcpUrl}`] },
    { id: "devin", name: "Devin CLI", caps: hooks, agent: run, copy: ["commands", `devin mcp add -s user opencadre --url ${mcpUrl}\ndevin mcp login opencadre`] },
  ];
}
/** A command, config or prompt with its Copy button, named for its app. */
function copyBox(app, [what, text]) {
  return el("div", { class: "connect-cmd-box" },
    el("code", { class: "connect-cmd" }, text),
    el("button", { class: "btn btn-sm", type: "button", "aria-label": `Copy ${app.name} ${what}`, onclick: () => copyToClipboard(text, `${app.name} ${what}`) }, "Copy"));
}
/** The hub agents and apps connect to: /v1/me's hubUrl, which differs from this page's host in production (console on
 * app.opencadre.example, MCP on hub.opencadre.example; docs/ops/PRODUCTION.md). Only a bare origin, lower-cased: https, or http on
 * a loopback host (src/oauth.ts acceptableRedirectUri's rule); no user, path, query or fragment. Else null. */
function connectHub() {
  const value = typeof me?.hubUrl === "string" ? me.hubUrl.trim().toLowerCase().replace(/\/+$/, "") : "";
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(url.hostname);
    // A trailing dot names the same host to DNS but a different origin to a browser and to an OAuth resource check.
    if (url.origin === value && !url.hostname.endsWith(".") && (url.protocol === "https:" || (url.protocol === "http:" && loopback))) return value;
  } catch { /* not a URL */ }
  return null;
}
/** The hub for the manual snippets and Settings, which fall back to this page's origin. */
const hubBase = () => connectHub() ?? location.origin;
let connectAppsShown = null; // what the list shows: the hub its cards were built for, "loading" or "failed"
/** The persistent status line beside the list says why there are no cards, and the list stays empty; with cards up the
 * line is empty and hidden. Only its text changes, so a screen reader announces each change. */
function connectAppsStatus(state) {
  if (connectAppsShown === state) return;
  connectAppsShown = state;
  $("connect-apps")?.replaceChildren();
  const line = $("connect-apps-status");
  if (!line) return;
  line.hidden = false;
  line.replaceChildren(...(state === "loading" ? ["Loading…"] : ["Couldn't load. ", el("button", { class: "btn-link", type: "button", onclick: retryConnectApps }, "Try again")]));
  // A failed retry hands focus to the re-created Try again, and stops waiting for cards: a later background poll that
  // succeeds builds them without pulling focus.
  if (state === "failed" && connectAppsFocusOnBuild) {
    connectAppsFocusOnBuild = false;
    line.querySelector("button")?.focus();
  }
}
let connectAppsFocusOnBuild = false; // a retry asked for the cards, so focus goes to them when they arrive
/** Try again: through refresh(), which coalesces with polling and checks sign-in. */
function retryConnectApps() {
  connectAppsFocusOnBuild = true;
  connectAppsStatus("loading");
  void refresh();
}
/** The /v1/me read failed: say so, unless cards from an earlier read are already up. */
function connectAppsReadFailed() {
  if (connectAppsShown === null || connectAppsShown === "loading") connectAppsStatus("failed");
}
/** Built from /v1/me's hub only, never from this page's host: on production that is the console's host, so nothing
 * copyable is shown from it. Until the identity arrives the list says it is loading; with no usable hub it says it
 * could not load. */
function renderConnectApps() {
  if (!me) {
    if (connectAppsShown === null) connectAppsStatus("loading");
    return;
  }
  const hub = connectHub();
  if (!hub) return connectAppsStatus("failed");
  if (hub === connectAppsShown) return;
  connectAppsShown = hub;
  const line = $("connect-apps-status");
  if (line) {
    line.replaceChildren();
    line.hidden = true;
  }
  $("connect-apps")?.replaceChildren(...connectApps(`${hub}/mcp`).map((app) => el("li", { class: "app-card", dataset: { app: app.id } },
    el("div", { class: "app-card-head" },
      vendorLogo(app.vendor, { size: 18 }),
      el("h3", {}, app.name),
      el("ul", { class: "app-caps", "aria-label": `${app.name} gets` }, ...app.caps.map((cap) => el("li", {}, cap)))),
    app.link && (app.link[1].startsWith("https:")
      ? el("a", { class: "btn btn-ink btn-sm app-action", href: app.link[1], target: "_blank", rel: "noopener" }, app.link[0], el("span", { class: "visually-hidden" }, " (opens in a new tab)"))
      : el("a", { class: "btn btn-ink btn-sm app-action", href: app.link[1] }, app.link[0])),
    app.copy && copyBox(app, app.copy),
    app.steps && el("ol", { class: "connect-howto" }, ...app.steps.map((step) => el("li", {}, step))),
    app.more && el("details", { class: "app-more" }, el("summary", {}, app.more[0]), copyBox(app, app.more)),
    app.wake && el("details", { class: "app-more" }, el("summary", {}, "Set up wake"),
      copyBox(app, ["wake prompt", app.wake]),
      el("button", { class: "btn-link app-wake-agents", type: "button", onclick: () => { openUnlinkedAgents(); focusNewestWake(); } }, "Paste them in Agents")))));
  if (connectAppsFocusOnBuild) {
    connectAppsFocusOnBuild = false;
    $("connect-apps")?.querySelector(".app-card a[href], .app-card button, .app-card summary")?.focus();
  }
}
/** After "Paste them in Agents": the newest Grok Bot connection's Wake URL field, its form opened, or else the Agents
 * heading. Found by its OAuth client (the roster's client_name), never by its name, which the person chose at consent and
 * can change, so a routine's address never lands on another app's agent. Focus never stays on the now-hidden page. */
function focusNewestWake() {
  const newest = [...namedAgentSubjects.values()]
    .filter((a) => a.kind === "connector" && /^Grok Bot\b/i.test(a.client_name ?? "") && namedAgentRows.get(a.id)?.querySelector("[data-wake]"))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  const row = newest && namedAgentRows.get(newest.id);
  if (row) {
    const open = row.querySelector("[data-wake]");
    if (open.getAttribute("aria-expanded") !== "true") open.click();
    const field = row.querySelector('input[name="wake-url"]');
    if (field) {
      row.scrollIntoView?.({ block: "center" });
      field.focus();
      return;
    }
  }
  const heading = $("h-fleet");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
}
// Computer (the three-step guide) or App (the cards).
const connectKindTabs = [$("connect-kind-computer"), $("connect-kind-app")].filter(Boolean);
const selectConnectKind = wireTabs(connectKindTabs);
$("connect-apps-computer")?.addEventListener("click", () => { selectConnectKind(connectKindTabs[0]); $("computer-name")?.focus(); });
renderConnectApps();

/** Find an agent: on Agents, scroll to its row and mark it for a moment (f46c: the result only opened the page). */
function showAgentRow(name) {
  const row = [...document.querySelectorAll('[data-panel="fleet"] .callsign')].find((c) => c.textContent === name)?.closest(".strip");
  if (!row) return;
  row.scrollIntoView?.({ block: "center" });
  row.classList.add("is-found");
  setTimeout(() => row.classList.remove("is-found"), 2000);
}

/** A code that can no longer be used (expired, or its computer removed): step 2 stays current and says why, with a way
 * to get a new one. Before this, the message went to step 3's status chip, which an upcoming step hides, while step 2
 * hid the spent command, so nothing on screen explained what happened (Codex-OpenCadre-f46c on 60948ee). */
function showConnectDead(message) {
  setWizardStep("run");
  $("wizard-dead-text").textContent = message;
  $("wizard-dead").hidden = false;
  $("computer-status-chip").hidden = true;
}
$("wizard-dead-retry")?.addEventListener("click", () => {
  $("wizard-dead").hidden = true;
  $("computer-output").hidden = true;
  setWizardStep("name");
  $("computer-name").focus(); // the name is still filled in: one click on "Get a connect code" tries again
});

// ---------- Settings › Projects: keep projects apart, and linked projects (F5) ----------
// GET/PUT /v1/org/project-isolation and GET/POST/DELETE /v1/org/project-links (src/project-isolation.ts), both
// admin-only on the hub. Switching on is refused (409, with a pre-flight report) while one repository is in use under
// more than one project key, because that would cut one fleet in two.
let isolationState = null;
let isolationGen = 0;
let projectLinks = [];
async function refreshIsolation(options = {}) {
  const section = $("isolation-section");
  if (!section) return;
  if (!readerAdmin()) { section.hidden = true; return; }
  return runVisibleReader("isolation", read => Promise.all([read("/v1/org/project-isolation"), read("/v1/org/project-links")]), ([state, links]) => {
    isolationState = state;
    projectLinks = links.links ?? [];
    section.hidden = false;
    renderIsolation();
  }, options);
}

function renderIsolation() {
  const on = Boolean(isolationState?.enabled);
  if (!$("isolation-toggle").disabled) $("isolation-toggle").checked = on;
  $("isolation-status").textContent = on
    ? "On: each project's agents are kept to their own project and its links."
    : "Off: every agent in the workspace can see and message every other.";
  reconcileReaderRows($("project-links-list"), projectLinks, link => JSON.stringify([link.projectA, link.projectB]), link => {
      const unlink = el("button", { class: "btn btn-sm btn-quiet", type: "button" }, "Unlink");
      unlink.addEventListener("click", () => changeProjectLink("DELETE", link.projectA, link.projectB));
      return el("div", { class: "strip link-row" },
        el("p", { class: "link-pair" }, el("strong", {}, link.nameA), el("span", { class: "muted" }, " and "), el("strong", {}, link.nameB)),
        el("p", { class: "muted link-by" }, `linked by ${link.createdBy} ${ago(link.createdAt)}`),
        unlink);
    });
  if (!projectLinks.length) $("project-links-list").append(el("p", { class: "muted empty-state" }, emptyMark("link"), "No projects are linked."));
  const enabled = (lastFleetProjectsData?.projects ?? []).filter((p) => p.enabled);
  for (const id of ["link-project-a", "link-project-b"]) {
    const select = $(id);
    const chosen = select.value;
    const signature = JSON.stringify(enabled.map(p => [p.projectKey, p.name]));
    if (select.dataset.projectsSignature !== signature) {
      select.replaceChildren(...enabled.map((p) => el("option", { value: p.projectKey }, p.name)));
      select.dataset.projectsSignature = signature;
    }
    if (enabled.some((p) => p.projectKey === chosen)) select.value = chosen;
  }
  if (enabled.length > 1 && $("link-project-a").value === $("link-project-b").value) $("link-project-b").selectedIndex = 1;
  $("project-link-form").hidden = enabled.length < 2;
}

$("isolation-toggle")?.addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  isolationGen++; // any read already in flight predates this change
  invalidateVisibleReader("isolation");
  const refusal = $("isolation-refusal");
  refusal.hidden = true;
  event.target.disabled = true;
  try {
    let data;
    try {
      data = await api("/v1/org/project-isolation", { method: "PUT", body: { enabled } });
    } catch (err) {
      if (err.status !== 409 || !err.data?.report) throw err;
      event.target.checked = false;
      showIsolationRefusal(err.message, err.data.report);
      return;
    }
    isolationState = { enabled: data.enabled };
    renderIsolation();
    toast(data.enabled ? "Projects are now kept apart." : "Projects are no longer kept apart.");
  } catch (err) {
    event.target.checked = !enabled;
    toast(err.message);
  } finally {
    event.target.disabled = false;
  }
});

/** The pre-flight's reason, in the page: which repository is split, under which keys, with which agents on each. */
function showIsolationRefusal(message, report) {
  const refusal = $("isolation-refusal");
  refusal.replaceChildren(
    el("p", {}, el("strong", {}, "Not switched on. "), message),
    ...(report.splits ?? []).map((split) => el("div", { class: "split" },
      el("p", {}, `"${split.name}" is in use under ${split.keys.length} project keys:`),
      el("ul", {}, ...split.keys.map((k) => el("li", {}, el("code", {}, k.projectKey),
        k.liveAgents.length ? ` (${k.liveAgents.join(", ")})` : " (no live agents)"))))),
  );
  refusal.hidden = false;
}

async function changeProjectLink(method, projectA, projectB) {
  isolationGen++;
  invalidateVisibleReader("isolation");
  const errEl = $("project-link-error");
  errEl.hidden = true;
  try {
    await api("/v1/org/project-links", { method, body: { projectA, projectB } });
    toast(method === "DELETE" ? "Projects unlinked." : "Projects linked.");
    await refreshIsolation();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}
$("project-link-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const a = $("link-project-a").value;
  const b = $("link-project-b").value;
  if (!a || !b) return;
  if (a === b) { $("project-link-error").textContent = "Pick two different projects."; $("project-link-error").hidden = false; return; }
  changeProjectLink("POST", a, b);
});

// ---------- Agents: reviewed-work record and capabilities ----------
// GET /v1/reliability/all counts each agent's reviewed tasks (task.accepted / task.rejected directed at it,
// src/reliability.ts). accept_rate is null with no reviewed task: "no record yet" is not "0%", and the page must not
// say it is. Capabilities are what the agent declared it can do (POST /v1/capabilities); a task can require them.
let reliabilityById = new Map();
let capabilitiesById = new Map();
function setTrustData(reliabilityData, agents) {
  reliabilityById = new Map((reliabilityData?.reliability ?? []).map((r) => [r.agent_id, r]));
  capabilitiesById = new Map((agents ?? []).map((a) => [a.id, parseCapabilities(a.capabilities)]));
}
function parseCapabilities(raw) {
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === "string");
  try { const list = JSON.parse(raw ?? "[]"); return Array.isArray(list) ? list.filter((c) => typeof c === "string") : []; } catch { return []; }
}
/** Nothing when there is nothing to say: an agent with no reviewed task and no capabilities gets no chips. */
function trustChips(agentId) {
  const r = reliabilityById.get(agentId);
  const caps = capabilitiesById.get(agentId) ?? [];
  return [
    r && r.total > 0
      ? el("span", { class: `trust-chip${r.accept_rate < 0.5 ? " is-low" : ""}`, title: `${r.rejected} sent back` }, `${r.accepted} of ${r.total} reviewed tasks accepted`)
      : null,
    caps.length ? el("span", { class: "caps-chip", title: "What this agent said it can do. A task can require these." }, `can: ${caps.join(", ")}`) : null,
  ].filter(Boolean);
}

// ---------- Inbox: one line when nothing is waiting ----------
// Each section drew its own large empty card ("All clear", "All caught up") beside an empty detail pane. When the whole
// queue is empty it is one line; per-section empty cards are hidden inside the queue (the filter chips still say which
// section is showing).
function syncInboxEmpty() {
  const queue = $("inbox-queue-view");
  if (!queue) return;
  const empty = !queue.querySelector(".inbox-queue-list .strip");
  queue.classList.toggle("is-empty", empty);
  const allClear = $("inbox-all-clear");
  if (allClear) allClear.hidden = !empty;
}
(() => {
  const list = document.querySelector(".inbox-queue-list");
  if (list && typeof MutationObserver === "function") new MutationObserver(syncInboxEmpty).observe(list, { childList: true, subtree: true });
  syncInboxEmpty();
  $("inbox-view-activity")?.addEventListener("click", () => selectTab("timeline"));
})();

// Recovery remains reachable when a chat's older hooks cannot receive an announcement.
$("connector-update-check")?.addEventListener("click", async () => {
  const button = $("connector-update-check");
  const result = $("connector-update-result");
  button.disabled = true;
  result.textContent = "Checking the hub's current connector…";
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("manifest timeout")); }, 5000);
  });
  try {
    const read = async () => {
      const response = await fetch("/cli/manifest.json", { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("manifest unavailable");
      return response.json();
    };
    // The deadline covers both the request and body consumption, including a stalled stream.
    const body = await Promise.race([read(), expired]);
    const stamp = body?.tarball?.stamp;
    const sha = body?.tarball?.sha256;
    const url = new URL(body?.tarball?.url);
    if (typeof stamp !== "string" || !/^[0-9a-f]{12}$/.test(stamp)
      || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha) || !sha.startsWith(stamp)
      || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !/^[a-zA-Z0-9._:\[\]-]+$/.test(url.hostname) || !/^[a-zA-Z0-9._/-]*$/.test(url.pathname) || !url.pathname.endsWith(`/cli/${stamp}/opencadre-cli.tgz`)) throw new Error("unverified manifest");
    // Ignore arbitrary server command strings; build advice only from the validated package address.
    const command = `npx -y ${url.href} connect --upgrade`;
    result.replaceChildren(
      el("span", {}, `Hub connector package ${stamp}. Installed version: unknown to this page. `),
      el("code", {}, command),
      el("span", {}, " It updates OpenCadre's helpers and the OpenCadre settings of every tool already connected on that computer; it never connects a new tool. It ends with 0 (up to date), 3 (updated, with anything left for you listed per tool, such as checking whether Codex lists changed hooks for review) or 2 (not finished: run it again). Then run doctor on the computer to check identity, mail and clearance. A different build does not by itself mean your version is unsupported."));
  } catch {
    result.textContent = "The hub's current package could not be verified. Keep using your existing setup; try again when the hub is reachable. No cached or unstamped upgrade command is suggested.";
  } finally { clearTimeout(timer); controller.abort(); button.disabled = false; }
});
