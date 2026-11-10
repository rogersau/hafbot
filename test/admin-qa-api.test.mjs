import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

import { commonResponses } from "../scripts/admin-docs/fixtures.mjs";
import { createApi } from "../scripts/admin-qa/api.mjs";

const root = "/admin/api";
const limits = `${root}/reaction-limits`;
const blocklist = `${root}/blocklist`;
const profile = `${root}/profile/preferences`;
const request = (api, method, url, body) => api.handle({ method, url, body });
const saveLimits = (api, values = {}) =>
  request(api, "POST", `${limits}/config`, {
    guildId: "docs-guild",
    limitsEnabled: true,
    maxReactionsPerMessage: 17,
    ...values,
  });

test("GET fixtures are independent snapshots, including query-sensitive responses", async () => {
  const api = createApi();
  const read = await request(api, "GET", `${blocklist}?guildId=docs-guild`);
  assert.equal(read.status, 200);
  read.json.emojis.push("🚀");
  api.snapshot(blocklist).emojis.push("🤖");
  assert.deepEqual(api.snapshot(blocklist).emojis, ["🚫", "💩"]);
  const permissions = await request(api, "GET", `${root}/permissions?feature=blocklist`);
  assert.equal(permissions.json.feature, "blocklist");
  assert.deepEqual(commonResponses[blocklist].emojis, ["🚫", "💩"]);
  assert.equal(api.requests[0].kind, "snapshot");
  api.assertNoUnhandled();
});

test("documentation GET fixtures satisfy the current response contracts", async () => {
  const result = await build({
    entryPoints: ["src/contracts/admin/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { adminOperationContracts } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  let checked = 0;
  for (const operation of adminOperationContracts) {
    const fixture = commonResponses[operation.path];
    if (operation.method !== "GET" || fixture === undefined) continue;
    const url = new URL(`https://hafbot.invalid${operation.path}?guildId=docs-guild`);
    const response = typeof fixture === "function" ? fixture(url) : fixture;
    assert.doesNotThrow(() => operation.success.schema.parse(response), operation.operationId);
    checked++;
  }
  assert.ok(checked > 0);
});

test("Free/Premium and owner/member fixtures are orthogonal and use canonical plan limits", async () => {
  for (const tier of ["free", "premium"]) {
    for (const role of ["owner", "member"]) {
      const api = createApi({ tier, role });
      const entitlement = api.snapshot(`${root}/entitlement`);
      assert.equal(entitlement.tier, tier);
      assert.equal(entitlement.limits.paidFeatures, tier === "premium");
      assert.equal(entitlement.limits.reactionLimitsEnabled, true);
      assert.equal(entitlement.limits.blocklistMaxEmojis, tier === "free" ? 10 : null);
      assert.equal(entitlement.limits.clansMax, tier === "free" ? 5 : 25);
      assert.equal(entitlement.limits.r2MaxBytes, (tier === "free" ? 100 : 1024) * 1024 * 1024);
      assert.equal(api.snapshot(`${root}/guild-overview`).tier, tier);
      assert.ok(api.snapshot(`${root}/guild-overview`).cards.length > 0);
      assert.equal(
        api.snapshot(`${root}/workspaces`).workspaces[0].role,
        role === "member" ? "viewer" : "owner",
      );
      // Workspace membership is not Guild Admin authorization or billing ownership.
      assert.equal((await saveLimits(api)).status, 200);
      assert.equal((await request(api, "GET", `${root}/billing`)).status, 200);
    }
  }
});

test("owner and non-owner personas satisfy the real workspace response contract", async () => {
  const result = await build({
    entryPoints: ["src/contracts/admin/cross-cutting.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { crossCuttingContracts } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  for (const role of ["owner", "member"]) {
    const response = createApi({ role }).snapshot(`${root}/workspaces`);
    assert.equal(crossCuttingContracts.workspaces.success.schema.safeParse(response).success, true);
  }
  const invalid = createApi().snapshot(`${root}/workspaces`);
  invalid.workspaces[0].role = "member";
  assert.equal(crossCuttingContracts.workspaces.success.schema.safeParse(invalid).success, false);
});

test("reaction-limit POST persists explicit nulls and GET readback, without body metadata", async () => {
  const api = createApi();
  const response = await saveLimits(api, {
    workspaceId: "docs-workspace",
    maxReactionsPerUserPerMessage: null,
    breachDmText: null,
    channelMode: "exclude",
    channelIds: ["channel-general"],
  });
  assert.deepEqual(response, { status: 200, json: { ok: true } });
  const readback = await request(api, "GET", `${limits}?guildId=docs-guild`);
  assert.equal(readback.json.config.maxReactionsPerMessage, 17);
  assert.equal(readback.json.config.maxReactionsPerUserPerMessage, null);
  assert.equal(readback.json.config.breachDmText, null);
  assert.deepEqual(readback.json.config.channelIds, ["channel-general"]);
  assert.equal(Object.hasOwn(readback.json.config, "workspaceId"), false);
  assert.equal(api.requests[0].method, "POST");
  assert.equal(api.requests[0].path, `${limits}/config`);
  assert.equal(api.requests[0].body.maxReactionsPerMessage, 17);
});

test("a pristine null reaction-limit configuration can be saved", async () => {
  const api = createApi({
    tier: "free",
    responses: {
      [limits]: { guildId: "docs-guild", config: null, counters: [] },
    },
  });
  assert.equal((await saveLimits(api)).status, 200);
  assert.equal(api.snapshot(limits).config.maxReactionsPerMessage, 17);
  assert.equal(api.snapshot(limits).config.breachRoleId, null);
  assert.deepEqual(api.snapshot(limits).config.channelIds, []);
});

test("blocklist batch add/remove, channel and filter writes have separate readback state", async () => {
  const api = createApi();
  const added = await request(api, "POST", blocklist, {
    guildId: "docs-guild",
    action: "add",
    emojis: ["🚫", "🤖", "🤖", "<:sample:123>"],
  });
  assert.deepEqual(added.json.added, ["🤖", "sample:123"]);
  assert.deepEqual(added.json.alreadyBlocked, ["🚫"]);
  assert.deepEqual(added.json.blocklist.emojis, ["🚫", "💩", "🤖", "sample:123"]);
  await request(api, "POST", blocklist, { guildId: "docs-guild", action: "remove", emoji: "🤖" });
  await request(api, "POST", `${root}/blocklist-channel`, {
    guildId: "docs-guild",
    notificationChannelId: null,
  });
  await request(api, "POST", `${root}/blocklist-channel-filter`, {
    guildId: "docs-guild",
    channelMode: "include",
    channelIds: ["channel-general"],
  });
  const readback = (await request(api, "GET", blocklist)).json;
  assert.deepEqual(readback.emojis, ["🚫", "💩", "sample:123"]);
  assert.equal(readback.notificationChannelId, null);
  assert.equal(readback.channelMode, "include");
  assert.deepEqual(readback.channelIds, ["channel-general"]);
});

test("invalid mutations and a Free blocklist quantity overflow leave state unchanged", async () => {
  const api = createApi({ tier: "free" });
  const before = api.snapshot();
  assert.equal((await saveLimits(api, { maxReactionsPerMessage: -1 })).status, 400);
  assert.equal((await saveLimits(api, { guildId: "unexpected-guild" })).status, 400);
  assert.equal(
    (
      await request(api, "POST", blocklist, {
        guildId: "docs-guild",
        action: "add",
        emojis: Array.from({ length: 9 }, (_, index) => `emoji-${index}`),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(api, "POST", blocklist, {
        guildId: "docs-guild",
        action: "remove",
        emojis: ["🚫"],
      })
    ).status,
    400,
  );
  assert.equal((await request(api, "PATCH", profile, '{"theme":')).status, 400);
  assert.equal((await request(api, "PATCH", profile, { theme: "unknown" })).status, 400);
  assert.equal(
    (await request(api, "PATCH", profile, { theme: "light", unrelated: true })).status,
    400,
  );
  assert.deepEqual(api.snapshot(), before);
});

test("profile PATCH merges preferences, deduplicates hidden Guilds and persists explicit null", async () => {
  const api = createApi();
  const response = await request(api, "PATCH", profile, {
    theme: "light",
    defaultGuildId: null,
    hiddenGuildIds: ["docs-guild", "docs-guild"],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.theme, "light");
  assert.equal(response.json.emailNotifications, true);
  assert.equal(response.json.defaultGuildId, null);
  assert.deepEqual(response.json.hiddenGuildIds, ["docs-guild"]);
  assert.deepEqual((await request(api, "GET", profile)).json, response.json);
});

test("LFG saves optional fields as null and does not copy workspace metadata", async () => {
  const api = createApi();
  const config = api.snapshot(`${root}/lfg`).config;
  await request(api, "POST", `${root}/lfg/config`, {
    ...config,
    workspaceId: "docs-workspace",
    notificationRoleId: null,
    approvalVoiceCategoryId: " ",
    noticeColor: 0x123456,
  });
  assert.equal(api.snapshot(`${root}/lfg`).config.notificationRoleId, null);
  assert.equal(api.snapshot(`${root}/lfg`).config.approvalVoiceCategoryId, null);
  assert.equal(api.snapshot(`${root}/lfg`).config.noticeColor, 0x123456);
  assert.equal(Object.hasOwn(api.snapshot(`${root}/lfg`).config, "workspaceId"), false);
});

test("counter clear changes only the requested fictional member before clear-all", async () => {
  const api = createApi({
    responses: {
      [limits]: {
        ...commonResponses[limits],
        counters: [
          { userId: "one", count: 2 },
          { userId: "two", count: 3 },
        ],
      },
    },
  });
  await request(api, "POST", `${limits}/counter/clear`, { guildId: "docs-guild", userId: "one" });
  assert.deepEqual(api.snapshot(limits).counters, [{ userId: "two", count: 3 }]);
  await request(api, "POST", `${limits}/counter/clear`, { guildId: "docs-guild", userId: null });
  assert.deepEqual(api.snapshot(limits).counters, []);
});

test("controlled failure is recorded, does not write, and allows a successful retry", async () => {
  const api = createApi({
    failures: [
      {
        method: "POST",
        path: `${limits}/config`,
        status: 503,
        json: { error: "Fictional temporary outage" },
      },
    ],
  });
  const before = api.snapshot(limits);
  assert.throws(() => api.assertExpectedFailuresConsumed(), /Unused controlled failure/);
  assert.equal((await saveLimits(api)).status, 503);
  assert.deepEqual(api.snapshot(limits), before);
  assert.equal(api.requests[0].expectedFailure, true);
  assert.equal(api.unhandled.length, 0);
  assert.equal((await saveLimits(api)).status, 200);
  assert.equal(api.snapshot(limits).config.maxReactionsPerMessage, 17);
  api.assertNoUnhandled();
  api.assertExpectedFailuresConsumed();
});

test("reset and fresh instances isolate fixture overrides, mutations, logs and failure counters", async () => {
  const responses = { [profile]: { ...commonResponses[profile], theme: "system" } };
  const api = createApi({ responses, failures: [{ method: "PATCH", path: profile, status: 403 }] });
  const before = api.snapshot();
  responses[profile].theme = "light";
  const log = api.requests;
  await request(api, "PATCH", profile, { theme: "dark" });
  await request(api, "PATCH", profile, { theme: "dark" });
  await saveLimits(api);
  await request(api, "DELETE", blocklist);
  api.reset();
  assert.equal(api.requests, log);
  assert.deepEqual(api.requests, []);
  assert.deepEqual(api.unhandled, []);
  assert.deepEqual(api.snapshot(), before);
  assert.equal((await request(api, "PATCH", profile, { theme: "dark" })).status, 403);
  const fresh = createApi();
  assert.equal(fresh.snapshot(profile).theme, "dark");
  assert.equal(fresh.snapshot(limits).config.maxReactionsPerMessage, 20);
  assert.equal(commonResponses[profile].theme, "dark");
});

test("unknown routes and wrong methods fail explicitly, including formerly permissive POSTs", async () => {
  const api = createApi({ failures: [{ method: "POST", path: profile, status: 503 }] });
  const before = api.snapshot();
  for (const [method, path, status] of [
    ["POST", profile, 405],
    ["GET", `${limits}/config`, 405],
    ["PUT", blocklist, 405],
    ["POST", `${root}/tickets/panel`, 405],
    ["POST", `${root}/unknown`, 501],
    ["GET", `${root}/unknown`, 501],
    ["GET", `${root}/product-analytics/events`, 405],
  ]) {
    assert.equal((await request(api, method, path, {})).status, status);
  }
  assert.deepEqual(api.snapshot(), before);
  assert.equal(api.unhandled.length, 7);
  assert.throws(() => api.assertNoUnhandled(), /POST \/admin\/api\/profile\/preferences/);
  // Failure injection cannot hide a missing method contract.
  assert.throws(() => api.assertExpectedFailuresConsumed(), /Unused controlled failure/);
});

test("negative control: successful acknowledgement cannot substitute for persisted readback", async () => {
  const healthy = createApi();
  const faulty = createApi({ faults: { dropWrites: [`${limits}/config`] } });
  async function checkSave(api) {
    assert.equal((await saveLimits(api)).status, 200);
    const readback = await request(api, "GET", limits);
    assert.equal(
      readback.json.config.maxReactionsPerMessage,
      17,
      "persisted reaction-limit readback",
    );
  }
  await checkSave(healthy);
  await assert.rejects(checkSave(faulty), /persisted reaction-limit readback/);
  assert.equal(faulty.requests[0].droppedWrite, true);
  faulty.assertNoUnhandled();
});

test("analytics is a recognized POST acknowledgement without mutable GET state", async () => {
  const api = createApi();
  const response = await request(api, "POST", `${root}/product-analytics/events`, {
    guildId: "docs-guild",
    event: "page_viewed",
    page: "overview",
  });
  assert.deepEqual(response, { status: 202, json: { accepted: true } });
  assert.equal(api.snapshot(`${root}/product-analytics/events`), undefined);
  api.assertNoUnhandled();
});
