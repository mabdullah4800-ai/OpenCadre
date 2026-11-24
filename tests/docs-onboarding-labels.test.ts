// The onboarding docs name console labels a new user looks for. When the console changed and the docs did not, the
// quickstart sent people to "Connect → Connect a computer" and promised chips ("Code redeemed", "Online &
// coordinating") that no longer existed, and the landing page still taught the manual key route the connect code
// replaced. This pins each named label to the console that must show it. Red on the docs before this change.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const consoleText = read("public/app/index.html") + read("public/app/app.js");

describe("onboarding docs name only what the console shows", () => {
  const docs = ["docs/quickstart.md", "docs/troubleshooting.md"];
  const labels = ["Add a computer", "Get a connect code", "My AI agent will run it", "Get a new code", "Waiting for computer to connect", "Connected ✓"];

  it("every label the docs point at exists in the console", () => {
    const docText = docs.map(read).join("\n");
    for (const label of labels) {
      expect(docText, `the docs should name "${label}"`).toContain(label);
      expect(consoleText, `the console should show "${label}"`).toContain(label);
    }
  });

    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("no doc names a status the console no longer shows", () => {
    for (const doc of [...docs, "docs/CLIENT-ONBOARDING.md"]) {
      expect(read(doc), doc).not.toMatch(/Code redeemed|Online & coordinating|Connect → Connect a computer|Fleet → Projects|Generate connect command|open \*\*Connect\*\*|Fleet →|Connect →|Settings → Members|console Fleet|console's Fleet/);
    }
  });
});
