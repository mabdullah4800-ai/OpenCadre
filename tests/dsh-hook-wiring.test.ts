import { describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The WIRING CONTRACT: examples/hooks/dsh-hooks.json must actually cause the hook to run and
 * send the chat's identity, when consumed the way the real bridge consumes it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE HOOK TESTS. Those prove the hook works when invoked
 * directly. This proves the CONFIG is right, which is a different failure surface:
 *
 *   - the bridge substitutes `${CLAUDE_PROJECT_DIR}` (BRACED) at config-parse time. An
 *     unbraced `$CLAUDE_PROJECT_DIR` - the form Claude Code itself tolerates - is left
 *     untouched, so the command points at a path that does not exist. That bug was in the
 *     first version of this file and was found only by running the substitution.
 *   - the bridge fails SOFT on a bad config: it logs a warning, runs no hooks, and the agent
 *     still starts. So a wrong config is indistinguishable from a working one from outside.
 *   - the bridge supplies only `CLAUDE_PROJECT_DIR` plus the inherited environment
 *     (lib/index.js:169). It does NOT supply OPENCADRE_HOOK_HOME, which every other test here
 *     sets - so anywhere that variable is load-bearing, production differs from the suite.
 *
 * Written by DeepSeek-D2V6 for unit 2 (#207).
 */

const REPO = process.cwd();
const CONFIG = path.join(REPO, "examples", "hooks", "dsh-hooks.json");

/** The bridge's own substitution rule, verbatim from its documented behaviour. */
const substitute = (command: string, projectDir: string) =>
  command
    .split("${CLAUDE_PLUGIN_ROOT}")
    .join("")
    .split("${CLAUDE_PROJECT_DIR}")
    .join(projectDir);

const loadHookCommand = () => {
  const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
  return raw?.hooks?.SessionStart?.[0]?.hooks?.[0] as { type?: string; command?: string; timeout?: number } | undefined;
};

describe("the dsh hooks.json is consumable by the real bridge", () => {
  it("declares a SessionStart command hook", () => {
    const hook = loadHookCommand();
    expect(hook, "the config must declare a SessionStart hook").toBeDefined();
    expect(hook?.type).toBe("command");
    expect(typeof hook?.command).toBe("string");
    // SessionStart is in the bridge's SUPPORTED event set (it maps to agent/session-start);
    // the other events in the file's declared list would register nothing.
    expect(hook?.timeout).toBeGreaterThan(0);
  });

  it("uses the BRACED token, which is the only form the bridge substitutes", () => {
    const hook = loadHookCommand()!;
    // The bug this guards: an unbraced $CLAUDE_PROJECT_DIR is NOT substituted, so the command
    // silently points at a nonexistent path. Asserting the braced form catches the regression
    // at the config level rather than three steps later at runtime.
    expect(hook.command).toContain("${CLAUDE_PROJECT_DIR}");
    expect(hook.command).not.toMatch(/\$CLAUDE_PROJECT_DIR(?!\})/);
  });

  it("resolves to a script that exists on disk", () => {
    const hook = loadHookCommand()!;
    const resolved = substitute(hook.command, REPO);
    expect(resolved).not.toContain("${CLAUDE_PROJECT_DIR}");
    const m = resolved.match(/^node\s+"([^"]+)"$/);
    expect(m, `unexpected command shape: ${resolved}`).not.toBeNull();
    expect(() => readFileSync(m![1]), `resolved script missing: ${m![1]}`).not.toThrow();
  });

  it("actually runs the hook and delivers the chat id under the BRIDGE's env", async () => {
    const hook = loadHookCommand()!;
    const resolved = substitute(hook.command, REPO);
    const script = resolved.match(/^node\s+"([^"]+)"$/)![1];

    const received: { url?: string; sess?: string; client?: string }[] = [];
    const server = http.createServer((req, res) => {
      received.push({
        url: req.url,
        sess: req.headers["x-opencadre-session"] as string | undefined,
        client: req.headers["x-opencadre-client"] as string | undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    // A temp home so the hook's homedir() fallback finds credentials - the bridge does NOT
    // supply OPENCADRE_HOOK_HOME, so this is the production path.
    const home = mkdtempSync(path.join(tmpdir(), "oc-wiring-"));
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(
      path.join(home, ".opencadre", "credentials.json"),
      JSON.stringify({
        computer: { hub: `http://127.0.0.1:${port}/`, credential: `dev_${"ab".repeat(24)}`, deviceId: "d1" },
      }),
    );

    try {
      const code = await new Promise<number | null>((done) => {
        // ASYNC spawn, deliberately. A synchronous spawn blocks this process's event loop, so
        // the local hub above could never answer the hook's fetch - the hook would swallow the
        // failure, exit 0, and look exactly like a broken config. That false negative cost real
        // time once; the async form is what makes this test mean anything.
        const child = spawn(process.execPath, [script], {
          env: { CLAUDE_PROJECT_DIR: REPO, USERPROFILE: home, HOME: home, PATH: process.env.PATH ?? "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.write(
          JSON.stringify({
            session_id: "wiring-chat-1",
            transcript_path: "",
            cwd: REPO,
            hook_event_name: "SessionStart",
            source: "startup",
          }),
        );
        child.stdin.end();
        child.on("close", done);
      });

      expect(code).toBe(0);
      expect(received.length, "the hook made no request - the config did not lead to a live hook").toBeGreaterThan(0);
      expect(received[0].sess).toBe("wiring-chat-1");
      expect(received[0].client).toBe("dsh");
    } finally {
      server.close();
    }
  }, 20_000);
});