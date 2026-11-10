import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
test("public docs build exposes self-hosting and current Cloudflare boundaries", () => {
  for (const file of ["index.html", "self-hosting.html", "deploy-cloudflare.html"]) {
    const dom = new JSDOM(readFileSync(`docs-site/.vitepress/dist/${file}`, "utf8"));
    assert.ok(
      dom.window.document.querySelector('meta[name="description"]')?.getAttribute("content"),
    );
    assert.ok(dom.window.document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    dom.window.close();
  }
  const sitemap = readFileSync("docs-site/.vitepress/dist/sitemap.xml", "utf8");
  assert.match(sitemap, /self-hosting/);
  assert.match(sitemap, /deploy-cloudflare/);
});
