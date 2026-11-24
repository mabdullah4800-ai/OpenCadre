import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";
import { Window } from "happy-dom";
import { app } from "../src/rest.js";
import { upsertPerson, createWorkspace, createSession } from "../src/accounts.js";
import { registerAgent, sendMessage } from "../src/service.js";

/** THE SPRINT'S LAST CLAUSE: "they coordinate **visibly in the console**".
 *
 * `tests/sprint-acceptance.test.ts` proves the transport -- the message is sent, delivered, and wakes
 * an idle chat -- but it contains no reference to `public/app`, `/app/`, or the served asset at all,
 * so it does not prove VISIBILITY. This file covers that, and it is deliberately two claims with two
 * verdicts rather than one bundled green, because they can fail independently and a single assertion
 * that passes on its assertable half is how a real gap hides behind a passing test:
 *
 *   1. the DATA path   -- the coordination is retrievable as the identity the CONSOLE reads with
 *   2. the RENDER path -- the served console renders that message body into its inbox
 *
 * NOTHING HERE IS A FIXTURE, and that is the point of the file. The repo's older console tests
 * (`tests/console-inbox.test.ts`) load the real `app.js` but drive it with a MOCKED fetch and
 * hand-written messages -- which proves rendering-given-a-response, not that a real user sees real
 * data. Instead this drives the REAL console code against the REAL hub:
 *   - `public/app/index.html` and `public/app/app.js` are read from disk and executed as they ship
 *     (the console is served live, no build step);
 *   - the fetch handed to that code is a thin wrapper over the real one, adding only the session
 *     cookie and workspace header that a signed-in browser would send anyway;
 *   - `enterWorkspace()` is the app's OWN session entry point, so the app detects the session from the
 *     hub itself rather than being told -- no internals are set from outside;
 *   - the message is created through the real hub, and the assertion is on the resulting DOM.
 *
 * THE ENVIRONMENT IS NODE, and the DOM is constructed explicitly -- this is load-bearing, and the
 * reason is a trap worth recording. Writing the happy-dom environment docblock at the top of this file
 * makes importing `src/rest.js` die at `src/connect.ts:33`: that environment replaces
 * `import.meta.url` with a browser-like value, and `fileURLToPath` then refuses it. Constructing a
 * `Window` here keeps real module semantics for the hub while still giving the console code a real
 * DOM to render into.
 *
 * DO NOT write that docblock token anywhere in this file, INCLUDING IN PROSE. It was originally
 * mentioned here in a sentence explaining why it is *not* used, and vitest scans the leading comment
 * for the directive rather than parsing intent -- so the explanation itself set the environment and
 * reproduced the exact failure it was describing. The error presents as a load-time TypeError from an
 * unrelated module, which is hard to trace to a comment.
 *
 * The one thing that is not real is the rendering engine: `happy-dom`, not Edge. So the claim is
 * "the shipped console code, against real data, produces a DOM containing the message" -- not "Edge
 * painted it". For a real browser, `scripts/dev/console-shots.mjs` drives headless Edge over CDP
 * against this same served console and mints the same kind of session cookie; it is a screenshot
 * harness rather than an assertion suite, so it is the human-run verification path rather than a
 * substitute for this one.
 *
 * The session is minted the way `scripts/dev/console-shots.mjs` mints it (`upsertPerson` ->
 * `createWorkspace` -> `createSession`): signing in for real would need a live OAuth/magic-link round
 * trip, and there is no local Supabase. The credential produced is a genuine session row the hub
 * verifies, not a bypass. */
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const BODY = "sprint: coordinate with me";

let recorder: Awaited<ReturnType<typeof startFetchRecorder>> | undefined;
let hub: string;
let orgId: string;
let cookie: string;
let ownerAgentName: string;
// Stops the console the render test started: its poll, its live socket and any refresh it still has queued.
let stopConsole: (() => Promise<void>) | undefined;

// Workspace creation is invite-only unless sign-up is open, and the claim here is about a self-serve
// user. Set inside beforeAll and RESTORED in afterAll rather than at module scope: process.env is
// shared across files in a worker, so a bare assignment could leak the flag into a file that asserts
// the closed behaviour.
const priorSignup = process.env.OPENCADRE_SIGNUP;

beforeAll(async () => {
  process.env.OPENCADRE_SIGNUP = "open";
  // Module-level (static) imports, matching the repo's other console tests. The database comes from
  // vitest.config's `OPENCADRE_DB_PATH=:memory:`, which is why nothing has to be set before the hub
  // loads -- and why this file does not use the dynamic-import pattern the acceptance test needs for
  // its own DB path.
  recorder = await startFetchRecorder(app);
  hub = recorder.url;

  // The owner, minted exactly as console-shots.mjs does it.
  const person = upsertPerson({
    id: `sprint-owner-${Math.random().toString(36).slice(2, 10)}`,
    email: "owner@example.com", emailVerified: true, name: "Sprint Owner", avatarUrl: null,
  });
  const ws = createWorkspace(person, "Console Visibility Co");
  orgId = (ws as { orgId: string }).orgId;
  cookie = (createSession(person.id) as { token: string }).token;

  // Who the owner reads their mail AS -- the identity the console resolves through the cookie.
  const me = await fetch(`${hub}/v1/me`, { headers: { cookie: `oc_session=${cookie}`, "x-opencadre-workspace": orgId } });
  expect(me.status).toBe(200);
  ownerAgentName = ((await me.json()) as { agentName?: string; name?: string }).agentName ?? "";

  // The coordination itself, from a second agent to the owner, through the real hub.
  const from = registerAgent(orgId, "Sprint-Claude");
  const sent = await sendMessage(orgId, { id: from.agentId, name: from.agentName }, ownerAgentName, BODY, "high");
  expect(sent.ok, "the seed message must be accepted by the hub").toBe(true);
});

afterAll(async () => {
  if (priorSignup === undefined) delete process.env.OPENCADRE_SIGNUP;
  else process.env.OPENCADRE_SIGNUP = priorSignup;
  // The console this file started is still running when the last test ends, with a refresh going. Left alone, that
  // refresh's request went out just after the hub below closed (measured: 9 ms after) and failed with
  // `fetch failed` -- a test-teardown race, not a console fault (the refresh, poll and push paths all keep retrying
  // in a browser, where the hub does not vanish). Stop the console and let the request it has out finish, so nothing
  // is sent to, or left waiting on, a closed server.
  await stopConsole?.();
  await recorder?.close();
});

/** Built LAZILY, on purpose. As a module-level object literal this captured `cookie` and `orgId` while
 * they were still undefined -- before beforeAll had minted them -- so every request went out as
 * `oc_session=undefined` and the hub answered 401. The failure looked like a broken session, not a
 * broken fixture, which is exactly the shape of mistake this file keeps warning about. */
const consoleAuth = () => ({ cookie: `oc_session=${cookie}`, "x-opencadre-workspace": orgId });

describe("SPRINT: the coordination is visible in the console", () => {
  it("DATA PATH: retrievable as the identity the console reads with (a session, not an agent key)", async () => {
    // The console's signed-in mode reads /v1/messages with the person's session cookie plus
    // X-OpenCadre-Workspace (public/app/app.js:184). That route is behind requireAgentAuth and returns
    // the CALLER's own inbox (src/rest.ts:887/:892), so this asserts the narrower and more useful
    // claim: the person who signed up can see the coordination between their own agents.
    const res = await fetch(`${hub}/v1/messages?peek=true`, { headers: consoleAuth() });
    expect(res.status, "a session cookie must be accepted where the console reads messages").toBe(200);
    const { messages } = (await res.json()) as { messages?: Array<{ body?: string }> };
    expect(
      (messages ?? []).some((m) => (m.body ?? "").includes(BODY)),
      "the coordination must be in the inbox the console reads",
    ).toBe(true);
  });

  it("RENDER PATH: the shipped console renders the coordination into its inbox", async () => {
    // The real HTML and the real script, as served. Inline <script>/<link> tags are stripped so
    // happy-dom does not try to fetch assets; app.js is injected below exactly as the repo's other
    // console tests do it.
    let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
    html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    // A real DOM, built explicitly (see the header for why this is not the happy-dom *environment*).
    const win = new Window({ url: `${hub}/app/` });
    const document = win.document;
    document.documentElement.innerHTML = html;

    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");

    // A real fetch, with only what a signed-in browser would already send. Relative /v1 paths are
    // resolved against the real hub; `credentials: "same-origin"` (set by app.js in session mode) is
    // meaningless to Node's fetch, so the cookie goes on explicitly.
    const realFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = raw.startsWith("http") ? raw : `${hub}${raw}`;
      const headers = new Headers(init?.headers ?? {});
      for (const [k, v] of Object.entries(consoleAuth())) headers.set(k, v);
      return fetch(url, { ...init, headers });
    };

    // `enterWorkspace` is the app's OWN session entry point: it reads /v1/auth/me through the real
    // session, switches itself into session mode, and enters the console -- so the app decides what
    // identity it is rather than being told from outside.
    // app.js is browser code and reaches for DOM globals directly (`Node`, `Element`, events,
    // timers). Binding them by name off the Window is what lets the REAL file run unmodified --
    // hand-picking a couple (as the first attempt did) dies on the first one missed, and the error
    // then reads as a bug in the console rather than a missing global in the harness.
    //
    // A hand-picked list is not enough either, and this test proved it: #644 added
    // `instanceof HTMLTextAreaElement` to renderInbox(), that name was not on the list, and every
    // refresh then threw a ReferenceError that app.js's refresh() catches and discards -- so the inbox
    // stayed on its loading skeleton and this test timed out with no error anywhere. A browser always
    // has that constructor, so it was never a console bug; the harness was simply missing a global.
    // So EVERY name the Window defines that Node does not is bound first: a name that would otherwise
    // be a ReferenceError resolves to the Window's value, whatever the console starts using next.
    // Names Node already has (Array, Promise, JSON...) are deliberately left to Node: rebinding them to
    // the Window's copies would make `instanceof` checks on the hub's parsed JSON cross a realm.
    const browserOnly: Record<string, unknown> = {};
    const IDENT = /^[A-Za-z_$][\w$]*$/;
    const UNBINDABLE = new Set(["eval", "arguments", "undefined", "NaN", "Infinity"]);
    for (let o: object | null = win; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Object.getOwnPropertyNames(o)) {
        if (!IDENT.test(name) || UNBINDABLE.has(name) || name in globalThis || name in browserOnly) continue;
        try {
          browserOnly[name] = (win as unknown as Record<string, unknown>)[name];
        } catch {
          // A getter that throws outside a real page is not a global the console can be using.
        }
      }
    }
    const GLOBALS = [
      "Node", "Element", "HTMLElement", "Text", "Comment", "DocumentFragment", "Event", "CustomEvent",
      "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "IntersectionObserver",
      "NodeList", "getComputedStyle", "matchMedia", "location", "history", "Notification",
      "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval",
      "clearInterval", "URL", "URLSearchParams", "DOMParser", "FormData", "Blob", "File", "FileReader",
    ] as const;
    const scope: Record<string, unknown> = {
      ...browserOnly,
      window: win, document, localStorage: win.localStorage, fetch: realFetch, Headers, navigator: win.navigator,
    };
    for (const name of GLOBALS) {
      scope[name] = (win as unknown as Record<string, unknown>)[name] ?? (globalThis as unknown as Record<string, unknown>)[name];
    }
    const names = Object.keys(scope);
    const app = new Function(...names, `${appJs}; return {
      enterWorkspace,
      // Sign the console out of its own state without a request: nothing polls, listens or starts a refresh after this,
      // and it resolves once the refresh already in flight has ended (the new generation makes that one stale, so it paints nothing).
      stop: async () => {
        clearTimeout(pollTimer); disconnectLiveWs(); currentWorkspace = null; agentKey = null; beginConsoleGeneration();
        await refreshRunning?.promise;
      },
    };`)(
      ...names.map((n) => scope[n]),
    ) as { enterWorkspace: (id: string) => Promise<void>; stop: () => Promise<void> };
    stopConsole = app.stop;

    await app.enterWorkspace(orgId);

    // The inbox is rendered asynchronously by the app's own refresh loop; wait for the body to appear
    // rather than assuming a tick count, so a slower machine is not a false red. (A healthy run renders
    // it in well under a second.) The wait must end INSIDE the test's own timeout: it was 15 s against
    // vitest's 5 s, so a real failure never reached the assertions below and surfaced only as a bare
    // "Test timed out", with nothing saying what the inbox showed.
    const deadline = Date.now() + 4_000;
    const inbox = () => document.getElementById("inbox-list")?.textContent ?? "";
    while (!inbox().includes(BODY) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(document.getElementById("inbox-list"), "the console must have an inbox list container").toBeTruthy();
    expect(inbox(), "the coordination must be rendered into the console's inbox").toContain(BODY);
  });
});
