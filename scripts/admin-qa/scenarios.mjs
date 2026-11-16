import assert from "node:assert/strict";

// These scenarios exercise the compiled browser client against fictional, stateful
// responses. Workspace roles are fixture inputs, not proof of backend authorization.
const GUILD = "docs-guild";
const WORKSPACE = "docs-workspace";
const OVERVIEW = `/admin/${GUILD}?workspaceId=${WORKSPACE}`;
const LIMITS = `/admin/${GUILD}/blocklist?workspaceId=${WORKSPACE}&tab=limits`;
const LFG = `/admin/${GUILD}/lfg?workspaceId=${WORKSPACE}`;
const REACTION_READ = "/admin/api/reaction-limits";
const REACTION_WRITE = "/admin/api/reaction-limits/config";
const LFG_WRITE = "/admin/api/lfg/config";

const overviewScenarios = ["free", "premium"].flatMap((tier) =>
  ["owner", "member"].map((role) => ({
    id: `overview-${tier}-${role}`,
    title: `${tier === "free" ? "Free" : "Premium"} Overview with fictional workspace ${role}`,
    tier,
    role,
    route: OVERVIEW,
    async run({ page, api, expect }) {
      await overviewReady(page, expect);
      await expect(page.locator(".admin-ops-tier")).toHaveText(
        `${tier === "free" ? "Free" : "Premium"} tier`,
      );
      assert.equal(
        reads(api, "/admin/api/workspaces").length,
        0,
        "Server-first startup must not fetch workspaces",
      );
      assert.equal(api.snapshot("/admin/api/entitlement").tier, tier);
      assert.equal(api.snapshot("/admin/api/guild-overview").tier, tier);
      assert.equal(
        api.snapshot("/admin/api/workspaces").workspaces.find((item) => item.id === WORKSPACE).role,
        role === "member" ? "viewer" : "owner",
      );
      for (const path of ["/admin/api/entitlement", "/admin/api/guild-overview"]) {
        assert.ok(reads(api, path).length > 0, `Overview must request ${path}`);
      }
      assert.deepEqual(featureWrites(api), [], "Rendering Overview must not change configuration");
    },
  })),
);

const selectedGuildScenarios = [false, true].flatMap((withWorkspace) =>
  [false, true].map((prefixed) => ({
    id: `selected-guild-${prefixed ? "prefixed" : "raw"}${withWorkspace ? "-workspace" : ""}`,
    title: `Explicit ${prefixed ? "guild_-prefixed" : "raw"} Guild selection loads the real Overview ${withWorkspace ? "with" : "without"} a workspace`,
    tier: "free",
    role: "owner",
    route: `/admin?guildId=${prefixed ? "guild_docs%2Dguild" : GUILD}${withWorkspace ? `&workspaceId=${WORKSPACE}` : ""}`,
    apiOptions: withWorkspace ? {} : { responses: { "/admin/api/workspaces": { workspaces: [] } } },
    async run({ page, api, origin, expect }) {
      await overviewReady(page, expect);
      await expect(
        page.locator('[data-section="all-features"]').getByRole("link", { name: /Reaction Rules/ }),
      ).toContainText("6 blocked emoji");
      const canonicalRoute = `/admin/docs-guild${withWorkspace ? `?workspaceId=${WORKSPACE}` : ""}`;
      await expect(page).toHaveURL(`${origin}${canonicalRoute}`);
      await expect(page.getByText(/^(Choose a server|No servers available)$/)).toHaveCount(0);
      for (const path of ["/admin/api/entitlement", "/admin/api/guild-overview"]) {
        const requests = reads(api, path);
        assert.ok(requests.length > 0, `Selected Guild Overview must request ${path}`);
        for (const request of requests) {
          const params = new URL(request.url).searchParams;
          assert.equal(params.get("guildId"), GUILD);
          assert.equal(params.get("workspaceId"), withWorkspace ? WORKSPACE : null);
        }
      }
      if (!withWorkspace && !prefixed) {
        // Canonicalization replaces the legacy entry, so Back must reach the
        // previous page rather than immediately redirecting to Overview again.
        await page.goto(`${origin}/admin/profile`, { waitUntil: "networkidle" });
        await page.goto(`${origin}/admin?guildId=docs-guild`, { waitUntil: "networkidle" });
        await overviewReady(page, expect);
        await expect(page).toHaveURL(`${origin}${canonicalRoute}`);
        await page.goBack({ waitUntil: "networkidle" });
        await expect(page).toHaveURL(`${origin}/admin/profile`);
        await page.goForward({ waitUntil: "networkidle" });
        await overviewReady(page, expect);
        await expect(page).toHaveURL(`${origin}${canonicalRoute}`);
      }
      assert.deepEqual(featureWrites(api), [], "Selecting a Guild must not change configuration");
    },
  })),
);

export const scenarios = [
  {
    id: "shell-lazy-menus",
    title: "Deferred shell menus open, restore focus, and navigate with the keyboard",
    tier: "free",
    role: "owner",
    route: OVERVIEW,
    async run({ page, api, expect }) {
      await overviewReady(page, expect);
      const trigger = page.getByRole("button", { name: "Open command palette", exact: true });
      await trigger.focus();
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await page.locator("#sidebar-guild").click();
      const guild = page.getByRole("menuitemradio");
      await expect(guild.first()).toBeVisible();
      await expect(guild.filter({ hasText: "Northstar Gaming" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("Escape");
      await expect(guild).toHaveCount(0);

      await trigger.click();
      await dialog.getByRole("combobox").fill("Reaction Rules");
      await expect(
        dialog.getByRole("option", { name: "Reaction Rules", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Reaction Rules", exact: true }),
      ).toBeVisible();
      assert.deepEqual(featureWrites(api), [], "Menu navigation must not change configuration");
    },
  },
  {
    id: "reaction-roles-publish",
    title: "Free reaction-role panel publishes and survives reload",
    tier: "free",
    role: "owner",
    route: `/admin/${GUILD}/reaction-roles?workspaceId=${WORKSPACE}`,
    apiOptions: {
      responses: {
        "/admin/api/reaction-roles": { panel: null },
        "/admin/api/reaction-roles/resources": {
          guildId: GUILD,
          roles: [{ id: "300", name: "DayZ" }],
          textChannels: [{ id: "200", name: "welcome" }],
          categories: [],
          voiceChannels: [],
          forumChannels: [],
          emojis: [],
        },
      },
    },
    async run({ page, api, expect }) {
      await expect(
        page.getByRole("heading", { name: "Reaction Roles", exact: true }),
      ).toBeVisible();
      await page.locator("#reaction-role-channel").click();
      await page.getByRole("option", { name: "#welcome", exact: true }).click();
      await page.locator("#reaction-role-0").click();
      await page.getByRole("option", { name: "@DayZ", exact: true }).click();
      await expect(page.getByLabel("Reaction-role message preview")).toContainText("DayZ");
      await page.getByRole("button", { name: "Save and publish", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Active$/ })).toBeVisible();
      assert.equal(api.snapshot("/admin/api/reaction-roles").panel.enabled, true);
      await page.reload({ waitUntil: "networkidle" });
      await expect(
        page.getByRole("link", { name: "View in Discord", exact: true }),
      ).toHaveAttribute("href", `https://discord.com/channels/${GUILD}/200/500`);
      await expect(page.locator("#reaction-role-label-0")).toHaveValue("DayZ");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /Paused/ })).toBeVisible();
      assert.equal(api.snapshot("/admin/api/reaction-roles").panel.enabled, false);
      return { choice: "DayZ", persistedAfterReload: true, canPause: true };
    },
  },
  ...overviewScenarios,
  ...selectedGuildScenarios,
  {
    id: "first-steam-link-config",
    title: "Unconfigured Steam Link loads without a workspace and gates panel publication",
    tier: "free",
    role: "owner",
    route: "/admin/docs-guild/player-link?platform=steam",
    apiOptions: {
      responses: {
        "/admin/api/workspaces": { workspaces: [] },

        "/admin/api/player-link": { guildId: GUILD, platform: "steam", config: null, links: [] },
      },
    },
    async run({ page, api, expect }) {
      await expect(page.getByRole("button", { name: "Publish panel", exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Save Steam Link config", exact: true }),
      ).toBeVisible();
      assert.deepEqual(featureWrites(api), []);
    },
  },
  {
    id: "first-visit-no-guilds",
    title: "First visit without a discoverable server offers installation and refresh",
    tier: "free",
    role: "owner",
    route: "/admin",
    apiOptions: {
      responses: {
        "/admin/api/workspaces": { workspaces: [] },
        "/admin/api/guilds": { guilds: [] },
      },
    },
    async run({ page, api, expect }) {
      await expect(page.getByText("No servers available", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Add HAF to a server" })).toHaveAttribute(
        "href",
        "/install",
      );
      const before = reads(api, "/admin/api/guilds").length;
      await page.getByRole("button", { name: "Refresh servers", exact: true }).click();
      await expect.poll(() => reads(api, "/admin/api/guilds").length).toBeGreaterThan(before);
      assert.ok(
        reads(api, "/admin/api/guilds").some(
          (request) => new URL(request.url).searchParams.get("refresh") === "1",
        ),
      );
      await expect(
        page.getByText("The feature directory is unavailable.", { exact: false }),
      ).toHaveCount(0);
    },
  },
  {
    id: "first-visit-discovery-retry",
    title: "First visit recovers from guild discovery denial without a workspace",
    tier: "free",
    role: "owner",
    route: "/admin",
    apiOptions: {
      responses: { "/admin/api/workspaces": { workspaces: [] } },
      failures: [
        { method: "GET", path: "/admin/api/guilds", status: 403, json: { error: "Forbidden" } },
      ],
    },
    async run({ page, api, expect }) {
      await expect(page.getByText("Could not load your servers", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Refresh servers", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/docs-guild/);
      await overviewReady(page, expect);
      assert.deepEqual(featureWrites(api), []);
    },
  },
  {
    id: "owner-access-policy",
    title: "Owner can disable automatic Manage Server access and read it back",
    tier: "free",
    role: "owner",
    route: `/admin/${GUILD}/guild-settings`,
    async run({ page, api, expect }) {
      await page.getByRole("button", { name: "Disable automatic Manage Server access" }).click();
      await expect(
        page.getByRole("button", { name: "Enable automatic Manage Server access" }),
      ).toBeVisible();
      assert.equal(
        api.snapshot("/admin/api/guild-rbac/admin-role").manageServerAdminEnabled,
        false,
      );
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Enable automatic Manage Server access" }),
      ).toBeVisible();
    },
  },
  {
    id: "delegated-access-settings",
    title: "Delegated admin can inspect access settings but cannot re-delegate",
    tier: "free",
    role: "member",
    route: `/admin/${GUILD}/guild-settings`,
    apiOptions: {
      responses: {
        "/admin/api/guild-rbac/admin-role": {
          guildId: GUILD,
          adminRoleId: "role-admin",
          manageServerAdminEnabled: false,
          canManageDelegation: false,
          canManageServerPolicy: false,
        },
      },
    },
    async run({ page, api, expect }) {
      await expect(page.getByText("Automatic HAF access for Manage Server:")).toContainText("Off");
      await expect(
        page.getByRole("button", { name: "Enable automatic Manage Server access" }),
      ).toHaveCount(0);
      await expect(
        page.getByText(
          "Only the server owner or a Discord Administrator can change the HAF admin role.",
        ),
      ).toBeVisible();
      assert.deepEqual(featureWrites(api), []);
    },
  },
  {
    id: "reaction-pristine",
    title: "Untouched Reaction Rules is clean and leaves without a prompt",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await expect(unsaved(page)).toHaveCount(0);
      await expect(saveReaction(page)).toBeDisabled();
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await overviewReady(page, expect);
      await expect(leaveDialog(page)).toHaveCount(0);
      assert.deepEqual(featureWrites(api), []);
    },
  },
  {
    id: "reaction-free-pristine-counters",
    title: "Free Reaction Rules defaults stay clean with existing breach counters",
    tier: "free",
    role: "member",
    route: LIMITS,
    apiOptions: {
      responses: {
        [REACTION_READ]: {
          guildId: GUILD,
          config: null,
          counters: [{ guildId: GUILD, userId: "fictional-member", breachCount: 1 }],
        },
      },
    },
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("");
      await expect(unsaved(page)).toHaveCount(0);
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await overviewReady(page, expect);
      await expect(leaveDialog(page)).toHaveCount(0);
      assert.deepEqual(featureWrites(api), []);
    },
  },
  {
    id: "reaction-history-stay",
    title: "Stay preserves the Reaction Rules draft after links and browser Back/Forward",
    tier: "premium",
    role: "owner",
    route: OVERVIEW,
    async run({ page, api, expect }) {
      await overviewReady(page, expect);
      await openLimits(page, expect);
      // Prepare real SPA history with a forward entry. Explicitly leaving here is
      // setup only: the separate pristine case asserts no untouched-page prompt.
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await leaveDialog(page).isVisible()) ||
            (await page.locator('[data-section="all-features"]').isVisible()),
        )
        .toBe(true);
      if (await leaveDialog(page).isVisible()) {
        await leaveDialog(page).getByRole("button", { name: "Leave", exact: true }).click();
      }
      await overviewReady(page, expect);
      await page.evaluate(() => history.back());
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await settleHistory(page);
      const draftUrl = page.url();
      await page.locator("#rl-max-message").fill("7");
      await expect(unsaved(page).first()).toBeVisible();

      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await stayAndCheckDraft(page, expect, draftUrl, "7");
      for (const direction of ["back", "forward"]) {
        await page.evaluate((value) => history[value](), direction);
        await stayAndCheckDraft(page, expect, draftUrl, "7");
      }
      assert.equal(api.snapshot(REACTION_READ).config.maxReactionsPerMessage, 20);
      assert.deepEqual(featureWrites(api), [], "Stay must neither save nor discard to the API");
    },
  },
  {
    id: "reaction-discard",
    title: "Cancel preserves a draft and confirmed Discard restores saved Reaction Rules",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await page.locator("#rl-max-message").fill("7");
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      const dialog = namedDialog(page, "Discard Reaction Rules changes?");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("#rl-max-message")).toHaveValue("7");
      await expect(unsaved(page).first()).toBeVisible();
      await discard(page, expect, "Reaction Rules");
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      assert.equal(api.snapshot(REACTION_READ).config.maxReactionsPerMessage, 20);
      assert.deepEqual(featureWrites(api), [], "Discard must not save changes");
      await expect(unsaved(page)).toHaveCount(0);
      await expect(saveReaction(page)).toBeDisabled();
    },
  },
  {
    id: "reaction-leave",
    title: "Leave drops a Reaction Rules draft and returning reads the saved value",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await page.locator("#rl-max-message").fill("9");
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await leaveDialog(page).getByRole("button", { name: "Leave", exact: true }).click();
      await overviewReady(page, expect);
      await openLimits(page, expect);
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      assert.equal(api.snapshot(REACTION_READ).config.maxReactionsPerMessage, 20);
      assert.deepEqual(featureWrites(api), [], "Leaving a draft must not save it");
    },
  },
  {
    id: "reaction-save-repeat-readback",
    title: "Repeated Reaction Rules saves mutate state and survive fresh-page readback",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    async run({ page, api, expect }) {
      const cleanCheckpoints = [];
      for (const value of [7, 9]) {
        await expect(page.locator("#rl-max-message")).toBeVisible();
        await page.locator("#rl-max-message").fill(String(value));
        await expect(unsaved(page).first()).toBeVisible();
        const response = await submit(page, saveReaction(page), REACTION_WRITE);
        assert.equal(response.status(), 200);
        await expect(saveReaction(page)).toBeDisabled();
        await expect(page.locator("#rl-max-message")).toHaveValue(String(value));
        const write = writes(api, REACTION_WRITE).at(-1);
        assert.equal(write.body.maxReactionsPerMessage, value);
        assert.equal(write.body.guildId, GUILD);
        assert.equal(write.body.workspaceId, WORKSPACE);
        assertPersistedLimit(api, value);
        cleanCheckpoints.push({
          value,
          phase: "after-save",
          clean: (await unsaved(page).count()) === 0,
        });

        const readCount = reads(api, REACTION_READ).length;
        await reloadDocument(page);
        await expect(page.locator("#rl-max-message")).toHaveValue(String(value));
        assert.ok(
          reads(api, REACTION_READ).length > readCount,
          "Reload must make a fresh API read",
        );
        assertPersistedLimit(api, value);
        cleanCheckpoints.push({
          value,
          phase: "after-reload",
          clean: (await unsaved(page).count()) === 0,
        });
      }
      assert.deepEqual(
        writes(api, REACTION_WRITE).map((request) => request.body.maxReactionsPerMessage),
        [7, 9],
      );
      assert.deepEqual(
        cleanCheckpoints,
        cleanCheckpoints.map((checkpoint) => ({ ...checkpoint, clean: true })),
        "Successful save and reload must both clear the unsaved indicator",
      );
    },
  },
  {
    id: "reaction-save-retry",
    title: "A rejected Reaction Rules save preserves the draft and can be retried",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    apiOptions: {
      failures: [
        {
          method: "POST",
          path: REACTION_WRITE,
          status: 503,
          times: 1,
          json: {
            error: "Fictional temporary save failure",
            code: "internal_error",
            retryable: true,
          },
        },
      ],
    },
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await page.locator("#rl-max-message").fill("7");
      const failure = await submit(page, saveReaction(page), REACTION_WRITE);
      assert.equal(failure.status(), 503);
      await expect(
        page.getByText(/could not be saved.*Retry to save the remaining changes/).first(),
      ).toBeVisible();
      await expect(page.locator("#rl-max-message")).toHaveValue("7");
      await expect(unsaved(page).first()).toBeVisible();
      await expect(saveReaction(page)).toBeEnabled();
      assert.equal(api.snapshot(REACTION_READ).config.maxReactionsPerMessage, 20);
      const retry = await submit(page, saveReaction(page), REACTION_WRITE);
      assert.equal(retry.status(), 200);
      await expect(saveReaction(page)).toBeDisabled();
      assertPersistedLimit(api, 7);
      await reloadDocument(page);
      await expect(page.locator("#rl-max-message")).toHaveValue("7");
      assert.deepEqual(
        writes(api, REACTION_WRITE).map((request) => request.status),
        [503, 200],
      );
    },
  },
  {
    id: "reaction-lost-write-control",
    title: "Negative control detects an acknowledged but deliberately lost Reaction Rules write",
    tier: "premium",
    role: "owner",
    route: LIMITS,
    apiOptions: { faults: { dropWrites: [REACTION_WRITE] } },
    async run({ page, api, expect }) {
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      await page.locator("#rl-max-message").fill("7");
      const response = await submit(page, saveReaction(page), REACTION_WRITE);
      assert.equal(response.status(), 200, "The fault must acknowledge the write successfully");
      await expect(saveReaction(page)).toBeDisabled();
      const recordedWrites = writes(api, REACTION_WRITE);
      assert.equal(recordedWrites.length, 1);
      assert.equal(recordedWrites[0].body.maxReactionsPerMessage, 7);
      const readCount = reads(api, REACTION_READ).length;
      await reloadDocument(page);
      await expect(page.locator("#rl-max-message")).toHaveValue("20");
      assert.ok(
        reads(api, REACTION_READ).length > readCount,
        "The control must exercise a fresh read",
      );
      assert.equal(api.snapshot(REACTION_READ).config.maxReactionsPerMessage, 20);
      // Only this exact persisted-value mismatch counts as successful detection.
      // Browser failures, missing requests, and arbitrary exceptions above still fail.
      assert.throws(
        () => assertPersistedLimit(api, 7),
        (error) =>
          error instanceof PersistedLimitMismatch && error.expected === 7 && error.actual === 20,
        "The persistence oracle must reject the deliberately lost 7 → 20 update",
      );
      return {
        expectedFailureDetected: "reaction-limit-readback-mismatch",
        expected: 7,
        actual: 20,
      };
    },
  },
  {
    id: "lfg-optional-none",
    title: "Optional LFG destinations can be cleared, discarded, saved, and reloaded",
    tier: "premium",
    role: "owner",
    route: LFG,
    async run({ page, api, expect }) {
      await expect(page.locator("#lfg-notice-channel")).toContainText("looking-for-group");
      await expect(page.locator("#lfg-notification-role")).toContainText("Members");
      await selectNone(page, expect, "#lfg-notice-channel");
      await selectNone(page, expect, "#lfg-notification-role");
      await expect(unsaved(page).first()).toBeVisible();
      await discard(page, expect, "LFG");
      await expect(page.locator("#lfg-notice-channel")).toContainText("looking-for-group");
      await expect(page.locator("#lfg-notification-role")).toContainText("Members");
      await expect(unsaved(page)).toHaveCount(0);
      assert.deepEqual(writes(api, LFG_WRITE), []);

      await selectNone(page, expect, "#lfg-notice-channel");
      await selectNone(page, expect, "#lfg-notification-role");
      const response = await submit(
        page,
        page.getByRole("button", { name: "Save LFG config", exact: true }),
        LFG_WRITE,
      );
      assert.equal(response.status(), 200);
      await expect(unsaved(page)).toHaveCount(0);
      const write = writes(api, LFG_WRITE).at(-1);
      assert.equal(write.body.noticeChannelId, null);
      assert.equal(write.body.notificationRoleId, null);
      assert.equal(api.snapshot("/admin/api/lfg").config.noticeChannelId, null);
      assert.equal(api.snapshot("/admin/api/lfg").config.notificationRoleId, null);
      const readCount = reads(api, "/admin/api/lfg").length;
      await reloadDocument(page);
      await expect(page.locator("#lfg-notice-channel")).toBeVisible();
      await expect(page.locator("#lfg-notice-channel")).toHaveText(/^(None|Select a channel)$/);
      await expect(page.locator("#lfg-notification-role")).toHaveAttribute("data-placeholder", "");
      await expect(page.locator("#lfg-notification-role")).toHaveText("Optional LFG alerts role");
      await expect(unsaved(page)).toHaveCount(0);
      assert.ok(reads(api, "/admin/api/lfg").length > readCount);
      assert.equal(api.snapshot("/admin/api/lfg").config.noticeChannelId, null);
      assert.equal(api.snapshot("/admin/api/lfg").config.notificationRoleId, null);
      assert.equal(writes(api, LFG_WRITE).length, 1);
    },
  },
];

function reads(api, path) {
  return api.requests.filter((request) => request.method === "GET" && request.path === path);
}
function writes(api, path) {
  return api.requests.filter((request) => request.method === "POST" && request.path === path);
}
function featureWrites(api) {
  return api.requests.filter(
    (request) =>
      !["GET", "HEAD"].includes(request.method) &&
      request.path !== "/admin/api/product-analytics/events",
  );
}
function unsaved(page) {
  return page.getByText("Unsaved changes", { exact: true });
}
function saveReaction(page) {
  return page.getByRole("button", { name: /^(Save changes|Saved)$/ });
}
function namedDialog(page, title) {
  return page
    .locator('[role="dialog"], [role="alertdialog"]')
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
function leaveDialog(page) {
  return namedDialog(page, "Leave page?");
}
async function overviewReady(page, expect) {
  await expect(
    page.getByRole("heading", { name: "What needs your attention", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-section="all-features"] a').first()).toBeVisible();
}
async function openLimits(page, expect) {
  const moderation = page.locator('[data-nav-section="Moderation"] > button');
  if ((await moderation.getAttribute("aria-expanded")) === "false") await moderation.click();
  const reactionRules = page.getByRole("button", { name: "Reaction Rules", exact: true });
  if ((await reactionRules.getAttribute("aria-expanded")) === "false") await reactionRules.click();
  await page.getByRole("link", { name: "Limits", exact: true }).click();
  await expect(page.locator("#rl-max-message")).toBeVisible();
}
async function settleHistory(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function stayAndCheckDraft(page, expect, url, value) {
  const dialog = leaveDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settleHistory(page);
  await expect(page).toHaveURL(url);
  await expect(page.locator("#rl-max-message")).toHaveValue(value);
  await expect(unsaved(page).first()).toBeVisible();
}
async function discard(page, expect, feature) {
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  const dialog = namedDialog(page, `Discard ${feature} changes?`);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function selectNone(page, expect, selector) {
  await page.locator(selector).click();
  const none = page.getByRole("option", { name: "None", exact: true });
  await expect(none).toBeVisible();
  await none.click();
}
async function submit(page, button, path) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.request().method() === "POST",
    ),
    button.click(),
  ]);
  await response.finished();
  return response;
}
async function reloadDocument(page) {
  // Reload is an intentional user action. Accept only its browser beforeunload
  // prompt, including on baselines with a false dirty state; no app guard is bypassed.
  const unexpected = [];
  const handleDialog = async (dialog) => {
    if (dialog.type() === "beforeunload") await dialog.accept();
    else {
      unexpected.push(`${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    }
  };
  page.on("dialog", handleDialog);
  try {
    await page.reload({ waitUntil: "networkidle" });
  } finally {
    page.off("dialog", handleDialog);
  }
  assert.deepEqual(unexpected, [], "Unexpected native dialog during reload");
}
class PersistedLimitMismatch extends Error {
  constructor(expected, actual) {
    super(`Reaction Rules persisted readback mismatch: expected ${expected}, received ${actual}`);
    this.name = "PersistedLimitMismatch";
    this.expected = expected;
    this.actual = actual;
  }
}
function assertPersistedLimit(api, expected) {
  const actual = api.snapshot(REACTION_READ).config.maxReactionsPerMessage;
  if (actual !== expected) throw new PersistedLimitMismatch(expected, actual);
}
