/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { parseAppIdListWithErrors } from "../src/services/steam-ban-app-id-parser";
import {
  validateWebhookConfigDraft,
  validateWebhookConfigDraftDetails,
} from "../src/admin/components/admin-webhooks-page";

type WebhookDraft = Parameters<typeof validateWebhookConfigDraft>[0];

function createWebhookDraft(overrides: Partial<WebhookDraft> = {}): WebhookDraft {
  return {
    guildId: "guild-1",
    publicId: "",
    name: "Proxy",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredential: { action: "clear" },
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credential: { action: "replace", url: "https://discord.com/api/webhooks/123456/main" },
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [],
    ...overrides,
  };
}

test("parseAppIdListWithErrors returns valid App IDs and collects invalid entries", () => {
  assert.deepEqual(parseAppIdListWithErrors("221100, 730, -1, 0, abc"), {
    appIds: [221100, 730],
    invalid: ["-1", "0", "abc"],
  });
});

test("parseAppIdListWithErrors returns empty arrays for empty input", () => {
  assert.deepEqual(parseAppIdListWithErrors(""), { appIds: [], invalid: [] });
});

test("parseAppIdListWithErrors ignores whitespace-only entries", () => {
  assert.deepEqual(parseAppIdListWithErrors("221100, , 730"), {
    appIds: [221100, 730],
    invalid: [],
  });
});

test("validateWebhookConfigDraft reports routing rule regex and destination errors", () => {
  const draft = createWebhookDraft({
    routingRules: [
      {
        id: "errors",
        label: "Errors",
        pattern: "(",
        flags: "i",
        destinationIds: [],
      },
    ],
  });

  assert.equal(
    validateWebhookConfigDraft(draft),
    "Routing rule 1: Enter a valid regular expression.",
  );
});

test("validateWebhookConfigDraftDetails reports missing routing destinations inline", () => {
  const validation = validateWebhookConfigDraftDetails(
    createWebhookDraft({
      routingRules: [
        {
          id: "errors",
          label: "Errors",
          pattern: "error|failed",
          flags: "i",
          destinationIds: [],
        },
      ],
    }),
  );

  assert.equal(
    validation.routingRules[0]?.destinationIds,
    "Select at least one destination for this rule.",
  );
});

test("validateWebhookConfigDraftDetails returns row-level content replacement errors", () => {
  const validation = validateWebhookConfigDraftDetails(
    createWebhookDraft({
      contentReplacements: [
        {
          id: "",
          label: "",
          pattern: "(",
          flags: "g",
          replacement: "",
        },
      ],
    }),
  );

  assert.equal(validation.contentReplacements[0]?.id, "Enter a replacement ID.");
  assert.equal(validation.contentReplacements[0]?.label, "Enter a replacement label.");
  assert.equal(validation.contentReplacements[0]?.pattern, "Enter a valid regular expression.");
  assert.equal(validation.contentReplacements[0]?.replacement, "Enter replacement text.");
});
