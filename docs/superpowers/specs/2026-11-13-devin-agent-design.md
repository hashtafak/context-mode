# Devin CLI agent support — design

Date: 2026-11-13 · Branch: `devin-agent` · Status: draft for approval

## Intent and why

Add Devin CLI as a supported agent so this fork delivers context-mode's
sandbox + FTS5 search + session continuity inside Devin sessions. Devin is not
one of the upstream 10 agents; this is a private fork, so we extend
`AGENT_IDS` ourselves rather than working around the closed list.

Upstream reference: https://github.com/mksglu/context-mode
Prior research: `FINDINGS.md` at repo root (untracked, main checkout).

## Goals

- `context-mode setup --agents devin` installs everything Devin needs:
  MCP server entry, lifecycle hooks, skills.
- `ctx_*` MCP tools work in Devin sessions; hook pipeline (policy deny,
  sandbox redirect, session recall, stats, doctor) works end-to-end.
- Runtime enforcement strictness selectable without reinstalling
  (env var + optional per-project file, read on every hook invocation).
- `doctor`, `stats`, `uninstall` understand the devin agent.

## Non-goals

- No upstream PR, no marketplace packaging, no Devin plugin format
  (Devin has none — we emit plain `.devin/` config files).
- No changes to the other 10 agents' behavior.

> Correction vs FINDINGS.md: Devin **does** support PostToolUse
> `hookSpecificOutput.updatedToolOutput` since CLI v3000.11.205
> (2026-10-22 changelog). The earlier docs page was stale. The replace
> path is therefore IN scope — Devin joins `REPLACE_ROWS`, restoring the
> ~99% ceiling. Exact `updatedToolOutput` value shape for Devin's
> `tool_response {success, output, error}` must be verified in a spike
> (expected: the `output` string).

## Anti-goals

- Blocking `read`/`grep` by default — kills code exploration; keeps the
  realistic savings ceiling ~95%, not 99%.
- A separate sidecar hook script duplicating policy logic — must reuse
  `decide()` so deny rules and stats stay consistent.

## Constraints

- Devin hook contract (docs.devin.ai/cli/extensibility/hooks +
  v3000.11.205 changelog + community-verified quirks):
  - Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
    `PostCompaction`, `SessionStart`, `SessionEnd`.
  - stdin: `hook_event_name`, `tool_name`, `tool_input`, `session_id`,
    `prompt_id`; PostToolUse adds `tool_response: {success, output, error}`
    where `output` is a plain string. **No `cwd` field** — project dir
    comes from env `DEVIN_PROJECT_DIR`.
  - stdout control: `decision: "approve"|"block"` + `reason`;
    `hookSpecificOutput.{hookEventName, additionalContext}`;
    `updatedInput` (PreToolUse only);
    **`updatedToolOutput` (PostToolUse, v3000.11.205+)**.
  - `hookEventName` in the reply MUST echo the firing event's name or the
    reply is dropped (community-verified).
  - `additionalContext` under **PreToolUse is silently dropped** — hints
    must ride PostToolUse / UserPromptSubmit / SessionStart.
  - Exit codes: 0 ok, 2 block, other = logged error.
  - `.devin/hooks.v1.json` is a **root event map with no `"hooks"`
    wrapper**: `{"PreToolUse": [...]}`.
  - User-level hooks: `"hooks"` key inside `~/.config/devin/config.json`
    (`%APPDATA%\devin\config.json` on Windows).
  - MCP servers: `.devin/mcp_config.json` (project) or
    `~/.config/devin/mcp_config.json` (user); tool names appear as
    `mcp__<server>__<tool>`.
  - Skills: `.devin/skills/<name>/SKILL.md` or `~/.config/devin/skills/`
    (`%APPDATA%\devin\skills` on Windows).
  - Hook `command` runs through the system shell (Git Bash on Windows).
- Devin built-in tool names and `tool_input` keys (from the CLI's own tool
  schemas — the policy engine keys on these):
  - `exec`: `{command, shell_id?, workdir?, timeout?, env?}` → canonical
    Bash policy reads `command`.
  - `read`: `{file_path, offset?, limit?, ...}` → `file_path`.
  - `edit`: `{file_path, old_string, new_string, replace_all?}` → `file_path`.
  - `write`: `{file_path, content}` → `file_path`.
  - `grep`: `{pattern, path?, glob_pattern?, ...}` → grep policy.
  - `find_file_by_name`: `{pattern, path?}` → treated as grep/glob.
  - `webfetch`: `{url}` → WebFetch policy reads `url`.
  - `notebook_edit`: `{notebook_path, ...}` → edit-class.
  All names already match canonical policy keys (`command`, `url`,
  `file_path`) — no field renaming needed; `nativeTools` mapping suffices.
- Repo engines: Node >= 24.15.0 (dev machine runs 22 — warning only so far).
- Minimum Devin CLI for full function: v3000.11.205 (PostToolUse
  `updatedToolOutput`). `ctx_doctor` should warn below that and the row
  can degrade `hasReplace` dynamically if we implement a version probe —
  default: require it, document it.
- Worktree `.worktree/devin`, branch `devin-agent`; `main` untouched.

## Approaches considered

- **A. Full citizen (chosen).** `"devin"` joins `AGENT_IDS`; new
  `src/adapters/devin.ts`; new `AdapterRow`; setup/doctor/stats learn the
  `.devin/` paths. Reuses the whole decide/index/store pipeline.
- B. Adapter-only module outside `AGENT_IDS`. Rejected: `AgentId` type is
  derived from `AGENT_IDS`; would need type hacks and duplicate setup code.
- C. External sidecar script. Rejected: loses policy engine, deny rules,
  session recall, stats — most of the value.

## Design

### 1. Agent registration

- `src/core/contracts/agents.ts`: append `"devin"` to `AGENT_IDS` (order:
  end of list — keeps existing rows' indices stable).
- Audit every `AGENT_IDS.length` / "10 agents" assumption: `constants.ts`
  (~lines 198, 840–843, 1043, 1097–1099), `setup/print.ts`, `stats.ts`,
  `doctor.ts`, README/docs counts. Most are display strings; fix to derive
  from `AGENT_IDS.length` where cheap, else update literal.

### 2. Adapter (`src/adapters/devin.ts`)

Follows `codex.ts` pattern (Claude-shape decode, custom encode) because
Devin's payload is close to Claude's but not identical:

- `decode`: parse `hook_event_name` ∈ {SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse} (+ map `PostCompaction` → canonical `PreCompact`
  so the pending-flag compaction path works; Devin fires it *after*
  compaction, which still delivers recall at the next prompt — builder
  verifies timing in e2e).
  - `tool_name`/`tool_input` pass through; `tool_response` is
    `{success, output, error}` — `output` is a plain string, so
    `ToolResultInfo.text = output`, `isError = !success`.
    No `shape`/`blocks`/`persistedPath` (replace is off anyway).
  - `callId`: no `tool_use_id` in Devin payload → reuse the claude-code
    FNV fallback (`"h" + fnv1a(name + input + turn)`).
  - `cwd`: `process.env.DEVIN_PROJECT_DIR || process.cwd()`.
  - `sessionId`: `session_id`; `prompt`: UserPromptSubmit `prompt` field.
- `encode`: Devin output contract —
  - allow → empty stdout, exit 0
  - hint → `hookSpecificOutput.additionalContext` with
    `hookEventName` echoing the firing event (required or dropped).
    NOTE: `additionalContext` is silently dropped on **PreToolUse** —
    hint decisions must only be emitted on PostToolUse /
    UserPromptSubmit / SessionStart (policy `decide()` already gates
    hint emission; verify per-event in e2e).
  - deny → `{"decision":"block","reason":<reason>}` (exit 0; reason is
    shown to the agent — matches "deny-reason" channel semantics).
    Verify in smoke test that block truly prevents execution.
  - replace → PostToolUse `hookSpecificOutput.updatedToolOutput`.
    `tool_response.output` is a plain string, so the replace value is
    the selected-output string (expected shape; spike verifies whether
    Devin wants the bare string or a wrapped object).
- `TOOL_NAME_PREFIX`: `"mcp__context-mode__"` (server name `context-mode`).

### 3. AdapterRow (`src/adapters/table.ts`)

```ts
{
  id: "devin",
  installMode: "hooks+mcp",
  projectSource: "spawn-cwd",   // Devin spawns the MCP server with cwd = project root (same as gemini); verify in smoke test, fallback env:DEVIN_PROJECT_DIR for hooks
  toolNamePrefix: devin.TOOL_NAME_PREFIX,
  nativeTools: {
    shell: ["exec"],
    read: ["read"],
    grep: ["grep", "find_file_by_name"],
    webfetch: ["webfetch"],
    edit: ["write", "edit", "notebook_edit"],
  },
  execReadOnlyHint: false,
  eventMap: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit",
              PreToolUse: "PreToolUse", PostToolUse: "PostToolUse",
              PreCompact: "PostCompaction" },
  compactDelivery: "pending-flag",
  compactSummary: "none",
  hookTimeoutMs: HOOK_TIMEOUT_MS,
  denyChannel: "deny-reason",   // verify block actually denies in e2e; else "hint-only"
  hookChannel: { kind: "home-file", path: <devin user config> },
  skillChannel: { kind: "home-dir", path: <devin user skills dir> },
  decode: devin.decode, encode: devin.encode,
}
```

Add `"devin"` to `REPLACE_ROWS` and `DUMP_REPLACE_ROWS` (PostToolUse
`updatedToolOutput` exists on v3000.11.205+). Add to `RECALL_ROWS` if
the UserPromptSubmit `additionalContext` path verifies (expected yes).

`spawn-cwd` already exists as a `ProjectSourceKind` (gemini uses it) —
no type change needed if the MCP server indeed inherits the project cwd;
otherwise fall back to adding `"env:DEVIN_PROJECT_DIR"`.

### 4. Setup / install (`src/setup/`)

Devin has no plugin system; setup writes config files directly (like
codex's `config-mcp` / zcode's `hooks+mcp` modes):

- **User-level (default):** merge into Devin user config —
  `~/.config/devin/config.json` hooks key (or dedicated
  `hooks.v1.json`? — Devin reads `"hooks"` inside user config.json) and
  `~/.config/devin/mcp_config.json` `mcpServers."context-mode"` entry:
  `{"command":"node","args":["<pkg>/server.mjs","--agent","devin"]}`.
  Windows: `%APPDATA%\devin\` equivalents — the setup engine's home
  resolution must map this (verify; copilot-cli already writes
  `.copilot/...` home files, so a home-file channel exists).
- **Project-level (`--project` flag or cwd `.devin/`):** write
  `.devin/hooks.v1.json` + `.devin/mcp_config.json` in the project —
  requires a new HookChannel/SkillChannel kind (`"project-file"`) or
  reuse home-file with DEVIN_PROJECT_DIR. Decide during planning; default
  to user-level only for v1 of this fork.
- New `src/setup/devin-gate.ts` if the engine needs per-agent gating
  (pattern: `zcode-gate.ts`, `vscode-gate.ts`).
- `setup --remove` must cleanly remove hooks/mcp entries/skills it wrote
  (JSON merge must be surgical — other servers/hooks preserved).

### 5. Skills

Copy `skills/*` (ctx-doctor, ctx-stats, ctx-upgrade) into the devin skill
channel dir. Optionally a `ctx-usage` skill teaching strictness levels —
small, included if cheap.

### 6. Runtime enforcement strictness

New env var `CONTEXT_MODE_ENFORCE` = `off | voluntary | moderate |
aggressive`, read by the hook process on every invocation (hook is a
per-call process → truly runtime). Resolution order:

1. `CONTEXT_MODE_ENFORCE` env (set in the hook command line or user env)
2. `<project>/.context-mode/enforce.json` → `{"level": "..."}`
   (per-project override; also writable by the agent via ctx_execute)
3. default `moderate`

Levels gate ONLY context-mode's own redirects/denies — the user's own
deny rules (`user-deny.ts`) always apply at every level, including
`off` (they are explicit user policy, not context-mode behavior). This
is a deliberate call: `off` disables sandbox redirection, not security.

- `off` — context-mode never denies/redirects; ctx_* tools still work.
- `voluntary` — no blocks; hints where the host accepts them.
- `moderate` — deny/redirect obvious heavy shell patterns (builds, full
  logs, `cat` of large files); `read`/`grep`/`webfetch` untouched.
- `aggressive` — also redirect `webfetch` and oversized-read heuristics;
  `read`/`grep` still native (they're the exploration path).

Implementation: a small `src/core/policy/enforce.ts` consulted by
`decide()`; the level is part of hook context, not persisted state.
Existing `D10 enforcement mode` doctor check extended to print the
resolved level + source.

### 7. MCP server agent arg

`server.mjs --agent devin` — server entry validates against `AGENT_IDS`;
adding "devin" covers it. `TOOL_NAME_PREFIX` for journal/policy
attribution: `mcp__context-mode__`.

### 8. Tests

- Unit: `src/adapters/devin.ts` decode/encode against captured Devin
  hook payloads (fixtures under `tests/` following existing adapter
  tests).
- e2e: `e2e/cases/` — add a devin case replaying hook payloads through
  `hook.mjs` (the e2e harness feeds payloads; no live Devin needed).
- Manual smoke (needs Devin CLI installed): `setup --agents devin`,
  `ctx_doctor`, one `ctx_execute`, one blocked `exec`.

## Open items for the builder

- Exact shape Devin expects for `updatedToolOutput` when
  `tool_response = {success, output, error}` — bare string vs object.
  Spike first; if it must be an object, wrap as `{output: <string>}`
  matching the input shape.
- Whether Devin's MCP server process inherits the project cwd
  (`spawn-cwd`) or needs `DEVIN_PROJECT_DIR`-style env injected via
  `mcp_config.json` `env` — affects `projectSource` and session identity
  for `ctx_resume`/session-scoped search.
- Whether `decision:"block"` on PreToolUse truly prevents execution and
  surfaces `reason` to the agent (docs say yes; verify in smoke test).
- Whether PostCompaction→PreCompact mapping delivers recall correctly.
- Local Devin CLI version must be ≥ v3000.11.205 for replace; check
  `devin --version` before smoke testing.
- Whether Devin hook commands run via Git Bash on Windows (context-mode
  requires bash for sandbox) — `command` is a shell string; test.
