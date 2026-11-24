// The stable ENTRY STUBS at ~/.opencadre/bin (Q1g PR-2, plan §2.B, ruling 049a §2 and 049a's §2b refinements).
//
// Clients reference helpers by fixed paths (bin/opencadre-approval-gate.mjs, bin/opencadre-mcp.mjs,
// bin/opencode-plugin/index.js, ...). Those paths now hold small stubs whose bytes do NOT depend on the generation: each
// reads bin/.gen/current ONCE and loads its own name from bin/.gen/<id>/. Every import the generation's module makes is a
// relative specifier, so it resolves inside that same folder: one invocation = one generation = one closure, whatever
// the pointer does next. An upgrade therefore never rewrites a file a client runs; it stages a new generation and flips
// the pointer (cli/lib/generations.mjs).
//
// WHAT A STUB DOES WHEN IT CANNOT LOAD ITS GENERATION (missing pointer, malformed pointer, missing or partial tree, an
// import error). A stub cannot import anything from a broken generation, so everything it needs is IN the stub, baked in
// when it is written:
//   gate     the approval gate. The client's own BLOCKING answer, per dialect (049a §2b-2: exit 2 is not universal):
//            the exact deny the gate's `emit("deny")` gives for `--client <x>` (permissionOutput on stdout, or exit 2 /
//            denyExit with the reason on stderr for Windsurf and Droid). `--report` and `--typed-commit` are never a
//            decision in the gate itself, so there the stub says the client's "no opinion" and why on stderr.
//   loader   the gate loader (Windsurf, Devin, Droid, Crush): exit 2 with the reason on stderr, the loader's own contract.
//   cline    the Cline hook: `{cancel:true}` for a `run_commands` tool call or an unreadable payload (what the hook itself
//            does when its dialect cannot load), `{}` for everything else.
//   quiet    awareness, wake, usage, session stamp, Antigravity inbox: the client's "no opinion" (silenceFor), exit 0,
//            the reason on stderr. A runtime error that is not a load failure is rethrown unchanged.
//   proxy    the MCP server: the reason on stderr, exit 1 (a server that fails to start is not fatal to the client).
//   *-plugin an IMPORTED module (Kilo, Amp, OpenCode run it in-process): the stub re-exports exactly the generation
//            module's export names (Kilo calls every function a plugin exports, so the set must not grow), and on a load
//            failure exports a plugin that BLOCKS shell commands the way that client's real plugin denies one.
//
// MAIN-MODULE DETECTION: no helper decides "am I the main module" (process.argv[1] / import.meta.main); every executed
// helper runs its main path at import. So importing it from the stub runs it, and argv, stdin and cwd are the stub's.
// tests/generation-stubs.test.ts asserts that no helper grows such a check.

import { pathToFileURL } from "node:url";
import { ENTRIES, helperSource } from "./helpers.mjs";
import { exportNames } from "./imports.mjs";

export const STUB_MARKER = "// opencadre-entry-stub v1";

/** The reason every stub-level deny carries on stdout. Fixed text, so a stub's bytes do not vary by generation; the
 * specific failure (which file, which error) goes to stderr. */
export const STUB_DENY_REASON = "OpenCadre's approval gate could not load its installed files, so this command was blocked. Ask the user to run `opencadre doctor`.";

// Built from THIS CLI's own dialect module (the one the generation it installs carries), so the frozen table cannot
// disagree with the gate it stands in for. tests/generation-stubs.test.ts checks every client against the live module.
const dialect = await import(pathToFileURL(helperSource("opencadre-hook-dialect.mjs")).href);
const clientsModule = await import(pathToFileURL(helperSource("opencadre-clients.mjs")).href);

/** Every client a hook may be installed for, plus "*" for an unknown `--client` (the dialect's own fallback). */
export const STUB_CLIENTS = [...new Set(["claude-code", ...clientsModule.CLIENT_NAMES])].sort();

/** { client: { out, exit } }: what the approval gate's own `emit("deny", reason)` produces for that client. */
export function denyTable() {
  const row = (client) => {
    if (client === "windsurf") return { out: "", exit: 2 };
    const denyExit = dialect.denyExitFor(client);
    if (denyExit) return { out: "", exit: denyExit };
    return { out: dialect.permissionOutput(client, "deny", STUB_DENY_REASON), exit: 0 };
  };
  return Object.fromEntries([...STUB_CLIENTS.map((c) => [c, row(c)]), ["*", row("claude-code")]]);
}

/** { client: silence }: each client's "no opinion" (only the non-empty ones; absent means empty stdout). */
export function silenceTable() {
  return Object.fromEntries(STUB_CLIENTS.map((c) => [c, dialect.silenceFor(c)]).filter(([, s]) => s));
}

const HEAD = (name, role) => `${STUB_MARKER} ${name} (${role})
// Written by \`opencadre connect\`: the same bytes in every generation, so an upgrade never rewrites it. It reads
// .gen/current (beside it at the install root) ONCE and loads this entry from that generation, so one run uses one
// generation's files throughout. Do not edit; see cli/lib/stubs.mjs in the OpenCadre repository.
import { readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME = ${JSON.stringify(name)};
const ROOT = ((dir) => { for (let i = 0; i < ${name.split("/").length - 1}; i++) dir = dirname(dir); return dir; })(dirname(fileURLToPath(import.meta.url)));
const say = (fd, text) => { try { writeSync(fd, text); } catch { /* the stream is gone */ } };
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end); } };
function generationUrl() {
  const file = join(ROOT, ".gen", "current");
  let text;
  for (let attempt = 0; ; attempt++) {
    try {
      text = readFileSync(file, "utf8");
      break;
    } catch (err) {
      // A pointer being replaced can refuse a reader for a moment on Windows (EPERM/EBUSY).
      const tries = ["EPERM", "EBUSY", "EACCES"].includes(err?.code) ? 40 : err?.code === "ENOENT" ? 2 : 0;
      if (attempt >= tries) throw Object.assign(new Error(\`no generation pointer at \${file} (\${err?.code ?? err?.message})\`), { code: "OPENCADRE_NO_GENERATION" });
      pause(Math.min(5 * (attempt + 1), 25));
    }
  }
  const id = text.trim();
  if (!/^[0-9a-f]{12}$/.test(id)) throw Object.assign(new Error(\`the generation pointer \${file} is malformed\`), { code: "OPENCADRE_NO_GENERATION" });
  return pathToFileURL(join(ROOT, ".gen", id, ...NAME.split("/"))).href;
}
const LOAD_CODES = new Set(["OPENCADRE_NO_GENERATION", "ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT", "ERR_INVALID_URL", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_PACKAGE_CONFIG", "ENOENT"]);
const isLoadFailure = (err) => LOAD_CODES.has(err?.code) || err instanceof SyntaxError;
let loaded;
let failure;
try {
  const url = generationUrl();
${role === "opencode-plugin" ? "  // setup defers these safety imports; load them now so a partial tree selects the denying plugin.\n  await import(new URL(\"../opencadre-config.mjs\", url).href);\n  await import(new URL(\"./clearance.js\", url).href);\n" : ""}  loaded = await import(url);
} catch (err) {
  failure = err;
}
const why = failure && \`OpenCadre could not load \${NAME} from its installed generation (\${failure?.message ?? failure}). Run \\\`opencadre doctor\\\`.\`;
const argvClient = () => (process.argv.includes("--client") ? process.argv[process.argv.indexOf("--client") + 1] : "claude-code");
`;

const TAILS = {
  gate: ({ deny, silence }) => `const DENY = ${JSON.stringify(deny)};
const SILENCE = ${JSON.stringify(silence)};
if (failure) {
  const client = argvClient();
  if (process.argv.includes("--report") || process.argv.includes("--typed-commit")) {
    // Never a decision in the gate itself: say the client's "no opinion".
    say(2, \`\${why} Nothing was recorded.\\n\`);
    if (SILENCE[client]) say(1, SILENCE[client]);
    process.exit(0);
  }
  const deny = DENY[client] ?? DENY["*"];
  say(2, \`\${why} This command was blocked.\\n\`);
  if (deny.out) say(1, deny.out);
  process.exit(deny.exit);
}
`,
  loader: () => `if (failure) {
  say(2, \`\${why} This command was blocked.\\n\`);
  process.exit(2);
}
`,
  cline: () => `if (failure) {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch { /* unreadable: stopped below */ }
  say(2, \`\${why}\\n\`);
  if (!input || typeof input !== "object" || (input.hookName === "tool_call" && input.tool_call?.name === "run_commands")) {
    say(1, JSON.stringify({ cancel: true, errorMessage: \`\${why} The run was stopped.\` }));
    process.exit(0);
  }
  say(1, "{}");
  process.exit(0);
}
`,
  quiet: ({ silence }) => `const SILENCE = ${JSON.stringify(silence)};
if (failure) {
  if (!isLoadFailure(failure)) throw failure;
  say(2, \`\${why} Skipped.\\n\`);
  const quiet = SILENCE[argvClient()];
  if (quiet) say(1, quiet);
  process.exit(0);
}
`,
  proxy: () => `if (failure) {
  if (!isLoadFailure(failure)) throw failure;
  say(2, \`\${why}\\n\`);
  process.exit(1);
}
`,
};

// The fail-closed plugin each IMPORTED entry exports when its generation cannot load: it blocks a shell command exactly
// the way that client's real OpenCadre plugin denies one (the verdict path of opencadre-kilo-core.mjs,
// opencadre-amp-plugin.mjs and examples/opencode-plugin/clearance.js).
const FALLBACKS = {
  "kilo-plugin": `{
  OpenCadre: async function OpenCadre() {
    return {
      "tool.execute.before": async (input, output) => {
        const tool = input?.tool;
        const args = output?.args;
        if (tool === "bash" || (tool === "background_process" && (args?.action === "start" || args?.action === "monitor"))) throw new Error(\`\${why} This command was blocked.\`);
      },
    };
  },
}`,
  "amp-plugin": `{
  default: function opencadre(amp) {
    amp.on("tool.call", async (event) => {
      const shell = amp.helpers?.shellCommandFromToolCall?.(event);
      return typeof shell?.command === "string" && shell.command ? { action: "reject-and-continue", message: \`\${why} This command was blocked.\` } : undefined;
    });
  },
}`,
  "opencode-plugin": `{
  default: {
    id: "opencadre",
    async setup(ctx) {
      await ctx.permission.hook("evaluate", async (event) => {
        if (event?.action !== "shell") return;
        event.effect = "deny";
        event.message = \`\${why} This command was blocked.\`;
      });
    },
  },
}`,
};

const pluginTail = (role, exports) => {
  if (exports.includes("*")) throw new Error(`a plugin entry (${role}) uses \`export *\`, which a stub cannot re-export by name`);
  const lines = [
    `const FALLBACK = ${FALLBACKS[role]};`,
    "if (failure) {",
    "  try { console.error(why); } catch { /* nowhere to say it */ }",
    "}",
  ];
  for (const name of exports) {
    const value = `failure ? FALLBACK[${JSON.stringify(name)}] : loaded[${JSON.stringify(name)}]`;
    lines.push(name === "default" ? `export default ${value};` : `export const ${name} = ${value};`);
  }
  return `${lines.join("\n")}\n`;
};

/** The stub text for entry `name`, given the text of its generation module (for a plugin's export names). */
export function stubText(name, moduleText, tables = { deny: denyTable(), silence: silenceTable() }) {
  const role = ENTRIES[name];
  if (!role) throw new Error(`${name} is not an entry`);
  const tail = role in FALLBACKS ? pluginTail(role, exportNames(moduleText)) : TAILS[role](tables);
  return `${HEAD(name, role)}${tail}`;
}

/** True when `text` is one of our stubs (by its first line). Identifies a slot's LAYOUT, never its provenance: whether a
 * stub may be replaced is decided by the classification in cli/lib/generations.mjs, like any other file. */
export const isStub = (text) => typeof text === "string" && text.startsWith(STUB_MARKER);
