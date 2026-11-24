import type { WorkspaceChoice } from "./oauth-authorize.js";

/**
 * The consent page and the authorize error page (docs/design/MCP-CONNECTOR.md §3 "The consent page"; plan §3/§7.3).
 * Hub-served HTML on the console's origin, styled only by the console's own stylesheets and classes (the sign-in card),
 * with no script and no inline style, so it works under the console's CSP and without JavaScript: a plain form POST.
 *
 * Everything a client controls (its name) and everything a person typed is escaped. The redirect's HOSTNAME is shown
 * beside the client's name because the name is only a claim; the hostname is where the answer really goes (design §4).
 * The form's hidden fields are the consent id and the CSRF token (and, on the workspace step, the name the person typed);
 * the request's client, redirect, challenge and state never travel through the page (plan §7.3).
 *
 * The answer is a page too (onboarding slice 3): renderReturnPage, whose meta refresh and link take the browser back to
 * the client. That navigation is not a form submission, so the consent page's form-action stays 'self'.
 */

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PageChrome {
  /** The console's own preconnect and stylesheet <link> tags, in order and versioned, as its page serves them
   * (src/rest.ts consoleStyleLinks): the consent page renders with exactly the console's styles, design tokens first. */
  styleLinks: string;
  /** The console's inline SVG sprite (the lockup), so the wordmark renders exactly as on the sign-in card. */
  sprite: string;
}

function page(chrome: PageChrome, title: string, card: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">${head}
  <title>${escapeHtml(title)}</title>
  ${chrome.styleLinks}
  <link rel="icon" href="/shared/brand/favicon.ico" sizes="16x16 24x24 32x32">
  <link rel="icon" href="/shared/brand/favicon.svg" type="image/svg+xml">
</head>
<body>
  ${chrome.sprite}
  <main class="signin">
    <div class="signin-card">
      <p class="wordmark"><svg class="oc-brand oc-lockup" width="146" height="24" role="img" aria-label="OpenCadre"><use href="#oc-lockup"/></svg></p>
${card}

    </div>
  </main>
</body>
</html>
`;
}

/** The console, for a page with nowhere else to send the person: never a dead end. */
const OPEN_APP = `<a class="btn btn-quiet" href="/app/">Open OpenCadre</a>`;

/** One way on, always: `returnTo` is a plain link back to the client with the error, for a request error the hub will
 * not redirect by itself (security review S1); the person must click it, and it names the host it goes to. Without one,
 * the console. */
export function renderOauthErrorPage(chrome: PageChrome, message: string, returnTo?: { href: string; host: string }): string {
  const action = returnTo
    ? `<a class="btn btn-quiet" href="${escapeHtml(returnTo.href)}">Return to ${escapeHtml(returnTo.host)}</a>`
    : OPEN_APP;
  return page(chrome, "Couldn't connect | OpenCadre", `      <h1 class="signin-title">Couldn't connect</h1>
      <p class="error" role="alert">${escapeHtml(message)}</p>
      <p>${action}</p>`);
}

/** The answer to a consent that was already used to connect, when the hub can tell what it made (onboarding slice 2).
 * Names only; never an id, code or token. */
export function renderAlreadyConnectedPage(chrome: PageChrome, made: { agentName: string; workspaceName: string; projectName: string | null }): string {
  const where = made.projectName
    ? `<strong>${escapeHtml(made.projectName)}</strong> (${escapeHtml(made.workspaceName)})`
    : `<strong>${escapeHtml(made.workspaceName)}</strong>`;
  return page(chrome, "Already connected | OpenCadre", `      <h1 class="signin-title">Already connected</h1>
      <p>Already connected as <strong>${escapeHtml(made.agentName)}</strong> in ${where}.</p>
      <p><a class="btn btn-quiet" href="/app/#/agents/named">Open Agents in OpenCadre</a></p>`);
}

/** The page an answer returns, from the hub's own origin (onboarding slice 3), in place of a 302 to the client. A 302
 * answering the consent form is part of a form submission, and Chrome holds every hop of its redirect chain to the
 * consent page's form-action; a client's callback that bounces on (Cursor's: www.cursor.com -> cursor.com -> a loopback
 * port) then needed form-action widened to any https origin. A meta refresh is a navigation of type "other", which
 * form-action does not govern (CSP3 §6.4.1.1), and no other CSP directive governs where a page navigates itself
 * (navigate-to was dropped from CSP3 and never shipped). The link is the same URL, for a browser that does not refresh,
 * or one that wants a click before it opens an app.
 *
 * `href` is the client's redirect as approve or deny built it from the stored, re-checked consent, with the code or the
 * error appended; it is escaped like every other value here. `connected` is whether approve made a connection, and
 * `names` what it made, by name. */
export function renderReturnPage(chrome: PageChrome, view: {
  href: string; host: string; connected: boolean; names?: { agentName: string; scopeName: string } | null;
}): string {
  const href = escapeHtml(view.href);
  const host = escapeHtml(view.host);
  const title = !view.connected
    ? "Not connected."
    : view.names
      ? `Connected as <strong>${escapeHtml(view.names.agentName)}</strong> to <strong>${escapeHtml(view.names.scopeName)}</strong>.`
      : "Connected.";
  return page(chrome, `${view.connected ? "Connected" : "Not connected"} | OpenCadre`, `      <h1 class="signin-title">${title}</h1>
      <p>Returning to <strong>${host}</strong>…</p>
      <p><a class="btn btn-ink" href="${href}">Return to ${host}</a></p>`, `
  <meta http-equiv="refresh" content="0;url=${href}">`);
}

export interface ConsentView {
  consentId: string;
  csrf: string;
  clientName: string;
  redirectHost: string;
  personLabel: string;
  workspaces: WorkspaceChoice[];
  /** The workspace chosen. With one workspace it is that one. */
  selectedOrgId: string | null;
  /** The first step, for a person with two or more workspaces: the workspace only, then Continue. The page has no script,
   * so a project list drawn beside the workspace radios could belong to another workspace than the one ticked; asking
   * for the workspace first means every project shown is the chosen workspace's. */
  chooseWorkspace: boolean;
  /** The project ticked: the person's choice, else the preselected one, else none. */
  projectKey: string | null;
  /** The project to create, for a workspace that keeps projects apart and has none. */
  newProjectName: string;
  connectionName: string;
  error?: string;
  /** The field the error is about, marked invalid and focused. */
  errorField?: "project" | "name";
}

const ERROR_ID = "consent-error";
/** The error, placed directly above the buttons it concerns (they reference it by id). */
const errorBlock = (view: ConsentView) =>
  view.error ? `        <p class="error" id="${ERROR_ID}" role="alert">${escapeHtml(view.error)}</p>\n` : "";
const describedBy = (view: ConsentView) => (view.error ? ` aria-describedby="${ERROR_ID}"` : "");
/** aria-invalid, the error reference and autofocus, for the field the error is about. */
const invalidAttrs = (view: ConsentView, field: "project" | "name") =>
  view.error && view.errorField === field ? ` aria-invalid="true" aria-describedby="${ERROR_ID}"` : "";
const focusIf = (view: ConsentView, field: "project" | "name") => (view.error && view.errorField === field ? " autofocus" : "");

/** Workspace radios: every eligible workspace on the first step, only the chosen one after it. */
function workspaceField(workspaces: WorkspaceChoice[], checkedOrgId: string | null, change: boolean): string {
  const items = workspaces.map((w) => `          <label class="workspace-item">
            <span class="workspace-item-name"><input type="radio" name="workspace" value="${escapeHtml(w.orgId)}"${w.orgId === checkedOrgId ? " checked" : ""} required> ${escapeHtml(w.name)}</span>
          </label>`).join("\n");
  // A radio group, not a .field: .field styles every input inside it as a full-width text box.
  return `        <div class="stack" role="radiogroup" aria-labelledby="consent-workspace-label">
          <span class="field-label" id="consent-workspace-label">Workspace</span>
          <div class="workspace-list">
${items}
          </div>${change ? `
          <button class="btn btn-quiet btn-sm" type="submit" name="decision" value="workspaces" formnovalidate>Change workspace</button>` : ""}
        </div>`;
}

/** Whether Approve can succeed for this workspace: it does not keep projects apart, or it has a project, or the person
 * may create one here. Otherwise the page says who can help and draws no Approve. */
const approvable = (w: WorkspaceChoice) => !w.isolated || w.projects.length > 0 || w.canCreateProjects;

function scopeField(view: ConsentView, selected: WorkspaceChoice): string {
  if (!selected.isolated) {
    return `        <p class="callout signin-email-sent">Can message every agent in ${escapeHtml(selected.name)}.</p>`;
  }
  if (selected.projects.length === 0) {
    if (!selected.canCreateProjects) return `        <p class="field-hint">Ask an owner or admin to add a project.</p>`;
    return `        <label class="field">
          <span class="field-label">New project</span>
          <input name="new_project" type="text" value="${escapeHtml(view.newProjectName)}" maxlength="40" required autocomplete="off" spellcheck="false"${invalidAttrs(view, "project")}${focusIf(view, "project")}>
        </label>`;
  }
  // A project's key shows only to tell apart two projects with the same name.
  const named = (name: string) => selected.projects.filter((p) => p.name.toLowerCase() === name.toLowerCase()).length;
  const items = selected.projects.map((p, i) => `          <label class="workspace-item">
            <span class="workspace-item-name"><input type="radio" name="project" value="${escapeHtml(p.key)}"${p.key === view.projectKey ? " checked" : ""} required${i === 0 ? focusIf(view, "project") : ""}> ${escapeHtml(p.name)}</span>${named(p.name) > 1 ? `
            <span class="workspace-item-role">${escapeHtml(p.key)}</span>` : ""}
          </label>`).join("\n");
  return `        <div class="stack" role="radiogroup" aria-labelledby="consent-project-label"${invalidAttrs(view, "project")}>
          <span class="field-label" id="consent-project-label">Project</span>
          <div class="workspace-list">
${items}
          </div>
        </div>`;
}

export function renderConsentPage(chrome: PageChrome, view: ConsentView): string {
  const client = escapeHtml(view.clientName);
  const host = escapeHtml(view.redirectHost);
  const selected = view.chooseWorkspace
    ? undefined
    : view.workspaces.find((w) => w.orgId === view.selectedOrgId) ?? (view.workspaces.length === 1 ? view.workspaces[0] : undefined);
  const hidden = `        <input type="hidden" name="consent" value="${escapeHtml(view.consentId)}">
        <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">`;
  const deny = `<button class="btn btn-quiet" type="submit" name="decision" value="deny" formnovalidate>Deny</button>`;
  // The redirect's host is the one line kept above the form: the client's name is only a claim, and this is where the
  // answer really goes (design §4), so a person can tell an app posing as another.
  const header = `      <h1 class="signin-title">Connect ${client}</h1>
      <p class="field-hint">Returns to <strong>${host}</strong></p>
`;
  // The account, with a way to switch: a submit of this form (its CSRF token), never a bare sign-out link another site
  // could fire.
  const footer = `      <p class="field-hint">${escapeHtml(view.personLabel)} · <button class="btn btn-ghost btn-sm" type="submit" name="decision" value="switch_account" form="consent-form" formnovalidate>Use another account</button></p>`;
  const form = `<form class="stack" id="consent-form" method="post" action="/oauth/authorize">`;
  const title = `Connect ${view.clientName} | OpenCadre`;
  if (view.workspaces.length === 0) {
    return page(chrome, title, `${header}      <p class="field-hint">You need to be an owner or admin of a workspace.</p>
      ${form}
${hidden}
${errorBlock(view)}        <div class="wizard-actions">
          <button class="btn btn-quiet" type="submit" name="decision" value="deny"${describedBy(view)}>Deny</button>
          ${OPEN_APP}
        </div>
      </form>
${footer}`);
  }
  if (!selected) {
    // Step one of two: the workspace. A typed name rides along so Change workspace does not lose it.
    const keepName = view.connectionName ? `\n        <input type="hidden" name="name" value="${escapeHtml(view.connectionName)}">` : "";
    return page(chrome, title, `${header}      ${form}
${hidden}${keepName}
${workspaceField(view.workspaces, view.selectedOrgId, false)}
${errorBlock(view)}        <div class="wizard-actions">
          <button class="btn btn-ink" type="submit" name="decision" value="choose"${describedBy(view)}>Continue</button>
          ${deny}
        </div>
      </form>
${footer}`);
  }
  const canApprove = approvable(selected);
  const nameField = canApprove ? `
        <label class="field">
          <span class="field-label">Agent name</span>
          <input name="name" type="text" value="${escapeHtml(view.connectionName)}" maxlength="80" required autocomplete="off" spellcheck="false"${invalidAttrs(view, "name")}${focusIf(view, "name")}>
        </label>` : "";
  // Without Approve (no project, and no right to add one) the page still leads somewhere: Deny, or the console.
  const actions = canApprove
    ? `<button class="btn btn-ink" type="submit" name="decision" value="approve"${describedBy(view)}>Approve</button>
          ${deny}`
    : `${deny}
          ${OPEN_APP}`;
  return page(chrome, title, `${header}      ${form}
${hidden}
${workspaceField([selected], selected.orgId, view.workspaces.length > 1)}
${scopeField(view, selected)}${nameField}
${errorBlock(view)}        <div class="wizard-actions">
          ${actions}
        </div>
      </form>
${footer}`);
}
