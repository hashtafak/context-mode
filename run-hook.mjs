import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, "plugins", "agy", "hook-agy.mjs");
const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit"
});
child.on("close", (code) => {
  process.exit(code ?? 0);
});
