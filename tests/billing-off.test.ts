import { describe, it, expect } from "vitest";
import {
  billingEnabled, signupPlan, defaultPlan,
  NON_EXPIRING_PLAN, PENDING_PLAN, DEFAULT_PLAN,
} from "../src/billing.js";

// Explicit env objects only: process.env is never touched. vitest.config.ts sets OPENCADRE_BILLING=on for the
// engine tests, so these cases pass their own env to prove the default.
describe("billing is off by default", () => {
  const off: NodeJS.ProcessEnv[] = [
    {},
    { OPENCADRE_BILLING: "" },
    { OPENCADRE_BILLING: "off" },
    { OPENCADRE_BILLING: "true" },
    { OPENCADRE_BILLING: "1" },
  ];

  for (const env of off) {
    it(`billingEnabled is false for ${JSON.stringify(env)}`, () => {
      expect(billingEnabled(env)).toBe(false);
    });
    it(`signupPlan and defaultPlan are the non-expiring plan for ${JSON.stringify(env)}`, () => {
      expect(signupPlan(env)).toBe(NON_EXPIRING_PLAN);
      expect(defaultPlan(env)).toBe(NON_EXPIRING_PLAN);
    });
  }

  it("a trial mode setting does not turn billing on", () => {
    for (const mode of ["card", "cardless"]) {
      const env = { OPENCADRE_TRIAL_MODE: mode };
      expect(billingEnabled(env)).toBe(false);
      expect(signupPlan(env)).toBe(NON_EXPIRING_PLAN);
    }
  });
});

describe("billing on keeps the plan engine behaviour", () => {
  it("is enabled by OPENCADRE_BILLING=on", () => {
    expect(billingEnabled({ OPENCADRE_BILLING: "on" })).toBe(true);
  });
  it("card mode (the default) signs up on the pending plan", () => {
    expect(signupPlan({ OPENCADRE_BILLING: "on" })).toBe(PENDING_PLAN);
    expect(signupPlan({ OPENCADRE_BILLING: "on", OPENCADRE_TRIAL_MODE: "card" })).toBe(PENDING_PLAN);
  });
  it("cardless mode signs up on the default trial plan", () => {
    expect(signupPlan({ OPENCADRE_BILLING: "on", OPENCADRE_TRIAL_MODE: "cardless" })).toBe(DEFAULT_PLAN);
  });
  it("defaultPlan is the default trial plan", () => {
    expect(defaultPlan({ OPENCADRE_BILLING: "on" })).toBe(DEFAULT_PLAN);
  });
});
