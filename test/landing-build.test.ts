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

test("landing groups feature discovery under an accessible community-goals section", async () => {
  const document = await readLandingDocument();
  const section = document.querySelector<HTMLElement>('section[aria-labelledby="goals-title"]');
  assert.ok(section);
  assert.equal(
    section.querySelector("#goals-title")?.textContent?.trim(),
    "What should HAF help your community do?",
  );

  const visibleText = section.textContent ?? "";
  for (const goal of [
    "Protect the community",
    "Run staff operations",
    "Help members participate",
    "Connect players and systems",
    "Manage access and communications",
  ]) {
    assert.match(visibleText, new RegExp(goal));
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
