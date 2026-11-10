/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";

import {
  buildAssignmentAnnouncement,
  formatAssignmentCapacity,
  requiresExplicitMoveSource,
} from "../src/admin/components/admin-billing-page";
import {
  buildBillingUpgradeHref,
  getLockedFeatureDescription,
} from "../src/admin/components/admin-overview-page";
import {
  buildTroubleshootingFeatureHref,
  diagnosticPriority,
  getDiagnosticStatus,
} from "../src/admin/components/admin-troubleshooting-page";

test("Billing assignment copy names the source and target and exposes capacity", () => {
  assert.equal(
    buildAssignmentAnnouncement("move", "Target Guild", "Source Guild"),
    "Paid access moved from Source Guild to Target Guild.",
  );
  assert.equal(
    buildAssignmentAnnouncement("unassign", "Guild A"),
    "Paid access removed from Guild A.",
  );
  assert.equal(formatAssignmentCapacity(1, 1), "1 of 1 slots in use · No slots available");
  assert.equal(formatAssignmentCapacity(1, 3), "1 of 3 slots in use · Slots available");
  assert.equal(requiresExplicitMoveSource(1), false);
  assert.equal(requiresExplicitMoveSource(2), true);
});

test("Troubleshooting status ordering and feature links preserve route state", () => {
  assert.equal(getDiagnosticStatus([]), "unconfigured");
  assert.equal(getDiagnosticStatus([{ status: "ok" }]), "healthy");
  assert.equal(getDiagnosticStatus([{ status: "warning" }]), "warning");
  assert.equal(getDiagnosticStatus([{ status: "error" }, { status: "warning" }]), "danger");
  assert.ok(diagnosticPriority("danger") < diagnosticPriority("warning"));
  assert.ok(diagnosticPriority("warning") < diagnosticPriority("healthy"));
  assert.equal(
    buildTroubleshootingFeatureHref("tickets", "workspace-1", "guild-1"),
    "/admin/guild-1/tickets?workspaceId=workspace-1&tab=setup",
  );
  assert.equal(
    buildTroubleshootingFeatureHref("player-link", "", "guild-1"),
    "/admin/guild-1/player-link?platform=steam",
  );
});

test("Overview locked cards explain value and route to Billing with return context", () => {
  const card = {
    id: "events",
    label: "Events",
    path: "/admin/events",
    status: "requires-paid-plan" as const,
    detail: null,
    locked: true,
  };
  assert.match(getLockedFeatureDescription(card), /Publish community events/);
  assert.equal(
    buildBillingUpgradeHref(card, "/admin/billing?workspaceId=workspace-1&guildId=guild_guild-1"),
    "/admin/billing?feature=events&plan=premium&workspaceId=workspace-1&guildId=guild_guild-1",
  );
});
