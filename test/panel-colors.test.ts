/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { buildLfgNoticeMessage } from "../src/lfg";
import { buildPlatformLinkMessage } from "../src/runtime/platform-link-buttons";

test("Platform Link panel uses its persisted embed colour", () => {
  const message = buildPlatformLinkMessage("xbox", {
    panelTitle: "Link Xbox",
    panelDescription: "Sign in to link your Xbox account.",
    panelButtonLabel: "Link Xbox",
    panelButtonStyle: "Primary",
    panelColor: 0x123456,
  });

  assert.equal(message.embeds?.[0]?.color, 0x123456);
});

test("LFG Noticeboard uses its persisted embed colour", () => {
  const message = buildLfgNoticeMessage({
    notificationRoleId: null,
    noticeColor: 0x654321,
  });

  assert.equal(message.embeds[0]?.color, 0x654321);
});
