// Devin CLI adapter (docs/superpowers/specs/2026-11-13-devin-agent-design.md; hook contract verified against
// the installed CLI 3000.12.28, docs.devin.ai/cli/extensibility/hooks). Native events: SessionStart /
// UserPromptSubmit / PreToolUse / PostToolUse / PostCompaction (decoded as canonical PreCompact so the
// pending-flag compaction path works; it fires after compaction, recall lands on the next prompt).
// stdin carries {hook_event_name, tool_name, tool_input, session_id, prompt_id} and PostToolUse adds
// tool_response {success, output, error} with output a plain string; there is NO cwd field, so the project
// dir is DEVIN_PROJECT_DIR or the hook's own cwd. Devin never sends tool_use_id: the callId is the
// claude-code FNV-1a fallback label. additionalContext is silently dropped on PreToolUse, so hints ride
// SessionStart / UserPromptSubmit / PostToolUse only. Deny is the top-level {"decision":"block","reason"}
// on exit 0; replace is PostToolUse hookSpecificOutput.updatedToolOutput (the output string — the exact
// host value shape is an open spike item, this is the documented intent).
import type { CanonicalHookEvent, Decision, HookOutput, ToolCall, ToolResultInfo } from "../core/contracts/types.ts";

export const TOOL_NAME_PREFIX = "mcp__context-mode__"; // Devin MCP tool names: mcp__<server>__<tool>

type Event = CanonicalHookEvent["event"];
type Source = NonNullable<CanonicalHookEvent["source"]>;

// Reverse of the table.ts devin eventMap row: PostCompaction decodes as canonical PreCompact.
const DEVIN_EVENTS: Readonly<Record<string, Event>> = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PostCompaction: "PreCompact",
};

// canonical -> native, for the hookEventName echo (Devin drops a reply whose hookEventName does not name
// the firing event). Only PreCompact differs from its canonical name.
const DEVIN_NATIVE: Readonly<Record<string, string>> = { PreCompact: "PostCompaction" };
const nativeEvent = (ev: CanonicalHookEvent): string => DEVIN_NATIVE[ev.event] ?? ev.event;

const DEVIN_SOURCES: Readonly<Record<string, Source>> = { startup: "startup", resume: "resume" };

// Events whose native output reads hookSpecificOutput.additionalContext; Devin drops it on PreToolUse.
const HINT_EVENTS: readonly Event[] = ["SessionStart", "UserPromptSubmit", "PostToolUse"];

const EMPTY: HookOutput = { stdout: "", exitCode: 0 };

// Devin built-in tool name -> canonical name (design spec tool list, verified against the installed CLI's
// own hooks docs). Own-prefix strip and mcp__<srv>__<tool> -> "mcp:<srv>:<tool>" as claude-code.ts.
const NATIVE_TO_CANONICAL: Readonly<Record<string, string>> = {
  exec: "Bash",
  get_output: "Bash",
  read: "Read",
  notebook_read: "Read",
  grep: "Grep",
  glob: "Grep",
  find_file_by_name: "Grep",
  webfetch: "WebFetch",
  edit: "Edit",
  write: "Write",
  apply_patch: "Edit",
  notebook_edit: "Edit",
};

const MCP_PREFIX = "mcp__";
const MCP_SEP = "__";

function own(p: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(p, key) ? p[key] : undefined;
}

// Own tool -> bare ctx_* name; another MCP server's tool -> "mcp:<server>:<tool>"; a native name in
// NATIVE_TO_CANONICAL maps to its canonical class; other names pass through unchanged.
function canonicalName(name: string): string {
  if (name.startsWith(TOOL_NAME_PREFIX)) return name.slice(TOOL_NAME_PREFIX.length);
  if (Object.hasOwn(NATIVE_TO_CANONICAL, name)) return NATIVE_TO_CANONICAL[name];
  if (!name.startsWith(MCP_PREFIX)) return name;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(MCP_SEP);
  if (sep < 0) return name;
  return "mcp:" + rest.slice(0, sep) + ":" + rest.slice(sep + MCP_SEP.length);
}

// tool_response is {success, output, error} with output a plain string; success === false marks failure.
// No shape/blocks/keep/persistedPath: Devin's output is already the text the model sees.
function readResult(resp: unknown): ToolResultInfo {
  const obj = typeof resp === "object" && resp !== null ? (resp as Record<string, unknown>) : undefined;
  const out = obj === undefined ? undefined : own(obj, "output");
  const text = typeof out === "string" ? out : typeof resp === "string" ? resp : resp === undefined ? "" : JSON.stringify(resp);
  return { isError: obj !== undefined && own(obj, "success") === false, bytes: Buffer.byteLength(text), text };
}

// FNV-1a 32-bit, hex: same fallback label as claude-code.ts (hook path stays free of node:crypto).
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function decode(raw: unknown): CanonicalHookEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("devin: hook payload is not a JSON object");
  const p = raw as Record<string, unknown>;
  const native = own(p, "hook_event_name");
  const event = typeof native === "string" && Object.hasOwn(DEVIN_EVENTS, native) ? DEVIN_EVENTS[native] : undefined;
  if (event === undefined) throw new Error("devin: unknown hook event " + String(native));
  // Devin sends no cwd: DEVIN_PROJECT_DIR, else the hook's own cwd.
  const ev: CanonicalHookEvent = { event, agent: "devin", sessionId: String(own(p, "session_id") ?? ""), cwd: process.env.DEVIN_PROJECT_DIR || process.cwd() };
  const source = own(p, "source");
  if (event === "SessionStart" && typeof source === "string" && Object.hasOwn(DEVIN_SOURCES, source)) ev.source = DEVIN_SOURCES[source];
  const prompt = own(p, "prompt");
  if (event === "UserPromptSubmit" && typeof prompt === "string") ev.prompt = prompt;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const name = String(own(p, "tool_name") ?? "");
    const input = own(p, "tool_input");
    const tool: ToolCall = {
      name,
      canonicalName: canonicalName(name),
      input: typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
    };
    const id = own(p, "tool_use_id"); // Devin never sends it; kept for shape parity with the Claude form.
    if (typeof id === "string" && id !== "") tool.callId = id;
    ev.tool = tool;
  }
  if (event === "PostToolUse") ev.result = readResult(own(p, "tool_response"));
  // callId fallback (claude-code.ts): a label from a hash of the command and the turn, so one command in
  // one turn keeps one source. PostToolUse only — it is the label the replace path reads.
  if (ev.event === "PostToolUse" && ev.tool !== undefined && ev.tool.callId === undefined) {
    const cmd = typeof ev.tool.input.command === "string" ? ev.tool.input.command : JSON.stringify(ev.tool.input);
    ev.tool.callId = "h" + fnv1a(ev.tool.name + "\0" + cmd + "\0" + String(ev.turn ?? 0));
  }
  return ev;
}

export function encode(ev: CanonicalHookEvent, d: Decision, _extra?: string): HookOutput {
  const specific = (fields: Record<string, unknown>): HookOutput => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: nativeEvent(ev), ...fields } }),
    exitCode: 0,
  });
  switch (d.kind) {
    case "allow":
      return EMPTY;
    case "hint":
      // additionalContext is silently dropped on PreToolUse (and PreCompact is not a hint event).
      if (!HINT_EVENTS.includes(ev.event)) return EMPTY;
      return specific({ additionalContext: d.text });
    case "deny":
      // Top-level decision block + reason on exit 0; the reason is shown to the agent (deny-reason channel).
      return { stdout: JSON.stringify({ decision: "block", reason: d.rewritten === undefined ? d.reason : d.rewritten + "\n" + d.reason }), exitCode: 0 };
    case "replace":
      // PostToolUse hookSpecificOutput.updatedToolOutput; the value is the output string (tool_response.output
      // is a plain string). Whether Devin wants the bare string or a wrapped object is an open spike item.
      if (ev.event !== "PostToolUse") return EMPTY;
      return specific({ updatedToolOutput: d.output });
  }
}
