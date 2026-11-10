import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("built Node entrypoints keep E2E configuration out of production and validate it before connecting", async (t) => {
  const root = resolve(".artifacts");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "discord-e2e-entrypoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const entry of ["main", "e2e-main"]) {
    await build({
      entryPoints: [`src/node/${entry}.ts`],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile: join(directory, `${entry}.mjs`),
    });
  }
  const base = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    STAGING_MODE: "true",
    DATABASE_URL: "postgresql://haf:fake-only@127.0.0.1:1/haf_e2e_test",
    BOT_USER_ID: "100000000000000003",
    HAF_E2E_GUILD_ID: "100000000000000001",
    HAF_E2E_BOT_USER_IDS: "100000000000000002",
  };
  for (const [entry, overrides, error] of [
    ["main", {}, /separate Discord E2E entrypoint/],
    ["e2e-main", { STAGING_MODE: "false" }, /requires STAGING_MODE=true/],
    ["e2e-main", { HAF_E2E_GUILD_ID: undefined }, /HAF_E2E_GUILD_ID/],
    [
      "e2e-main",
      { DATABASE_URL: "postgresql://haf:fake-only@127.0.0.1:1/production" },
      /separate DATABASE_URL/,
    ],
    ["e2e-main", { HAF_E2E_BOT_USER_IDS: base.BOT_USER_ID }, /own bot/],
  ]) {
    const result = spawnSync(process.execPath, [join(directory, `${entry}.mjs`)], {
      env: { ...base, ...overrides },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, `${entry} must fail before starting the host`);
    assert.match(`${result.stdout}\n${result.stderr}`, error);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fake-only|ECONNREFUSED/);
  }
});
