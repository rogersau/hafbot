/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";

async function readLandingDocument(): Promise<Document> {
  const html = await readFile("src/landing/home.html", "utf8");
  return new JSDOM(html, { url: "https://hafbot.xyz/" }).window.document;
}

test("landing build emits bounded enhancement assets", async () => {
  const [homeScript, stylesheet, changelogScript] = await Promise.all([
    stat("dist-landing/home.js"),
    stat("dist-landing/landing.css"),
    readFile("dist-landing/changelog.js"),
  ]);

  assert.ok(
    homeScript.size > 0 && homeScript.size < 5_000,
    `home enhancement was ${homeScript.size} bytes`,
  );
  assert.ok(
    stylesheet.size > 0 && stylesheet.size < 150_000,
    `landing stylesheet was ${stylesheet.size} bytes`,
  );
  assert.ok(
    changelogScript.byteLength < 50_000,
    `changelog script was ${changelogScript.byteLength} bytes`,
  );
  assert.ok(
    gzipSync(changelogScript).byteLength < 20_000,
    `gzipped changelog script was ${gzipSync(changelogScript).byteLength} bytes`,
  );
});

test("built changelog renders its accessible shared logo and release entries", async () => {
  const source = await readFile("dist-landing/changelog.js", "utf8");
  const dom = new JSDOM('<!doctype html><div id="landing-root"></div>', {
    runScripts: "outside-only",
    url: "https://hafbot.xyz/changelog",
  });

  dom.window.eval(source);

  const logo = dom.window.document.querySelector<HTMLImageElement>('img[src="/logo.png"]');
  assert.equal(logo?.alt, "HAF Bot logo");
  assert.equal(logo?.width, 44);
  assert.equal(logo?.height, 44);
  assert.equal(dom.window.document.querySelector("h1")?.textContent, "What's new in HAF Bot");
  assert.ok(dom.window.document.querySelectorAll("article").length > 0);
  dom.window.close();
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

test("shared logo declares an explicit browser cache policy", async () => {
  const headers = await readFile("assets/_headers", "utf8");
  const blocks = headers
    .split(/\n(?=\/)/)
    .map((block) => block.trim())
    .filter(Boolean);
  const logoBlock = blocks.find((block) => block.startsWith("/logo.png"));

  assert.ok(logoBlock);
  assert.match(logoBlock, /Cache-Control: public, max-age=86400, stale-while-revalidate=604800/);
});
