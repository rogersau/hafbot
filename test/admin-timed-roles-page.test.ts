/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  humanizeTimedRoleDuration,
  relativeExpiry,
  validateDurationInput,
  validateTimedRoleRulesDetailed,
} from "../src/admin/components/admin-timed-roles-page";
import {
  discordUserIdError,
  normalizeDiscordUserId,
  parseDiscordUserId,
} from "../src/admin/lib/discord-user-id";

type TimedRoleRules = Parameters<typeof validateTimedRoleRulesDetailed>[0];

test("validateTimedRoleRulesDetailed reports row-level missing fields and duplicates", () => {
  const rules: TimedRoleRules = [
    { roleId: "", durationInput: "", dmMessage: null },
    { roleId: "role-1", durationInput: "1h", dmMessage: null },
    { roleId: "role-1", durationInput: "2h", dmMessage: null },
  ];

  const validation = validateTimedRoleRulesDetailed(rules);

  assert.equal(
    validation.firstError,
    "Timed-role row 1: Select the role for this timed role rule.",
  );
  assert.equal(validation.rows[0]?.roleId, "Select the role for timed-role row 1.");
  assert.equal(
    validation.rows[0]?.durationInput,
    "Enter how long the role should stay on the member.",
  );
  assert.equal(validation.rows[2]?.roleId, "Duplicate timed-role role selected: role-1.");
});

test("validateTimedRoleRulesDetailed reports invalid DM placeholders inline", () => {
  const validation = validateTimedRoleRulesDetailed([
    {
      roleId: "role-1",
      durationInput: "1h",
      dmMessage: "Hi {unknown}",
    },
  ]);

  assert.equal(
    validation.firstError,
    "Timed-role row 1: Timed-role DM row 1 has an unknown placeholder.",
  );
  assert.equal(validation.rows[0]?.dmMessage, "Timed-role DM row 1 has an unknown placeholder.");
});

test("validateTimedRoleRulesDetailed rejects suspending the timed role itself", () => {
  const validation = validateTimedRoleRulesDetailed([
    {
      roleId: "timed-role",
      durationInput: "1h",
      suspendedRoleIds: ["access-role", "timed-role"],
    },
  ]);

  assert.equal(
    validation.firstError,
    "Timed-role row 1: The assigned timed role cannot also be suspended.",
  );
  assert.equal(
    validation.rows[0]?.suspendedRoleIds,
    "The assigned timed role cannot also be suspended.",
  );
});

test("Timed Role duration builders validate, humanize, and preview supported units", () => {
  assert.equal(validateDurationInput("30min"), null);
  assert.equal(validateDurationInput("24h"), null);
  assert.match(validateDurationInput("0h") ?? "", /greater than zero/);
  assert.match(validateDurationInput("1.5h") ?? "", /positive whole number/);
  assert.equal(humanizeTimedRoleDuration("30min"), "30 minutes");
  assert.match(relativeExpiry(Date.now() + 7 * 24 * 60 * 60 * 1000), /expires in 7 days/);
});

test("Discord member IDs accept bare IDs and both mention forms", () => {
  assert.equal(normalizeDiscordUserId(" 123456789012345678 "), "123456789012345678");
  assert.equal(normalizeDiscordUserId("<@123456789012345678>"), "123456789012345678");
  assert.equal(normalizeDiscordUserId("<@!123456789012345678>"), "123456789012345678");
  assert.equal(parseDiscordUserId("<@123456789012345678>").ok, true);
  assert.match(discordUserIdError("hello <@123456789012345678>") ?? "", /17–20 digit/);
  assert.match(discordUserIdError("123") ?? "", /17–20 digit/);
});
