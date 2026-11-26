import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { serveLanding } from "../scripts/admin-qa/server.mjs";

test("mobile landing keeps pricing and the primary action reachable with usable navigation targets", async (t) => {
  const server = await serveLanding();
  const { origin } = server;
  let browser;
  try {
    browser = await chromium.launch();
    for (const reducedMotion of ["no-preference", "reduce"]) {
      for (const width of [320, 375, 390]) {
        const viewport = { width, height: 667 };
        const page = await browser.newPage({ viewport, reducedMotion });
        page.setDefaultTimeout(5_000);
        const browserErrors = [];
        page.on("pageerror", (error) => browserErrors.push(error.message));
        await page.route("**/*", (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        try {
          await openLanding(page, origin);

          const dimensions = await page.evaluate(() => ({
            documentWidth: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            planTop: Math.round(document.querySelector("#plans").getBoundingClientRect().top),
            firstPlanTop: Math.round(
              document.querySelector(".plan-grid article").getBoundingClientRect().top,
            ),
            heroHeight: Math.round(document.querySelector(".hero").getBoundingClientRect().height),
          }));
          assert.equal(dimensions.documentWidth, width, "page has horizontal overflow");

          const links = await page.locator(".site-nav a, .site-footer a").evaluateAll((items) =>
            items.map((link) => {
              const { left, right, width, height } = link.getBoundingClientRect();
              return {
                name: link.getAttribute("aria-label") || link.textContent.trim(),
                left,
                right,
                width,
                height,
                fontSize: Number.parseFloat(getComputedStyle(link).fontSize),
              };
            }),
          );
          for (const link of links) {
            assert.ok(link.width >= 44 && link.height >= 44, `${link.name} is too small to tap`);
            assert.ok(link.fontSize >= 13, `${link.name} text is too small`);
            assert.ok(link.left >= 0 && link.right <= width, `${link.name} goes off screen`);
          }

          assert.ok(await page.getByText("Sample server preview").isVisible());
          const primary = await page.locator(".hero .button-primary").evaluate((link) => {
            const { left, width, top, height, bottom } = link.getBoundingClientRect();
            const hit = document.elementFromPoint(left + width / 2, top + height / 2);
            return { top: Math.round(top), bottom, acceptsTap: link.contains(hit) };
          });
          assert.ok(primary.top >= 0 && primary.bottom <= viewport.height);
          assert.ok(primary.acceptsTap, "hero action is obscured");

          const navigation = page.getByRole("navigation", { name: "Main navigation" });
          await navigation.getByRole("link", { name: "HAF Bot home" }).focus();
          await page.keyboard.press("Tab");
          const pricing = navigation.locator('a[href="#plans"]');
          assert.equal(await pricing.evaluate((link) => link === document.activeElement), true);
          assert.notEqual(
            await pricing.evaluate((link) => getComputedStyle(link).outlineStyle),
            "none",
          );
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => {
            const heading = document.querySelector("#plans-title").getBoundingClientRect();
            return location.hash === "#plans" && heading.top >= 0 && heading.bottom <= innerHeight;
          });
          t.diagnostic(
            `${width}px (${reducedMotion}): ${JSON.stringify({ ...dimensions, primaryTop: primary.top })}`,
          );
          if (width === 375 && reducedMotion === "reduce") {
            await checkFirstUse(page, origin);
          }
          assert.deepEqual(browserErrors, [], "built landing page should load without errors");
        } catch (error) {
          if (browserErrors.length) {
            throw new Error(`${error.message}\nBrowser errors: ${browserErrors.join("; ")}`, {
              cause: error,
            });
          }
          throw error;
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

async function openLanding(page, origin) {
  const response = await page.goto(origin);
  assert.equal(response?.status(), 200, "the built landing route should respond successfully");
  await page.locator(".hero h1").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function checkFirstUse(page, origin) {
  await openLanding(page, origin);
  const workflow = page.getByRole("region", { name: "What do you want to fix first?" });
  await workflow.focus();
  await page.keyboard.press("Tab");
  const tickets = workflow.getByRole("radio", { name: "Handle support or reports" });
  assert.equal(await tickets.evaluate((radio) => radio === document.activeElement), true);
  await page.keyboard.press("Space");
  await workflow.getByRole("heading", { name: "Tickets", exact: true }).waitFor();
  assert.match(await workflow.innerText(), /As a non-staff member, open and close a test Ticket/);
  assert.equal(
    await workflow.getByRole("link", { name: "Review install permissions" }).getAttribute("href"),
    "/install?workflow=tickets",
  );

  const openChannels = page.getByRole("button", { name: "Open channel list" });
  assert.match(await openChannels.innerText(), /Channel list/);
  await openChannels.click();
  assert.equal(await page.getByRole("tab").count(), 6);
  await page.keyboard.press("ArrowDown");
  const welcome = page.getByRole("tab", { name: "# welcome" });
  assert.equal(await welcome.evaluate((tab) => tab === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await openChannels.evaluate((button) => button === document.activeElement), true);
  const preview = page.getByRole("tabpanel");
  assert.match(
    (await preview.innerText()).replace(/\s+/g, " "),
    /When they hit Verify, HAF gives them the role you picked/,
  );
  assert.equal(
    await preview.getByRole("link").getAttribute("href"),
    "https://docs.hafbot.xyz/features/member-verification#verification-methods",
  );
}
