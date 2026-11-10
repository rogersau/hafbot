/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  AdminEvidenceVaultPage,
  buildRemovedEvidenceFieldEnumValueWarnings,
  validateEvidenceFields,
} from "../src/admin/components/admin-evidence-vault-page";
import type { EvidenceVaultLoaderData } from "../src/admin/lib/admin-route-loaders";
import type { EntitlementInfo } from "../src/admin/hooks/use-entitlement";

function buildInitialData(
  overrides: Partial<EvidenceVaultLoaderData["config"]> = {},
): EvidenceVaultLoaderData {
  return {
    guildId: "guild-1",
    entitlement: null,
    enumValueUsage: {},
    recordUsage: { used: 0, max: null },
    config: {
      guildId: "guild-1",
      auditChannelId: "audit-channel-1",
      accessRoleIds: [],
      subjectsEnabled: false,
      updatedAtMs: 0,
      ...overrides,
    },
  };
}

function renderPage(
  initialData: EvidenceVaultLoaderData | null,
  tier: EntitlementInfo["tier"] = "premium",
) {
  const entitlement = {
    tier,
    limits: { evidenceVaultMaxRecords: tier === "free" ? 30 : null },
    supportInvite: "https://example.com/upgrade",
    r2Usage: { usedBytes: 0, maxBytes: 0 },
  } as EntitlementInfo;
  return renderToString(
    <AdminEvidenceVaultPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      entitlement={entitlement}
      initialData={initialData}
    />,
  );
}

test("AdminEvidenceVaultPage renders the subjects Switch unchecked when subjectsEnabled is false", () => {
  const html = renderPage(buildInitialData({ subjectsEnabled: false }));

  // The radix Switch exposes its state via data-state; unchecked = "unchecked".
  assert.match(html, /aria-label="Enable Evidence Vault subjects"/);
  assert.match(html, /data-state="unchecked"/);
  assert.doesNotMatch(html, /data-state="checked"/);
});

test("AdminEvidenceVaultPage renders the subjects Switch checked when subjectsEnabled is true", () => {
  const html = renderPage(buildInitialData({ subjectsEnabled: true }));

  assert.match(html, /aria-label="Enable Evidence Vault subjects"/);
  assert.match(html, /data-state="checked"/);
});

test("AdminEvidenceVaultPage shows Free record usage and a contextual limit prompt", () => {
  const data = buildInitialData();
  data.recordUsage = { used: 30, max: 30 };
  const html = renderPage(data, "free");

  assert.match(html, /30 \/ 30 Evidence Vault records used/);
  assert.match(html, /Existing evidence remains available/);
  assert.match(html, /Upgrade for no plan limit/);
  assert.match(html, /Evidence Vault configuration/);
});

test("buildRemovedEvidenceFieldEnumValueWarnings reports removed enum values with usage counts", () => {
  const warnings = buildRemovedEvidenceFieldEnumValueWarnings(
    [
      {
        key: "evidence_type",
        label: "Evidence type",
        type: "enum",
        allowedValues: ["Video", "Image", "Note"],
      },
    ],
    [
      {
        key: "evidence_type",
        label: "Evidence type",
        type: "enum",
        allowedValues: ["Video"],
      },
    ],
    { evidence_type: { Image: 2, Note: 0 } },
  );

  assert.deepEqual(warnings, [
    { fieldKey: "evidence_type", fieldLabel: "Evidence type", value: "Image", count: 2 },
    { fieldKey: "evidence_type", fieldLabel: "Evidence type", value: "Note", count: 0 },
  ]);
});

test("Evidence Fields render as ordered cards with token choices, stable keys, usage, and preview", () => {
  const data = buildInitialData({
    evidenceFields: [
      {
        key: "evidence_type",
        label: "Evidence type",
        type: "enum",
        allowedValues: ["Video", "Image"],
      },
    ],
  });
  data.enumValueUsage = { evidence_type: { Video: 3 } };

  const html = renderPage(data);

  assert.match(html, /Field(?:\s|<!-- -->)*1/);
  assert.match(html, /Allowed choices/);
  assert.match(html, /value="Video"/);
  assert.match(html, /3(?:\s|<!-- -->)*records/);
  assert.match(html, /evidence_type/);
  assert.match(html, /Copy key/);
  assert.match(html, /Move Evidence type up/);
  assert.match(html, /Staff preview/);
});

test("validateEvidenceFields rejects blank and duplicate structured values", () => {
  assert.equal(
    validateEvidenceFields([{ key: "one", label: "", type: "short_text" }]),
    "Every Evidence Field needs a label.",
  );
  assert.equal(
    validateEvidenceFields([
      { key: "one", label: "Source", type: "short_text" },
      { key: "two", label: " source ", type: "text" },
    ]),
    'Evidence Field labels must be unique: "source".',
  );
  assert.equal(
    validateEvidenceFields([
      {
        key: "one",
        label: "Type",
        type: "enum",
        allowedValues: ["Video", " video "],
      },
    ]),
    'Type contains a duplicate choice: "video".',
  );
  assert.equal(
    validateEvidenceFields([
      { key: "one", label: "Type", type: "enum", allowedValues: ["Video", "Image"] },
    ]),
    null,
  );
});
