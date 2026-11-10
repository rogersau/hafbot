/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";

import { createPublicRoutes } from "../src/routes/public-routes";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type { ProductAnalyticsEvent } from "../src/product-analytics";

test("home response exposes the launch content and discovery metadata without JavaScript", async () => {
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });

  const response = await routes(new Request("https://hafbot.xyz/"));
  const html = (await response?.text()) ?? "";

  assert.equal(response?.status, 200);
  assert.match(html, /<h1[^>]*>\s*Less time running Discord\. More time playing\./);
  assert.match(html, /Example Discord gaming community using HAF Bot/);
  assert.match(html, /Managed Message/i);
  assert.match(html, /Image Rules Mod Queue/i);
  assert.match(html, /Guild Audit Log/i);
  assert.match(html, /<h2[^>]*>Start free\. Upgrade when your community needs more\.<\/h2>/);
  assert.match(html, /<title>HAF Bot.*Discord tickets, player links/);
  assert.match(html, /<link rel="canonical" href="https:\/\/hafbot\.xyz\/"/);
  assert.match(html, /<meta name="robots" content="index, follow/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /"@type":"SoftwareApplication"/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /href="\/admin"[^>]*>Login<\/a>/);
  assert.match(html, /href="\/install"[^>]*>Install/);
  assert.match(html, /href="\/changelog"[^>]*>What's New<\/a>/);
  assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1);
  assert.match(html, /What happens if I cancel\?/);
  assert.match(html, /href="https:\/\/docs\.hafbot\.xyz\/features\/image-rules"/);
});

test("home response renders the same Stripe catalogue values into plans and structured offers", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    landingPriceCatalog: {
      readFounderAdmission: async () => ({
        historicalCount: 12,
        publicCount: 12,
        limit: 50,
        open: true,
      }),
      read: async () => [
        {
          plan: "premium",
          frequency: "monthly",
          unitAmount: 2900,
          currency: "aud",
          decimalAmount: "29.00",
          formattedAmount: "$29.00",
        },
        {
          plan: "premium",
          frequency: "yearly",
          unitAmount: 29000,
          currency: "aud",
          decimalAmount: "290.00",
          formattedAmount: "$290.00",
        },
        {
          plan: "premium_plus",
          frequency: "monthly",
          unitAmount: 4900,
          currency: "aud",
          decimalAmount: "49.00",
          formattedAmount: "$49.00",
        },
        {
          plan: "premium_plus",
          frequency: "yearly",
          unitAmount: 49000,
          currency: "aud",
          decimalAmount: "490.00",
          formattedAmount: "$490.00",
        },
      ],
    },
  });

  const response = await routes(new Request("https://hafbot.xyz/"));
  const html = (await response?.text()) ?? "";

  assert.match(html, /\$29\.00<\/strong><span>AUD \/ month/);
  assert.match(html, /\$290\.00<\/strong><span>AUD \/ year/);
  assert.match(html, /\$49\.00<\/strong><span>AUD \/ month/);
  assert.match(html, /\$490\.00<\/strong><span>AUD \/ year/);
  assert.match(html, /"name":"Premium monthly"[^}]+"price":"29\.00"/);
  assert.match(html, /"name":"Premium Plus yearly"[^}]+"price":"490\.00"/);
  assert.doesNotMatch(html, /View current price in Billing/);
  assert.match(html, /Standard subscription prices/);
  assert.doesNotMatch(html, /founder|places claimed|cannot be reclaimed/i);
  assert.doesNotMatch(html, /normally|was <|<del|line-through/i);
  const structuredData = readStructuredData(html);
  const offers = structuredData["@graph"]
    ?.find((entry) => entry["@type"] === "SoftwareApplication")
    ?.offers?.slice(1)
    .map((offer) => ({ name: offer.name, price: offer.price, currency: offer.priceCurrency }));
  assert.deepEqual(offers, [
    { name: "Premium monthly", price: "29.00", currency: "AUD" },
    { name: "Premium yearly", price: "290.00", currency: "AUD" },
    { name: "Premium Plus monthly", price: "49.00", currency: "AUD" },
    { name: "Premium Plus yearly", price: "490.00", currency: "AUD" },
  ]);
});

test("home response fails honestly when no valid Stripe catalogue is available", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    landingPriceCatalog: { read: async () => null },
  });

  const html = (await (await routes(new Request("https://hafbot.xyz/")))?.text()) ?? "";

  assert.match(html, /View current price in Billing/);
  assert.doesNotMatch(html, /\$29\.00|\$49\.00/);
  const structuredData = readStructuredData(html);
  const software = structuredData["@graph"]?.find(
    (entry) => entry["@type"] === "SoftwareApplication",
  );
  assert.equal(software?.offers?.length, 1);
});

test("home response has coherent accessible tab and landmark semantics", async () => {
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });
  const html = (await (await routes(new Request("https://hafbot.xyz/")))?.text()) ?? "";
  const document = new JSDOM(html).window.document;
  const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);

  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(document.querySelectorAll("header nav, main, footer").length >= 3, true);
  assert.equal(new Set(ids).size, ids.length);
  for (const tab of document.querySelectorAll<HTMLElement>("[role=tab]")) {
    const panelId = tab.getAttribute("aria-controls");
    assert.ok(panelId);
    assert.equal(document.getElementById(panelId)?.getAttribute("role"), "tabpanel");
  }
});

test("home Discord preview exposes each community workflow as a selectable Discord embed", async () => {
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });
  const html = (await (await routes(new Request("https://hafbot.xyz/")))?.text()) ?? "";
  const document = new JSDOM(html).window.document;
  const expectedChannels = [
    "announcements",
    "community",
    "mod-queue",
    "audit-log",
    "welcome",
    "looking-for-group",
    "marketplace",
    "evidence-vault",
  ];

  assert.deepEqual(
    [...document.querySelectorAll<HTMLElement>("[role=tab][data-channel]")].map(
      (tab) => tab.dataset.channel,
    ),
    expectedChannels,
  );
  for (const channel of expectedChannels.slice(3)) {
    const panel = document.querySelector<HTMLElement>(`[data-panel="${channel}"]`);
    assert.ok(panel, `missing ${channel} panel`);
    assert.ok(
      panel.querySelector(".discord-message .discord-embed"),
      `${channel} is not represented as a Discord embed`,
    );
  }
  assert.equal(document.querySelectorAll('[data-panel="audit-log"] .discord-embed').length, 3);
  const auditText = document.querySelector('[data-panel="audit-log"]')?.textContent ?? "";
  assert.match(auditText, /Image Rules Mod Queue Action/);
  assert.match(auditText, /Author[\s\S]+Channel[\s\S]+Message ID/);
  assert.match(auditText, /Member Verified[\s\S]+User[\s\S]+Context/);
  assert.equal(
    document.querySelectorAll('[data-panel="audit-log"] .embed-fields.single-column').length,
    3,
  );
  assert.match(document.querySelector('[data-panel="welcome"]')?.textContent ?? "", /Verify/);
  assert.match(
    document.querySelector('[data-panel="looking-for-group"]')?.textContent ?? "",
    /I'm Interested[\s\S]+Close Post/,
  );
  assert.match(
    document.querySelector('[data-panel="marketplace"]')?.textContent ?? "",
    /Is there something you are looking for\?[\s\S]+Extra info[\s\S]+Do Business[\s\S]+Close Post/,
  );
  assert.match(
    document.querySelector('[data-panel="evidence-vault"]')?.textContent ?? "",
    /View record/,
  );
});

test("public discovery documents point crawlers at the canonical product sources", async () => {
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });

  const robots = await routes(new Request("https://hafbot.xyz/robots.txt"));
  const sitemap = await routes(new Request("https://hafbot.xyz/sitemap.xml"));
  const llms = await routes(new Request("https://hafbot.xyz/llms.txt"));
  const llmsText = (await llms?.text()) ?? "";

  assert.equal(robots?.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(
    (await robots?.text()) ?? "",
    /User-agent: \*\s+Allow: \/\s+Sitemap: https:\/\/hafbot\.xyz\/sitemap\.xml/,
  );
  assert.equal(sitemap?.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.match((await sitemap?.text()) ?? "", /<loc>https:\/\/hafbot\.xyz\/<\/loc>/);
  assert.equal(llms?.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(llmsText, /Discord bot built for gaming communities/);
  assert.match(llmsText, /https:\/\/docs\.hafbot\.xyz/);
});

test("public HTML and install routes emit bounded events without affecting responses", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    discordApplicationId: "123456789012345678",
    productAnalytics: { report: async (event) => void events.push(event) },
  });

  const home = await routes(
    new Request(
      "https://hafbot.xyz/?utm_source=Discord&utm_medium=customer-123&utm_campaign=launch&secret=drop",
      {
        headers: {
          referer: "https://example.com/private/path?token=secret",
          "user-agent": "Mozilla/5.0 Chrome/120.0",
          "cf-ipcountry": "au",
        },
      },
    ),
  );
  const install = await routes(new Request("https://hafbot.xyz/install"));

  assert.equal(home?.status, 200);
  assert.equal(install?.status, 302);
  assert.equal(events[0]?.name, "public_page_viewed");
  assert.deepEqual(events[0]?.name === "public_page_viewed" ? events[0] : null, {
    name: "public_page_viewed",
    insertionId: events[0]?.insertionId,
    path: "/",
    referrerDomain: "example.com",
    utmSource: "discord",
    utmMedium: undefined,
    utmCampaign: "launch",
    deviceClass: "desktop",
    browserFamily: "chrome",
    country: "AU",
  });
  assert.equal(events[1]?.name, "install_started");
  assert.doesNotMatch(JSON.stringify(events), /private|token|secret/);
});

test("public page views honor privacy signals and exclude crawlers", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    productAnalytics: { report: async (event) => void events.push(event) },
  });

  await routes(new Request("https://hafbot.xyz/", { headers: { "sec-gpc": "1" } }));
  await routes(new Request("https://hafbot.xyz/changelog", { headers: { dnt: "1" } }));
  await routes(
    new Request("https://hafbot.xyz/privacy", { headers: { "user-agent": "ExampleBot/1.0" } }),
  );

  assert.deepEqual(events, []);
});

function readStructuredData(html: string): StructuredData {
  return JSON.parse(
    /<script id="landing-structured-data" type="application\/ld\+json">([^<]+)<\/script>/.exec(
      html,
    )?.[1] ?? "{}",
  ) as StructuredData;
}

interface StructuredData {
  "@graph"?: Array<{
    "@type"?: string;
    offers?: Array<{ name?: string; price?: string; priceCurrency?: string }>;
  }>;
}
