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
        link.textContent?.includes("Compare every feature and plan limit"),
    ),
  );
});

test("landing gives the main action to workflow selection and points deeper discovery to the docs", async () => {
  const document = await readLandingDocument();
  try {
    const [primary] = document.querySelectorAll<HTMLAnchorElement>(".hero-actions .button");
    assert.equal(document.querySelectorAll(".hero-actions .button").length, 1);
    assert.equal(primary?.getAttribute("href"), "#first-workflow");
    const selector = document.querySelector("#first-workflow");
    assert.equal(selector?.getAttribute("tabindex"), "-1");
    assert.equal(selector?.querySelectorAll('input[type="radio"]').length, 6);
    assert.equal(selector?.nextElementSibling?.id, "live-demo");

    const guides = document.querySelector('nav[aria-labelledby="workflow-guides-title"]');
    assert.ok(
      guides?.querySelector('a[href="https://docs.hafbot.xyz/features/mention-protection"]'),
    );
    assert.ok(guides?.querySelector('a[href="https://docs.hafbot.xyz/features/player-link"]'));
    assert.ok(guides?.querySelector('a[href="https://docs.hafbot.xyz/features/managed-messages"]'));
    assert.ok(guides?.querySelector('a[href="https://docs.hafbot.xyz/"]'));

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
    assert.match(assignment, /does not upgrade every server you manage/);
    assert.match(assignment, /choose\s+one eligible Discord server in Billing with Premium/);
    assert.match(assignment, /up to three with Premium\s+Plus/);

    const [free, premium] = plans.querySelectorAll("article");
    assert.match(
      free?.textContent ?? "",
      /3 Managed Messages total across drafts and published messages/,
    );
    assert.equal(premium?.querySelector("h3")?.textContent, "When Free is not enough");
    const examples = premium?.textContent ?? "";
    assert.match(examples, /ticket types for support and reports/);
    assert.match(examples, /Scheduled Events, Image Rules or Mention Spam Protection/);
    assert.match(examples, /Player Count or Webhooks/);
    assert.match(examples, /More than 100 Player Links or more than 3 Managed Messages/);
  } finally {
    document.defaultView?.close();
  }
});
