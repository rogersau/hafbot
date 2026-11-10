/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  getInteractionCustomId,
  getInteractionUserDisplayName,
  getInteractionUserId,
} from "../src/runtime/discord-interaction-parsers";
import type { DiscordInteraction } from "../src/runtime/app-types";

test("shared interaction parsers preserve custom id and user fallback behavior", () => {
  const interaction = {
    type: 3,
    data: { custom_id: "ticket:open:support" },
    member: {
      nick: "MemberNick",
      user: { id: "member-user", username: "MemberName", global_name: "Member Global" },
    },
    user: { id: "fallback-user", username: "FallbackName", global_name: "Fallback Global" },
  } satisfies DiscordInteraction;

  assert.equal(getInteractionCustomId(interaction), "ticket:open:support");
  assert.equal(getInteractionUserId(interaction), "member-user");
  assert.equal(getInteractionUserDisplayName(interaction), "MemberNick");
});

test("shared interaction parsers reject malformed optional string fields", () => {
  const interaction = {
    type: 3,
    data: { custom_id: 42 },
    member: { user: { global_name: null } },
    user: {},
  } as DiscordInteraction;

  assert.equal(getInteractionCustomId(interaction), null);
  assert.equal(getInteractionUserId(interaction), null);
  assert.equal(getInteractionUserDisplayName(interaction), null);
});
