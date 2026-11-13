// Runtime enforcement strictness (devin-agent design §6, 2026-11-13 plan task 3).
// CONTEXT_MODE_ENFORCE = off | voluntary | moderate | aggressive, resolved on every call — the hook
// process is per-invocation, so there is no cache. Order: env CONTEXT_MODE_ENFORCE ->
// <projectDir>/.context-mode/enforce.json {"level": ...} -> "moderate". A present, non-empty env value
// that is not a known level is terminal "moderate" (source "env-invalid"); a bad or absent file value
// falls through; nothing anywhere -> "moderate".
// The level gates ONLY context-mode's own denies (decide.ts, after the user-deny step) and the
// PostToolUse replace (dispatch.ts). The user's own deny rules apply at every level, "off" included:
// off disables context-mode's redirection, not the user's explicit security policy.
// D-CI-PERF-3: node:fs through getBuiltinModule; a static ESM import of node:fs also loads fs/promises, readline and streams.
const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { join } from "node:path";
import { ENFORCE_DIR_NAME, ENFORCE_ENV, ENFORCE_FILE } from "../contracts/constants.ts";

export type EnforceLevel = "off" | "voluntary" | "moderate" | "aggressive";
export type EnforceSource = "env" | "env-invalid" | "file" | "default";

export interface EnforceResolution {
  level: EnforceLevel;
  source: EnforceSource;
}

const LEVELS: readonly EnforceLevel[] = Object.freeze(["off", "voluntary", "moderate", "aggressive"]);
const DEFAULT_LEVEL: EnforceLevel = "moderate";

function asLevel(v: unknown): EnforceLevel | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(s) ? (s as EnforceLevel) : null;
}

function fileLevel(projectDir: string): EnforceLevel | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(projectDir, ENFORCE_DIR_NAME, ENFORCE_FILE), "utf8"));
  } catch {
    return null; // absent, unreadable or not JSON: the file source does not apply
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  return asLevel((doc as Record<string, unknown>).level);
}

/** env CONTEXT_MODE_ENFORCE -> <projectDir>/.context-mode/enforce.json -> "moderate" (design §6).
 *  A present, non-empty env value that is not a level is terminal: it resolves to "moderate" and the
 *  file is never consulted — a malformed env var must not fall through to a file that could set a
 *  lower level (task-3 review ruling). An empty/blank value counts as missing. */
export function resolveEnforce(env: NodeJS.ProcessEnv, projectDir: string): EnforceResolution {
  const raw = env[ENFORCE_ENV];
  const fromEnv = asLevel(raw);
  if (fromEnv !== null) return { level: fromEnv, source: "env" };
  if (raw !== undefined && raw.trim() !== "") return { level: DEFAULT_LEVEL, source: "env-invalid" };
  const fromFile = fileLevel(projectDir);
  if (fromFile !== null) return { level: fromFile, source: "file" };
  return { level: DEFAULT_LEVEL, source: "default" };
}

/** The resolved level only (the brief's hook/decide surface). */
export function enforceLevelOf(env: NodeJS.ProcessEnv, projectDir: string): EnforceLevel {
  return resolveEnforce(env, projectDir).level;
}

/** off|voluntary drop context-mode's own denies; moderate|aggressive keep them (current behavior).
 *  TODO(aggressive): the plan allows aggressive == moderate for now; its remaining delta is an
 *  unbounded-Read deny heuristic, to add when trivial (2026-11-13 devin-agent plan, task 3). */
export function levelAllowsDeny(level: EnforceLevel): boolean {
  return level === "moderate" || level === "aggressive";
}

/** "off" also drops the PostToolUse replace (the model gets the whole output); every other level keeps
 *  it — replace only shrinks what the model sees, it never blocks the call. */
export function levelAllowsReplace(level: EnforceLevel): boolean {
  return level !== "off";
}
