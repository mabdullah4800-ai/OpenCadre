// @vitest-environment happy-dom
// UX batch 1, fix 3 (Codex audit): sending a magic link hid the form for good. There was no resend and no way to fix a
// typo in the address short of a reload, the "open it in this same browser" rule appeared only after sending, and an
// error (the hub's 429, a dropped connection) had nowhere to go once the form was gone. Red before the fix: none of the
// sent-state controls existed and the same-browser rule was absent from the form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock: ReturnType<typeof vi.fn>) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  new Function("window", "document", "localStorage", "fetch", appJs)(window, document, window.localStorage, fetchMock);
}

/** The hub's POST /v1/auth/email, answering each call from `answers` in turn (then 200). */
function emailHub(answers: Array<() => unknown> = []) {
  const calls: Array<{ email: string }> = [];
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/v1/auth/email" && init?.method === "POST") {
      calls.push(JSON.parse(String(init.body)));
      const next = answers.shift();
      return next ? next() : json(200, { ok: true });
    }
    return json(401, {}); // boot's /v1/auth/me: signed out
  });
  return { fetchMock, calls };
}

async function send(address: string) {
  ($("signin-email") as HTMLInputElement).value = address;
  $("signin-email-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
afterEach(() => vi.useRealTimers());

describe("email sign-in", () => {
  it("says to open the link in this same browser before anything is sent", () => {
    const form = $("signin-email-form");
    expect(form.textContent).toMatch(/same browser/i);
    // Tied to the field, so a screen reader hears it with the input.
    const hint = $("signin-email-hint");
    expect(($("signin-email") as HTMLInputElement).getAttribute("aria-describedby")).toContain("signin-email-hint");
    expect(hint.textContent).toMatch(/same browser/i);
  });

  it("after sending: shows the address, and Resend waits out a visible countdown", async () => {
    const { fetchMock, calls } = emailHub();
    loadConsole(fetchMock);
    $("signin-email-form").hidden = false;
    await send("ada@example.com");

    expect(calls).toEqual([{ email: "ada@example.com", next: "/app/" }]);
    expect($("signin-email-form").hidden).toBe(true);
    expect($("signin-email-sent").hidden).toBe(false);
    expect($("signin-email-sent-addr").textContent).toBe("ada@example.com");
    const resend = $("signin-email-resend") as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toBe("Resend in 60s");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resend.textContent).toBe("Resend in 30s");
    expect(resend.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resend.disabled).toBe(false);
    expect(resend.textContent).toBe("Resend");
  });

  it("Resend asks the hub again for the same address, then starts a new cooldown", async () => {
    const { fetchMock, calls } = emailHub();
    loadConsole(fetchMock);
    $("signin-email-form").hidden = false;
    await send("ada@example.com");
    await vi.advanceTimersByTimeAsync(60_000);
    $("signin-email-resend").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.email)).toEqual(["ada@example.com", "ada@example.com"]);
    expect(($("signin-email-resend") as HTMLButtonElement).disabled).toBe(true);
    expect($("signin-email-status").textContent).toMatch(/new link/i);
  });

  it("Use a different email returns to the form with the address filled in", async () => {
    const { fetchMock } = emailHub();
    loadConsole(fetchMock);
    $("signin-email-form").hidden = false;
    await send("ada@exmaple.com");
    $("signin-email-change").click();
    expect($("signin-email-sent").hidden).toBe(true);
    expect($("signin-email-form").hidden).toBe(false);
    expect(($("signin-email") as HTMLInputElement).value).toBe("ada@exmaple.com");
    expect(document.activeElement).toBe($("signin-email"));
  });

  it("shows a rate limit and a dropped connection in the alert region, and keeps the way to try again", async () => {
    const { fetchMock } = emailHub([
      () => json(200, { ok: true }),
      () => json(429, { error: "Too many sign-in emails. Wait a while, then try again." }),
      () => { throw new TypeError("Failed to fetch"); },
    ]);
    loadConsole(fetchMock);
    $("signin-email-form").hidden = false;
    await send("ada@example.com");
    await vi.advanceTimersByTimeAsync(60_000);

    $("signin-email-resend").click();
    await vi.advanceTimersByTimeAsync(0);
    const error = $("signin-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Too many sign-in emails. Wait a while, then try again.");
    expect($("signin-email-sent").hidden).toBe(false); // still on the sent state, with its controls

    await vi.advanceTimersByTimeAsync(60_000);
    $("signin-email-resend").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(error.textContent).toMatch(/couldn't reach OpenCadre/i);
    expect(($("signin-email-resend") as HTMLButtonElement).disabled).toBe(false); // nothing was sent: no wait
  });
});
