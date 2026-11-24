import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("mobile landing keeps pricing and the primary action reachable with usable navigation targets", async (t) => {
  const vite = await createServer({
    configFile: false,
    cacheDir: "node_modules/.vite-landing-mobile-test",
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
    plugins: [react(), landingFixture()],
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch();
    const origin = vite.resolvedUrls.local[0];
    for (const reducedMotion of ["no-preference", "reduce"]) {
      for (const width of [320, 375, 390]) {
        const viewport = { width, height: 667 };
        const page = await browser.newPage({ viewport, reducedMotion });
        page.setDefaultTimeout(5_000);
        try {
          await page.goto(origin);
          // The first navigation compiles the Vite fixture and Tailwind CSS under shared CI load.
          await page.locator(".hero h1").waitFor({ timeout: 20_000 });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));

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

          assert.equal(await page.locator(".radar-scope").isVisible(), false);
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
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser?.close();
    await vite.close();
  }
});

async function checkFirstUse(page, origin) {
  await page.goto(origin);
  const start = page.getByRole("link", { name: "Choose your first workflow" });
  await start.focus();
  await page.keyboard.press("Enter");
  const workflow = page.getByRole("region", { name: "What do you want to fix first?" });
  assert.equal(await workflow.evaluate((region) => region === document.activeElement), true);
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
  assert.equal(await page.getByRole("tab").count(), 3);
  await page.keyboard.press("ArrowDown");
  const welcome = page.getByRole("tab", { name: "# welcome" });
  assert.equal(await welcome.evaluate((tab) => tab === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await openChannels.evaluate((button) => button === document.activeElement), true);
  const preview = page.getByRole("tabpanel");
  assert.match(
    (await preview.innerText()).replace(/\s+/g, " "),
    /does not prove human or game-account identity/,
  );
  assert.equal(
    await preview.getByRole("link").getAttribute("href"),
    "https://docs.hafbot.xyz/features/member-verification#verification-methods",
  );
}

function landingFixture() {
  const entry = "/landing-mobile-test-entry.tsx";
  return {
    name: "landing-mobile-test-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Landing mobile test</title><div id="root"></div>
          <script type="module" src="${entry}"></script></html>`);
      });
    },
    resolveId(id) {
      if (id === entry) return id;
    },
    load(id) {
      if (id !== entry) return;
      return `import { createRoot } from "react-dom/client";
        import { LandingHomePage } from "/src/landing/home-page.tsx";
        import "/src/landing/styles.css";
        createRoot(document.getElementById("root")).render(<LandingHomePage prices={[]} />);`;
    },
  };
}
