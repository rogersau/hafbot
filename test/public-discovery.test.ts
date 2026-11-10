import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createPublicRoutes } from "../src/routes/public-routes";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type { LandingPriceCatalog } from "../src/runtime/billing/landing-catalog";
import { renderLandingPage } from "../src/runtime/landing-page";

for (const admission of ["missing", "failed", "closed"] as const) {
  test(`founder admission ${admission} never invents a sold-out counter`, async () => {
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
    if (admission === "failed")
      catalog.readFounderAdmission = async () => {
        throw new Error("unavailable");
      };
    if (admission === "closed")
      catalog.readFounderAdmission = async () => ({
        open: false,
        historicalCount: 50,
        publicCount: 50,
        limit: 50,
      });
    const html = await renderLandingPage(catalog);
    assert.match(html, /\$1\.23/);
    assert.doesNotMatch(html, /fully claimed|50 of 50/);
    assert.match(
      html,
      admission === "closed" ? /not currently available/ : /availability could not be confirmed/,
    );
  });
}

test("FAQ structured answers exactly match visible homepage answers", async () => {
  const dom = new JSDOM(await renderLandingPage());
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
  const html = await renderLandingPage();
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
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });
  const response = await routes(new Request("https://hafbot.xyz/changelog"));
  const dom = new JSDOM(await response!.text());
  try {
    assert.equal(response?.status, 200);
    assert.equal(dom.window.document.querySelectorAll("h1").length, 1);
    assert.ok(dom.window.document.querySelectorAll("article").length > 0);
    assert.equal(
      dom.window.document.querySelector('script[src="/landing/assets/changelog.js"]'),
      null,
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
      await routes(new Request("https://hafbot.xyz/changelog.xml", { method: "POST" })),
      null,
    );
  } finally {
    dom.window.close();
  }
});
