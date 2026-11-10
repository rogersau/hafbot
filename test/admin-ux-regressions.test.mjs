import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { commonResponses } from "../scripts/admin-docs/fixtures.mjs";
import { scenarios } from "../scripts/admin-docs/scenarios.mjs";

test("compiled Admin preserves drafts and completes canonical Guild setup flows", async (t) => {
  const defaults = await build({
    stdin: {
      contents:
        'export { defaultSuggestionsConfig } from "./src/suggestions"; export { defaultClanManagementConfig } from "./src/clans";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { defaultSuggestionsConfig, defaultClanManagementConfig } = await import(
    `data:text/javascript;base64,${Buffer.from(defaults.outputFiles[0].text).toString("base64")}`
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/admin/assets/")) {
      try {
        const file = resolve("dist-admin", `.${url.pathname}`);
        response.writeHead(200, {
          "content-type": extname(file) === ".css" ? "text/css" : "text/javascript",
        });
        response.end(await readFile(file));
      } catch {
        response.writeHead(404).end();
      }
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><html><head><link rel="stylesheet" href="/admin/assets/admin.css"></head><body><div id="admin-root" data-authenticated="true" data-initial-path="${url.pathname}" data-initial-search="${url.search.replaceAll('"', "&quot;")}" data-user-name="Fictional Admin"></div><script type="module" src="/admin/assets/admin.js"></script></body></html>`,
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  async function withPage(run, overrides = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const writes = [];
    const responses = {
      ...structuredClone(
        Object.fromEntries(
          Object.entries(commonResponses).filter(([, value]) => typeof value !== "function"),
        ),
      ),
      "/admin/api/workspaces": { workspaces: [] },
      "/admin/api/operations/incidents/capabilities": { canWrite: true },
      "/admin/api/guild-overview": {
        ...scenarios[0].responses["/admin/api/guild-overview"],
        cards: scenarios[0].responses["/admin/api/guild-overview"].cards.map((card) => ({
          ...card,
          readiness: "enabled",
        })),
      },
      "/admin/api/guild-rbac/admin-role": {
        guildId: "docs-guild",
        adminRoleId: null,
        manageServerAdminEnabled: true,
        canManageDelegation: true,
        canManageServerPolicy: true,
      },
      "/admin/api/product-analytics/preference": { guildId: "docs-guild", enabled: false },
      "/admin/api/clans": {
        guildId: "docs-guild",
        config: defaultClanManagementConfig("docs-guild"),
        requests: [],
        clans: [],
        setup: null,
      },
      "/admin/api/suggestions": {
        guildId: "docs-guild",
        config: defaultSuggestionsConfig("docs-guild"),
        suggestions: [],
        collapsedReplies: [],
        readiness: { state: "not_setup", checks: {} },
      },
      ...overrides,
    };
    responses["/admin/api/entitlement"].limits = {
      ...responses["/admin/api/entitlement"].limits,
      clansMax: 5,
      clanMembersMax: 25,
      clanOfficersMax: 5,
    };
    const page = await context.newPage();
    const diagnostics = [];
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text());
    });
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/admin/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (request.method() !== "GET") {
        const body = request.postDataJSON();
        writes.push({ path, body });
        if (path === "/admin/api/reaction-limits/config") {
          responses["/admin/api/reaction-limits"].config = {
            ...responses["/admin/api/reaction-limits"].config,
            ...body,
          };
          return route.fulfill({
            json: { config: responses["/admin/api/reaction-limits"].config },
          });
        }
        if (path === "/admin/api/evidence-vault/enabled") {
          responses["/admin/api/evidence-vault"].config.enabled = body.enabled;
          return route.fulfill({ json: { ok: true } });
        }
        if (path === "/admin/api/lfg/disable" || path === "/admin/api/marketplace/disable") {
          const resource = responses[path.replace("/disable", "")];
          resource.config = { ...resource.config, enabled: false, noticeMessageId: null };
          return route.fulfill({ json: { config: resource.config, noticeRemoved: false } });
        }
        if (path === "/admin/api/lfg/config") {
          responses["/admin/api/lfg"].config = { ...responses["/admin/api/lfg"].config, ...body };
          return route.fulfill({ json: responses["/admin/api/lfg"] });
        }
        if (
          path === "/admin/api/suggestions/config" ||
          path === "/admin/api/suggestions/panel/publish"
        ) {
          if (path.endsWith("/config")) {
            assert.equal("workspaceId" in body, false);
            assert.ok(body.prompts.every((prompt) => prompt.label.length <= 45));
            if (body.enabled) {
              assert.ok(
                body.panelMessageId && body.replyWebhookId && body.replyWebhookCredentialId,
              );
              assert.ok(
                [
                  "gathering_feedback",
                  "needs_work",
                  "under_review",
                  "planned",
                  "implemented",
                  "rejected",
                ].every((status) => body.statusTagIds[status]),
              );
            }
            responses["/admin/api/suggestions"].config = {
              ...responses["/admin/api/suggestions"].config,
              ...body,
            };
          } else {
            responses["/admin/api/suggestions"].config.panelMessageId = "fictional-panel";
            responses["/admin/api/suggestions"].config.replyWebhookId = "fictional-webhook";
            responses["/admin/api/suggestions"].config.replyWebhookCredentialId =
              "fictional-credential-reference";
            responses["/admin/api/suggestions"].config.statusTagIds = Object.fromEntries(
              [
                "gathering_feedback",
                "needs_work",
                "under_review",
                "planned",
                "implemented",
                "rejected",
              ].map((status) => [status, `fictional-tag-${status}`]),
            );
          }
          return route.fulfill({ json: { config: responses["/admin/api/suggestions"].config } });
        }
      }
      const value =
        responses[path] ??
        (typeof commonResponses[path] === "function" ? commonResponses[path](url) : undefined);
      if (value?.error) return route.fulfill({ status: 500, json: value });
      if (value === undefined) {
        errors.push(`Missing fixture: ${path}`);
        return route.fulfill({ status: 501, json: { error: `Missing fixture: ${path}` } });
      }
      await route.fulfill({ json: value });
    });
    try {
      await run(page, responses, writes);
      assert.deepEqual(errors, []);
    } catch (error) {
      throw new Error(
        `${error.message}\nBrowser diagnostics: ${JSON.stringify({ errors, console: diagnostics, body: (await page.locator("body").innerText()).slice(0, 2000) })}`,
        { cause: error },
      );
    } finally {
      await context.close();
    }
  }

  async function section(page, label) {
    const button = page.locator(`[data-nav-section="${label}"] > button`);
    if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  }
  async function limits(page) {
    await section(page, "Moderation");
    const group = page.getByRole("button", { name: "Reaction Rules", exact: true });
    if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
    await page.getByRole("link", { name: "Limits", exact: true }).click();
    await expect(page.locator("#rl-max-message")).toBeVisible();
  }
  try {
    await t.test(
      "Free Overview without workspace renders discovery and Guided setup actions",
      async () => {
        await withPage(
          async (page) => {
            await page.goto(`${origin}/admin/docs-guild`);
            await expect(page.locator('[data-section="all-features"] a').first()).toBeVisible();
            await page.getByText("Run staff operations", { exact: true }).click();
            await expect(
              page.getByRole("link", { name: /Tickets:|Review|Set up/ }).first(),
            ).toBeVisible();
            await page.reload();
            await expect(page.locator('[data-section="all-features"] a').first()).toBeVisible();
          },
          {
            "/admin/api/entitlement": {
              ...commonResponses["/admin/api/entitlement"],
              tier: "free",
            },
          },
        );
      },
    );
    await t.test(
      "untouched Reaction Rules is pristine and Back/Forward Stay retains a real draft",
      async () => {
        await withPage(async (page, responses, writes) => {
          await page.goto(`${origin}/admin/docs-guild`);
          await limits(page);
          await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
          await page.getByRole("link", { name: "Dashboard", exact: true }).click();
          await expect(page.locator('[data-section="all-features"]')).toBeVisible();
          await page.evaluate(() => history.back());
          await expect(page.locator("#rl-max-message")).toHaveValue("20");
          const limitsUrl = page.url();
          await page.locator("#rl-max-message").fill("7");
          await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible();
          await page.getByRole("link", { name: "Dashboard", exact: true }).click();
          await page.getByRole("button", { name: "Stay", exact: true }).click();
          await expect(page).toHaveURL(limitsUrl);
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          for (const direction of ["back", "forward"]) {
            await page.evaluate((value) => history[value](), direction);
            await page.getByRole("button", { name: "Stay", exact: true }).click();
            await expect(page).toHaveURL(limitsUrl);
            await expect(page.locator("#rl-max-message")).toHaveValue("7");
            await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible();
            await page.evaluate(
              () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
            );
          }
          assert.equal(responses["/admin/api/reaction-limits"].config.maxReactionsPerMessage, 20);
          assert.equal(writes.filter((write) => write.path.includes("reaction-limits")).length, 0);
          await page.getByRole("button", { name: "Discard changes", exact: true }).click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Discard changes", exact: true })
            .click();
          await expect(page.locator("#rl-max-message")).toHaveValue("20");
          await page.locator("#rl-max-message").fill("7");
          await page.getByRole("button", { name: "Save changes", exact: true }).click();
          await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
          await expect(page.locator("#rl-max-message")).toHaveValue("7");
          await expect(
            page.getByRole("button", { name: "Save changes", exact: true }),
          ).toBeDisabled();
          await page.locator("#rl-max-message").fill("9");
          await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible();
          await page.getByRole("link", { name: "Dashboard", exact: true }).click();
          await page.getByRole("button", { name: "Leave", exact: true }).click();
          await limits(page);
          await expect(page.locator("#rl-max-message")).toHaveValue("7");
        });
      },
    );
    await t.test(
      "Free Reaction Rules with default settings is pristine even with breach counters",
      async () => {
        await withPage(
          async (page) => {
            await page.goto(`${origin}/admin/docs-guild/blocklist?tab=limits`);
            await expect(page.locator("#rl-max-message")).toBeVisible();
            await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
            await page.getByRole("link", { name: "Dashboard", exact: true }).click();
            await expect(page.locator('[data-section="all-features"]')).toBeVisible();
            await expect(page.getByRole("button", { name: "Stay", exact: true })).toHaveCount(0);
          },
          {
            "/admin/api/entitlement": {
              ...commonResponses["/admin/api/entitlement"],
              tier: "free",
            },
            "/admin/api/reaction-limits": {
              guildId: "docs-guild",
              config: null,
              counters: [{ guildId: "docs-guild", userId: "fictional-member", count: 1 }],
            },
          },
        );
      },
    );
    await t.test(
      "Commerce seller tab does not leak into Clan Management or break history",
      async () => {
        await withPage(
          async (page) => {
            await page.goto(`${origin}/admin/docs-guild/commerce`);
            await expect(
              page.getByRole("heading", { name: "Commerce", exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("tab", { name: "Seller & finance", exact: true }),
            ).toHaveAttribute("aria-selected", "true");
            await page.getByRole("tab", { name: "Seller & finance", exact: true }).click();
            await expect(page).toHaveURL(/tab=seller/);
            await section(page, "Community Management");
            await page.getByRole("link", { name: "Clan Management", exact: true }).click();
            await expect(
              page.getByRole("heading", { name: "Clan Management", exact: true }),
            ).toBeVisible();
            assert.equal(new URL(page.url()).searchParams.get("tab"), null);
            await page.evaluate(() => history.back());
            await expect(
              page.getByRole("heading", { name: "Commerce", exact: true }),
            ).toBeVisible();
            await page.evaluate(() => history.forward());
            await expect(
              page.getByRole("heading", { name: "Clan Management", exact: true }),
            ).toBeVisible();
          },
          {
            "/admin/api/commerce": {
              ...commonResponses["/admin/api/commerce"],
              sellerProfile: null,
              dashboard: { seller: null, offerings: [] },
            },
          },
        );
      },
    );
    await t.test(
      "optional LFG destination can be cleared, discarded, and saved as null",
      async () => {
        await withPage(async (page, responses) => {
          await page.goto(`${origin}/admin/docs-guild/lfg`);
          await page.locator("#lfg-notice-channel").click();
          await page.getByRole("option", { name: "None", exact: true }).click();
          await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible();
          await page.getByRole("button", { name: "Discard changes", exact: true }).click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Discard changes", exact: true })
            .click();
          await expect(page.locator("#lfg-notice-channel")).toContainText("looking-for-group");
          await page.locator("#lfg-notice-channel").click();
          await page.getByRole("option", { name: "None", exact: true }).click();
          await page.locator("#lfg-notification-role").click();
          await page.getByRole("option", { name: "None", exact: true }).click();
          await page.getByRole("button", { name: /Save settings|Save changes|Save LFG/ }).click();
          await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
          assert.equal(responses["/admin/api/lfg"].config.noticeChannelId, null);
          assert.equal(responses["/admin/api/lfg"].config.notificationRoleId, null);
        });
      },
    );
    for (const [feature, label] of [
      ["lfg", "LFG"],
      ["marketplace", "Marketplace"],
    ]) {
      await t.test(
        `${label} disable stays in More actions and preserves the saved destination`,
        async () => {
          await withPage(async (page, responses, writes) => {
            await page.goto(`${origin}/admin/docs-guild/${feature}`);
            const disable = page.getByRole("button", { name: `Disable ${label}`, exact: true });
            await expect(disable).not.toBeVisible();
            await page.getByLabel(`More actions for ${label}`, { exact: true }).click();
            await disable.click();
            await page
              .getByRole("alertdialog")
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            assert.equal(writes.filter(({ path }) => path.endsWith("/disable")).length, 0);
            await expect(disable).not.toBeVisible();
            await page.getByLabel(`More actions for ${label}`, { exact: true }).click();
            await disable.click();
            await page
              .getByRole("alertdialog")
              .getByRole("button", { name: `Disable ${label}`, exact: true })
              .click();
            await expect(page.getByText(`${label} is disabled.`, { exact: false })).toBeVisible();
            await expect(page.getByText(/The old noticeboard could not be removed/)).toBeVisible();
            await expect(
              page.getByRole("button", { name: "Publish noticeboard", exact: true }),
            ).toBeEnabled();
            await expect(disable).toHaveCount(0);
            assert.ok(responses[`/admin/api/${feature}`].config.noticeChannelId);
            assert.equal(responses[`/admin/api/${feature}`].config.enabled, false);
            const disableWrites = writes.filter(({ path }) => path.endsWith("/disable"));
            assert.deepEqual(
              disableWrites.map(({ path }) => path),
              [`/admin/api/${feature}/disable`],
            );
            assert.equal(disableWrites[0].body.guildId, "docs-guild");
          });
        },
      );
    }
    await t.test(
      "Evidence Vault can be disabled and enabled from More actions without losing settings",
      async () => {
        await withPage(async (page, responses, writes) => {
          const before = structuredClone(responses["/admin/api/evidence-vault"].config);
          await page.goto(`${origin}/admin/docs-guild/evidence-vault`);
          const menu = page.getByLabel("More actions for Evidence Vault", { exact: true });
          const disable = page.getByRole("button", { name: "Disable Evidence Vault", exact: true });
          let releaseRefresh;
          const refreshGate = new Promise((resolve) => {
            releaseRefresh = resolve;
          });
          let heldRefresh = false;
          await page.route(
            (url) => url.pathname === "/admin/api/evidence-vault",
            async (route) => {
              if (
                !heldRefresh &&
                route.request().method() === "GET" &&
                writes.some(({ path }) => path === "/admin/api/evidence-vault/enabled")
              ) {
                heldRefresh = true;
                await refreshGate;
              }
              await route.fallback();
            },
          );
          await expect(disable).not.toBeVisible();
          await menu.click();
          await disable.click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          assert.equal(writes.filter(({ path }) => path.endsWith("/enabled")).length, 0);
          await menu.click();
          await disable.click();
          const refreshStarted = page.waitForRequest(
            (request) =>
              request.method() === "GET" &&
              new URL(request.url()).pathname === "/admin/api/evidence-vault",
          );
          try {
            await Promise.all([
              refreshStarted,
              page
                .getByRole("alertdialog")
                .getByRole("button", { name: "Disable Evidence Vault", exact: true })
                .click(),
            ]);
            await expect(
              page.getByText("Evidence Vault disabled.", { exact: true }),
            ).not.toBeVisible();
          } finally {
            releaseRefresh();
          }
          await expect(page.getByText("Evidence Vault disabled.", { exact: true })).toBeVisible();
          await menu.click();
          await page.getByRole("button", { name: "Enable Evidence Vault", exact: true }).click();
          await expect(page.getByText("Evidence Vault enabled.", { exact: true })).toBeVisible();
          const after = responses["/admin/api/evidence-vault"].config;
          assert.deepEqual(after, { ...before, enabled: true });
          assert.deepEqual(
            writes.filter(({ path }) => path.endsWith("/enabled")).map(({ body }) => body.enabled),
            [false, true],
          );
        });
      },
    );
    await t.test(
      "canonical Suggestions first save accepts shipped defaults then publishes and enables",
      async () => {
        await withPage(async (page, responses, writes) => {
          await page.goto(`${origin}/admin/docs-guild/suggestions`);
          const inputs = page
            .locator(".admin-form-field")
            .filter({ has: page.getByText("Title", { exact: true }) })
            .locator("input");
          await inputs.fill("Fictional suggestions");
          const forum = page
            .locator(".admin-form-field")
            .filter({ has: page.getByText("Suggestion Forum", { exact: true }) })
            .getByRole("combobox");
          await forum.click();
          await expect(page.getByRole("option", { name: "None", exact: true })).toHaveCount(0);
          await page.getByRole("option", { name: /ban-cases/ }).click();
          await page
            .locator(".admin-form-field")
            .filter({ has: page.getByText("Suggestion Panel channel", { exact: true }) })
            .getByRole("combobox")
            .click();
          await page.getByRole("option", { name: /haf-setup/ }).click();
          await page
            .locator(".admin-form-field")
            .filter({ has: page.getByText("Suggestions Mod Queue", { exact: true }) })
            .getByRole("combobox")
            .click();
          await page.getByRole("option", { name: /mod-queue/ }).click();
          await page
            .getByRole("button", { name: "Save Suggestions settings", exact: true })
            .click();
          await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: "Publish panel & tags", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Update panel & tags", exact: true }),
          ).toBeEnabled();
          await page.getByRole("checkbox", { name: "Enable Suggestions", exact: true }).check();
          await page
            .getByRole("button", { name: "Save Suggestions settings", exact: true })
            .click();
          await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
          assert.equal(responses["/admin/api/suggestions"].config.enabled, true);
          assert.equal(
            responses["/admin/api/suggestions"].config.panelMessageId,
            "fictional-panel",
          );
          assert.deepEqual(
            writes
              .filter((write) => write.path.startsWith("/admin/api/suggestions/"))
              .map((write) => write.path),
            [
              "/admin/api/suggestions/config",
              "/admin/api/suggestions/panel/publish",
              "/admin/api/suggestions/config",
            ],
          );
        });
      },
    );
    await t.test(
      "privacy retries preserve the unsaved admin role and leave a failed setting disabled",
      async () => {
        await withPage(
          async (page, responses, writes) => {
            await page.goto(`${origin}/admin/docs-guild/guild-settings`);
            await expect(
              page.getByRole("heading", { name: "Guild Settings", exact: true }),
            ).toBeVisible();
            await expect(
              page.getByText("The privacy setting could not be loaded.", { exact: false }),
            ).toBeVisible();
            await expect(
              page.getByRole("switch", { name: "Share anonymous product usage" }),
            ).toBeDisabled();
            await page.locator("#guild-admin-role-id").click();
            await page.getByRole("option", { name: "@Moderators", exact: true }).click();
            await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
            await Promise.all([
              page.waitForResponse(
                (response) =>
                  response.url().includes("/product-analytics/preference") &&
                  response.status() === 500,
              ),
              page.getByRole("button", { name: "Retry privacy setting", exact: true }).click(),
            ]);
            await expect(
              page.getByRole("button", { name: "Retry privacy setting", exact: true }),
            ).toBeEnabled();
            await expect(
              page.getByRole("switch", { name: "Share anonymous product usage" }),
            ).toBeDisabled();
            await expect(page.locator("#guild-admin-role-id")).toContainText("Moderators");
            responses["/admin/api/product-analytics/preference"] = {
              guildId: "docs-guild",
              enabled: false,
            };
            await page.getByRole("button", { name: "Retry privacy setting", exact: true }).click();
            await expect(
              page.getByRole("switch", { name: "Share anonymous product usage" }),
            ).toBeEnabled();
            await expect(page.locator("#guild-admin-role-id")).toContainText("Moderators");
            await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
            await expect(
              page.getByRole("button", { name: "Discard changes", exact: true }),
            ).toBeEnabled();
            assert.deepEqual(
              writes.filter((write) => write.path !== "/admin/api/product-analytics/events"),
              [],
            );
          },
          {
            "/admin/api/product-analytics/preference": {
              error: "Something went wrong.",
              code: "internal_error",
              correlationId: "fictional-reference",
              retryable: true,
              action: "contact_support",
            },
          },
        );
      },
    );
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
