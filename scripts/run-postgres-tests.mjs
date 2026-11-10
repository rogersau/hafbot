import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getTestInventory } from "./test-inventory.mjs";

if (!process.env.TEST_POSTGRES_URL?.trim()) {
  throw new Error("TEST_POSTGRES_URL is required; PostgreSQL contracts must not silently skip.");
}
let url;
try {
  url = new URL(process.env.TEST_POSTGRES_URL);
} catch {
  throw new Error("TEST_POSTGRES_URL must be a valid PostgreSQL URL.");
}
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !url.pathname.endsWith("_test")
) {
  throw new Error("PostgreSQL contracts require a local database ending in _test.");
}
const tests = getTestInventory()
  .node.filter((file) => /^test\/postgres-.*\.test\.ts$/.test(file))
  .map((file) => join(process.env.TEST_DIST_DIR ?? "dist-tests", file.replace(/\.ts$/, ".js")))
  .sort();
if (tests.length === 0) throw new Error("No PostgreSQL contract tests were discovered.");
const result = spawnSync(
  process.execPath,
  [
    "--require",
    "./test/support/cloudflare-workers-shim.cjs",
    "--test",
    "--test-concurrency=1",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
