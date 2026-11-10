import { spawnSync } from "node:child_process";

const seed = process.env.TEST_REPEAT_SEED ?? String(Date.now());
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["test/runtime-app.test.ts", "test/cloudflare-webhook-proxy-store.test.ts"];
const count = Number(process.env.TEST_REPEAT_COUNT ?? 5);
if (!Number.isInteger(count) || count < 1)
  throw new Error("TEST_REPEAT_COUNT must be a positive integer.");
const build = spawnSync("pnpm", ["run", "build:test"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
for (let iteration = 1; iteration <= count; iteration += 1) {
  const order = shuffle([...files], `${seed}:${iteration}`).map(toCompiledPath);
  const result = spawnSync(
    process.execPath,
    ["--require", "./test/support/cloudflare-workers-shim.cjs", "--test", ...order],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Repeated test run ${iteration}/${count} failed (seed ${seed}, order ${order.join(", ")}).`,
    );
  }
}

function toCompiledPath(file) {
  if (file.startsWith("dist-tests/") || file.endsWith(".mjs")) return file;
  return `dist-tests/${file.replace(/\.(?:ts|tsx)$/, ".js")}`;
}

function shuffle(values, seed) {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    const target = value % (index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}
