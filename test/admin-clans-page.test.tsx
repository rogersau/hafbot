/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildClanReviewDialogView,
  ClanLimitFields,
  parseOptionalClanLimit,
  validateReviewReason,
} from "../src/admin/components/admin-clans-page";
import type { ClanRequest } from "../src/clans";
import { defaultClanManagementConfig } from "../src/clans";

test("Clan limit fields expose every Guild ceiling and preserve configured values", () => {
  const html = renderToStaticMarkup(
    <ClanLimitFields
      config={{
        ...defaultClanManagementConfig("guild-1"),
        localClansMax: 3,
        localMembersMax: 12,
        localOfficersMax: 2,
      }}
      onChange={() => {}}
    />,
  );

  assert.match(html, /Local maximum active Clans/);
  assert.match(html, /Local maximum members per Clan/);
  assert.match(html, /Local maximum officers per Clan/);
  assert.match(html, /id="clan-local-clans-max"[^>]+value="3"/);
  assert.match(html, /id="clan-local-members-max"[^>]+value="12"/);
  assert.match(html, /id="clan-local-officers-max"[^>]+value="2"/);
});

test("Clan limit parsing uses null for the plan maximum and respects field minimums", () => {
  assert.equal(parseOptionalClanLimit("", 1), null);
  assert.equal(parseOptionalClanLimit("  ", 1), null);
  assert.equal(parseOptionalClanLimit("18", 1), 18);
  assert.equal(parseOptionalClanLimit("0", 1), 1);
  assert.equal(parseOptionalClanLimit("0", 0), 0);
  assert.equal(parseOptionalClanLimit("invalid", 1), null);
});

test("Clan review reasons are required only for non-approval decisions and respect the service limit", () => {
  assert.equal(validateReviewReason("approve", ""), null);
  assert.match(validateReviewReason("request-changes", "") ?? "", /Describe the changes/);
  assert.match(validateReviewReason("reject", "") ?? "", /Provide a reason/);
  assert.equal(validateReviewReason("reject", "a valid reason"), null);
  assert.match(validateReviewReason("reject", "x".repeat(1001)) ?? "", /1,000/);
});

test("Clan review dialog exposes decision context, raw ID copy, ticket health, and revision", () => {
  const request: ClanRequest = {
    id: "request-1",
    guildId: "guild-1",
    requesterId: "123456789",
    name: "Raiders",
    normalizedName: "raiders",
    tag: "RAID",
    normalizedTag: "raid",
    description: "Weekend raids",
    focus: "Progression",
    recruitmentState: "applications-open",
    proposedOfficerIds: ["987654321"],
    status: "changes-requested",
    revision: 4,
    reviewerId: "reviewer-1",
    reviewReason: "Add a clearer recruitment focus",
    clanId: null,
    createdAtMs: Date.now() - 86_400_000,
    updatedAtMs: Date.now(),
    terminalAtMs: null,
    retentionExpiresAtMs: null,
    reviewTicketState: "decision-pending",
    reviewTicketError: "Could not update review thread",
  };
  assert.deepEqual(buildClanReviewDialogView(request), {
    title: "Review Clan request",
    requesterLabel: "Requester ID",
    requesterId: "123456789",
    description: "Weekend raids",
    focus: "Progression",
    reviewReason: "Add a clearer recruitment focus",
    reviewTicketState: "decision-pending",
    reviewTicketError: "Could not update review thread",
    revision: 4,
  });
});
