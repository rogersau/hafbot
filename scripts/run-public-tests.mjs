import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const prebuilt = process.argv.includes("--prebuilt");
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (prebuilt) {
  for (const path of [
    "dist-admin/.vite/manifest.json",
    "dist-admin/admin/assets/admin.js",
    "dist-landing/home.js",
    "src/runtime/landing-bundle.ts",
  ]) {
    if (!existsSync(path)) throw new Error(`Missing public build artifact: ${path}`);
  }
} else {
  run("pnpm", ["run", "build:admin"]);
  run("pnpm", ["run", "build:landing"]);
}
run(process.execPath, ["scripts/run-build-tests.mjs"]);
run("pnpm", ["run", "build:test"]);
run(process.execPath, ["scripts/run-node-tests.mjs"]);
run(process.execPath, ["scripts/run-architecture-tests.mjs"]);
