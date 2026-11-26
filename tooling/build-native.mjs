import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "audio-capture-macos", "capture.swift");
const outDir = join(root, "native", "audio-capture-macos", "bin");
const binary = join(outDir, "urbuddy-audio-capture");

if (process.platform !== "darwin") {
  console.error("native:build requires macOS");
  process.exit(2);
}

let swiftc = "swiftc";
try {
  execFileSync("swiftc", ["--version"], { stdio: "pipe" });
} catch {
  console.error("native:build requires swiftc on PATH (Xcode command line tools)");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
execFileSync(swiftc, ["-O", "-o", binary, source], { stdio: "inherit" });
chmodSync(binary, 0o755);
const stat = statSync(binary);
if (!stat.isFile() || stat.size === 0) {
  console.error("native:build produced no binary");
  process.exit(1);
}
console.log(`native:build ok: ${binary} (${stat.size} bytes)`);
