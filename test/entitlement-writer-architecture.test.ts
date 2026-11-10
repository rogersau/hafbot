/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

const REPOSITORY_ROOT = process.cwd();
test("entitlement projection writers remain inside the Billing boundary", () => {
  const runtimeFiles = listTextFiles(join(REPOSITORY_ROOT, "src")).filter(
    (file) => extname(file) === ".ts" || extname(file) === ".tsx",
  );
  const writePatterns = [
    ".insert(guildentitlements)",
    ".update(guildentitlements)",
    ".delete(guildentitlements)",
    "insert into guild_entitlements",
    "update guild_entitlements",
    "delete from guild_entitlements",
  ];
  const writers = runtimeFiles
    .filter((file) => {
      const source = readFileSync(file, "utf8").toLowerCase();
      return writePatterns.some((pattern) => source.includes(pattern));
    })
    .map((file) => relative(REPOSITORY_ROOT, file).replaceAll("\\", "/"))
    .sort();

  assert.deepEqual(writers, [
    "src/runtime/billing/cloudflare-adverse-store.ts",
    "src/runtime/billing/cloudflare-assignment-store.ts",
    "src/runtime/billing/cloudflare-billing-sync-store.ts",
    "src/runtime/billing/cloudflare-grace-store.ts",
    "src/runtime/cloudflare-guild-plan-projection-store.ts",
  ]);
});

function listTextFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "dist" || entry === "cache") {
        continue;
      }
      files.push(...listTextFiles(path));
      continue;
    }
    if ([".ts", ".tsx", ".js", ".md", ".toml", ".json"].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}
