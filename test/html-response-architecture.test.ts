import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ALLOWED_HTML_PRODUCERS = new Set(["src/http/html-response.ts"]);

test("production HTML is constructed only through the hardened HTML response module", async () => {
  const files = await walk("src");
  const violations: string[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".ts"))) {
    if (ALLOWED_HTML_PRODUCERS.has(file)) continue;
    const source = await readFile(file, "utf8");
    if (/content-type["']?\s*:\s*["']text\/html/i.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});

test("generated HTML has no Google font dependency or inline Admin script", async () => {
  const sources = await Promise.all([
    readFile("src/runtime/admin-shell-template.ts", "utf8"),
    readFile("scripts/embed-landing-build.mjs", "utf8"),
    readFile("src/routes/legal-pages.ts", "utf8"),
  ]);
  for (const source of sources) assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic/i);
  assert.doesNotMatch(sources[0]!, /<script>(?!<)/i);
});

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else result.push(path);
  }
  return result;
}
