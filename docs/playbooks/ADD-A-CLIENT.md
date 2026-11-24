# Playbook: adding an AI tool to OpenCadre, fully

Use this every time OpenCadre gains a new client (a coding agent, an IDE, a CLI). It turns
[LAUNCH-CLIENT-GATE.md](../planning/LAUNCH-CLIENT-GATE.md) §1 ("fully working", six capabilities) into ordered
steps, each with its done-check. Most of it was learned the hard way on 2026-09-19 (Claude Code, Codex, OpenCode);
§11 lists those traps so the next tool does not rediscover them.

**The rule behind every step: measure on a real install first, build second.** A capability claimed from vendor docs
alone is "documented", not "done", and a green test that cannot fail proves nothing.

## 0. Before starting

| Check | Done when |
|---|---|
| Tier decided | The tool has a row in LAUNCH-CLIENT-GATE.md §2 (Tier 1, 1.5 or 2) |
| Installed on a test machine | The binary/app runs; version recorded |
| Credentials | Any vendor sign-in or API key is set **by the operator** (agents never enter credentials) |
| Owner | One lane owns the tool end to end; identity work follows the ownership rule in the gate §4 |

## 1. Measure the tool (the harness doc)

Create `docs/design/HARNESS-<TOOL>.md`. Every claim is labelled **MEASURED** (the command run, its output, the date)
or **DOCUMENTED** (the vendor URL and the fetch date). Answer each of these on the real install:

1. **Config:** which file(s), which format, which key holds MCP servers, and whether the version you run matches the
   docs. (OpenCode's docs show `mcp.<name>`; v2 stores `mcp.servers.<name>` and accepts both. Check with the tool's own
   commands.)
2. **MCP transport:** remote URL entry, local command entry, or both. Does it send a `max_tokens`? (§11)
3. **Process model:** does it start **one MCP process per chat** or one per app, and does it start extra "phantom"
   processes that never chat? Test with a stub server that logs PID and requests across two chats.
4. **Session id:** what per-chat id reaches the MCP server or hooks (env var, header, `_meta.sessionID`, nothing)?
5. **Hooks/plugins:** what fires before a tool runs, after it, at turn end, when idle. Can a hook **block** a tool call?
   Can a plugin **start a new turn**?
6. **Shell:** which shell its command tool uses (bash, PowerShell), since agents' commands depend on it.

## 2. Connect (capability 1)

| Work | Where |
|---|---|
| Detection (config folder or binary on PATH) | `cli/lib/clients.mjs` `CLIENTS`, `detectClients` |
| Config writer that keeps every other key the user has, and refuses (never mangles) a file it can't safely rewrite | `JSON_CLIENTS` / the TOML writer, `planClientConfig`, `readExistingServer` |
| Registry row, starting as **measuring** | `scripts/opencadre-clients.mjs` |
| Example config with a placeholder key | `examples/clients/<tool>.json` |

**Done when:** `opencadre connect` on a real install writes a config the tool actually loads (verify with the tool's
own "list MCP servers"), and a second run replaces rather than duplicates.

## 3. Identity (capability 2)

- Declare `sessionIdSource` **only from a measurement** in step 1.4. Never guess: an unobserved declaration is worse
  than a missing one.
- If the tool spawns phantom processes, **label, don't suppress** (decision #22438): create the row, mark it
  process-scope, promote it to chat-scope on the first `tools/call` (the measured proof of a real chat). Suppressing
  creation breaks identity and wake for idle chats.

**Done when:** two chats on one machine appear as two agents, and a phantom never appears as a named agent.

## 4. Mail and wake (capability 3)

- Awareness: new mail is shown to the agent during its turn (hook output, or a plugin).
- Wake: an idle agent is started on new mail where the vendor allows it (Claude Code: the Stop/rewake hook; OpenCode:
  a plugin that calls `session.prompt` on the idle event). Where the vendor cannot (e.g. Cursor editor chat), state
  "mail arrives at the next turn" as the tool's bar.
- The hub's `/v1/awareness` text is authoritative. Gate on the same field you render (the #447 defect).

**Done when:** an idle agent on a real install picks up a message sent to it, without a human typing.

## 5. Clearance (capability 4)

- Reuse the shared risk rules (`examples/hooks/`), never a second copy.
- The check runs **before** the command (a blocking pre-tool hook or plugin), not as an after-the-fact report.

**Done when:** on the real binary, a denied risky command demonstrably does not run, and an approved one does.

## 6. Lapsed bill (capability 5)

Every hook, proxy and plugin treats a `402` as a **silent no-op**: the user's own tool keeps working. Never log the key.

**Done when:** pointed at a lapsed workspace, the tool works as a plain tool, with no errors or blocked commands.

## 7. doctor (the instrument)

Add the tool's row so `opencadre doctor --client <tool>` reports capabilities 1–5, with **not-measured** kept distinct
from pass and fail. The test iterates every `measuring: true` registry entry, not the tool by name.

## 8. Verified (capability 6)

- Record a smoke run (command, output, date) in the harness doc, **and the input that would make it fail**.
- Add the tool as a machine in the end-to-end journey test (`tests/e2e-stranger-journey.test.ts`).
- Mutate each guard once and see the right test go red.

## 9. Promote and publish

- Registry row: measuring → served (`device: true`, `sessionIdSource` set), in the same PR as the evidence.
- LAUNCH-CLIENT-GATE.md §2: update the tool's cells in the same PR.
- Docs: list the tool as supported only once it passes; state any vendor limit, in the **same
  merge batch** as the capability.
- Onboarding: the console "Connect a tool" picker and the "Get started" page gain the tool's tab.

## 10. Review and merge

Every PR gets a non-author reviewer who checks it against the recorded real-install output, not the diff alone, and a
full serial test suite on the merge preview before merge.

## 11. Traps already paid for (2026-09-19)

| Trap | What happened | Rule |
|---|---|---|
| Missing `max_tokens` | OpenCode sends none; Hive's default cut every reply at ~100–250 characters, truncating tool calls | Check what the client sends; the Hive shim now defaults it |
| Docs vs installed version | OpenCode docs showed one config shape, v2 used another | Measure with the tool's own commands |
| Resumed session keeps its model | OpenCode fell back to its free built-in model | Pin the model per agent mode; disable unwanted providers |
| Debug output prints secrets | `opencode debug config` expanded `{env:KEY}` into the key | Never run config-dump commands on a config that references a secret |
| Every file in `plugins/` loads as a plugin | A helper module next to the plugin failed to load | Keep helpers out of the plugin folder, and load-test on the real binary |
| Provider blocks the client | A model provider refuses Claude Code and Codex ("unapproved channel") | Never disguise a client; choose a provider that allows it |
| Shared background server | One OpenCode crash killed every agent | One server per agent (`--standalone`) |
| Phantom processes | Codex desktop starts MCP processes that never chat | Label them, don't suppress them (§3) |
| Config written to the wrong file | An agent probing config edited the operator's global file | Agents work only in their worktree; configs are per worktree |
