import { describe, expect, it } from "vitest";
import { isPureAck } from "../scripts/pure-ack.mjs";

describe("isPureAck", () => {
  it("detects pure acknowledgments", () => {
    expect(isPureAck("Thanks.")).toBe(true);
    expect(isPureAck("Confirmed, got both: 16:12:09Z. Round-trip works. Thanks.")).toBe(true);
  });

  it("does not treat directives as pure acks", () => {
    expect(isPureAck("TASK ASSIGNMENT: acknowledge receipt.")).toBe(false);
    expect(isPureAck("STOP adding commits. Reply with hash.")).toBe(false);
  });
});
