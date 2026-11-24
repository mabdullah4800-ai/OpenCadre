// @vitest-environment happy-dom
// UX batch 1, fix 5 (Codex audit): Activity's delivery dots lit their first ("live") dot for every message, from
// `p.priority === "high" || true`, so a message that was only queued read as delivered live. There is no persisted
// "live" state: src/deliveries.ts records queued, delivered, and the agent's own acknowledged/acted/dismissed. The dots
// now show those states and nothing else. Red before the fix: a queued message lit two dots.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const { renderDeliveryTracker } = (() => {
  const html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  document.documentElement.innerHTML = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderDeliveryTracker };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {})),
  ) as { renderDeliveryTracker: (e: unknown, p: unknown) => HTMLElement };
})();

const lit = (tracker: HTMLElement) => [...tracker.querySelectorAll(".d-dot")].map((d) => d.classList.contains("d-active") || d.classList.contains("d-acked"));
const message = (delivery_state?: string) => ({ type: "message.sent", seq: 1, ...(delivery_state ? { delivery_state } : {}) });

describe("delivery dots follow the persisted delivery state", () => {
  it("queued lights only the queued dot, and nothing claims live delivery", () => {
    for (const tracker of [renderDeliveryTracker(message("queued"), { priority: "high" }), renderDeliveryTracker(message(), {})]) {
      expect(lit(tracker)).toEqual([true, false, false]);
      expect(tracker.querySelector(".d-label")!.textContent).toBe("queued");
      expect(tracker.textContent + (tracker.getAttribute("title") ?? "")).not.toMatch(/\blive\b/i);
    }
  });

  it("delivered lights two, and the agent's own acknowledgement lights all three", () => {
    expect(lit(renderDeliveryTracker(message("delivered"), {}))).toEqual([true, true, false]);
    const acked = renderDeliveryTracker(message("acknowledged"), {});
    expect(lit(acked)).toEqual([true, true, true]);
    expect(acked.querySelector(".d-label")!.textContent).toBe("acknowledged");
    expect(renderDeliveryTracker(message("acted"), {}).querySelector(".d-label")!.textContent).toBe("acted on");
  });

  it("a payload field is not a delivery state: only the delivery row can say acknowledged", () => {
    expect(lit(renderDeliveryTracker(message("queued"), { acknowledged: true, outcome: "acted" }))).toEqual([true, false, false]);
  });
});
