# Upgrading OpenCadre

OpenCadre runs on your computer as a set of helper files in `~/.opencadre/bin`, plus OpenCadre's
entries in each connected tool's settings. **One command brings both up to date.** This page covers
what that command changes, what it leaves alone, and what you may need to do afterwards.

---

## 1. Get the command and run it

Copy the upgrade command from one of these places:

- **The console:** **Add a computer** → **Update a connected computer** → **Get current upgrade command**.
- **An update notice in a chat:** *OpenCadre connector update available (optional) … Upgrade command: …*
- **`doctor`**, when it finds this computer's helpers out of date.

It looks like this:

```bash
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz connect --upgrade
```

**Always copy the whole command, stamp included.** `<stamp>` names one build of the CLI. npx keeps a
package by its URL, so a bare `…/cli/opencadre-cli.tgz`, or a command you saved a while ago, can run an
older CLI and reinstall older helpers. The upgrade checks for this first: it asks the hub which build
is current, and if the CLI you ran isn't that build, it changes nothing and prints the current command.
If the hub can't be reached, it also changes nothing.

Before you run it, save your work and close the tools you use with OpenCadre. To see what would
change without writing anything, add `--dry-run`.

## 2. What changes, and what doesn't

**What changes:**

- **The helpers.** They're installed as a new version (a *generation*) under `~/.opencadre/bin`. The
  paths your tools point at stay the same, and new processes started from them use the new version.
  Earlier versions stay on disk.
- **OpenCadre's own entries in your tools' settings**, for tools already connected on this computer:
  Claude Code, Codex, Cursor, Gemini CLI and Qwen Code. For example, an upgrade moves Claude Code's
  approval gate from `Bash` to `Bash|PowerShell`.

**What doesn't change:**

- Anything in those settings files that isn't OpenCadre's: your own hooks, servers and options.
- Tools that aren't connected to OpenCadre. The upgrade never connects a new tool.
- An OpenCadre hook you removed. It isn't added back, but it's listed, and `connect` adds it if you
  want it.
- A hook or server you switched off. It stays off.
- A helper file edited on this computer. It's left alone and listed. Adding `--force` backs it up,
  then replaces it.
- Hooks that run OpenCadre's helpers from somewhere else, such as a repository checkout. They're left
  alone and listed.
- Other connected tools, such as OpenCode or Amp. The upgrade tells you when their settings are out of
  date, and `connect --client <tool>` updates them.
- This computer's credential.

## 3. Read the result

The upgrade prints one result line. If anything needs you, a numbered **What you need to do** list
follows, grouped by tool. (Older versions of the CLI print these items as lines starting `TO DO:`.)
It ends by saying whether backups were made, and where the full report is: `~/.opencadre/last-upgrade.txt`,
or add `--verbose` to print it.

| Exit code | Meaning |
|---|---|
| `0` | Up to date. Nothing for you to do. |
| `3` | Updated. The list says what's left for you. |
| `2` | Not finished, or refused before changing anything. Do what the message says. If it says the CLI you ran isn't the hub's current one, run the command it prints, not the same one again. If it names a file or a hub that couldn't be reached, fix that, then run the same command again. |
| `1` | An error stopped it. The message says what happened. |

### Approving changed hooks

**Codex** records each hook's settings. When an upgrade changes one (a matcher, for example), Codex
may list that hook for review and not run it until you trust it. OpenCadre can't see whether Codex has
done this, so it asks you to check:

- **Codex app:** send one ordinary message in the folder you work in (Codex lists a folder's hooks
  only after a chat has run there), then open **Settings → Hooks** and trust each OpenCadre hook
  listed for review.
- **Codex CLI:** run `/hooks` and do the same.

While a hook is waiting for review, Codex may not run it, so OpenCadre's awareness, usage reporting
and approval gate may be off there.

**Claude Code** keeps no approval record per hook, so there's nothing to approve. New sessions use
the changed settings.

**Cursor, Gemini CLI and Qwen Code:** OpenCadre doesn't know whether these record approval per hook.
If one asks you to allow OpenCadre's hooks or its server, allow them.

### Other items you may see

- **Not added back:** an OpenCadre hook you may have removed on purpose. Run `connect` if you want it.
- **Left alone:** a file OpenCadre won't change on its own, with the reason and the command that does.
- **Restart these:** processes that were still running when you used `--force`. Restart them so they
  load the new helpers.
- **Could not be read, or changed by another program during the upgrade:** the message names the file
  and says whether it was changed. Fix what it names, then run the same command again.

## 4. Open chats

Each OpenCadre helper picks its version when its process starts:

- **Long-running parts**, such as the connection to the OpenCadre server that a tool starts with a chat,
  keep the version they started with until that tool or chat is restarted.
- **Short-lived hooks**, which a tool starts fresh for each event, use the new version from their next
  run, even inside a chat that was already open.

So an open chat can briefly mix old and new parts. To avoid that, save your work and close your tools
before upgrading, then reopen them afterwards.

## 5. Backups and rolling back

Every settings file the upgrade changes is first copied to `<file>.bak-<timestamp>` in the same
folder, for example `~/.claude/settings.json.bak-2026-10-02T00-13-32-846Z`. The full report lists
each one. A helper replaced with `--force` is first copied to `~/.opencadre/bin/.backup/<timestamp>/`.

To undo a change to a settings file, close the tool, then copy the backup back over the file:

```bash
cp ~/.claude/settings.json.bak-<timestamp> ~/.claude/settings.json
```

```powershell
Copy-Item "$HOME\.claude\settings.json.bak-<timestamp>" "$HOME\.claude\settings.json"
```

Then start a new session. The next upgrade makes the same change again.

There's no command to switch the helpers back to an earlier version. Earlier versions are kept on
disk, not deleted.

## 6. Update notices

By default, OpenCadre's hooks check the hub at most once every six hours and tell a chat when an
update is available. They never install anything: you run the upgrade yourself.

```bash
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz update --status         # the policy in effect, and why
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz update --policy off     # no background update checks
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz update --policy notify  # the default
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz update --check          # check the hub once, now
```

With `off`, `doctor` and `update --check` still check when you run them. `off` covers update checks
only: OpenCadre's hooks still report which connector build this computer runs to your hub, using this
computer's credential, so the console can show it per computer. That report installs nothing and isn't
an update check. Automatic updates aren't available.

## 7. Check health with doctor

After upgrading, check each tool you use:

```bash
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz doctor --client codex
```

Use `--client claude-code`, `--client cursor` and so on for the others. `doctor` only reads; it
changes nothing. For Codex, exit code `3` is the best result `doctor` can give: it can see what
OpenCadre changed, but not whether Codex trusts the hooks, so it asks you to check. Every line it
prints is explained in [troubleshooting.md](./troubleshooting.md).
