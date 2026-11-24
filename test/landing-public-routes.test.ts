/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";

import { createPublicWeb } from "./helpers/public-web";
import type { ProductAnalyticsEvent } from "../src/product-analytics";

test("home response exposes the launch content and discovery metadata without JavaScript", async () => {
  const routes = createPublicWeb();

  const response = await routes(new Request("https://hafbot.xyz/"));
  const html = (await response?.text()) ?? "";

  assert.equal(response?.status, 200);
  assert.match(html, /<h1[^>]*>\s*Handle player reports in private\./);
  assert.match(html, /Example Discord gaming community using HAF Bot/);
  assert.match(html, /Managed Message/i);
  assert.match(html, /Choose your first workflow/);
  assert.match(html, /<h2[^>]*>Start free\. Upgrade when your community needs more\.<\/h2>/);
  assert.match(html, /<title>HAF Bot.*Discord tickets, player links/);
  assert.match(html, /<link rel="canonical" href="https:\/\/hafbot\.xyz\/"/);
  assert.match(html, /<meta name="robots" content="index, follow/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /"@type":"SoftwareApplication"/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /href="\/admin"[^>]*>Login<\/a>/);
  assert.match(html, /href="\/install"[^>]*>Install/);
  const dom = new JSDOM(html);
  try {
    assert.equal(
      dom.window.document.querySelector('a[href="/changelog"]')?.textContent,
      "What's New",
    );
  } finally {
    dom.window.close();
  }
  assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1);
  assert.match(html, /What happens if I cancel\?/);
  assert.match(html, /href="https:\/\/docs\.hafbot\.xyz\/features\/tickets"/);
});

test("public documents keep their security headers and nonce all hydration scripts", async () => {
  const routes = createPublicWeb();
  for (const path of ["/", "/changelog"]) {
    const response = await routes(new Request(`https://hafbot.xyz${path}`));
    const csp = response.headers.get("content-security-policy") ?? "";
    const scriptSources = /(?:^|; )script-src ([^;]+)/.exec(csp)?.[1] ?? "";
    assert.match(scriptSources, /'nonce-landingtest'/);
    assert.match(scriptSources, /'self'/);
    assert.doesNotMatch(scriptSources, /unsafe-inline/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=60, stale-while-revalidate=300",
    );
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
    assert.equal(response.headers.get("set-cookie"), null);
    const dom = new JSDOM(await response.text());
    try {
      const document = dom.window.document;
      assert.equal(document.documentElement.lang, "en-AU");
      assert.ok(document.querySelector('script[type="module"]'));
      for (const script of document.querySelectorAll("script")) {
        assert.equal(script.getAttribute("nonce"), "landingtest");
      }
    } finally {
      dom.window.close();
    }
  }
});

test("signed-out plans, structured offers, and checkout review use the same Stripe catalogue", async () => {
  const routes = createPublicWeb({
    landingPriceCatalog: {
      read: async () => [
        {
          plan: "premium",
          frequency: "monthly",
          unitAmount: 499,
          currency: "aud",
          decimalAmount: "4.99",
          formattedAmount: "$4.99",
        },
        {
          plan: "premium",
          frequency: "yearly",
          unitAmount: 4500,
          currency: "aud",
          decimalAmount: "45.00",
          formattedAmount: "$45.00",
        },
        {
          plan: "premium_plus",
          frequency: "monthly",
          unitAmount: 899,
          currency: "aud",
          decimalAmount: "8.99",
          formattedAmount: "$8.99",
        },
        {
          plan: "premium_plus",
          frequency: "yearly",
          unitAmount: 8000,
          currency: "aud",
          decimalAmount: "80.00",
          formattedAmount: "$80.00",
        },
      ],
    },
  });

  const response = await routes(new Request("https://hafbot.xyz/"));
  const html = (await response?.text()) ?? "";

  assert.match(html, /\$4\.99<\/strong><span>AUD \/ month/);
  assert.match(html, /\$45\.00<\/strong><span>AUD \/ year/);
  assert.match(html, /\$8\.99<\/strong><span>AUD \/ month/);
  assert.match(html, /\$80\.00<\/strong><span>AUD \/ year/);
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
    { name: "Premium monthly", price: "4.99", currency: "AUD" },
    { name: "Premium yearly", price: "45.00", currency: "AUD" },
    { name: "Premium Plus monthly", price: "8.99", currency: "AUD" },
    { name: "Premium Plus yearly", price: "80.00", currency: "AUD" },
  ]);

  for (const [plan, frequency, amount, interval] of [
    ["premium", "monthly", "$4.99", "month"],
    ["premium", "yearly", "$45.00", "year"],
    ["premium_plus", "monthly", "$8.99", "month"],
    ["premium_plus", "yearly", "$80.00", "year"],
  ]) {
    const billing = await routes(
      new Request(`https://hafbot.xyz/admin/billing?plan=${plan}&frequency=${frequency}`),
    );
    assert.equal(billing.status, 302);
    const location = billing.headers.get("location");
    assert.ok(location?.startsWith("/admin/login?next="));
    const login = await routes(new Request(new URL(location!, "https://hafbot.xyz")));
    assert.equal(login.status, 200);
    const loginHtml = await login.text();
    assert.ok(loginHtml.includes(`${amount} AUD / ${interval}`));
    assert.ok(
      loginHtml.includes(
        plan === "premium"
          ? "choose one eligible Discord server in Billing"
          : "choose up to three eligible Discord servers in Billing",
      ),
    );
  }
});

test("home response fails honestly when no valid Stripe catalogue is available", async () => {
  const routes = createPublicWeb({
    landingPriceCatalog: { read: async () => null },
  });

  const html = (await (await routes(new Request("https://hafbot.xyz/")))?.text()) ?? "";

  assert.match(html, /View current price in Billing/);
  assert.doesNotMatch(html, /\$4\.99|\$8\.99/);
  const structuredData = readStructuredData(html);
  const software = structuredData["@graph"]?.find(
    (entry) => entry["@type"] === "SoftwareApplication",
  );
  assert.equal(software?.offers?.length, 1);
});

test("home response has coherent accessible tab and landmark semantics", async () => {
  const routes = createPublicWeb();
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

test("home Discord preview gives new visitors three representative workflows", async () => {
  const routes = createPublicWeb();
  const html = await (await routes(new Request("https://hafbot.xyz/"))).text();
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    const tabs = [...document.querySelectorAll<HTMLElement>("[role=tab][data-channel]")];
    assert.deepEqual(
      tabs.map((tab) => tab.dataset.channel),
      ["support", "welcome", "looking-for-group"],
    );
    const docs = [
      "/features/tickets",
      "/features/member-verification#verification-methods",
      "/features/lfg",
    ];
    for (const [index, tab] of tabs.entries()) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      assert.ok(panel);
      assert.ok(panel.querySelector(".discord-message .discord-embed"));
      assert.equal(panel.hidden, index !== 0);
      assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
      assert.ok(panel.querySelector(`a[href="https://docs.hafbot.xyz${docs[index]}"]`));
    }
    assert.match(document.querySelector("#panel-support")?.textContent ?? "", /Open ticket/);
    assert.match(
      (document.querySelector("#panel-welcome")?.textContent ?? "").replace(/\s+/g, " "),
      /It does not prove human or game-account identity/,
    );
    assert.match(
      document.querySelector("#panel-looking-for-group")?.textContent ?? "",
      /I'm Interested/,
    );
  } finally {
    dom.window.close();
  }
});

test("public discovery documents point crawlers at the canonical product sources", async () => {
  const routes = createPublicWeb();

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

test("hosted install review works without scripts and does not reflect unsupported workflows", async () => {
  const routes = createPublicWeb({ discordApplicationId: "123456789012345678" });
  const url = new URL("https://hafbot.xyz/install");
  url.searchParams.set("workflow", "<img src=x onerror=alert(1)>");
  const response = await routes(new Request(url));
  assert.equal(response.status, 200);
  const html = await response.text();
  const dom = new JSDOM(html, { url: url.href });
  try {
    const { document } = dom.window;
    assert.equal(document.querySelector("script, img"), null);
    const skip = document.querySelector("body > a");
    assert.equal(skip?.getAttribute("href"), "#main-content");
    const main = document.querySelector("main#main-content");
    assert.equal(main?.getAttribute("tabindex"), "-1");
    assert.match(main?.textContent ?? "", /no extra permissions for the bot role/);
    assert.equal(main?.querySelector('a[href="/admin"]')?.textContent, "open dashboard setup");
    assert.match(
      main?.querySelector('a[href="/install?continue=discord"]')?.textContent ?? "",
      /opens in a new tab/,
    );
  } finally {
    dom.window.close();
  }
});

test("public HTML and install routes emit bounded events without affecting responses", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const routes = createPublicWeb({
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
  const review = await routes(new Request("https://hafbot.xyz/install"));

  assert.equal(home?.status, 200);
  assert.equal(review?.status, 200);
  assert.equal(events.length, 1);

  const install = await routes(new Request("https://hafbot.xyz/install?continue=discord"));
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
  const routes = createPublicWeb({
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
    /<script id="landing-structured-data" type="application\/ld\+json"[^>]*>([^<]+)<\/script>/.exec(
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
