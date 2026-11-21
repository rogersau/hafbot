import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ALLOWED_HTML_PRODUCERS = new Set(["src/http/html-response.ts"]);

test("production HTML is constructed only through the hardened HTML response module", async () => {
  const files = await walk("src");
  const violations: string[] = [];
  for (const file of files.filter((entry) => /\.tsx?$/.test(entry))) {
    if (ALLOWED_HTML_PRODUCERS.has(file)) continue;
    const source = await readFile(file, "utf8");
    if (/content-type["']?\s*:\s*["']text\/html/i.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});

test("server-rendered documents share the hardened HTML header policy", async () => {
  const source = await readFile("src/web/start.ts", "utf8");
  assert.match(source, /import \{ htmlResponseHeaders \} from "\.\.\/http\/html-response"/);
  assert.match(source, /htmlResponseHeaders\(\{/);
});

test("legal HTML has no Google font dependency", async () => {
  const source = await readFile("src/routes/legal-pages.ts", "utf8");
  assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic/i);
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
