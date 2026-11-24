import { describe, expect, it } from "vitest";
import { cursorAfterConfirmation, selectIdleChat, wakeworthy } from "../scripts/opencadre-cursor-bridge-wake.mjs";

const chatId = "dc87b1d2-de7c-4de0-a0f5-5846d839e30c";
const profile = "C:\\Users\\dev\\AppData\\Roaming\\Cursor";
const chat = (overrides: Record<string, unknown> = {}) => ({
  id: chatId, title: "OpenCadre", source: "local", status: "completed",
  instance: { userDataDir: profile }, ...overrides,
});

describe("Cursor Desktop Bridge wake targeting", () => {
  it("only targets one completed local chat in the exact profile", () => {
    expect(selectIdleChat([chat()], { chatId, profile })).toMatchObject({ id: chatId });
    expect(selectIdleChat([chat({ status: "idle" })], { chatId, profile })).toMatchObject({ id: chatId });
    expect(selectIdleChat([chat({ status: "running" })], { chatId, profile })).toBeNull();
    expect(selectIdleChat([chat({ source: "cloud" })], { chatId, profile })).toBeNull();
    expect(selectIdleChat([chat({ id: "another-chat" })], { chatId, profile })).toBeNull();
    expect(selectIdleChat([chat({ instance: { userDataDir: "B:\\ai-work\\cursor-bridge-smoke-8160" } })], { chatId, profile })).toBeNull();
    expect(selectIdleChat([chat(), chat()], { chatId, profile })).toBeNull();
  });

  it("keeps low-priority and pure acknowledgements from waking a chat", () => {
    expect(wakeworthy({ priority: "low", body: "Please review this" })).toBe(false);
    expect(wakeworthy({ priority: "medium", body: "Thanks, got it." })).toBe(false);
    expect(wakeworthy({ priority: "medium", body: "Please review this" })).toBe(true);
    expect(wakeworthy({ priority: "low", body: "Thanks", awaiting_reply: true })).toBe(false);
  });

  it("does not move past a Bridge submission until the target mail is actually read", () => {
    const previous = "older-message";
    const target = "unread-target";
    expect(cursorAfterConfirmation(previous, target, [target], [{ id: target }])).toBe(previous);
    // Other unread mail is allowed; only the submitted target must disappear.
    expect(cursorAfterConfirmation(previous, target, [target], [{ id: "newer-message" }])).toBe(target);
    // Even at the 100-row fetch boundary, the last target stays visible while unread.
    const page = Array.from({ length: 99 }, (_, i) => ({ id: `older-${i}` }));
    expect(cursorAfterConfirmation(previous, target, [target], [...page, { id: target }])).toBe(previous);
    expect(cursorAfterConfirmation(previous, target, [target], page)).toBe(target);
  });
});
