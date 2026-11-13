# Install context-mode v2 on Devin CLI

## Install

```sh
npm i -g context-mode
context-mode setup --agents devin
```

Update:

```sh
context-mode upgrade
```

Check: `context-mode doctor`

Devin CLI has no install command of its own that takes the package, so setup is the install path here. `npm i -g context-mode` also gives the `context-mode` command for doctor.

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents devin`. Without it, setup stops with exit 2.

Restart Devin CLI after setup.

To do the setup step by hand, run `context-mode setup --print devin` and follow what it prints.

## What setup changes

- Adds the `context-mode` entry to `mcpServers` in the Devin MCP config: `mcp_config.json` in the Devin user dir.
- Writes the hooks to the `hooks` key of `config.json` in the same dir: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and PostCompaction. PreToolUse matches the shell, read, grep, edit and fetch tools plus the `mcp__context-mode__ctx_*` tools; PostToolUse matches the same plus every other MCP tool, so a large MCP result is replaced too.
- Writes the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade` to `skills/<name>/SKILL.md` in the same dir.
- Effect: a large tool result is replaced by a short selection that names `ctx_search` (replace). This needs Devin CLI v3000.11.205 or later, which added PostToolUse `updatedToolOutput`; on an older CLI the replace is not applied.
- Backs up each file first. A failed step is rolled back byte for byte.
- Never edits `CLAUDE.md`, `AGENTS.md` or other instruction files.

The Devin user dir is `%APPDATA%\devin` on Windows and `$XDG_CONFIG_HOME/devin` on Linux and macOS when `XDG_CONFIG_HOME` is set, else `~/.config/devin`. Devin has no environment variable of its own for it; `XDG_CONFIG_HOME` is the standard one Devin honors.

## Verify

```sh
context-mode doctor --agents devin
devin mcp list
```

`context-mode` must be listed. Then run `/ctx-doctor` in Devin CLI.

## Remove

```sh
context-mode setup --remove --agents devin
```

It puts each touched file back. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- Full saving (the PostToolUse replace) needs Devin CLI v3000.11.205 or later. On Windows, hook commands run through Git Bash: install Git for Windows or the shell tools return `NO_GIT_BASH` and doctor check D11 fails.
- Devin sends no project dir in the hook payload; the hook uses `DEVIN_PROJECT_DIR` when set, else the directory the hook runs in. Run Devin from the project root.
- Devin drops a hook reply whose `hookEventName` does not echo the firing event; context-mode always echoes it.

## Report a problem

Run `context-mode doctor --agents devin`. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.

## Verified

Tested on Windows (win32), Node 24.15.0, Devin CLI 3000.12.28, the release build of this branch, against the real user config (`%APPDATA%\devin`). A clean-HOME run is not possible on Windows: `devin.exe` ignores the `APPDATA` override, so `devin mcp list` never sees a sandboxed `mcp_config.json` and setup's list check fails.

| Command | Devin version | Date | Result |
|---|---|---|---|
| `context-mode setup --yes --agents devin` | 3000.12.28 | 2026-11-13 | Pass: `config.json` hooks and `mcp_config.json` written, other keys kept |
| `context-mode doctor --agents devin` | 3000.12.28 | 2026-11-13 | Pass |
| `context-mode setup --remove --yes --agents devin` | 3000.12.28 | 2026-11-13 | Pass: files restored byte for byte |

A live `devin -p` session in a scratch git repo fired the hooks (5 loaded), the MCP server answered `ctx_resume`, a large `exec` output was replaced (8,944 B -> 174 B returned), `CONTEXT_MODE_ENFORCE=off` skipped the replace, and a large `read` was denied with the reason shown to the agent. The hook round trip is also covered by the recorded-payload replay in `e2e/fixtures/devin/`. Linux and macOS are not run.
