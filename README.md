# context-mode-devin

> **Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode)** adding first-class native support for **Devin CLI**, lifecycle hook integration, and runtime enforcement levels.
>
> 📖 **Original Documentation:** For upstream documentation, architecture, gateway guides, and all other supported coding agents, please refer to the [upstream README on GitHub](https://github.com/mksglu/context-mode#readme).

---

## 🚀 What's New in this Fork

This fork adds full support for **Devin CLI** alongside the original 10 supported agents:

1. **Native Devin Integration (no plugin marketplace needed)**:
   - `context-mode setup --agents devin` writes Devin's own config surfaces directly: the `"hooks"` key in the user `config.json` (`%APPDATA%\devin\config.json` on Windows, `~/.config/devin/config.json` or `$XDG_CONFIG_HOME/devin/config.json` on macOS/Linux), the `context-mode` entry in `mcp_config.json`, and skills in the Devin skills directory.
   - Both Devin config files are treated as JSONC end-to-end, so existing comments are preserved byte-for-byte.
2. **Lifecycle Hooks Integration**:
   - `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `PostCompaction` (mapped to the canonical compaction flow with recall delivered on the next prompt).
   - `PreToolUse`: Intercepts massive shell dumps, builds, and large reads, redirecting the agent to `ctx_execute`, `ctx_index`, and `ctx_search`.
   - `PostToolUse`: Rewrites oversized tool output via `hookSpecificOutput.updatedToolOutput` — requires **Devin CLI v3000.11.205 or later**.
3. **Runtime Enforcement Levels**:
   - Switch strictness dynamically via the `CONTEXT_MODE_ENFORCE` environment variable or a per-project `.context-mode/enforce.json` file, re-read on every hook call — no reinstall, no restart.
   - Levels: `off`, `voluntary`, `moderate` (default), `aggressive`. User-configured deny rules always apply at every level.

---

## ⚡ Context Saving Benchmark (Devin CLI)

Measured on Devin CLI 3000.12.28 (Windows) with real `devin -p` sessions; metric = bytes of `role=tool` messages the model actually read:

| Scenario / Task | Without context-mode | With context-mode | Context Saved |
| :--- | :--- | :--- | :--- |
| **Heavy workload** (`cat` 1 MB logs + `git log -p`, n=2) | ~2.2 MB tool bytes avg (540 KB / 3.85 MB); one run FAILED after 6 compactions | ~64 KB tool bytes (50 KB / 78 KB); 0 compactions, both runs correct | **~97%** |
| **Light workload** (small reads + short git log) | Small outputs already | Hooks have little to replace; fixed `ctx_*` schema overhead | **~15%** |

Plain reading: on heavy output the savings are large (~90%+); on light tasks the plugin is roughly neutral. Savings come from both hook replacement and the model routing bulk work to `ctx_execute`/`ctx_batch`.

---

## 📦 Installation for Devin CLI

Requires **Node.js 24.15.0+** and **Devin CLI v3000.11.205+** (for PostToolUse output replace). On Windows, the sandbox shell tools run in Git Bash.

```powershell
# Build the release bundle, then run setup for devin only
node build/build.mjs --out release-out
node release-out/cli.mjs setup --agents devin -y
```

Setup writes:

- `%APPDATA%\devin\config.json` (Windows) / `~/.config/devin/config.json` or `$XDG_CONFIG_HOME/devin/config.json` (macOS/Linux) — the `"hooks"` event map, merged without touching your own keys.
- `mcp_config.json` in the same directory — the `context-mode` stdio MCP server.
- Skills (`ctx-doctor`, `ctx-stats`, `ctx-upgrade`) into the Devin skills directory.

Verify with `node release-out/cli.mjs setup --agents devin` (runs parse, MCP handshake, and a live hook check) or the `ctx_doctor` skill inside Devin. To remove: `node release-out/cli.mjs setup --remove --agents devin`.

---

## 🎛️ Runtime Enforcement Levels

Choose how aggressively context-mode redirects tool calls:

| Level | Behavior | Best For |
| :--- | :--- | :--- |
| **`off`** | No denies or output replacement; `ctx_*` MCP tools stay available | Debugging, auditing raw outputs |
| **`voluntary`** | No denies; replacement still active | Letting the model choose `ctx_*` freely |
| **`moderate`** *(Default)* | Blocks/redirects obvious heavy patterns (builds, full logs, large `cat`); `read`/`grep`/`webfetch` mostly stay native | Everyday development |
| **`aggressive`** | Currently equivalent to `moderate` (extra heuristics planned) | Maximum protection |

### How to Adjust Strictness Without Rebuilding

Read on every hook invocation, highest priority first:

1. **Environment variable**:
   ```powershell
   $env:CONTEXT_MODE_ENFORCE = "off"    # or voluntary / moderate / aggressive
   ```
2. **Project file**: `<project>/.context-mode/enforce.json`
   ```json
   { "level": "voluntary" }
   ```
3. **Default**: `moderate` when neither is set. A present but invalid env value resolves to `moderate` (it never falls through to a lower file level). User-configured deny rules apply at every level.

---

## 📁 Repository Structure

```text
context-mode-devin/
├── src/
│   ├── adapters/devin.ts          <-- Devin adapter (hook decode/encode)
│   ├── adapters/table.ts          <-- Adapter registry (devin row + capability sets)
│   ├── core/policy/enforce.ts     <-- CONTEXT_MODE_ENFORCE level resolution
│   └── ...                        <-- Shared context-mode engine (10 upstream agents)
├── docs/
│   ├── install/devin.md           <-- Devin install/verify/uninstall guide
│   └── superpowers/specs/         <-- Fork design docs (devin agent, enforcement)
├── plugins/                       <-- Upstream agent plugin bundles
└── skills/                        <-- ctx-doctor, ctx-stats, ctx-upgrade
```

---

## 📄 License & Credits

* Forked from [mksglu/context-mode](https://github.com/mksglu/context-mode) by Mert Koseoglu.
* Licensed under the [Elastic License 2.0 (ELv2)](LICENSE).
