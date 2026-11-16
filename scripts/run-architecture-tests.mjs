import { spawnSync } from "node:child_process";
import { listArchitectureTestPaths } from "./test-inventory.mjs";

const tests = listArchitectureTestPaths({
  compiledRoot: process.env.TEST_DIST_DIR ?? "dist-tests",
});
if (tests.length === 0) throw new Error("No architecture tests were discovered.");

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
