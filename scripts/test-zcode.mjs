// Run only the ZCode suite with an isolated homedir and no external network.
// The real HOME environment variable and the user's ZCode files stay intact.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

if (!process.versions.bun) throw new Error("Run this script with bun")
const root = mkdtempSync(join(tmpdir(), "zcode-plugin-tests-"))
try {
  mkdirSync(join(root, "home"))
  const preload = join(root, "preload.mjs")
  writeFileSync(preload, `
import { mock } from "bun:test";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const testRoot = join(dirname(fileURLToPath(import.meta.url)), "home");
mock.module("node:os", () => ({ ...os, homedir: () => testRoot }));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")
    throw new Error("External network disabled in isolated ZCode tests");
  return nativeFetch(input, init);
};
`, { mode: 0o600 })
  const result = spawnSync(process.execPath, ["test", "--preload", preload,
    fileURLToPath(new URL("../packages/zcode", import.meta.url))], { stdio: "inherit" })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
