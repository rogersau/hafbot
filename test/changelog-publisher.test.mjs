import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGeneratedBundleFresh,
  buildDiscordPayload,
  getLatestRelease,
  validateChangelog,
} from "../scripts/changelog-format.mjs";

test("changelog freshness check rejects a generated bundle without the latest version", () => {
  assert.doesNotThrow(() => assertGeneratedBundleFresh("release 2026.07.17.2", "2026.07.17.2"));
  assert.throws(
    () => assertGeneratedBundleFresh("release 2026.07.17.1", "2026.07.17.2"),
    /Generated landing bundle is stale/,
  );
});

const changelog = {
  releases: [
    {
      version: "2026.07.10",
      date: "2026-07-10",
      title: "A clearer view of what changed",
      summary: "Customers can now follow product updates without leaving the HAF Bot website.",
      changes: [
        { type: "new", text: "Added a public changelog." },
        { type: "improved", text: "Made deployments faster." },
      ],
    },
  ],
};

test("latest changelog release becomes a customer-facing Discord announcement", () => {
  validateChangelog(changelog);

  const release = getLatestRelease(changelog);
  const payload = buildDiscordPayload(release, "https://hafbot.xyz/changelog");

  assert.equal(payload.username, "HAF Bot updates");
  assert.equal(payload.embeds[0].title, "A clearer view of what changed");
  assert.equal(payload.embeds[0].url, "https://hafbot.xyz/changelog");
  assert.match(payload.embeds[0].description, /Customers can now follow product updates/);
  assert.deepEqual(payload.embeds[0].fields, [
    { name: "New", value: "• Added a public changelog." },
    { name: "Improved", value: "• Made deployments faster." },
  ]);
  assert.equal(payload.embeds[0].footer.text, "HAF Bot · 2026.07.10 · 10 Jul 2026");
});

test("invalid changelog entries fail before deployment", () => {
  assert.throws(
    () => validateChangelog({ releases: [{ ...changelog.releases[0], changes: [] }] }),
    /at least one change/i,
  );
});

test("changelog releases must be newest first so the website and Discord agree", () => {
  const olderRelease = {
    ...changelog.releases[0],
    version: "2026.06.01",
    date: "2026-06-01",
  };

  assert.throws(
    () => validateChangelog({ releases: [olderRelease, changelog.releases[0]] }),
    /newest first/i,
  );
});

test("Discord field limits fail validation instead of silently dropping customer changes", () => {
  const oversizedRelease = {
    ...changelog.releases[0],
    changes: [{ type: "new", text: "x".repeat(1024) }],
  };

  assert.throws(() => validateChangelog({ releases: [oversizedRelease] }), /Discord.*1,024/i);
});
