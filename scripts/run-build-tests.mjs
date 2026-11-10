import { spawnSync } from "node:child_process";
import { listBuildTestPaths } from "./test-inventory.mjs";

const tests = listBuildTestPaths();
if (tests.length === 0) process.exit(0);

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
