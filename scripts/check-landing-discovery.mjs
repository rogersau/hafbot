import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { prerenderChangelog, renderChangelogFeed } from "./landing-discovery.mjs";

const changelog = JSON.parse(readFileSync("changelog.json", "utf8"));

test("Atom feed has stable unique release IDs and deterministic release dates", () => {
  const feed = renderChangelogFeed(changelog);
  assert.equal(feed, renderChangelogFeed(changelog));
  const dom = new JSDOM(feed, { contentType: "application/xml" });
  try {
    const document = dom.window.document;
    assert.equal(document.documentElement.namespaceURI, "http://www.w3.org/2005/Atom");
    const entries = [...document.querySelectorAll("entry")];
    assert.equal(entries.length, changelog.releases.length);
    assert.equal(
      new Set(entries.map((entry) => entry.querySelector("id").textContent)).size,
      entries.length,
    );
    for (const [index, entry] of entries.entries()) {
      const release = changelog.releases[index];
      assert.equal(entry.querySelector("title").textContent, release.title);
      assert.equal(entry.querySelector("updated").textContent, `${release.date}T00:00:00Z`);
      assert.equal(
        entry.querySelector("link").getAttribute("href"),
        `https://hafbot.xyz/changelog#release-${encodeURIComponent(release.version)}`,
      );
    }
  } finally {
    dom.window.close();
  }
});

test("feed escapes XML instead of treating release text as markup", () => {
  const release = structuredClone(changelog.releases[0]);
  release.title = 'A & B <script> "update"';
  release.summary = "<img src=x> & 'quotes'";
  release.changes = [{ type: "fixed", text: "</content><script>bad()</script>" }];
  const dom = new JSDOM(renderChangelogFeed({ releases: [release] }), {
    contentType: "application/xml",
  });
  try {
    assert.equal(dom.window.document.querySelector("entry title").textContent, release.title);
    assert.equal(dom.window.document.querySelector("summary").textContent, release.summary);
    assert.equal(dom.window.document.querySelector("script"), null);
  } finally {
    dom.window.close();
  }
});

test("prerendered changelog contains all releases and works without the client script", () => {
  const html = prerenderChangelog(
    readFileSync("src/landing/changelog.html", "utf8"),
    readFileSync("dist-landing/changelog.js", "utf8"),
  );
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("h1").length, 1);
    assert.equal(document.querySelectorAll("article").length, changelog.releases.length);
    assert.equal(document.querySelector('script[src="/landing/assets/changelog.js"]'), null);
    for (const release of changelog.releases) {
      assert.ok(document.getElementById(`release-${encodeURIComponent(release.version)}`));
    }
    assert.ok(document.querySelector('a[href="/changelog.xml"]'));
    assert.match(document.body.textContent, /Entries describe features at their release date/);
  } finally {
    dom.window.close();
  }
});
