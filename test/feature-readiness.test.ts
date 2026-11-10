/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFeatureTroubleshootingHref,
  shouldHideFeatureReadiness,
  summarizeFeatureReadiness,
} from "../src/admin/components/feature-readiness";

test("feature readiness summarizes passing, warning, error, and unavailable states", () => {
  assert.equal(
    summarizeFeatureReadiness({
      kind: "ready",
      checks: [{ id: "manage-roles", label: "Manage Roles", status: "ok", detail: "Ready" }],
    }).label,
    "Setup check: Passed",
  );
  const warning = summarizeFeatureReadiness({
    kind: "ready",
    checks: [
      {
        id: "channel-access",
        label: "Channel access",
        status: "warning",
        detail: "Review this channel.",
      },
    ],
  });
  assert.equal(warning.label, "Setup check: Channel access");
  assert.equal(warning.problem, true);

  const error = summarizeFeatureReadiness({
    kind: "ready",
    checks: [
      {
        id: "role-permission",
        label: "Role permission",
        status: "error",
        detail: "Manage Roles is missing for the bot.",
      },
    ],
  });
  assert.equal(error.label, "Setup check: Missing Manage Roles");
  assert.equal(error.problem, true);

  const unavailable = summarizeFeatureReadiness({
    kind: "unavailable",
    message: "Discord unavailable",
  });
  assert.equal(unavailable.label, "Setup check unavailable");
  assert.equal(unavailable.problem, false);

  const unconfigured = summarizeFeatureReadiness({ kind: "ready", checks: [] });
  assert.equal(unconfigured.label, "Setup check: Not configured");
  assert.equal(unconfigured.problem, true);

  const unsaved = summarizeFeatureReadiness(
    {
      kind: "ready",
      checks: [{ id: "channel", label: "Channel", status: "ok", detail: "Ready" }],
    },
    true,
  );
  assert.equal(unsaved.label, "Setup check: Unsaved changes");
  assert.match(unsaved.detail, /saved configuration/i);
});

test("feature readiness links to the selected Guild and feature section", () => {
  const href = buildFeatureTroubleshootingHref("tickets", "workspace-1", "guild-1");
  assert.match(href, /\/admin\/guild-1\/troubleshooting/);
  assert.match(href, /workspaceId=workspace-1/);
  assert.match(href, /#feature-tickets$/);
});

test("feature readiness hides only a fully passing saved setup check", () => {
  const passing = {
    kind: "ready" as const,
    checks: [{ id: "channel", label: "Channel", status: "ok" as const, detail: "Ready" }],
  };

  assert.equal(shouldHideFeatureReadiness(passing), true);
  assert.equal(shouldHideFeatureReadiness(passing, true), false);
  assert.equal(
    shouldHideFeatureReadiness({
      kind: "ready",
      checks: [{ id: "channel", label: "Channel", status: "warning", detail: "Review channel" }],
    }),
    false,
  );
  assert.equal(shouldHideFeatureReadiness({ kind: "ready", checks: [] }), false);
  assert.equal(shouldHideFeatureReadiness({ kind: "loading" }), false);
  assert.equal(
    shouldHideFeatureReadiness({ kind: "unavailable", message: "Discord unavailable" }),
    false,
  );
});
