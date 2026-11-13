// src/core/policy/presets.ts
// Runtime policy & strictness presets for context-mode-agy.
// Presets:
// - strict: blocks full reads > 16KB, curl/HTTP, shell dumps, build/test commands.
// - balanced: blocks full reads > 32KB, curl/HTTP, shell dumps; allows build/test commands.
// - read-guard: blocks full reads > 16KB, curl/HTTP; allows all shell commands.
// - advisory: passive mode; allows all PreToolUse tools, relies on AGENTS.md + MCP tools.

const { existsSync, readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { join } from "node:path";
import { homeDirOf } from "../project/config-dir.ts";

export type StrictnessPreset = "strict" | "balanced" | "read-guard" | "advisory";

export interface ResolvedPolicy {
  preset: StrictnessPreset;
  readCapBytes: number;
  allowBuildCommands: boolean;
  allowShellDumps: boolean;
  allowWebFetch: boolean;
  allowAll: boolean;
  allowPerCallOverride: boolean;
  source: string;
}

const PRESET_DEFAULTS: Record<StrictnessPreset, Omit<ResolvedPolicy, "preset" | "source">> = {
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

function parsePreset(val: unknown): StrictnessPreset | null {
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "strict" || s === "balanced" || s === "read-guard" || s === "advisory") return s;
  }
  return null;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the active policy for an invocation:
 * 1. Per-turn prompt override: [ctx:<preset>] in lastUserInput
 * 2. Environment variables: CONTEXT_MODE_PRESET, CONTEXT_MODE_READ_CAP
 * 3. Project policy file: <cwd>/.agents/context-mode.json
 * 4. Global policy file: ~/.gemini/config/plugins/context-mode/policy.json
 * 5. Default: balanced
 */
export function resolvePolicy(cwd: string, lastUserInput?: string, env: NodeJS.ProcessEnv = process.env): ResolvedPolicy {
  // 1. Per-turn tag in lastUserInput
  if (typeof lastUserInput === "string") {
    const match = /\[ctx:(strict|balanced|read-guard|advisory)\]/i.exec(lastUserInput);
    if (match) {
      const p = match[1].toLowerCase() as StrictnessPreset;
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
  const projectConfig = readJsonFile(join(cwd, ".agents", "context-mode.json"));
  // 4. Global file: ~/.gemini/config/plugins/context-mode/policy.json
  const home = homeDirOf(env);
  const globalConfig = home ? readJsonFile(join(home, ".gemini", "config", "plugins", "context-mode", "policy.json")) : null;

  const fileConfig = projectConfig ?? globalConfig;
  const fileSource = projectConfig ? "project-file" : globalConfig ? "global-file" : null;

  if (fileConfig) {
    const preset = parsePreset(fileConfig.preset) ?? "balanced";
    const base = { ...PRESET_DEFAULTS[preset] };
    if (typeof fileConfig.readCapBytes === "number" && fileConfig.readCapBytes > 0) {
      base.readCapBytes = fileConfig.readCapBytes;
    }
    if (typeof fileConfig.allowBuildCommands === "boolean") base.allowBuildCommands = fileConfig.allowBuildCommands;
    if (typeof fileConfig.allowShellDumps === "boolean") base.allowShellDumps = fileConfig.allowShellDumps;
    if (typeof fileConfig.allowPerCallOverride === "boolean") base.allowPerCallOverride = fileConfig.allowPerCallOverride;
    return { preset, source: `${fileSource}:${preset}`, ...base };
  }

  // 5. Default
  return { preset: "balanced", source: "default:balanced", ...PRESET_DEFAULTS.balanced };
}
