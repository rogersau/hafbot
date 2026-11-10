import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const distDir = "dist-tests";

try {
  rmSync(distDir, { recursive: true, force: true });
  run("pnpm", ["run", "build:test"]);
  run(process.execPath, ["--test", join(distDir, "test", "docs-drift.test.js")]);
} finally {
  rmSync(distDir, { recursive: true, force: true });
}

function run(command, args) {
  const useShell = process.platform === "win32" && command === "pnpm";
  const result = spawnSync(command, args, { stdio: "inherit", shell: useShell });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
