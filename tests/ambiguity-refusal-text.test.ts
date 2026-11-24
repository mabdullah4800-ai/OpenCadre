// The ambiguity refusal's customer-facing text must not instruct the reader to make the defect worse.
//
// THE DEFECT (measured 2026-09-21, src/devices.ts): the hub refuses to choose when more than one live
// session exists in the project on this device. The remedy the chat printed was "…then start a fresh
// chat here" -- and A FRESH CHAT MINTS A NEW SESSION ROW ON THE SAME DEVICE, so the remedy ENLARGED the
// set that caused the refusal. A customer who complied got refused again and made the next attempt
// likelier to fail.
//
// THE BOUNDARY THAT MATTERS, and it is why this is a test rather than a diff: the refusal must stay
// LOUD and must still name no candidate -- that is decision #13378, "adoption a deduction rather than a
// guess", and it is the behaviour we are PROTECTING. What changed is only the remedy sentence.
//
// A note on what this can and cannot see: it reads the CONSTANT, so it fails if the compounding
// instruction returns. It cannot observe what a customer actually sees once other layers format it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.join(process.cwd(), "examples/hooks/opencadre-awareness.mjs"), "utf8");
// Tolerate CRLF and any whitespace before the terminating `;` -- the first version of this extractor
// required `;\n` exactly and silently produced an empty string on this box, which the guard test below
// caught before the other three could pass vacuously.
const text = src.match(/const AMBIGUITY_TEXT =([\s\S]*?);\s*\r?\n/);
const AMBIGUITY_TEXT = text ? text[1].replace(/["+]/g, " ").replace(/\s+/g, " ").trim() : "";

describe("the ambiguity refusal's text", () => {
  it("exists and is findable, so the assertions below cannot pass vacuously", () => {
    expect(AMBIGUITY_TEXT.length, "AMBIGUITY_TEXT moved or was renamed -- this test would otherwise assert nothing").toBeGreaterThan(80);
  });

  it("does NOT tell the customer to start another chat — the compounding instruction is gone", () => {
    // The exact phrase that was removed. Written as a plain substring so it cannot be satisfied by the
    // NEGATED form: the text now says "Do NOT start another chat", which contains the words and is the
    // opposite instruction. A guard that cannot tell "start a chat" from "do not start a chat" would
    // either fail on correct text (as a first draft of this test did) or pass on the defect.
    expect(AMBIGUITY_TEXT).not.toMatch(/then start a fresh chat/i);
    expect(AMBIGUITY_TEXT).not.toMatch(/start a fresh chat here/i);
    // The only occurrence of the phrase must be the prohibition, and it must be the remedy clause --
    // so the text must both warn against it AND state what actually reduces the count.
    expect(AMBIGUITY_TEXT).toMatch(/do not start another chat to work around this/i);
    expect(AMBIGUITY_TEXT).toMatch(/adds another live session/i);
    expect(AMBIGUITY_TEXT).toMatch(/more likely, not less/i);
  });

  it("still refuses LOUDLY and still names no candidate — the behaviour being protected", () => {
    // #13378: naming one would BE the guess the hub just declined to make.
    expect(AMBIGUITY_TEXT).toMatch(/will not guess/i);
    expect(AMBIGUITY_TEXT).toMatch(/no identity of its own/i);
    // No agent name may appear: an id in this string would be the guess itself.
    expect(AMBIGUITY_TEXT).not.toMatch(/OpenCadre-[0-9a-f]{4}/i);
  });

  it("points at an action that actually reduces the count", () => {
    // Closing a sibling, or an operator ending one, are the two remedies that lower the number of live
    // sessions. Both must be present, or the refusal is loud with nothing to do about it.
    expect(AMBIGUITY_TEXT).toMatch(/close the other chat/i);
    expect(AMBIGUITY_TEXT).toMatch(/operator/i);
  });
});
