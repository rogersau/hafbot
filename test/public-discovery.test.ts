import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createPublicWeb } from "./helpers/public-web";
import type { LandingPriceCatalog } from "../src/runtime/billing/landing-catalog";
import { renderChangelogFeed } from "../src/landing/changelog-feed";
import changelog from "../changelog.json";

test("the configured catalogue supplies standard pricing copy", async () => {
  const catalog: LandingPriceCatalog = {
    read: async () => [
      {
        plan: "premium",
        frequency: "monthly",
        unitAmount: 123,
        currency: "aud",
        decimalAmount: "1.23",
        formattedAmount: "$1.23",
      },
    ],
  };
  const html = await readHome(catalog);
  assert.match(html, /\$1\.23/);
  assert.doesNotMatch(html, /founder|fully claimed|50 of 50|cannot be reclaimed/i);
  assert.match(html, /Standard subscription prices/);
});

test("FAQ structured answers exactly match visible homepage answers", async () => {
  const dom = new JSDOM(await readHome());
  try {
    const document = dom.window.document;
    const data = JSON.parse(
      document.querySelector("#landing-structured-data")?.textContent ?? "{}",
    ) as {
      "@graph": {
        "@type": string;
        mainEntity?: { name: string; acceptedAnswer: { text: string } }[];
      }[];
    };
    const questions =
      data["@graph"].find((entry) => entry["@type"] === "FAQPage")?.mainEntity ?? [];
    assert.equal(questions.length, 4);
    const visible = [...document.querySelectorAll("#faq details")];
    assert.equal(visible.length, questions.length);
    for (const question of questions) {
      const item = visible.find(
        (node) => node.querySelector("summary")?.textContent === question.name,
      );
      assert.equal(
        item?.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim(),
        question.acceptedAnswer.text,
      );
    }
    assert.ok(document.querySelector(".discord-console[data-nosnippet]"));
    assert.match(
      (document.body.textContent ?? "").replace(/\s+/g, " "),
      /These are mockups, not live customer activity/,
    );
  } finally {
    dom.window.close();
  }
});

test("homepage links the WARDOGS guide without adding an unsupported integration claim", async () => {
  const html = await readHome();
  assert.match(html, /https:\/\/docs\.hafbot\.xyz\/guides\/wardogs-discord-community/);
  const dom = new JSDOM(html);
  try {
    assert.doesNotMatch(
      dom.window.document.querySelector("#landing-structured-data")?.textContent ?? "",
      /WARDOGS|RCON|reserved slots|Server XP/i,
    );
  } finally {
    dom.window.close();
  }
});

test("changelog and subscription feed are readable without scripts, accounts or tracking", async () => {
  const routes = createPublicWeb();
  const response = await routes(new Request("https://hafbot.xyz/changelog"));
  const dom = new JSDOM(await response!.text());
  try {
    assert.equal(response?.status, 200);
    assert.equal(dom.window.document.querySelectorAll("h1").length, 1);
    assert.ok(dom.window.document.querySelectorAll("article").length > 0);
    assert.equal(dom.window.document.querySelectorAll("article").length, changelog.releases.length);
    assert.ok(dom.window.document.querySelector('a[href="/changelog.xml"]'));
    assert.match(
      dom.window.document.body.textContent ?? "",
      /Entries describe features at their release date/,
    );
    const feed = await routes(new Request("https://hafbot.xyz/changelog.xml"));
    assert.equal(feed?.status, 200);
    assert.match(feed?.headers.get("content-type") ?? "", /application\/atom\+xml/);
    assert.equal(feed?.headers.get("set-cookie"), null);
    const feedDom = new JSDOM(await feed!.text(), { contentType: "application/xml" });
    for (const node of feedDom.window.document.querySelectorAll("entry id")) {
      const id = new URL(node.textContent!).hash.slice(1);
      assert.ok(dom.window.document.getElementById(id));
    }
    feedDom.window.close();
    const head = await routes(new Request("https://hafbot.xyz/changelog.xml", { method: "HEAD" }));
    assert.equal(head?.status, 200);
    assert.equal(await head?.text(), "");
    assert.equal(
      (await routes(new Request("https://hafbot.xyz/changelog.xml", { method: "POST" }))).status,
      404,
    );
  } finally {
    dom.window.close();
  }
});

async function readHome(landingPriceCatalog?: LandingPriceCatalog): Promise<string> {
  const routes = createPublicWeb({ landingPriceCatalog });
  return (await routes(new Request("https://hafbot.xyz/"))).text();
}

test("Atom feed escapes release text and uses stable, unique release IDs", () => {
  const release = structuredClone(changelog.releases[0]);
  release.title = 'A & B <script> "update"';
  release.summary = "<img src=x> & 'quotes'";
  release.changes = [{ type: "fixed", text: "</content><script>bad()</script>" }];
  const sample = { releases: [release, ...changelog.releases.slice(1)] };
  const feed = renderChangelogFeed(sample);
  assert.equal(feed, renderChangelogFeed(sample));
  const dom = new JSDOM(feed, { contentType: "application/xml" });
  try {
    const document = dom.window.document;
    assert.equal(document.documentElement.namespaceURI, "http://www.w3.org/2005/Atom");
    assert.equal(document.querySelector("entry title")?.textContent, release.title);
    assert.equal(document.querySelector("summary")?.textContent, release.summary);
    assert.equal(document.querySelector("script"), null);
    const entries = [...document.querySelectorAll("entry")];
    assert.equal(entries.length, sample.releases.length);
    const ids = new Set(entries.map((entry) => entry.querySelector("id")?.textContent));
    assert.equal(ids.size, entries.length);
    for (const [index, entry] of entries.entries()) {
      const published = sample.releases[index];
      const url = `https://hafbot.xyz/changelog#release-${encodeURIComponent(published.version)}`;
      assert.equal(entry.querySelector("id")?.textContent, url);
      assert.equal(entry.querySelector("link")?.getAttribute("href"), url);
      assert.equal(entry.querySelector("updated")?.textContent, `${published.date}T00:00:00Z`);
    }
  } finally {
    dom.window.close();
  }
});
