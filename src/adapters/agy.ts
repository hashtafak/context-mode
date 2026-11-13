// src/adapters/agy.ts
// Native adapter for Antigravity CLI (agy).
// References: agy-customizations hooks.md & plugins.md.
// Protocol features:
// - Tools: run_command (shell), read_file / view_file (read).
// - Stdin payload: { toolCall, stepIdx, conversationId, workspacePaths, lastUserInput, modelName, error }.
// - PreToolUse stdout: { decision: "allow" | "deny", reason?: string, overwrite?: object }.
// - PostToolUse stdout: {}.
// - SessionStart stdout: { injectSteps: [{ systemMessage: { systemMessage: string } }] }.
// - PreInvocation stdout: { injectSteps: [{ ephemeralMessage: string }] }.
// - Stop stdout: { decision: "continue" | "" }.

const { statSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import type { CanonicalEventName, CanonicalHookEvent, Decision, HookOutput, ToolCall } from "../core/contracts/types.ts";
import { resolvePolicy } from "../core/policy/presets.ts";

export const TOOL_NAME_PREFIX = "mcp_context-mode_";

const EMPTY: HookOutput = { stdout: "{}", exitCode: 0 };
const ALLOW_PRE_TOOL: HookOutput = { stdout: JSON.stringify({ decision: "allow" }), exitCode: 0 };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function decodeAgyShape(raw: unknown): CanonicalHookEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { event: "SessionStart", agent: "agy", sessionId: "", cwd: process.cwd() };
  }
  const p = raw as Record<string, unknown>;
  const conversationId = str(p.conversationId);
  const workspacePaths = Array.isArray(p.workspacePaths) && typeof p.workspacePaths[0] === "string"
    ? p.workspacePaths[0]
    : process.cwd();
  const lastUserInput = str(p.lastUserInput);
  const eventFlag = typeof p.__eventFlag === "string" ? p.__eventFlag : undefined;

  // Inferred or explicit event
  let event: CanonicalEventName = "PreToolUse";
  if (eventFlag) {
    if (eventFlag === "SessionStart") event = "SessionStart";
    else if (eventFlag === "PreInvocation" || eventFlag === "UserPromptSubmit") event = "UserPromptSubmit";
    else if (eventFlag === "PostToolUse") event = "PostToolUse";
    else if (eventFlag === "PreToolUse") event = "PreToolUse";
    else if (eventFlag === "Stop") event = "Stop";
  } else {
    // If not given, infer from payload
    if (p.toolCall) {
      event = p.error !== undefined ? "PostToolUse" : "PreToolUse";
    } else if (p.invocationNum !== undefined || p.initialNumSteps !== undefined) {
      event = "UserPromptSubmit";
    } else if (p.terminationReason !== undefined || p.executionNum !== undefined) {
      event = "Stop";
    } else {
      event = "SessionStart";
    }
  }

  const base: CanonicalHookEvent = {
    event,
    agent: "agy",
    sessionId: conversationId,
    cwd: workspacePaths,
    prompt: lastUserInput || undefined,
  };

  if (p.toolCall && typeof p.toolCall === "object" && p.toolCall !== null) {
    const tc = p.toolCall as Record<string, unknown>;
    const rawName = str(tc.name);
    const args = (typeof tc.args === "object" && tc.args !== null ? tc.args : {}) as Record<string, unknown>;

    let canonicalName = rawName;
    const input: Record<string, unknown> = { ...args };

    if (rawName === "run_command") {
      canonicalName = "Bash";
      input.command = str(args.CommandLine);
    } else if (rawName === "read_file" || rawName === "view_file") {
      canonicalName = "Read";
      input.file_path = str(args.Path ?? args.AbsolutePath);
      if (typeof args.StartLine === "number") input.offset = args.StartLine;
      if (typeof args.EndLine === "number" && typeof args.StartLine === "number") {
        input.limit = args.EndLine - args.StartLine + 1;
      }
    } else if (rawName.startsWith(TOOL_NAME_PREFIX)) {
      canonicalName = rawName.slice(TOOL_NAME_PREFIX.length);
    } else if (rawName === "call_mcp_tool" && str(args.ServerName) === "context-mode") {
      canonicalName = str(args.ToolName);
    }

    base.tool = {
      name: rawName,
      canonicalName,
      input,
    };
  }

  return base;
}

export function encodeAgyShape(ev: CanonicalHookEvent, d: Decision): HookOutput {
  if (ev.event === "PostToolUse" || ev.event === "Stop") {
    return EMPTY;
  }

  if (ev.event === "SessionStart") {
    if (d.kind === "hint" && d.reason) {
      return {
        stdout: JSON.stringify({
          injectSteps: [{ systemMessage: { systemMessage: d.reason } }],
        }),
        exitCode: 0,
      };
    }
    return EMPTY;
  }

  if (ev.event === "UserPromptSubmit") {
    if (d.kind === "hint" && d.reason) {
      return {
        stdout: JSON.stringify({
          injectSteps: [{ ephemeralMessage: d.reason }],
        }),
        exitCode: 0,
      };
    }
    return EMPTY;
  }

  // PreToolUse: check policy
  const policy = resolvePolicy(ev.cwd, ev.prompt);

  // Advisory preset: never block
  if (policy.allowAll) {
    return ALLOW_PRE_TOOL;
  }

  // Per-call override check for shell commands: # ctx-allow or CTX_ALLOW=1
  if (policy.allowPerCallOverride && ev.tool?.canonicalName === "Bash") {
    const cmd = str(ev.tool.input?.command);
    if (cmd.includes("# ctx-allow") || cmd.startsWith("CTX_ALLOW=1")) {
      return ALLOW_PRE_TOOL;
    }
  }

  // Check if decide returned a deny
  if (d.kind === "deny") {
    // If command is build/test command and policy allows build commands
    if (policy.allowBuildCommands && ev.tool?.canonicalName === "Bash") {
      const reason = d.reason ?? "";
      if (reason.includes("build command") || reason.includes("test")) {
        return ALLOW_PRE_TOOL;
      }
    }

    // If shell dump and policy allows shell dumps
    if (policy.allowShellDumps && ev.tool?.canonicalName === "Bash") {
      const reason = d.reason ?? "";
      if (reason.includes("shell dump") || reason.includes("cat") || reason.includes("head") || reason.includes("tail")) {
        return ALLOW_PRE_TOOL;
      }
    }

    // Check custom readCapBytes
    if (ev.tool?.canonicalName === "Read" && policy.readCapBytes !== 16384) {
      const filePath = str(ev.tool.input?.file_path);
      try {
        const stats = statSync(filePath);
        if (stats.size <= policy.readCapBytes) {
          return ALLOW_PRE_TOOL;
        }
      } catch {
        // Fall back to deny
      }
    }

    return {
      stdout: JSON.stringify({
        decision: "deny",
        reason: d.reason ?? "Blocked by context-mode policy.",
      }),
      exitCode: 0,
    };
  }

  return ALLOW_PRE_TOOL;
}
