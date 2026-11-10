import { spawnSync } from "node:child_process";
import { listNodeTestPaths } from "./test-inventory.mjs";

const suiteArgument = process.argv.find((argument) => argument.startsWith("--suite="));
const suite = suiteArgument ? suiteArgument.slice("--suite=".length) : "all";
if (!["all", "unit", "integration"].includes(suite)) {
  throw new Error(`Unknown Node test suite: ${suite}`);
}
const tests = listNodeTestPaths({
  compiledRoot: process.env.TEST_DIST_DIR ?? "dist-tests",
  suite,
});
if (tests.length === 0) {
  throw new Error(`No ${suite} Node tests were discovered.`);
}

const result = spawnSync(
  process.execPath,
  ["--require", "./test/support/cloudflare-workers-shim.cjs", "--test", ...tests],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
