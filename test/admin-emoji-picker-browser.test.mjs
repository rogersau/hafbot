import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";

const EMOJI_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("EmojiPicker cold load keeps a stable shell and loads the CSP-allowed Unicode grid", async () => {
  const vite = await createEmojiPickerTestServer({ productionCsp: true });
  let browser;
  try {
    browser = await chromium.launch();
    await warmEmojiPickerTestServer(vite, browser);
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const browserErrors = collectBrowserErrors(page);
    await stubEmojiPickerImages(page);
    await delayEmojiImplementation(page);
    await page.goto(testServerUrl(vite));
    assert.deepEqual(browserErrors, []);
    await page
      .getByTestId("standalone-picker")
      .getByRole("button", { name: "Choose emoji" })
      .click();

    const loadingShell = page
      .locator('[role="status"]')
      .filter({ hasText: "Loading unicode emojis" });
    await loadingShell.waitFor();
    assert.equal(Math.round((await loadingShell.boundingBox())?.height ?? 0), 340);
    assert.equal(await page.locator('[data-emoji-picker-unicode="true"]').count(), 0);

    const grid = page.locator('[data-emoji-picker-unicode="true"]');
    await grid.waitFor({ timeout: 10_000 });
    assert.equal(Math.round((await grid.boundingBox())?.height ?? 0), 340);
    const pickerStyleNonces = await page
      .locator("style")
      .evaluateAll((styles) =>
        styles
          .filter((style) => style.textContent?.includes(".EmojiPickerReact"))
          .map((style) => style.nonce),
      );
    assert.deepEqual(pickerStyleNonces, ["emoji-picker-test"]);
    const emojiImage = grid.locator('.epr-emoji img[src*="cdn.jsdelivr.net"]').first();
    await emojiImage.waitFor();
    await emojiImage.evaluate((image) => image.decode());
    assert.ok(
      (await emojiImage.evaluate((image) => image.naturalWidth)) > 0,
      "Expected the first emoji image to load",
    );
    await assertVisibleEmojiImagesLoad(grid);
    await assertEmojiCellsDoNotOverlap(grid);
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("BlocklistEmojiField makes already-blocked Unicode emoji unavailable", async () => {
  const vite = await createEmojiPickerTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    await warmEmojiPickerTestServer(vite, browser);
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await stubEmojiPickerImages(page);
    await page.goto(testServerUrl(vite));
    await page
      .getByTestId("blocklist-picker")
      .getByRole("button", { name: "Choose emojis" })
      .click();

    const grid = page.locator('[data-emoji-picker-unicode="true"]').last();
    await grid.waitFor({ timeout: 10_000 });
    const search = grid.getByPlaceholder("Search unicode emojis");
    await search.fill("check mark button");

    const blocked = grid.locator('button[data-unified="2705"]');
    await blocked.waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-unified="2705"]');
      return button?.hasAttribute("disabled") && button.getAttribute("aria-disabled") === "true";
    });
    assert.equal(await blocked.isDisabled(), true);
    assert.equal(await blocked.getAttribute("aria-disabled"), "true");
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("Resource creation inserts a Unicode emoji and sends the exact name to preview", async () => {
  const vite = await createEmojiPickerTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    await warmEmojiPickerTestServer(vite, browser);
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const browserErrors = collectBrowserErrors(page);
    await stubEmojiPickerImages(page);
    let previewBody;
    await page.route("**/admin/api/feature-resource-setup/preview*", async (route) => {
      previewBody = route.request().postDataJSON();
      const name = previewBody.choice.name;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          preview: {
            confirmationId: "confirm-1",
            guildId: "guild-1",
            featureKey: "lfg",
            definitionVersion: 1,
            dependencies: [
              {
                key: "channel",
                label: "LFG channel",
                kind: "text_channel",
                choice: { action: "create", name },
                relationship: "haf_configured",
                permissionSummary: "HAF can manage this channel.",
                resource: null,
              },
            ],
          },
        }),
      });
    });
    await page.goto(testServerUrl(vite));
    assert.deepEqual(browserErrors, []);
    const createButton = page.getByRole("button", { name: "Create LFG channel" });
    await createButton.click();
    assert.deepEqual(browserErrors, []);
    const createButtonHandle = await createButton.elementHandle();
    assert.ok(createButtonHandle);
    await page.waitForFunction(
      (button) => button?.getAttribute("data-state") === "open",
      createButtonHandle,
    );

    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Choose emoji", exact: true }).waitFor();
    const nameInput = dialog.getByLabel("Name");
    await nameInput.fill("🎮".repeat(101));
    assert.match((await dialog.textContent()) ?? "", /101 \/ 100 characters/);
    assert.match((await dialog.textContent()) ?? "", /Name must be 100 characters or fewer/);
    assert.equal(await dialog.getByRole("button", { name: "Review creation" }).isDisabled(), true);
    await nameInput.fill("lfg");

    await dialog.getByRole("button", { name: "Choose emoji" }).click();
    const emojiButton = dialog.locator(".epr-emoji").first();
    await emojiButton.waitFor({ timeout: 10_000 });
    await emojiButton.click();

    const insertedName = await nameInput.inputValue();
    assert.ok(insertedName.startsWith("lfg"));
    assert.ok(Array.from(insertedName).length > Array.from("lfg").length);

    await dialog.getByRole("button", { name: "Review creation" }).click();
    await page.getByRole("heading", { name: "Create LFG channel?" }).waitFor();
    assert.equal(previewBody.choice.name, insertedName);
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("Reaction Limits stays enabled after save invalidates and remounts the page", async () => {
  const vite = await createEmojiPickerTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    let savedConfig = null;
    await page.route("**/admin/api/tickets/resources*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [],
          voiceChannels: [],
          stageChannels: [],
          forumChannels: [],
          emojis: [],
        }),
      }),
    );
    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.startsWith("/admin/api/reaction-limits")) {
        await route.fallback();
        return;
      }
      if (pathname.endsWith("/config") && route.request().method() === "POST") {
        savedConfig = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ config: savedConfig }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ guildId: "guild-1", config: savedConfig, counters: [] }),
      });
    });

    await page.goto(`${testServerUrl(vite)}?view=blocklist`);
    const toggle = page.getByRole("switch", { name: "Toggle reaction limits" });
    await toggle.click();
    await page.getByLabel("Max reactions per message").fill("5");
    await page.getByLabel("Max reactions per user per message").fill("1");
    const saveButton = page.getByRole("button", { name: "Save changes" });
    assert.equal(await saveButton.isEnabled(), true);
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/admin/api/reaction-limits/config") &&
        response.request().method() === "POST",
    );
    await saveButton.click();
    await saveResponse;
    assert.ok(savedConfig, await page.locator("body").innerText());

    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Toggle reaction limits"]')
          ?.getAttribute("aria-checked") === "true",
    );
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.getByLabel("Max reactions per message").inputValue(), "5");
    assert.equal(await page.getByLabel("Max reactions per user per message").inputValue(), "1");
    assert.equal(savedConfig.limitsEnabled, true);
    assert.equal(savedConfig.maxReactionsPerMessage, 5);
    assert.equal(savedConfig.maxReactionsPerUserPerMessage, 1);
  } finally {
    await browser?.close();
    await vite.close();
  }
});

async function createEmojiPickerTestServer({ productionCsp = false } = {}) {
  const vite = await createViteServer({
    root: process.cwd(),
    configFile: false,
    logLevel: "error",
    plugins: [react({ fastRefresh: false }), emojiPickerTestPage({ productionCsp })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  return vite;
}

async function warmEmojiPickerTestServer(vite, browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const browserErrors = collectBrowserErrors(page);
  const failures = [];
  try {
    await stubEmojiPickerImages(page);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let phase = "navigation";
      try {
        await page.goto(testServerUrl(vite));
        phase = "trigger";
        const trigger = page
          .getByTestId("standalone-picker")
          .getByRole("button", { name: "Choose emoji" });
        await trigger.waitFor();
        await trigger.click();
        phase = "grid";
        await page.locator('[data-emoji-picker-unicode="true"] .epr-emoji').first().waitFor();
        return;
      } catch (error) {
        failures.push(
          formatEmojiPickerWarmupFailure({
            attempt: attempt + 1,
            phase,
            error,
            page,
            browserErrors,
          }),
        );
        if (attempt === 1) {
          throw new Error(
            `Emoji picker warm-up failed after ${attempt + 1} attempts:\n${failures.join("\n")}`,
            { cause: error },
          );
        }
      }
    }
  } finally {
    await page.close();
  }
}

function formatEmojiPickerWarmupFailure({ attempt, phase, error, page, browserErrors }) {
  const message = error instanceof Error ? error.message : String(error);
  let url = "unavailable";
  try {
    url = page.url() || "blank";
  } catch {
    // The page may have been closed by a failed navigation.
  }
  const recentBrowserErrors = browserErrors.slice(-3);
  return [
    `Attempt ${attempt}/2 during ${phase}: ${message}`,
    `Page URL: ${url}`,
    `Recent browser errors: ${recentBrowserErrors.length ? recentBrowserErrors.join(" | ") : "none"}`,
  ].join("\n");
}

async function stubEmojiPickerImages(page) {
  await page.route("**/cdn.jsdelivr.net/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: EMOJI_IMAGE_PNG }),
  );
}

function emojiPickerTestPage({ productionCsp }) {
  const virtualId = "\0emoji-picker-browser-entry.tsx";
  return {
    name: "emoji-picker-browser-test-page",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/__emoji-picker-test") return next();
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader(
          "content-security-policy",
          productionCsp
            ? "default-src 'none'; img-src 'self' data: https://cdn.jsdelivr.net; " +
                "connect-src 'self' ws:; script-src 'self' 'unsafe-inline'; " +
                "style-src 'self' 'nonce-emoji-picker-test'; style-src-attr 'unsafe-inline'"
            : "img-src 'self' data: https://cdn.jsdelivr.net",
        );
        response.end(
          `<!doctype html><html class="light"><head><link rel="icon" href="data:,"><meta property="csp-nonce" nonce="emoji-picker-test"></head><body><div id="admin-root" data-csp-style-nonce="emoji-picker-test"></div>
          <script type="module">
            import RefreshRuntime from "/@react-refresh";
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {};
            window.$RefreshSig$ = () => (type) => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script>
          <script type="module" src="/@emoji-picker-browser-entry"></script></body></html>`,
        );
      });
    },
    resolveId(id) {
      return id === "/@emoji-picker-browser-entry" ? virtualId : null;
    },
    load(id) {
      if (id !== virtualId) return null;
      return `
        import React, { createElement, useState } from "react";
        import { createRoot } from "react-dom/client";
        import {
          RouterProvider,
          createMemoryHistory,
          createRootRoute,
          createRouter,
        } from "@tanstack/react-router";
        import "/src/admin/styles.css";
        import { AdminBlocklistPage } from "/src/admin/components/admin-blocklist-page.tsx";
        import { BlocklistEmojiField } from "/src/admin/components/blocklist-emoji-field.tsx";
        import { EmojiPicker } from "/src/admin/components/emoji-picker.tsx";
        import { ChannelSelect } from "/src/admin/components/guild-resource-select.tsx";
        import { AdminRouteContextProvider } from "/src/admin/routes/page-context.tsx";

        function TestPage() {
          const [channelId, setChannelId] = useState("");
          return createElement(
            "main",
            null,
            createElement(
              "div",
              { "data-testid": "standalone-picker", style: { width: 220 } },
              createElement(EmojiPicker, {
                emojis: [],
                onSelect: () => undefined,
                unicodeOnly: true,
              }),
            ),
            createElement(
              "div",
              { "data-testid": "blocklist-picker" },
              createElement(BlocklistEmojiField, {
                currentEmojis: ["✅"],
                emojis: [],
                onSubmit: () => true,
              }),
            ),
            createElement(ChannelSelect, {
              value: channelId,
              onChange: setChannelId,
              channels: [],
              creation: {
                  guildId: "guild-1",
                  workspaceId: "workspace-1",
                  surfaceKey: "lfg",
                  dependencyKey: "channel",
                  label: "LFG channel",
                  recommendedName: "lfg",
              },
            }),
          );
        }

        const entitlement = {
          tier: "premium",
          limits: {
            blocklistMaxEmojis: null,
            reactionLimitsEnabled: true,
            ticketsMaxPanels: null,
            ticketsMaxTypesPerPanel: null,
            platformLinkMaxLinks: null,
            managedMessagesMax: null,
            messageTemplatesMax: null,
            evidenceVaultMaxRecords: null,
            r2MaxBytes: 1_000_000,
            paidFeatures: true,
          },
          supportInvite: null,
          r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 1_000_000, lastReconciledAtMs: null },
        };
        const routeContext = {
          currentPath: "/admin/guild-1/blocklist",
          currentSearch: "?tab=limits",
          selectedWorkspaceId: "workspace-1",
          selectedGuildId: "guild-1",
          pathGuildId: "guild-1",
          reactionRulesTab: "limits",
          playerLinkPlatform: "steam",
          ticketsTab: "panel",
          defaultRedirectTarget: null,
          guildDirectory: [{ guildId: "guild-1", name: "Guild", label: "Guild", icon: null }],
          guildLookupError: null,
          guildResourcesRefreshVersion: 0,
          onSelectedGuildChange: () => undefined,
          refreshGuildDirectory: async () => undefined,
          onRefresh: async () => undefined,
          playstationLinkEnabled: true,
          entitlement,
          userProfile: { name: "Admin", email: "", image: "" },
          userPreferences: {
            hiddenGuildIds: [],
            defaultGuildId: null,
            emailNotifications: true,
            pushNotifications: false,
            theme: "system",
            language: "en",
          },
          applyUserPreferencesPatch: async () => undefined,
          pageMetadata: null,
          setPageMetadata: () => undefined,
          isRoutePending: false,
        };

        function BlocklistHarness() {
          const [loadedAt, setLoadedAt] = useState(1);
          const [data, setData] = useState({
            blocklist: {
              emojis: ["🚫"],
              notificationChannelId: null,
              channelMode: "include",
              channelIds: [],
            },
            reactionLimits: { config: null, counters: [] },
            entitlement,
          });
          async function invalidateRoute() {
            const response = await fetch(
              "/admin/api/reaction-limits?workspaceId=workspace-1&guildId=guild-1",
            );
            const reactionLimits = await response.json();
            setData((current) => ({ ...current, reactionLimits }));
            setLoadedAt((current) => current + 1);
          }
          return createElement(
            AdminRouteContextProvider,
            { value: routeContext },
            createElement(AdminBlocklistPage, {
              key: loadedAt,
              selectedWorkspaceId: "workspace-1",
              selectedGuildId: "guild-1",
              activeTab: "limits",
              entitlement,
              initialData: data,
              onRouteDataRefresh: invalidateRoute,
            }),
          );
        }

        const rootRoute = createRootRoute({ component: BlocklistHarness });
        const router = createRouter({
          routeTree: rootRoute,
          history: createMemoryHistory({ initialEntries: ["/admin/guild-1/blocklist?tab=limits"] }),
        });
        const view = new URLSearchParams(window.location.search).get("view");
        createRoot(document.getElementById("admin-root")).render(
          view === "blocklist"
            ? createElement(RouterProvider, { router })
            : createElement(TestPage),
        );
      `;
    },
  };
}

function testServerUrl(vite) {
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite test server has no TCP port");
  return `http://127.0.0.1:${address.port}/__emoji-picker-test`;
}

async function delayEmojiImplementation(page) {
  await page.route("**/*emoji-picker-implementation*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function assertEmojiCellsDoNotOverlap(grid) {
  const cells = await grid.locator(".epr-emoji").evaluateAll((elements) =>
    elements.slice(0, 24).map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
  assert.ok(cells.length > 1, "Expected the loaded picker to expose emoji cells");
  for (let leftIndex = 0; leftIndex < cells.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cells.length; rightIndex += 1) {
      const left = cells[leftIndex];
      const right = cells[rightIndex];
      const overlap =
        left.left < right.right &&
        left.right > right.left &&
        left.top < right.bottom &&
        left.bottom > right.top;
      assert.equal(overlap, false, `Emoji cells ${leftIndex} and ${rightIndex} overlap`);
    }
  }
}

async function assertVisibleEmojiImagesLoad(grid) {
  await grid.locator(".epr-emoji img").evaluateAll(
    async (images, gridElement) => {
      const gridRect = gridElement.getBoundingClientRect();
      const visibleImages = images.filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > gridRect.top && rect.top < gridRect.bottom;
      });
      await Promise.all(visibleImages.map((image) => image.decode()));
      if (visibleImages.some((image) => image.naturalWidth === 0 || image.naturalHeight === 0)) {
        throw new Error("Expected every visible emoji image to load");
      }
    },
    await grid.elementHandle(),
  );
}

test("failed Player Link publish stays visible when inline feedback is below the viewport", async () => {
  const vite = await createActionFeedbackTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(8_000);

    await page.route("**/admin/api/tickets/resources*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [{ id: "channel-1", name: "steam-link" }],
          voiceChannels: [],
          stageChannels: [],
          forumChannels: [],
          emojis: [],
        }),
      }),
    );
    await page.route("**/admin/api/player-link/publish*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Required Steam deployment configuration is missing.",
          code: "internal_error",
          correlationId: "correlation-1",
          retryable: false,
        }),
      }),
    );

    await page.goto(actionFeedbackTestUrl(vite));
    const oldFeedbackLocation = page.getByRole("heading", { name: "Linked accounts" });
    const oldFeedbackBox = await oldFeedbackLocation.boundingBox();
    assert.ok(oldFeedbackBox);
    assert.ok(
      oldFeedbackBox.y >= 720,
      `Expected the former inline feedback area below the viewport, got y=${oldFeedbackBox.y}`,
    );

    await page.evaluate(() => window.scrollTo(0, 160));
    await page.getByRole("button", { name: "Publish panel", exact: true }).click();

    const toast = page
      .getByRole("alert")
      .filter({ hasText: "Required Steam deployment configuration is missing." });
    await toast.waitFor();
    const toastBox = await toast.boundingBox();
    assert.ok(toastBox);
    assert.ok(
      toastBox.x < 1280 &&
        toastBox.x + toastBox.width > 0 &&
        toastBox.y < 720 &&
        toastBox.y + toastBox.height > 0,
      `Expected the error toast to intersect the viewport, got ${JSON.stringify(toastBox)}`,
    );
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("Suggestions keeps a refresh warning and also announces it with an info toast", async () => {
  const vite = await createActionFeedbackTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(8_000);

    await page.route("**/admin/api/tickets/resources*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [{ id: "channel-1", name: "suggestions" }],
          voiceChannels: [],
          stageChannels: [],
          forumChannels: [],
          emojis: [],
        }),
      }),
    );
    await page.route("**/admin/api/suggestions/panel/publish*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      }),
    );

    await page.goto(`${actionFeedbackTestUrl(vite)}?view=suggestions`);
    await page.getByRole("button", { name: "Publish panel & tags", exact: true }).click();

    const warning =
      "Suggestions panel publish completed, but the page could not refresh. Route reload unavailable.";
    await page.getByRole("status").filter({ hasText: warning }).first().waitFor();
    assert.equal(
      await page.locator("[data-toast-container]").getByText(warning, { exact: true }).count(),
      1,
    );
    assert.match(
      await page.locator("body").innerText(),
      /Suggestions panel publish completed, but the page could not refresh\..*Your changes are saved\./s,
    );
  } finally {
    await browser?.close();
    await vite.close();
  }
});

async function createActionFeedbackTestServer() {
  const vite = await createViteServer({
    root: process.cwd(),
    configFile: false,
    logLevel: "error",
    plugins: [react({ fastRefresh: false }), actionFeedbackTestPage()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  return vite;
}

function actionFeedbackTestPage() {
  const virtualId = "\0admin-action-feedback-browser-entry.tsx";
  return {
    name: "admin-action-feedback-browser-test-page",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/__admin-action-feedback-test") return next();
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<!doctype html><html class="light"><head><link rel="icon" href="data:,">
          <style>
            body { margin: 0; }
            #admin-root { padding: 24px 24px 100px; }
            .admin-bottom-action-bar-host {
              position: fixed;
              right: 0;
              bottom: 0;
              left: 0;
              z-index: 40;
              padding: 0 24px;
              background: hsl(var(--background));
            }
          </style></head><body><div id="admin-root"></div>
          <script type="module">
            import RefreshRuntime from "/@react-refresh";
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {};
            window.$RefreshSig$ = () => (type) => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script>
          <script type="module" src="/@admin-action-feedback-browser-entry"></script></body></html>`,
        );
      });
    },
    resolveId(id) {
      return id === "/@admin-action-feedback-browser-entry" ? virtualId : null;
    },
    load(id) {
      if (id !== virtualId) return null;
      return `
        import React, { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import "/src/admin/styles.css";
        import { AdminBottomActionBarProvider } from "/src/admin/components/admin-bottom-action-bar.tsx";
        import { AdminPlatformLinkPage } from "/src/admin/components/admin-platform-link-page.tsx";
        import { AdminSuggestionsPage } from "/src/admin/components/admin-suggestions-page.tsx";
        import { ToastProvider } from "/src/admin/components/toast.tsx";
        import { defaultSuggestionsConfig } from "/src/suggestions.ts";

        const playerLinkData = {
          guildId: "guild-1",
          platform: "steam",
          config: {
            guildId: "guild-1",
            platform: "steam",
            linkedRoleId: null,
            logChannelId: null,
            gameAppIds: [],
            whoisFields: [],
            customLinks: [],
            panelTitle: "",
            panelDescription: "",
            panelButtonLabel: "",
            panelButtonStyle: "Primary",
            panelColor: 2829617,
            allowRelink: true,
            allowMultipleLinks: false,
            requireRelinkOnRejoin: false,
            panelChannelId: "channel-1",
            panelMessageId: null,
            updatedAtMs: 1,
          },
          links: [],
        };
        const suggestionsConfig = {
          ...defaultSuggestionsConfig("guild-1", 1),
          panelChannelId: "channel-1",
        };
        const view = new URLSearchParams(window.location.search).get("view");
        const page =
          view === "suggestions"
            ? createElement(AdminSuggestionsPage, {
                selectedWorkspaceId: "workspace-1",
                selectedGuildId: "guild-1",
                initialData: {
                  guildId: "guild-1",
                  config: suggestionsConfig,
                  suggestions: [],
                  collapsedReplies: [],
                  readiness: { state: "not_configured", checks: {} },
                },
                onRouteDataRefresh: async () => {
                  throw new Error("Route reload unavailable.");
                },
              })
            : createElement(AdminPlatformLinkPage, {
                selectedWorkspaceId: "workspace-1",
                selectedGuildId: "guild-1",
                activePlatform: "steam",
                initialData: playerLinkData,
              });

        createRoot(document.getElementById("admin-root")).render(
          createElement(
            ToastProvider,
            null,
            createElement(
              AdminBottomActionBarProvider,
              null,
              page,
            ),
          ),
        );
      `;
    },
  };
}

function actionFeedbackTestUrl(vite) {
  const address = vite.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite test server did not start.");
  return `http://127.0.0.1:${address.port}/__admin-action-feedback-test`;
}
