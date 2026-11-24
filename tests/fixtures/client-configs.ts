// CAPTURED client-config fixtures. Each is the entry shape a real client writes, taken from that
// client's own file on this machine — not composed by hand. See tests/fixtures/README.md for the
// rule, the provenance of each fixture, and the falsification each test carries.
//
// Paths are rewritten to <home>/<opencadre-bin> placeholders of identical shape so the fixture is
// readable and machine-independent; the ENTRY STRUCTURE and every key name are verbatim. Key
// material appears as ${OPENCADRE_KEY} or agt_<REDACTED>, never a live key.

/** Codex ~/.codex/config.toml — captured 2026-09-17.
 * The LIVE entry is a stdio command table. Note what is NOT here: no `http_headers`, no URL,
 * no Bearer. Codex's precedent test composed `[mcp_servers.opencadre]` with
 * `http_headers = { Authorization = "Bearer …" }`, which is not the shape the client now holds. */
export const CODEX_STDIO = `[mcp_servers.opencadre-session]
command = "node"
args = ["<home>/.opencadre/bin/opencadre-mcp.mjs", "--client", "codex"]
tool_timeout_sec = 300
`;

/** Codex, the HTTP+Bearer form the connect writer emits and the previous tests composed.
 * Kept as the SECOND shape, because `cli/lib/clients.mjs` still writes this one and both must work.
 * Table header and key names captured from the writer's output shape. */
export const CODEX_HTTP = `[mcp_servers.opencadre]
url = "https://app.opencadre.example/mcp"
http_headers = { "Authorization" = "Bearer agt_<REDACTED>" }
`;

/** Claude Code ~/.claude.json — captured 2026-09-17.
 * The live entry is stdio with an empty `env` object; `type` is present and set to "stdio". */
export const CLAUDE_STDIO = {
  mcpServers: {
    "opencadre-session": {
      type: "stdio",
      command: "node",
      args: ["<home>/.opencadre/bin/opencadre-mcp.mjs", "--client", "claude-code"],
      env: {},
    },
  },
};

/** Claude Code, the HTTP+Bearer form the connect writer emits. */
export const CLAUDE_HTTP = {
  mcpServers: {
    opencadre: {
      type: "http",
      url: "https://app.opencadre.example/mcp",
      headers: { Authorization: "Bearer agt_<REDACTED>" },
    },
  },
};

/** Reasonix machine-wide config.toml — captured 2026-09-17, INLINE form.
 * This is the shape `scripts/reasonix-agents.mjs` writes into a folder reasonix.toml. */
export const REASONIX_INLINE = `[[plugins]]
name    = "opencadre"
type    = "http"
url     = "https://app.opencadre.example/mcp"
headers = { Authorization = "Bearer \${OPENCADRE_KEY}" }
`;

/** Reasonix, the CANONICAL form. Reasonix rewrites its own config into this shape on some loads:
 * the inline `headers = { … }` becomes a `[plugins.headers]` sub-table. Observed on this machine
 * on 2026-09-17, and it is the shape that broke the parser — the block scan ended at the
 * `[plugins.headers]` header, so the Authorization line was never read and identity resolved to
 * nothing, silently (exit 0, empty stdout, no error). */
export const REASONIX_CANONICAL = `[[plugins]]
name    = "opencadre"
type    = "http"
url     = "https://app.opencadre.example/mcp"
[plugins.headers]
  Authorization = "Bearer \${OPENCADRE_KEY}"
`;

/** Antigravity ~/.gemini/antigravity/mcp_config.json — NOT captured on this machine: the file is
 * absent, so no live entry could be read. This is the writer's shape, labelled as such, and must
 * not be presented as a capture. Replace with a real capture when a machine has the file. */
export const ANTIGRAVITY_HTTP_COMPOSED = {
  mcpServers: {
    opencadre: {
      serverUrl: "https://app.opencadre.example/mcp",
      headers: { Authorization: "Bearer agt_<REDACTED>" },
      // NOTE: labelled COMPOSED — provenance, not a capture.
    },
  },
};

/** Cursor ~/.cursor/hooks.json — CAPTURED 2026-10-06 from this machine (written by `opencadre connect --client cursor`
 * on 2026-09-25, before board 70f528b2). The gate entry has NO `failClosed`, so Cursor runs the command when the gate
 * crashes, times out or cannot start; it is the install `connect --upgrade` must bring current. Byte-identical to
 * what cli/lib/session-hooks.mjs at 35efe939 writes for the same bin folder. `<opencadre-bin>/` stands for the bin
 * folder and its separator (`C:\Users\<user>\.opencadre\bin\` in the capture), JSON-escaped in place. */
export const CURSOR_HOOKS_PRE_FAILCLOSED = `{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-awareness.mjs\\" --client cursor",
        "timeout": 10
      }
    ],
    "beforeSubmitPrompt": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-awareness.mjs\\" --client cursor",
        "timeout": 10
      }
    ],
    "postToolUse": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-awareness.mjs\\" --client cursor",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-awareness.mjs\\" --client cursor",
        "timeout": 10,
        "loop_limit": 1
      }
    ],
    "preToolUse": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-session-stamp.mjs\\" --client cursor",
        "timeout": 10,
        "matcher": "^MCP:opencadre_"
      }
    ],
    "beforeShellExecution": [
      {
        "command": "node \\"<opencadre-bin>/opencadre-approval-gate.mjs\\" --client cursor",
        "timeout": 600
      }
    ]
  }
}
`;
