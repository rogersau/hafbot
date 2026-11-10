/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  DEFAULT_IDENTITY_PATTERNS,
  formatSubjectsForEmbed,
  parseUserInput,
  scanSourceText,
} from "../src/evidence-vault-subjects";

test("scanSourceText extracts distinct subjects from text and links", () => {
  const subjects = scanSourceText(
    "Evidence about <@123456789012345678> and Steam 76561198000000000",
    [
      "https://steamcommunity.com/profiles/76561198000000000",
      "https://cftools.cloud/profile/abcdef",
    ],
    DEFAULT_IDENTITY_PATTERNS,
  );

  assert.deepEqual(subjects, [
    { platform: "steam", id: "76561198000000000" },
    { platform: "discord", id: "123456789012345678" },
    { platform: "cftools", id: "abcdef" },
  ]);
});

test("parseUserInput uses pattern order so Steam wins over Discord snowflake", () => {
  assert.deepEqual(parseUserInput("76561198000000000", DEFAULT_IDENTITY_PATTERNS), {
    platform: "steam",
    id: "76561198000000000",
  });
  assert.equal(parseUserInput("not an identity", DEFAULT_IDENTITY_PATTERNS), null);
});

test("formatSubjectsForEmbed renders Discord subjects as mentions", () => {
  assert.equal(
    formatSubjectsForEmbed([
      { platform: "discord", id: "123456789012345678" },
      { platform: "steam", id: "76561198000000000" },
    ]),
    "<@123456789012345678>, steam:76561198000000000",
  );
  assert.equal(formatSubjectsForEmbed([]), "none");
});

test("default identity patterns extract PlayStation Online IDs", () => {
  assert.deepEqual(
    parseUserInput("https://psnprofiles.com/Player_One", DEFAULT_IDENTITY_PATTERNS),
    {
      platform: "playstation",
      id: "Player_One",
    },
  );
  assert.deepEqual(parseUserInput("Player-Two", DEFAULT_IDENTITY_PATTERNS), {
    platform: "playstation",
    id: "Player-Two",
  });
  assert.deepEqual(parseUserInput("PlayerOne", DEFAULT_IDENTITY_PATTERNS), {
    platform: "playstation",
    id: "PlayerOne",
  });
});

test("default PlayStation identity pattern does not match numeric platform IDs", () => {
  assert.deepEqual(parseUserInput("123456789012345678", DEFAULT_IDENTITY_PATTERNS), {
    platform: "discord",
    id: "123456789012345678",
  });
  assert.deepEqual(parseUserInput("76561198000000000", DEFAULT_IDENTITY_PATTERNS), {
    platform: "steam",
    id: "76561198000000000",
  });
});

test("formatSubjectsForEmbed renders PlayStation subjects consistently", () => {
  assert.equal(
    formatSubjectsForEmbed([{ platform: "playstation", id: "Player_One" }]),
    "playstation:Player_One",
  );
});
