# Client-config fixtures — capture, never compose

## The rule

> A fixture standing in for a real client's config, payload or transcript must be **CAPTURED** from
> that client, from **every surface it writes**. A hand-composed one is an *illustration*: it must be
> labelled as such, and nothing may depend on it.

Adopted fleet-wide 2026-09-17, after two defects shipped behind a green test suite in a single
cycle. Both were the same mistake: **the test asserted the author's handwriting instead of
production's output.**

### Why this rule exists — the two incidents

**Incident 1 — the session hook shipped silent.** `scripts/reasonix-opencadre-hook.mjs` forwarded
Reasonix's payload untranslated, so the shared awareness script — which reads Claude Code's key names
— saw `event: undefined`, hit `if (!HANDLED.has(event)) silent()`, and exited **0 with no output**.
Nothing in `tests/` exercised the wrapper at all, so a fully green suite certified a hook that
briefed no session. The failure was invisible *because* the success and failure states look
identical from outside.

**Incident 2 — the TOML parser shipped broken, with a test that passed.** The parser ended a
`[[plugins]]` block at the next line starting with `[`. Reasonix rewrites its own config so the
inline `headers = { … }` becomes a `[plugins.headers]` **sub-table** — which is itself a line starting
with `[`. The scan therefore stopped one line short of the `Authorization` line, the Bearer lookup
found nothing, and identity resolved to **nothing, silently**. The test passed because it **authored
the config in the inline form**: it asserted a format the client only sometimes uses.

Both were found only by falsification — swapping the pre-fix artefact in and confirming the test
fails. **"The suite is green" is not evidence for this class of bug.**

### The corollary the incidents forced

**Both forms occur in production.** For Reasonix, `scripts/reasonix-agents.mjs` *writes* the inline
form into a folder `reasonix.toml`, and Reasonix *rewrites* the machine-wide config into the
canonical sub-table on some loads. Both shapes were observed on disk on 2026-09-17. A fixture that
covers one form therefore tests half the contract — which is why the rule says *every surface*, not
just *a real sample*.

### Verify by behaviour, not by symbol

A captured fixture plus a green run is still not enough. The check is the **falsification**: replace
the artefact under test with its pre-fix revision and confirm the test **fails**. Two traps this
workstream hit:

* `grep -c startsNewTable` on the hook at the merged tip returns **0**, which reads as a regression.
  It is not — the parser moved into `scripts/opencadre-config.mjs` as `reasonixPlugin()`. Grep the
  symbol and you will chase a ghost; assert the behaviour and you get the truth.
* A silent exit 0 from `scripts/opencadre-wake.mjs` is **ambiguous three ways**: lock held, no new
  mail, or no identity. Only the lock and cursor files distinguish them.

## Provenance

Each fixture records where it was captured and when. Paths are rewritten to `<home>` /
`<opencadre-bin>` placeholders **of identical shape**; entry structure and every key name are
verbatim; key material appears as `${OPENCADRE_KEY}` or `agt_<REDACTED>`, never a live key.

| Fixture | Source file | Captured | Status |
|---|---|---|---|
| `CODEX_STDIO` | `~/.codex/config.toml` | 2026-09-17 | **CAPTURED** |
| `CODEX_HTTP` | writer shape, `cli/lib/clients.mjs` | 2026-09-17 | captured from writer |
| `CLAUDE_STDIO` | `~/.claude.json` | 2026-09-17 | **CAPTURED** |
| `CLAUDE_HTTP` | writer shape, `cli/lib/clients.mjs` | 2026-09-17 | captured from writer |
| `REASONIX_INLINE` | `%APPDATA%\Reasonix\config.toml` | 2026-09-17 | **CAPTURED** |
| `REASONIX_CANONICAL` | Reasonix-rewritten config | 2026-09-17 | **CAPTURED** |
| `CURSOR_HOOKS_PRE_FAILCLOSED` | `~/.cursor/hooks.json` (written 2026-09-25, before `failClosed`) | 2026-10-06 | **CAPTURED** |
| `ANTIGRAVITY_HTTP_COMPOSED` | — | — | **COMPOSED — illustrative only** |

`ANTIGRAVITY_HTTP_COMPOSED` is labelled, and no test may rely on it: the Antigravity config file was
**absent** on this machine, so no live entry could be read. Re-capture it on a machine that has the
file before depending on it. It is included only so the shape is visible next to the others.

## A divergence this capture surfaced

The captures showed something the hand-composed fixtures had hidden:

* **Both live clients hold a keyless stdio proxy** — `mcp_servers.opencadre-session` →
  `opencadre-mcp.mjs --client codex|claude-code`. Neither live config contains a URL or a Bearer
  token; `grep -c http_headers ~/.codex/config.toml` returns **0**.
* **The connect writer on `main` still emits HTTP+Bearer** (`cli/lib/clients.mjs`), and the previous
  tests composed only that shape — `connect-cli.test.ts` composed it 6 times and referenced the proxy
  **0** times.

Both paths are shipped, so this is **not** a claim that the tests are wrong — it is that they were
**incomplete**, which is exactly what the rule is for. Fixtures for both shapes are provided here.
Which shape is preferred going forward is a question for the client table's owner, not for a fixture
file to decide.

## How to use these

```ts
import { REASONIX_CANONICAL, CLAUDE_STDIO } from "./fixtures/client-configs";
```

Write the fixture to a temp home, point the reader at it, and assert on the resolved **value** — not
on an absence. An assertion that passes when nothing is found is the failure mode these fixtures
exist to prevent.