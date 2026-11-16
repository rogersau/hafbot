import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("feature services receive persistence through contracts", () => {
  const violations: string[] = [];
  for (const file of sourceFiles("src/services")) {
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g);
    for (const [, , specifier] of imports) {
      if (/\/(?:cloudflare-[^/]+|postgres\/|db\/)/.test(specifier!)) {
        violations.push(`${file}: ${specifier}`);
      }
    }
    if (/\b(?:D1Database|HAF_DB)\b/.test(source)) violations.push(`${file}: D1 binding`);
  }
  assert.deepEqual(violations, []);
});
