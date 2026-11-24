import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readSessionHints, SESSION_HEADER, HOST_SESSION_HEADER, CLIENT_HEADER, PROJECT_HEADER, PROJECT_NAME_HEADER, RESOLVE_ONLY_HEADER, ADOPT_LIVE_HEADER, CHAT_PROVEN_HEADER } from "../src/devices.js";

/**
 * THE ALLOWLIST AND THE READER MUST AGREE — INCLUDING ON WHAT IS DELIBERATELY LEFT OUT.
 *
 * `sessionFieldsFrom` (src/rest.ts) REPLACES `req.headers` for the device path on `/v1/sessions/join`
 * and `/leave`, so a header left out of that list is not "unset" — it is UNREADABLE. The function
 * carries a comment saying exactly that, and the comment failed to prevent a real omission once
 * (`ADOPT_LIVE_HEADER`, caught by tests/session-adoption.test.ts).
 *
 * The second apparent omission was NOT one: `CHAT_PROVEN_HEADER` is absent on purpose. It asserts "a
 * tool call proved this session is a chat" (migration 38's label), `/mcp` is its sole carrier, and a
 * HOOK MUST NOT BE ABLE TO ASSERT IT — hooks are resolve-only and build headers through
 * `sessionHeaders()`, a fixed set that cannot carry it. The adoption site's dead promotion call in
 * src/devices.ts rests on the same invariant, so listing the header here would describe a capability
 * the design forbids, and the two halves of that change would argue against each other.
 *
 * SO THIS TEST PINS A SCOPED INVARIANT, FROM BOTH SIDES. A test that pins a deliberate exclusion is
 * worth more than one that pins a list: the exclusion is the part a future maintainer will "fix".
 *
 * HOW IT STAYS HONEST: the required set is derived from the READER, not written as a third copy of the
 * list that can drift the same way. It drives `readSessionHints` with every session header and demands
 * each lands truthily on its own field; then it reads `sessionFieldsFrom`'s body from SOURCE (it is not
 * exported) and checks the two agree in both directions.
 */

/**
 * [header, a value that changes its output, the `SessionHints` field it populates, THE CONSTANT'S NAME].
 *
 * The fourth element is what the list half compares against: the list is written with CONSTANT
 * identifiers (`[SESSION_HEADER]:`), not header literals, so matching on the literal string would fail
 * on every entry and pass on none — which is what this file's first draft did, the omission's own class
 * of error caught inside the guard against it.
 *
 * `carried` says whether the JOIN path is supposed to accept the header. False only for `chatProven`,
 * and that flag is what makes the exclusion asserted rather than assumed.
 */
const HINTS: Array<[header: string, value: string, field: string, constant: string, carried: boolean]> = [
  [SESSION_HEADER, "seat-aaa", "toolSessionId", "SESSION_HEADER", true],
  [HOST_SESSION_HEADER, "host-bbb", "hostSessionId", "HOST_SESSION_HEADER", true],
  [CLIENT_HEADER, "codex", "client", "CLIENT_HEADER", true],
  [PROJECT_HEADER, "local:proj", "project", "PROJECT_HEADER", true],
  [PROJECT_NAME_HEADER, "Proj", "projectName", "PROJECT_NAME_HEADER", true],
  [RESOLVE_ONLY_HEADER, "1", "resolveOnly", "RESOLVE_ONLY_HEADER", true],
  [ADOPT_LIVE_HEADER, "1", "adoptLive", "ADOPT_LIVE_HEADER", true],
  // DELIBERATELY NOT CARRIED by the join path — see the header comment.
  [CHAT_PROVEN_HEADER, "1", "chatProven", "CHAT_PROVEN_HEADER", false],
];

const sessionFieldsFromBody = (): string => {
  const src = readFileSync(new URL("../src/rest.ts", import.meta.url), "utf8");
  const start = src.indexOf("function sessionFieldsFrom(");
  expect(start, "sessionFieldsFrom must exist — if it was renamed, update this guard").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n}\n", start));
};

describe("the session-field allowlist and the reader agree, in both directions", () => {
  it("readSessionHints reads every header in this table, truthily", () => {
    // THE READER HALF. Each header must land on its OWN field with a truthy value: an assertion on
    // presence alone would pass for a header that is read and then discarded.
    const hints = readSessionHints(Object.fromEntries(HINTS.map(([h, v]) => [h, v]))) as Record<string, unknown> | null;
    expect(hints, "a valid session id is required before any hint is read").not.toBeNull();
    for (const [header, value, field] of HINTS) {
      const got = hints![field];
      const ok = field === "hostSessionId" ? got === value : got === true || typeof got === "string";
      expect({ header, field, truthy: ok }, `${header} must populate ${field} truthily`).toEqual({ header, field, truthy: true });
    }
  });

  it("sessionFieldsFrom carries exactly the headers marked carried, and no others", () => {
    // THE LIST HALF, read from SOURCE so this test is not a third copy that drifts the same way.
    const body = sessionFieldsFromBody();
    for (const [header, , field, constant, carried] of HINTS) {
      const listed = body.includes(`[${constant}]`);
      expect({ header, field, listed }, carried
        ? `${header} (${field}) must be listed in sessionFieldsFrom`
        : `${header} (${field}) must NOT be listed — the exclusion is deliberate`).toEqual({ header, field, listed: carried });
    }
  });

  it("the deliberate exclusion has a written reason beside it", () => {
    // An exclusion with no reason reads as an oversight, and the next maintainer fixes it — which is
    // how the invariant this test protects would be broken. The comment IS the artifact here.
    const body = sessionFieldsFromBody();
    expect(body, "the boundary must explain WHY chat-proven is absent, not merely omit it")
      .toMatch(/CHAT_PROVEN_HEADER`? IS DELIBERATELY ABSENT/);
    expect(body, "and it must name the sole carrier").toMatch(/\/mcp` is its SOLE CARRIER|sole carrier/i);
    expect(body, "and the rule a hook must not be able to break").toMatch(/HOOK MUST NOT BE ABLE TO ASSERT IT/);
  });

  it("the reader itself still reads chatProven — the exclusion is the LIST's, not the reader's", () => {
    // Pins the scoping precisely. `readSessionHints` DOES read the field; what is restricted is which
    // callers can carry it. If someone "fixes" this by deleting the field from SessionHints, /mcp
    // breaks silently — that is the wrong repair and this assertion names it.
    const hints = readSessionHints({ [SESSION_HEADER]: "seat-aaa", [CHAT_PROVEN_HEADER]: "1" });
    expect(hints?.chatProven, "the reader reads it; /mcp depends on that").toBe(true);
  });
});
