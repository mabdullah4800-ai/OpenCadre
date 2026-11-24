import { it } from "vitest";
import { identityCases } from "./helpers/awareness-identity-cases.mjs";

// The same real child-hook fixtures also run without installed Vitest:
// node --test tests/helpers/awareness-identity-cases.mjs
for (const [name, run] of identityCases) it(name, { timeout: 30_000 }, run);
