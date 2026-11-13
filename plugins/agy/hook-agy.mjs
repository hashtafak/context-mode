#!/usr/bin/env node
// plugins/agy/hook-agy.mjs
// Standalone native hook handler for Antigravity CLI (agy)
// Supports presets: strict, balanced, read-guard, advisory
// Supports per-turn/per-call overrides and runtime policy.json

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function str(v) {
  return typeof v === "string" ? v : "";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parsePreset(val) {
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "strict" || s === "balanced" || s === "read-guard" || s === "advisory") return s;
  }
  return null;
}

const PRESET_DEFAULTS = {
  strict: {
    readCapBytes: 16384,
    allowBuildCommands: false,
    allowShellDumps: false,
    allowWebFetch: false,
    allowAll: false,
    allowPerCallOverride: false,
  },
  balanced: {
    readCapBytes: 32768,
    allowBuildCommands: true,
    allowShellDumps: false,
    allowWebFetch: false,
    allowAll: false,
    allowPerCallOverride: true,
  },
  "read-guard": {
    readCapBytes: 16384,
    allowBuildCommands: true,
    allowShellDumps: true,
    allowWebFetch: false,
    allowAll: false,
    allowPerCallOverride: true,
  },
  advisory: {
    readCapBytes: Infinity,
    allowBuildCommands: true,
    allowShellDumps: true,
    allowWebFetch: true,
    allowAll: true,
    allowPerCallOverride: true,
  },
};

const SHELL_DUMP_COMMANDS = ["cat", "head", "tail", "type", "more", "Get-Content", "gc"];
const BUILD_COMMANDS = ["npm test", "npm run", "npx", "pytest", "cargo", "mvn", "gradle", "go test", "make", "python -m unittest"];

function resolvePolicy(cwd, lastUserInput, env = process.env) {
  // 1. Per-turn prompt override: [ctx:<preset>] in lastUserInput
  if (typeof lastUserInput === "string") {
    const match = /\[ctx:(strict|balanced|read-guard|advisory)\]/i.exec(lastUserInput);
    if (match) {
      const p = match[1].toLowerCase();
      return { preset: p, source: `prompt:${p}`, ...PRESET_DEFAULTS[p] };
    }
  }

  // 2. Env var
  const envPreset = parsePreset(env.CONTEXT_MODE_PRESET);
  if (envPreset) {
    const base = { ...PRESET_DEFAULTS[envPreset] };
    if (env.CONTEXT_MODE_READ_CAP) {
      const cap = parseInt(env.CONTEXT_MODE_READ_CAP, 10);
      if (!isNaN(cap) && cap > 0) base.readCapBytes = cap;
    }
    return { preset: envPreset, source: `env:${envPreset}`, ...base };
  }

  // 3. Project file: <cwd>/.agents/context-mode.json
  const projPath = join(cwd || process.cwd(), ".agents", "context-mode.json");
  const home = env.USERPROFILE || env.HOME;
  const globalPath = home ? join(home, ".gemini", "config", "plugins", "context-mode", "policy.json") : null;

  let fileConfig = null;
  let fileSource = null;
  if (existsSync(projPath)) {
    try { fileConfig = JSON.parse(readFileSync(projPath, "utf8")); fileSource = "project-file"; } catch {}
  } else if (globalPath && existsSync(globalPath)) {
    try { fileConfig = JSON.parse(readFileSync(globalPath, "utf8")); fileSource = "global-file"; } catch {}
  }

  if (fileConfig && typeof fileConfig === "object") {
    const preset = parsePreset(fileConfig.preset) || "balanced";
    const base = { ...PRESET_DEFAULTS[preset] };
    if (typeof fileConfig.readCapBytes === "number" && fileConfig.readCapBytes > 0) {
      base.readCapBytes = fileConfig.readCapBytes;
    }
    if (typeof fileConfig.allowBuildCommands === "boolean") base.allowBuildCommands = fileConfig.allowBuildCommands;
    if (typeof fileConfig.allowShellDumps === "boolean") base.allowShellDumps = fileConfig.allowShellDumps;
    if (typeof fileConfig.allowPerCallOverride === "boolean") base.allowPerCallOverride = fileConfig.allowPerCallOverride;
    return { preset, source: `${fileSource}:${preset}`, ...base };
  }

  // 4. Default: balanced
  return { preset: "balanced", source: "default:balanced", ...PRESET_DEFAULTS.balanced };
}

async function main() {
  const argv = process.argv.slice(2);
  const evIdx = argv.indexOf("--event");
  const event = evIdx >= 0 ? argv[evIdx + 1] : "PreToolUse";

  let raw = {};
  try {
    const inputStr = await readStdin();
    if (inputStr.trim()) raw = JSON.parse(inputStr);
  } catch (err) {
    // Failsafe allow
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Handlers by event
  if (event === "SessionStart") {
    const hint = "Context Mode active. For large commands or logs use ctx_execute; for full files use ctx_index & ctx_search; to restore state use ctx_resume.";
    process.stdout.write(JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: hint } }]
    }));
    return;
  }

  if (event === "PreInvocation") {
    process.stdout.write(JSON.stringify({ injectSteps: [] }));
    return;
  }

  if (event === "PostToolUse" || event === "Stop") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // PreToolUse
  const toolCall = raw.toolCall || {};
  const toolName = str(toolCall.name);
  const args = toolCall.args || {};
  const cwd = (Array.isArray(raw.workspacePaths) && raw.workspacePaths[0]) ? raw.workspacePaths[0] : process.cwd();
  const lastUserInput = str(raw.lastUserInput);

  const policy = resolvePolicy(cwd, lastUserInput, process.env);

  if (policy.allowAll) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Check run_command
  if (toolName === "run_command") {
    const cmd = str(args.CommandLine);

    // Per-call override
    if (policy.allowPerCallOverride && (cmd.includes("# ctx-allow") || cmd.startsWith("CTX_ALLOW=1"))) {
      process.stdout.write(JSON.stringify({ decision: "allow" }));
      return;
    }

    // Check curl/webfetch
    if (!policy.allowWebFetch && (cmd.startsWith("curl ") || cmd.startsWith("wget ") || cmd.includes("Invoke-WebRequest") || cmd.includes("curl.exe"))) {
      const redirect = `Blocked large HTTP/curl command. Run in sandbox via ctx_execute or index via ctx_index:\nctx_execute(language="shell", code=${JSON.stringify(cmd)}, intent="fetch data")`;
      process.stdout.write(JSON.stringify({ decision: "deny", reason: redirect }));
      return;
    }

    // Check shell dump
    if (!policy.allowShellDumps) {
      const trimmed = cmd.trim();
      const firstWord = trimmed.split(/\s+/)[0];
      if (SHELL_DUMP_COMMANDS.includes(firstWord)) {
        const redirect = `Blocked full shell dump (${firstWord}). Run in sandbox via ctx_execute or index via ctx_index:\nctx_execute(language="shell", code=${JSON.stringify(cmd)}, intent="inspect output")`;
        process.stdout.write(JSON.stringify({ decision: "deny", reason: redirect }));
        return;
      }
    }

    // Check build command
    if (!policy.allowBuildCommands) {
      const matchBuild = BUILD_COMMANDS.some((b) => cmd.includes(b));
      if (matchBuild) {
        const redirect = `Blocked noisy build/test command. Run in sandbox via ctx_execute:\nctx_execute(language="shell", code=${JSON.stringify(cmd)}, intent="run build/test")`;
        process.stdout.write(JSON.stringify({ decision: "deny", reason: redirect }));
        return;
      }
    }

    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Check read_file / view_file
  if (toolName === "read_file" || toolName === "view_file") {
    // If targeted range read, always allow
    if (typeof args.StartLine === "number" || typeof args.ByteOffset === "number") {
      process.stdout.write(JSON.stringify({ decision: "allow" }));
      return;
    }

    const filePath = str(args.Path || args.AbsolutePath);
    if (filePath && policy.readCapBytes !== Infinity) {
      try {
        const st = statSync(filePath);
        if (st.size > policy.readCapBytes) {
          const redirect = `File is ${st.size} bytes (exceeds cap of ${policy.readCapBytes} bytes). To save context:\n1. Read with line range: read_file(Path=${JSON.stringify(filePath)}, StartLine=1, EndLine=100)\n2. Or index and search: ctx_index(path=${JSON.stringify(filePath)}), then ctx_search(query="keyword")\n3. Or inspect in sandbox: ctx_execute(language="javascript", code="const fs = require('fs'); ...")`;
          process.stdout.write(JSON.stringify({ decision: "deny", reason: redirect }));
          return;
        }
      } catch {
        // file missing or unreadable -> allow host tool to handle the error
      }
    }

    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Other tools
  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
