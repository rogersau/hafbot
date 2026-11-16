import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}

test("production has one native persistence path and no test or Worker dependencies", () => {
  for (const path of sources("src")) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:D1Database|D1PreparedStatement|DurableObjectNamespace|KVNamespace)\b|cloudflare:workers|@sentry\/cloudflare|\bHAF_DB\b|(?:from\s+|import\s*\()["'][^"']*\btest\//,
      path,
    );
    assert.doesNotMatch(source, /\.replaceAll\(["']\?["']/, `${path}: runtime SQL translation`);
  }
  assert.equal(existsSync("migrations"), false);
  assert.equal(existsSync("src/index.ts"), false);
  assert.ok(existsSync("schema/postgres.sql"));
});
