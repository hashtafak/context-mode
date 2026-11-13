# Devin CLI Agent Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Devin CLI as an 11th supported agent — adapter, setup/doctor/stats plumbing, runtime enforcement levels — in this private fork.

**Architecture:** Follow the existing per-agent pattern: `src/adapters/devin.ts` decodes Devin's hook payloads into `CanonicalHookEvent` and encodes `Decision`s back into Devin's hook output contract; a new `AdapterRow` in `table.ts` wires native tool names, event map, and install channels; `src/setup/` learns Devin's user-level config files (`config.json` hooks key + `mcp_config.json`).

**Tech Stack:** TypeScript (Node >= 24.15.0, runs on 22 with warning), node:test `.mjs` tests, esbuild bundle via `npm run build:release`.

**Spec:** `docs/superpowers/specs/2026-11-13-devin-agent-design.md` (same dir as this plan's parent; read it first)

## Global Constraints

- Devin hook contract (verified against local CLI 3000.12.28): stdin `{hook_event_name, tool_name, tool_input, session_id, prompt_id}`; PostToolUse adds `tool_response:{success,output,error}` (`output` is a string); **no `cwd`** — project dir is env `DEVIN_PROJECT_DIR`.
- stdout reply MUST echo the firing event name in `hookSpecificOutput.hookEventName` or it is dropped.
- `additionalContext` is silently dropped on PreToolUse — hints only on SessionStart/UserPromptSubmit/PostToolUse.
- `decision:"block"` + `reason` denies (exit 0); `updatedInput` merges tool args (PreToolUse only); `updatedToolOutput` replaces the tool result (PostToolUse, v3000.11.205+).
- Devin user config dir: `%APPDATA%\devin` on win32, `~/.config/devin` otherwise. Files: `config.json` (`"hooks"` key, Claude-shaped event map), `mcp_config.json` (`mcpServers`), `skills/<name>/SKILL.md`.
- `.devin/hooks.v1.json` is project-level only — NOT used; we install user-level.
- Worktree `.worktree/devin`, branch `devin-agent`. `main` untouched. Commit style: `type: summary` (see `git log`).
- `denyChannel: "deny-reason"`, `installMode: "hooks+mcp"`, `compactDelivery: "pending-flag"`, `compactSummary: "none"`, `execReadOnlyHint: false`, `hookTimeoutMs: HOOK_TIMEOUT_MS`.
- `projectSource: "spawn-cwd"` (verify in smoke; fallback `"env:DEVIN_PROJECT_DIR"` — would need a new `ProjectSourceKind`).

## Review Focus

- Devin versions < 3000.11.205 lack `updatedToolOutput` → replace must degrade to allow, never emit the field. Test: encode on a fake old-version path or gate behind a version probe (Task 4 smoke decides; unit test pins the fallback).
- `tool_response.output` may be non-string or missing on tool errors → decode must not throw; `isError` from `success===false`.
- `decision:"block"` reason text must contain the ctx_* redirect instructions or the agent can't recover → deny encode test asserts reason carries `ctx_execute` hint text.
- `AGENT_IDS`-derived display strings ("10 agents") in `setup/print.ts`, `stats.ts`, README → audit task; a stale "10" is user-visible.
- `hooks` merge in `config.json` must preserve user's other config keys (permissions, agent, etc.) → setup merge test.

---

### Task 1: `src/adapters/devin.ts` — decode/encode

**Files:**
- Create: `src/adapters/devin.ts`
- Modify: `src/core/contracts/agents.ts` (append `"devin"` to `AGENT_IDS`)
- Modify: `src/adapters/table.ts` (import + row; add to `REPLACE_ROWS`, `DUMP_REPLACE_ROWS`, `RECALL_ROWS`)
- Test: `tests/0020-adapters.test.mjs` (add devin block, follow existing per-agent pattern)

**Interfaces:**
- Produces: `TOOL_NAME_PREFIX = "mcp__context-mode__"`, `decode(raw: unknown): CanonicalHookEvent`, `encode(ev: CanonicalHookEvent, d: Decision): HookOutput` — same signatures as `codex.ts`.
- `NATIVE_TO_CANONICAL` (private): `exec→Bash`, `read→Read`, `notebook_read→Read`, `grep→Grep`, `glob→Grep`, `find_file_by_name→Grep`, `webfetch→WebFetch`, `edit→Edit`, `write→Write`, `apply_patch→Edit`, `notebook_edit→Edit`. Own-prefix strip and `mcp__<srv>__<tool>` → `mcp:<srv>:<tool>` same as `canonicalName()` in claude-code.ts (reuse or copy the 8-line helper — copy, adapters are self-contained).
- Consumes: types from `../core/contracts/types.ts`; `Decision`, `HookOutput`, `CanonicalHookEvent`, `ToolResultInfo`.

- [ ] **Step 1: Write failing decode/encode tests** in `tests/0020-adapters.test.mjs`:
  - decode `PreToolUse` `{hook_event_name:"PreToolUse", tool_name:"exec", tool_input:{command:"ls"}, session_id:"s1", prompt_id:"p1"}` → `event:"PreToolUse"`, `agent:"devin"`, `tool.canonicalName:"Bash"`, `tool.input.command:"ls"`, `cwd === process.env.DEVIN_PROJECT_DIR ?? process.cwd()`.
  - decode `PostToolUse` `{..., tool_name:"exec", tool_response:{success:true, output:"hello", error:null}}` → `result.text === "hello"`, `isError === false`.
  - decode same with `success:false` → `isError === true`.
  - decode `webfetch` → canonical `WebFetch`; `apply_patch`/`notebook_edit` → `Edit`; `write` → `Write`; `glob` → `Grep`.
  - decode `SessionStart` `{source:"startup"}` → `source:"startup"`; `{source:"resume"}` → `"resume"`.
  - decode `PostCompaction` → `event:"PreCompact"`.
  - decode `UserPromptSubmit` `{prompt:"hi"}` → `ev.prompt === "hi"`.
  - encode allow → `{stdout:"", exitCode:0}`; hint on `UserPromptSubmit` → JSON with `hookSpecificOutput.hookEventName:"UserPromptSubmit"` + `additionalContext`; hint on `PreToolUse` → empty stdout (dropped); deny → `{decision:"block", reason}`; replace on `PostToolUse` → `hookSpecificOutput.updatedToolOutput` = the output string; replace on other events → empty.
- [ ] **Step 2: Run tests, verify they fail** — `node --test tests/0020-adapters.test.mjs` (check how the file is invoked; `npm test` may not exist — use the repo's test runner, see `package.json`/CI).
- [ ] **Step 3: Implement `src/adapters/devin.ts`** modeled on `gemini.ts`/`codex.ts`:
  - `DEVIN_EVENTS` reverse map: `SessionStart→SessionStart`, `UserPromptSubmit→UserPromptSubmit`, `PreToolUse→PreToolUse`, `PostToolUse→PostToolUse`, `PostCompaction→PreCompact`. Unknown event → throw (same style as gemini).
  - `DEVIN_SOURCES`: `{startup:"startup", resume:"resume"}`.
  - `HINT_EVENTS = ["SessionStart","UserPromptSubmit","PostToolUse"]` (PreToolUse additionalContext is dropped by Devin).
  - `readResult`: `text = typeof resp.output === "string" ? resp.output : JSON.stringify(resp)`; `isError = resp.success === false`; no `shape`/`blocks`/`keep`/`persistedPath`.
  - `callId` fallback: copy claude-code's FNV-1a (`"h"+fnv1a(name+"\0"+JSON.stringify(input)+"\0"+turn)`) when `tool_use_id` absent — Devin never sends it.
  - `cwd`: `process.env.DEVIN_PROJECT_DIR || process.cwd()`.
  - `encode`: allow→EMPTY; hint→only HINT_EVENTS, `hookSpecificOutput:{hookEventName: ev.event === "PreCompact" ? "PostCompaction" : ev.event, additionalContext}` — IMPORTANT: echo the NATIVE event name, so keep a reverse lookup (canonical `PreCompact` → native `PostCompaction`); deny→`{decision:"block", reason: d.rewritten ? d.rewritten+"\n"+d.reason : d.reason}`; replace→PostToolUse only: `{hookSpecificOutput:{hookEventName:"PostToolUse", updatedToolOutput: d.output}}`, else EMPTY.
  - Top-level `decision` vs `hookSpecificOutput`: deny uses top-level `{"decision":"block","reason":...}` per docs.
- [ ] **Step 4: Register** — `AGENT_IDS` append `"devin"`; `table.ts` import `* as devin`, add row:
  ```ts
  {
    id: "devin", installMode: "hooks+mcp", projectSource: "spawn-cwd",
    toolNamePrefix: devin.TOOL_NAME_PREFIX,
    nativeTools: { shell: ["exec","get_output"], read: ["read","notebook_read"],
      grep: ["grep","glob","find_file_by_name"], webfetch: ["webfetch"],
      edit: ["edit","write","apply_patch","notebook_edit"] },
    execReadOnlyHint: false,
    eventMap: { SessionStart:"SessionStart", UserPromptSubmit:"UserPromptSubmit",
      PreToolUse:"PreToolUse", PostToolUse:"PostToolUse", PreCompact:"PostCompaction" },
    compactDelivery: "pending-flag", compactSummary: "none",
    hookTimeoutMs: HOOK_TIMEOUT_MS, denyChannel: "deny-reason",
    hookChannel: { kind: "home-file", path: ".config/devin/config.json" },
    skillChannel: { kind: "home-dir", path: ".config/devin/skills" },
    decode: devin.decode, encode: devin.encode,
  }
  ```
  Add `"devin"` to `REPLACE_ROWS`, `DUMP_REPLACE_ROWS`, `RECALL_ROWS`.
- [ ] **Step 5: Run adapter tests + `npm run typecheck`** — all pass.
- [ ] **Step 6: Commit** — `feat: add devin adapter (decode/encode, agent registration)`.

### Task 2: Setup/doctor plumbing for Devin's config files

**Files:**
- Modify: `src/core/project/config-dir.ts` (add `devinDirOf`)
- Modify: `src/core/contracts/constants.ts` (`AGENT_HOME_DIR.devin`, `OWN_MCP_ENTRY.devin`, audit "10 agents" literals ~lines 198/840/1043/1097)
- Modify: `src/setup/registry.ts` (`agentPath` devin branch, `ownMcpFileOf` call path, `hookFilesFor` devin case, `LIST.devin`)
- Modify: `src/setup/hook-shapes.ts` (`HOOK_SHAPES.devin`)
- Modify: `src/setup/hook-sample.ts` (devin golden payload case ~line 62)
- Test: `tests/0019-setup-engine.test.mjs`, `tests/0020-fire-hook-config.test.mjs`, `tests/0020-hooks-all.test.mjs` (follow existing agent cases)

**Interfaces:**
- Produces: `devinDirOf(env, home, platform?): string` — win32: `join(env.APPDATA ?? join(home,"AppData","Roaming"), "devin")`; else `join(home, ".config", "devin")`. (`APPDATA_ENV` constant already exists.)
- `OWN_MCP_ENTRY.devin = { file: [".config","devin","mcp_config.json"], key: ["mcpServers", SERVER_KEY] }` — JSON format, `ownMcpValue` supplies `{command,args}`.
- `HOOK_SHAPES.devin = (row, cmd) => nestedShape(row, cmd, seconds(row), true)` — nestedShape already yields `{"hooks":{<Event>:[{matcher?,hooks:[{type,command,timeout}]}]}}`, exactly Devin's `config.json` `"hooks"` value.
- Consumes: Task 1's `AdapterRow` (`hookChannel.path`, `skillChannel.path` are segments under the devin dir).

- [ ] **Step 1: Failing tests** — setup-engine test asserting `buildRegistry` produces for devin: `config.file` ends with `mcp_config.json` under the platform-correct devin dir (win32 → APPDATA, else `~/.config/devin`); `hookInstall.file` ends with `config.json` in same dir; hook shape JSON has `hooks.PreToolUse[0].matcher` matching `exec` and `hooks.PostToolUse` present; `skillInstall.dir` ends with `skills`. Copy the closest existing agent's test block (kiro or vscode — also home-file + home-dir).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement**:
  - `config-dir.ts`: `devinDirOf` + `DEVIN_DIR_ENV`? Devin has no env override for config dir — skip env, document.
  - `constants.ts`: `AGENT_HOME_DIR.devin = [".config","devin"]` (POSIX default; win32 handled by `devinDirOf`); `OWN_MCP_ENTRY.devin` as above. Grep `"10 agents"`/`AGENT_IDS.length` literals in `print.ts`, `stats.ts`, `doctor.ts`, README — replace literals with derived counts where trivial, else update text to 11.
  - `registry.ts` `agentPath`: add `if (id === "devin")` branch — map segments `[".config","devin", ...rest]` → `join(devinDirOf(ctx.env, ctx.home, ctx.platform), ...rest)`; `[".devin", ...]` → project dir (not used v1). Apply same rule in `ownMcpFileOf` (config-dir.ts) for `agent === "devin"`: `join(devinDirOf(env, home), ...file.slice(2))`.
  - `hookFilesFor`: `case "devin": return [{ file: path.join(devinDirOf(ctx.env, home, ctx.platform ?? process.platform), "config.json"), mode: "rewrite" }]`.
  - `hook-sample.ts`: add devin golden payload — same shape as claude-code's but `tool_name:"exec"`, `tool_input:{command:"true"}`, **no `cwd` field** (Devin doesn't send one; include `DEVIN_PROJECT_DIR` note if the harness supports env).
  - `LIST.devin = { bin: "devin", args: ["mcp", "list"] }` — verify `devin mcp list` exists (`devin mcp --help`); if not, omit.
- [ ] **Step 4: Run setup-engine + hooks-all + fire-hook-config tests + typecheck.**
- [ ] **Step 5: Commit** — `feat: setup/doctor support for devin agent`.

### Task 3: Runtime enforcement strictness (`CONTEXT_MODE_ENFORCE`)

**Files:**
- Create: `src/core/policy/enforce.ts`
- Modify: `src/core/policy/decide.ts` (gate context-mode denies after user-deny step)
- Modify: `src/core/hooks/dispatch.ts` (gate PostToolUse replace path)
- Modify: `src/core/tools/doctor.ts` or setup doctor check (print resolved level)
- Test: `tests/0008-enforcement.test.mjs` (extend) or new `tests/0024-devin-enforce.test.mjs`

**Interfaces:**
- Produces: `enforceLevelOf(env: NodeJS.ProcessEnv, projectDir: string): "off"|"voluntary"|"moderate"|"aggressive"` — resolution: `env.CONTEXT_MODE_ENFORCE` → `<projectDir>/.context-mode/enforce.json` `{"level":...}` → `"moderate"`. Invalid values → `"moderate"`. Add `ENFORCE_ENV = "CONTEXT_MODE_ENFORCE"` and `ENFORCE_FILE = "enforce.json"` to constants.
- `levelAllowsDeny(level)`: `off|voluntary` → false; `moderate|aggressive` → true.
- `levelAllowsReplace(level)`: `off` → false; others → true.
- Consumes: called inside `decide()` after the user-deny block (user deny ALWAYS applies, every level) and inside dispatch's replace branch.

- [ ] **Step 1: Failing tests** — with `CONTEXT_MODE_ENFORCE=off`, a PreToolUse `exec` curl-dump payload that normally denies returns allow; user-deny rule still denies at `off`; `voluntary` allows deny-path but replace still emitted on PostToolUse; `aggressive` behaves as `moderate` for now (document: aggressive adds unbounded-Read deny only if trivial — otherwise mark aggressive==moderate with a TODO comment referencing this plan).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `enforce.ts`** (tiny: env read, JSON file read with try/catch, level validation) + wire into `decide()` (after `userDenyHit`, before `webFetch`) and dispatch replace gate (find where `replace` Decision is produced for PostToolUse — grep `kind: "replace"` in dispatch.ts).
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `feat: CONTEXT_MODE_ENFORCE runtime levels`.

### Task 4: Skills, docs, e2e fixture, live smoke

**Files:**
- Modify: `README.md` agent list/count; `docs/install/` — add `devin.md` if a per-agent install doc pattern exists (check `docs/install/`); `FINDINGS.md` correction note already in spec.
- Test/e2e: `e2e/cases/` — add devin payload fixture following existing per-agent fixtures (`e2e/fixtures/`); `tests/0023-install-docs.test.mjs` may pin doc counts.
- Skills: `skillChannel home-dir` copies `skills/ctx-*` automatically via `skillInstallFor` — verify rendered `SKILL.md` mentions `mcp__context-mode__ctx_*` names correctly (prefix render). Optionally add `skills/ctx-enforce/SKILL.md` documenting the 4 levels — only if the skill template makes it cheap.

- [ ] **Step 1: Update README/docs** — add Devin to supported agents table, install command `context-mode setup --agents devin`, note min CLI v3000.11.205 for full savings and Windows Git Bash requirement.
- [ ] **Step 2: e2e fixture** — capture real Devin hook payloads: temporarily install a logging hook in a scratch project's `.devin/hooks.v1.json` (`matcher:""`, command appends stdin to a file), run a Devin session, feed captured payloads into `e2e` harness. Fallback: hand-write fixtures from the documented schema.
- [ ] **Step 3: Live smoke** (needs `devin` CLI, installed: 3000.12.28):
  1. `node release-out/server.mjs` build first: `npm run build:release`.
  2. `context-mode setup --agents devin` (from built package) → verify `%APPDATA%\devin\config.json` hooks + `mcp_config.json` entries.
  3. New Devin session in a scratch repo → `/hooks` shows context-mode; `ctx_doctor` MCP tool passes; `ctx_execute` returns sandboxed output; a big `exec` output gets replaced (updatedToolOutput) — verify model sees truncated output + search hint.
  4. `CONTEXT_MODE_ENFORCE=off` → same big exec is NOT replaced.
- [ ] **Step 4: Commit** — `docs: devin agent install docs + e2e fixtures`.

## Self-review notes

- Spec coverage: adapter (T1), registration (T1), setup/doctor/uninstall (T2 — uninstall rides `runRemove`/manifest automatically once registry rows exist; verify in smoke), enforcement (T3), skills/docs/e2e (T4).
- `hasReplace`/`DUMP_REPLACE_ROWS`/`RECALL_ROWS` membership is the switch that enables PostToolUse replace + recall — pinned in T1 step 4.
- Open spike item from spec: exact `updatedToolOutput` shape — T4 step 3 verifies live; if Devin wants an object not a string, fix is one line in `devin.ts` encode.
