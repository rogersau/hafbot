/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";
import { serveStaticAsset } from "../src/node/static-assets";
import { createPublicWeb } from "./helpers/public-web";

const routes = createPublicWeb();

async function readLandingDocument(path = "/"): Promise<Document> {
  const url = new URL(path, "https://hafbot.xyz");
  const response = await routes(new Request(url));
  assert.equal(response.status, 200);
  return new JSDOM(await response.text(), { url: url.href }).window.document;
}

test("the built public documents link to the served, local landing stylesheet", async () => {
  const [home, changelog] = await Promise.all([
    readLandingDocument(),
    readLandingDocument("/changelog"),
  ]);
  try {
    const links = [...home.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
    assert.equal(links.length, 1);
    const href = links[0].href;
    assert.match(href, /^https:\/\/hafbot\.xyz\/admin\/assets\/[^/]+\.css$/);
    assert.equal(changelog.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.href, href);
    const response = await serveStaticAsset(new Request(href), "dist-admin");
    assert.equal(response?.status, 200);
    assert.match(response?.headers.get("content-type") ?? "", /^text\/css/);
    const css = await response!.text();
    assert.ok(css.length > 0 && css.length < 150_000, `landing stylesheet was ${css.length} bytes`);
    assert.match(css, /\.landing-page/);
    assert.match(css, /@font-face/);
    assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic/i);
  } finally {
    home.defaultView?.close();
    changelog.defaultView?.close();
  }
});

test("the built changelog renders its accessible shared logo and release entries", async () => {
  const document = await readLandingDocument("/changelog");
  try {
    const logo = document.querySelector<HTMLImageElement>('img[src="/logo.png"]');
    assert.equal(logo?.alt, "HAF Bot logo");
    assert.equal(logo?.width, 44);
    assert.equal(logo?.height, 44);
    assert.equal(document.querySelector("h1")?.textContent, "What's new in HAF Bot");
    assert.ok(document.querySelectorAll("article").length > 0);
  } finally {
    document.defaultView?.close();
  }
});

test("landing exposes the visual radar as decoration and a labelled mobile navigation control", async () => {
  const document = await readLandingDocument();
  const radar = document.querySelector(".signal-field");
  const mobileNavigation = document.querySelector<HTMLButtonElement>(".mobile-channel-toggle");

  assert.equal(radar?.getAttribute("aria-hidden"), "true");
  assert.ok(mobileNavigation);
  assert.ok(
    mobileNavigation.getAttribute("aria-label") || mobileNavigation.textContent?.trim(),
    "mobile channel navigation needs an accessible name",
  );
});

test("landing plan choices preserve checkout intent and link to the complete comparison", async () => {
  const document = await readLandingDocument();
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));

  assert.ok(
    links.some((link) => {
      const url = new URL(link.href);
      return (
        url.pathname === "/admin/billing" &&
        url.searchParams.get("plan") === "premium" &&
        url.searchParams.get("frequency") === "yearly"
      );
    }),
  );
  assert.ok(
    links.some((link) => {
      const url = new URL(link.href);
      return (
        url.pathname === "/admin/billing" &&
        url.searchParams.get("plan") === "premium_plus" &&
        url.searchParams.get("frequency") === "yearly"
      );
    }),
  );
  assert.ok(
    links.some(
      (link) =>
        link.href === "https://docs.hafbot.xyz/plans" &&
        link.textContent?.includes("See which features each plan includes"),
    ),
  );
});

test("landing directs visitors to installation, a workflow preview and setup guides", async () => {
  const document = await readLandingDocument();
  try {
    assert.doesNotMatch(document.documentElement.textContent ?? "", /\u2014/);
    const [primary, secondary] = document.querySelectorAll<HTMLAnchorElement>(
      ".hero .hero-actions .button",
    );
    assert.equal(primary.getAttribute("href"), "/install?continue=discord");
    assert.equal(
      document.querySelector(".site-nav .install-link")?.getAttribute("href"),
      "/install?continue=discord",
    );
    assert.equal(secondary.getAttribute("href"), "#live-demo");
    assert.ok(document.querySelector("#live-demo"));
    const preview = document.querySelector(".workspace-preview");
    assert.ok(preview?.querySelector("img[src]"));
    assert.match(preview?.textContent ?? "", /Sample server preview/);
    const selector = document.querySelector("#live-demo #first-workflow");
    assert.equal(selector?.getAttribute("tabindex"), "-1");
    assert.equal(selector?.querySelectorAll('option:not([value=""])').length, 6);
    assert.ok(document.querySelector('.final-cta a[href="https://docs.hafbot.xyz/"]'));
    assert.match(document.querySelector(".footer-brand")?.textContent ?? "", /HELPFUL AS F\*\*K/);

    const footer = document.querySelector(".site-footer nav");
    assert.ok(footer?.querySelector('a[href="/privacy"]'));
    assert.ok(footer?.querySelector('a[href="/terms"]'));
    assert.ok(footer?.querySelector('a[href="https://docs.hafbot.xyz/self-hosting"]'));
  } finally {
    document.defaultView?.close();
  }
});

test("shared logo, favicon and social banner are served with cache validators", async () => {
  for (const [path, type] of [
    ["/logo.png", "image/png"],
    ["/favicon.ico", "image/x-icon"],
    ["/banner.png", "image/png"],
  ]) {
    const url = `https://hafbot.xyz${path}`;
    const response = await serveStaticAsset(new Request(url, { method: "HEAD" }), "dist-admin");
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("content-type"), type);
    const etag = response?.headers.get("etag");
    assert.ok(etag);
    const cached = await serveStaticAsset(
      new Request(url, { headers: { "if-none-match": etag } }),
      "dist-admin",
    );
    assert.equal(cached?.status, 304);
  }
});

test("landing pricing shows practical upgrade triggers and explains server assignment", async () => {
  const document = await readLandingDocument();
  try {
    const plans = document.querySelector("#plans");
    assert.ok(plans);
    const assignment = plans.querySelector(".pricing-summary")?.textContent ?? "";
    assert.match(assignment, /Assign Premium to one Discord server in Billing/);
    assert.match(assignment, /up to three with Premium Plus/);

    const [free, premium] = plans.querySelectorAll("article");
    assert.match(free?.textContent ?? "", /Up to 3 Managed Messages \(drafts \+ live\)/);
    assert.equal(premium?.querySelector("h3")?.textContent, "For one growing community");
    const examples = premium?.textContent ?? "";
    assert.match(examples, /Unlimited ticket panels & types, auto-replies and anonymous reports/);
    assert.match(examples, /Scheduled Events, Image Rules and Mention Spam Protection/);
    assert.match(examples, /Live player counts and webhooks/);
    assert.match(examples, /Unlimited player links and managed messages/);
  } finally {
    document.defaultView?.close();
  }
});
