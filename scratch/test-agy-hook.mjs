// scratch/test-agy-hook.mjs
// Automated verification script for plugins/agy/hook-agy.mjs
import { spawn } from "node:child_process";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, "../plugins/agy/hook-agy.mjs");

function runHook(event, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, "--event", event], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", (code) => {
      try {
        const json = JSON.parse(stdout);
        resolve({ code, json });
      } catch (e) {
        reject(new Error(`Failed to parse stdout "${stdout}": ${e.message}`));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function runTests() {
  console.log("=== Testing Antigravity Hook & Strictness Presets ===");

  // 1. SessionStart
  {
    const res = await runHook("SessionStart", { conversationId: "conv-1" });
    assert.equal(res.code, 0);
    assert.ok(res.json.injectSteps, "SessionStart should return injectSteps");
    console.log("✔ Test 1: SessionStart injects welcome instructions");
  }

  // 2. PreToolUse: targeted read_file (with StartLine) -> should allow
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "read_file", args: { Path: "README.md", StartLine: 1, EndLine: 50 } },
    });
    assert.equal(res.json.decision, "allow");
    console.log("✔ Test 2: Targeted read_file with line range is allowed");
  }

  // 3. PreToolUse: large full read_file (>32KB on default balanced) -> should deny
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "read_file", args: { Path: "README.md" } },
    });
    assert.equal(res.json.decision, "deny");
    assert.ok(res.json.reason.includes("exceeds cap"), "Reason should note byte cap");
    console.log("✔ Test 3: Large full read_file (>32KB) is denied with redirect reason");
  }

  // 4. PreToolUse: curl/HTTP -> should deny under balanced
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "run_command", args: { CommandLine: "curl -s https://api.example.com/data" } },
    });
    assert.equal(res.json.decision, "deny");
    assert.ok(res.json.reason.includes("ctx_execute"), "Reason should suggest ctx_execute");
    console.log("✔ Test 4: curl command is denied under balanced preset");
  }

  // 5. PreToolUse: shell dump (cat) -> should deny under balanced
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "run_command", args: { CommandLine: "cat large.log" } },
    });
    assert.equal(res.json.decision, "deny");
    console.log("✔ Test 5: cat shell dump is denied under balanced preset");
  }

  // 6. PreToolUse: build/test command -> allowed under balanced
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
    });
    assert.equal(res.json.decision, "allow");
    console.log("✔ Test 6: npm test is allowed under balanced preset");
  }

  // 7. Preset override via Env Var: strict blocks npm test
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
    }, { CONTEXT_MODE_PRESET: "strict" });
    assert.equal(res.json.decision, "deny");
    console.log("✔ Test 7: strict preset via env var blocks npm test");
  }

  // 8. Preset override via Prompt Tag: [ctx:read-guard] allows shell dump
  {
    const res = await runHook("PreToolUse", {
      lastUserInput: "Please check this [ctx:read-guard] for me",
      toolCall: { name: "run_command", args: { CommandLine: "cat large.log" } },
    });
    assert.equal(res.json.decision, "allow");
    console.log("✔ Test 8: [ctx:read-guard] prompt tag allows shell dump");
  }

  // 9. Preset override via Prompt Tag: [ctx:advisory] allows full read
  {
    const res = await runHook("PreToolUse", {
      lastUserInput: "Read this whole file [ctx:advisory]",
      toolCall: { name: "read_file", args: { Path: "README.md" } },
    });
    assert.equal(res.json.decision, "allow");
    console.log("✔ Test 9: [ctx:advisory] prompt tag allows large read_file");
  }

  // 10. Per-call override via comment: # ctx-allow
  {
    const res = await runHook("PreToolUse", {
      toolCall: { name: "run_command", args: { CommandLine: "cat large.log # ctx-allow" } },
    });
    assert.equal(res.json.decision, "allow");
    console.log("✔ Test 10: Per-call override '# ctx-allow' allows blocked command");
  }

  console.log("\nALL 10 TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
