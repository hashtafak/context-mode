# context-mode-agy

> **Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode)** adding first-class native support for **Google Antigravity CLI (`agy`)**, lifecycle hook integration, and runtime strictness presets.
>
> 📖 **Original Documentation:** For upstream documentation, architecture, gateway guides, and all other supported coding agents, please refer to the [upstream README on GitHub](https://github.com/mksglu/context-mode#readme).

---

## 🚀 What's New in this Fork

This fork adds full support for **Antigravity CLI (`agy`)** alongside the original 10 supported agents:

1. **Native `agy` Plugin Bundle (`plugins/agy/`)**:
   - Packaged with standard `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/AGENTS.md`, and skills (`ctx-doctor`, `ctx-stats`, `ctx-upgrade`).
   - Automatically discovered by Antigravity CLI in `~/.gemini/config/plugins/context-mode` (global) or `.agents/plugins/context-mode` (workspace).
2. **Lifecycle Hooks Integration**:
   - `PreToolUse`: Intercepts massive file reads (`read_file` / `view_file` over byte cap), shell dumps (`cat`, `tail`, `more`), and raw network fetches (`curl`, `wget`), redirecting the agent to `ctx_execute`, `ctx_index`, and `ctx_search`.
   - `SessionStart`: Injects session continuity and `ctx_resume` hints without polluting the user transcript.
   - `PostToolUse`: Conforms strictly to `agy`'s protojson hook contracts.
3. **Multi-tiered Runtime Strictness Presets**:
   - Switch presets dynamically via **prompt tags** (`[ctx:<preset>]`), **environment variables**, or a runtime JSON file (`policy.json`) without editing code or rebuilding bundles.

---

## ⚡ Context Saving Benchmark (agy CLI)

Across common heavy-context workflows, `context-mode-agy` achieves **96% to 99.9% reduction** in tokens loaded into the context window:

| Scenario / Task | Without Plugin | With `context-mode-agy` | Context Saved (%) |
| :--- | :--- | :--- | :--- |
| **Large File Read** (`read_file` full on ~50 KB file) | 50,000+ bytes loaded directly into context | Blocked at `PreToolUse` with range reading instructions (~300 B) | **~99.4%** |
| **Large API / Web Fetch** (`curl` on 1.04 MB JSON) | 1,039,898 bytes fill context window | Redirected to `ctx_execute` sandbox; model receives only summary (254 B) | **99.97%** |
| **Heavy Shell Dump / Logs** (`cat` on ~228 KB log) | 228,881 bytes loaded into context | Model redirected to `ctx_batch` / `ctx_search` for matching lines (~8.6 KB) | **96.2%** |
| **Normal Build / Test** (`npm test`, `pytest`) | Runs normally | Runs normally (allowed by default `balanced` preset) | **0%** *(no friction)* |
| **Long Session Continuity** (Compaction & Resume) | Massive transcript bloat | Compact state restored via `ctx_resume` in 2,019 bytes | **~99.5%** |

---

## 📦 Installation for Antigravity CLI (`agy`)

### Option 1: Global Installation (Recommended)
Copy the `plugins/agy` directory to your Antigravity global plugins directory:

```powershell
Copy-Item -Recurse -Force "plugins/agy" "$HOME\.gemini\config\plugins\context-mode"
```

### Option 2: Workspace Installation (Per-Repository)
To enable Context Mode only for the current project:

```powershell
Copy-Item -Recurse -Force "plugins/agy" ".agents/plugins/context-mode"
```

Once installed, Antigravity CLI will automatically detect the plugin, register the `context-mode` MCP server, and activate lifecycle hooks on subsequent sessions.

---

## 🎛️ Runtime Strictness Presets

Choose the right preset based on your workflow:

| Preset | Full `read_file` | `curl` / WebFetch | Shell Dump (`cat`, `tail`) | Build / Test (`npm test`, etc.) | Best For |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`strict`** | Blocked if > 16 KB | Blocked | Blocked | Blocked | Maximum context protection |
| **`balanced`** *(Default)* | Blocked if > 32 KB | Blocked | Blocked | **Allowed** | Everyday development & testing |
| **`read-guard`** | Blocked if > 16 KB | Blocked | **Allowed** | **Allowed** | Unrestricted shell execution |
| **`advisory`** | **Allowed** | **Allowed** | **Allowed** | **Allowed** | Passive mode (MCP tools only) |

### How to Adjust Strictness Without Rebuilding

You can adjust strictness at 4 levels (highest priority first):

1. **Per-turn Prompt Tag** (Overrides single turn):
   Append a tag to your message in `agy`:
   > *"Run the test suite and inspect the logs [ctx:read-guard]"*
2. **Per-call Command Override**:
   Add `# ctx-allow` to any shell command to bypass checks (when `allowPerCallOverride: true`):
   > `cat server.log # ctx-allow`
3. **Environment Variable**:
   ```powershell
   $env:CONTEXT_MODE_PRESET = "strict"    # or balanced / read-guard / advisory
   $env:CONTEXT_MODE_READ_CAP = "65536"   # custom byte limit for read_file
   ```
4. **Runtime Policy File** (Takes effect on next tool call immediately):
   Edit `~/.gemini/config/plugins/context-mode/policy.json` (or `.agents/context-mode.json` in workspace):
   ```json
   {
     "preset": "balanced",
     "readCapBytes": 32768,
     "allowBuildCommands": true,
     "allowShellDumps": false,
     "allowPerCallOverride": true
   }
   ```

---

## 📁 Repository Structure

```text
context-mode-agy/
├── plugins/
│   └── agy/                     <-- Native Antigravity Plugin
│       ├── plugin.json          <-- Plugin manifest
│       ├── mcp_config.json      <-- Stdio MCP server registration
│       ├── hooks.json           <-- Antigravity PreToolUse/PostToolUse hooks
│       ├── hook-agy.mjs         <-- Standalone runtime hook executor
│       ├── policy.json          <-- Live strictness configuration
│       ├── rules/AGENTS.md      <-- Context-mode rules injected into agy
│       └── skills/              <-- ctx-doctor, ctx-stats, ctx-upgrade skills
├── src/
│   ├── adapters/agy.ts          <-- agy adapter (protojson decode/encode)
│   ├── core/policy/presets.ts   <-- Multi-tiered preset resolution engine
│   └── ...                      <-- Upstream context-mode engine
└── scratch/test-agy-hook.mjs    <-- Automated E2E test harness
```

---

## 📄 License & Credits

* Forked from [mksglu/context-mode](https://github.com/mksglu/context-mode) by Mert Koseoglu.
* Licensed under the [Elastic License 2.0 (ELv2)](LICENSE).
