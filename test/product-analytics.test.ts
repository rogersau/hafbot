/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  browserPrivacySignalEnabled,
  createDeterministicInsertionId,
  createPostHogProductAnalytics,
  pseudonymizeGuildId,
  withGuildAnalyticsPreference,
  withProductAnalyticsWaitUntil,
} from "../src/product-analytics";

test("Guild pseudonyms are deterministic, separated, URL safe, and hide the raw ID", async () => {
  const key = "test-only-pseudonym-key-that-is-at-least-thirty-two-characters";
  const first = await pseudonymizeGuildId("123456789012345678", key);

  assert.equal(await pseudonymizeGuildId("123456789012345678", key), first);
  assert.notEqual(await pseudonymizeGuildId("223456789012345678", key), first);
  assert.notEqual(
    await pseudonymizeGuildId(
      "123456789012345678",
      "different-test-only-pseudonym-key-that-is-long-enough",
    ),
    first,
  );
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first, /123456789012345678/);
});

test("PostHog adapter sends only catalog properties to the explicit regional host", async () => {
  const requests: Request[] = [];
  const reporter = createPostHogProductAnalytics({
    host: "https://eu.i.posthog.com",
    projectToken: "test-project-token",
    pseudonymKey: "test-only-pseudonym-key-that-is-at-least-thirty-two-characters",
    now: () => new Date("2026-08-04T01:02:03.000Z"),
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 200 });
    },
  });

  await reporter.report({
    name: "feature_outcome",
    insertionId: "ticket:open:operation-1",
    guildId: "123456789012345678",
    feature: "tickets",
    action: "ticket_opened",
    status: "success",
    plan: "premium",
  });

  assert.equal(requests[0]?.url, "https://eu.i.posthog.com/i/v0/e/");
  const body = (await requests[0]?.json()) as Record<string, unknown>;
  assert.equal(body.api_key, "test-project-token");
  assert.equal(body.event, "feature_outcome");
  assert.notEqual(body.distinct_id, "123456789012345678");
  assert.deepEqual(Object.keys(body.properties as object).sort(), [
    "$insert_id",
    "$process_person_profile",
    "action",
    "environment",
    "feature",
    "guild",
    "plan",
    "schema_version",
    "status",
    "timestamp",
  ]);
  assert.doesNotMatch(JSON.stringify(body), /123456789012345678/);
});

test("PostHog adapter absorbs provider and network failures", async () => {
  const reporter = createPostHogProductAnalytics({
    host: "https://us.i.posthog.com",
    projectToken: "test-project-token",
    pseudonymKey: "test-only-pseudonym-key-that-is-at-least-thirty-two-characters",
    fetch: async () => {
      throw new Error("provider unavailable");
    },
  });

  await assert.doesNotReject(
    reporter.report({ name: "install_started", insertionId: "install-attempt-1" }),
  );
});

test("browser privacy signals suppress browser analytics", () => {
  assert.equal(
    browserPrivacySignalEnabled(
      new Request("https://hafbot.xyz/", { headers: { "sec-gpc": "1" } }),
    ),
    true,
  );
  assert.equal(
    browserPrivacySignalEnabled(new Request("https://hafbot.xyz/", { headers: { dnt: "1" } })),
    true,
  );
  assert.equal(browserPrivacySignalEnabled(new Request("https://hafbot.xyz/")), false);
});

test("Guild preference suppresses only Guild-scoped product analytics", async () => {
  const events: Array<{ name: string }> = [];
  const reporter = withGuildAnalyticsPreference(
    { report: async (event) => void events.push(event) },
    async (guildId) => guildId !== "123456789012345678",
  );

  await reporter.report({ name: "install_started", insertionId: "public-1" });
  await reporter.report({
    name: "guild_installed",
    insertionId: "guild-1",
    guildId: "123456789012345678",
  });
  await reporter.report({
    name: "guild_installed",
    insertionId: "guild-2",
    guildId: "223456789012345678",
  });

  assert.deepEqual(
    events.map(({ name }) => name),
    ["install_started", "guild_installed"],
  );
});

test("deterministic insertion IDs hide operation inputs and remain stable", async () => {
  const parts = ["guild-1", "user-1", "provider-account-1"];
  const first = await createDeterministicInsertionId(parts);

  assert.equal(await createDeterministicInsertionId(parts), first);
  assert.notEqual(await createDeterministicInsertionId([...parts, "retry-2"]), first);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first, /guild-1|user-1|provider-account-1/);
});

test("waitUntil wrapper owns preference reads and analytics delivery", async () => {
  const scheduled: Promise<unknown>[] = [];
  let delivered = false;
  const reporter = withProductAnalyticsWaitUntil(
    withGuildAnalyticsPreference(
      {
        report: async () => {
          await Promise.resolve();
          delivered = true;
        },
      },
      async () => {
        await Promise.resolve();
        return true;
      },
    ),
    (promise) => void scheduled.push(promise),
  );

  await reporter.report({
    name: "guild_installed",
    insertionId: "guild-install-1",
    guildId: "123456789012345678",
  });

  assert.equal(scheduled.length, 1);
  await Promise.all(scheduled);
  assert.equal(delivered, true);
});
