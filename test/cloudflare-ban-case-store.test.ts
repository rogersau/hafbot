/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { BanCase, BanCaseConfig, BanCaseSource } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const baseSource: Omit<BanCaseSource, "guildId" | "sourceId" | "publicId"> = {
  name: "COLDASFK bans",
  enabled: true,
  platform: "steam",
  pattern: "^(?<username>.+?) (?<subjectId>\\d{17}) got banned on .+?: (?<reason>.+)$",
  flags: "",
  subjectIdGroup: "subjectId",
  nameGroup: "username",
  reasonGroup: "reason",
  createdAtMs: 100,
  updatedAtMs: 100,
};

const baseConfig: Omit<BanCaseConfig, "guildId" | "updatedAtMs"> = {
  enabled: true,
  forumChannelId: "forum-1",
  modRoleIds: ["mod-role-1"],
};

const baseBanCase: Omit<BanCase, "guildId" | "caseId"> = {
  sourceId: "source-1",
  publicId: "pub-1",
  subject: { platform: "steam", id: "76561199304898090" },
  username: "KXWR.xyz",
  status: "new",
  threadChannelId: "thread-1",
  threadMessageId: "thread-1",
  createdAtMs: 100,
  updatedAtMs: 100,
};

test("ban case store reads null config initially", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  assert.equal(await store.readConfig("guild-1"), null);
  assert.equal(await store.readBanCaseSourceByPublicId("pub-1"), null);
  assert.deepEqual(await store.listBanCaseSources("guild-1"), []);
  assert.equal(await store.readBanCaseBySubject("guild-1", "steam", "1"), null);
});

test("ban case store round-trips config and sources", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.upsertConfig({ ...baseConfig, guildId: "guild-1", updatedAtMs: 100 });
  await store.upsertBanCaseSource({
    ...baseSource,
    guildId: "guild-1",
    sourceId: "source-1",
    publicId: "pub-1",
  });

  const config = await store.readConfig("guild-1");
  assert.deepEqual(config?.modRoleIds, ["mod-role-1"]);
  assert.equal(config?.forumChannelId, "forum-1");

  const source = await store.readBanCaseSourceByPublicId("pub-1");
  assert.equal(source?.name, "COLDASFK bans");
  assert.equal(source?.platform, "steam");

  const listed = await store.listBanCaseSources("guild-1");
  assert.equal(listed.length, 1);
});

test("ban case store does not leak sources or config between guilds", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.upsertBanCaseSource({
    ...baseSource,
    guildId: "guild-1",
    sourceId: "source-1",
    publicId: "pub-1",
  });

  assert.equal((await store.readBanCaseSourceByPublicId("pub-1"))?.guildId, "guild-1");
  assert.equal((await store.listBanCaseSources("guild-2")).length, 0);
});

test("ban case store enforces unique subject per guild", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.createBanCase({ ...baseBanCase, guildId: "guild-1", caseId: "case-1" });

  // Same subject in same guild -> rejected by the unique index.
  await assert.rejects(
    store.createBanCase({ ...baseBanCase, guildId: "guild-1", caseId: "case-2" }),
  );

  // Same subject in a different guild -> allowed.
  await store.createBanCase({ ...baseBanCase, guildId: "guild-2", caseId: "case-3" });
  assert.equal(
    (await store.readBanCaseBySubject("guild-2", "steam", "76561199304898090"))?.caseId,
    "case-3",
  );
});

test("ban case store reads a case by subject and id", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.createBanCase({ ...baseBanCase, guildId: "guild-1", caseId: "case-1" });

  const byId = await store.readBanCase("guild-1", "case-1");
  assert.equal(byId?.username, "KXWR.xyz");
  assert.deepEqual(byId?.subject, { platform: "steam", id: "76561199304898090" });

  const bySubject = await store.readBanCaseBySubject("guild-1", "steam", "76561199304898090");
  assert.equal(bySubject?.caseId, "case-1");
});

test("ban case store updates status and thread", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.createBanCase({ ...baseBanCase, guildId: "guild-1", caseId: "case-1" });

  const updated = await store.updateBanCaseStatus("guild-1", "case-1", "completed", 200);
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.updatedAtMs, 200);
  assert.equal((await store.readBanCase("guild-1", "case-1"))?.status, "completed");

  await store.updateBanCaseThread(
    "guild-1",
    "case-1",
    { threadChannelId: "thread-2", threadMessageId: "thread-2", publicId: "pub-9" },
    300,
  );
  assert.equal((await store.readBanCase("guild-1", "case-1"))?.publicId, "pub-9");
});

test("ban case store deletes a source", async () => {
  const { createCloudflareBanCaseStore } = await import("../src/runtime/cloudflare-ban-case-store");
  const store = createCloudflareBanCaseStore(new SqliteD1Database() as unknown as D1Database);

  await store.upsertBanCaseSource({
    ...baseSource,
    guildId: "guild-1",
    sourceId: "source-1",
    publicId: "pub-1",
  });

  await store.deleteBanCaseSource({ guildId: "guild-1", sourceId: "source-1" });
  assert.equal(await store.readBanCaseSourceByPublicId("pub-1"), null);
});
