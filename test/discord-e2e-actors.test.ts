import assert from "node:assert/strict";
import test from "node:test";
import {
  readDiscordE2eActors,
  rejectDiscordE2eEnvironment,
} from "../src/runtime/discord-e2e-actors";

const GUILD = "100000000000000001";
const TESTER = "100000000000000002";
const HAF = "100000000000000003";
const environment = {
  STAGING_MODE: "true",
  DATABASE_URL: "postgresql://haf:local-only@localhost/haf_e2e_test",
  BOT_USER_ID: HAF,
  HAF_E2E_GUILD_ID: GUILD,
  HAF_E2E_BOT_USER_IDS: TESTER,
};

test("the E2E actor view lets a named tester bot exercise the member message path", () => {
  const actors = readDiscordE2eActors(environment);
  const message = { guild_id: GUILD, author: { id: TESTER, bot: true }, content: "hello" };
  assert.deepEqual(actors.view(message, GUILD, HAF), {
    ...message,
    author: { id: TESTER, bot: false },
  });
  assert.equal(message.author.bot, true, "the original Discord event must remain unchanged");
});

test("the actor view retains bot guards outside its allowlist and preserves member permissions", () => {
  const actors = readDiscordE2eActors(environment);
  for (const message of [
    { guild_id: GUILD, author: { id: HAF, bot: true } },
    { guild_id: GUILD, author: { id: "100000000000000004", bot: true } },
    { guild_id: "100000000000000005", author: { id: TESTER, bot: true } },
    { guild_id: GUILD, author: { id: TESTER, bot: true }, webhook_id: "webhook" },
  ])
    assert.deepEqual(actors.view(message, GUILD, HAF), message);
  const payload = {
    user: { id: TESTER, bot: true },
    member: { user: { id: TESTER, bot: true }, roles: ["ordinary-role"], permissions: "1024" },
  };
  assert.deepEqual(
    actors.view(payload, GUILD, TESTER),
    payload,
    "the active HAF identity is never a tester",
  );
  assert.deepEqual(actors.view(payload, "100000000000000005", HAF), payload);
  assert.deepEqual(actors.view(payload, GUILD, HAF), {
    user: { id: TESTER, bot: false },
    member: { user: { id: TESTER, bot: false }, roles: ["ordinary-role"], permissions: "1024" },
  });
  assert.equal(payload.member.user.bot, true);
});

test("E2E startup refuses incomplete scope, production mode, own-bot actors and unsafe database names", () => {
  for (const overrides of [
    { STAGING_MODE: undefined },
    { STAGING_MODE: "false" },
    { STAGING_MODE: "1" },
    { HAF_E2E_GUILD_ID: undefined },
    { HAF_E2E_GUILD_ID: "*" },
    { HAF_E2E_GUILD_ID: "18446744073709551616" },
    { HAF_E2E_BOT_USER_IDS: undefined },
    { HAF_E2E_BOT_USER_IDS: "" },
    { HAF_E2E_BOT_USER_IDS: `${TESTER},` },
    { HAF_E2E_BOT_USER_IDS: HAF },
    { HAF_E2E_BOT_USER_IDS: Array(11).fill(TESTER).join(",") },
    { DATABASE_URL: undefined },
    { DATABASE_URL: "postgresql://haf:private-value@localhost/haf" },
    { DATABASE_URL: "https://localhost/haf_e2e_test" },
    { DATABASE_URL: `${environment.DATABASE_URL}?database=production` },
    { DATABASE_URL: `${environment.DATABASE_URL}?options=-csearch_path=production` },
    { DATABASE_URL: "private-value" },
  ]) {
    assert.throws(
      () => readDiscordE2eActors({ ...environment, ...overrides }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("private-value"));
        return true;
      },
    );
  }
});

test("the production entrypoint refuses E2E configuration even in staging", () => {
  rejectDiscordE2eEnvironment({ STAGING_MODE: "true" });
  for (const overrides of [
    { HAF_E2E_GUILD_ID: GUILD },
    { HAF_E2E_BOT_USER_IDS: TESTER },
    { HAF_E2E_GUILD_ID: "" },
  ]) {
    assert.throws(
      () => rejectDiscordE2eEnvironment({ STAGING_MODE: "true", ...overrides }),
      /separate Discord E2E entrypoint/,
    );
  }
});
