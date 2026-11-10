/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { AdminTabs } from "../src/admin/components/admin-tabs";
import { areAdminActionSnapshotsEqual } from "../src/admin/components/admin-bottom-action-bar";
import { AdminPageHeader } from "../src/admin/components/admin-page-header";

import { Button } from "../src/admin/components/ui/button";

test("AdminTabs renders prototype-style selected indicator", () => {
  const html = renderToString(
    <AdminTabs
      tabs={[
        { id: "panel", label: "Panel" },
        { id: "rules", label: "Rules" },
      ]}
      activeTab="rules"
      ariaLabel="Example tabs"
      onTabChange={() => undefined}
    />,
  );

  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"[^>]*>Rules/);
});

import { Dialog, DialogTrigger } from "../src/admin/components/ui/dialog";

import { hasUnsavedChanges } from "../src/admin/hooks/use-unsaved-changes";

test("admin dialog trigger renders accessible button", () => {
  const html = renderToString(
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
    </Dialog>,
  );

  assert.match(html, /Open dialog/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test("AdminPageHeader renders server administration heading with actions", () => {
  const html = renderToString(
    <AdminPageHeader
      title="Reaction Rules"
      description="Manage reaction configuration."
      actions={<Button>Save changes</Button>}
    />,
  );

  assert.match(html, /Server administration/);
  assert.match(html, /<h1>Reaction Rules<\/h1>/);
  assert.match(html, /Manage reaction configuration\./);
  assert.match(html, />Save changes</);
});

test("AdminPageHeader renders the page heading without actions", () => {
  const html = renderToString(<AdminPageHeader title="Reaction Rules" />);

  assert.match(html, /<h1>Reaction Rules<\/h1>/);
});

test("hasUnsavedChanges compares admin action snapshots", () => {
  assert.equal(hasUnsavedChanges({ enabled: true }, { enabled: true }), false);
  assert.equal(hasUnsavedChanges({ enabled: false }, { enabled: true }), true);
});

test("admin action snapshot comparison ignores object key insertion order", () => {
  assert.equal(
    areAdminActionSnapshotsEqual(
      { enabled: true, config: { channels: ["1", "2"], threshold: 0.8 } },
      { config: { threshold: 0.8, channels: ["1", "2"] }, enabled: true },
    ),
    true,
  );
});

import {
  DurationInput,
  durationInputToMs,
  msToDurationInput,
} from "../src/admin/components/ui/duration-input";
import { PresetNumberInput } from "../src/admin/components/ui/preset-number-input";
import {
  normalizeImageRulesConfigSnapshot,
  validateImageRulesThresholds,
} from "../src/admin/components/admin-image-rules-page";
import {
  reconcileReactionRulesSnapshot,
  validateReactionLimitFields,
  type ReactionRulesSavedSnapshot,
} from "../src/admin/components/admin-blocklist-page";
import { validateTicketCreationLimit } from "../src/admin/components/admin-tickets-page";

test("DurationInput renders human units and converts milliseconds", () => {
  assert.deepEqual(msToDurationInput("3600000"), { amount: "1", unit: "hours" });
  assert.equal(durationInputToMs("2", "days"), "172800000");
  assert.equal(durationInputToMs("", "permanent"), "");

  const html = renderToString(
    <DurationInput id="duration" value="86400000" onChange={() => undefined} />,
  );

  assert.match(html, /Minutes/);
  assert.match(html, /Hours/);
  assert.match(html, /Days/);
  assert.match(html, /Permanent/);
  assert.match(html, /value="1"/);
});

test("PresetNumberInput renders preset buttons and custom input", () => {
  const html = renderToString(
    <PresetNumberInput
      id="limit"
      value="5"
      presets={[
        { label: "5", value: "5" },
        { label: "10", value: "10" },
        { label: "No limit", value: "" },
      ]}
      onChange={() => undefined}
      placeholder="No limit"
    />,
  );

  assert.match(html, />5</);
  assert.match(html, />10</);
  assert.match(html, />No limit</);
  assert.match(html, /placeholder="No limit"/);
});

test("admin inline validators report configured boundaries", () => {
  assert.deepEqual(
    validateImageRulesThresholds({
      enabled: true,
      targetChannelIds: [],
      autoDeleteThreshold: 0.7,
      modReviewThreshold: 0.8,
    }),
    {
      targetChannelIds: "Select at least one target channel when Image Rules is enabled.",
      thresholds: "Mod review threshold must be lower than the auto-delete threshold.",
    },
  );

  assert.equal(
    validateReactionLimitFields({
      maxReactionsPerMessage: "1.5",
      maxReactionsPerUserPerMessage: "",
      breachThreshold: "-1",
      breachRoleDurationMs: "60000",
    }).maxReactionsPerMessage,
    "Max reactions per message must be a positive whole number.",
  );
  assert.equal(validateTicketCreationLimit(51), "Ticket creation limit cannot be higher than 50.");
  assert.equal(validateTicketCreationLimit(null), null);
});

test("Reaction Rules partial saves reconcile only the completed section", () => {
  const saved: ReactionRulesSavedSnapshot = {
    blocklistChannelFilter: { channelMode: "include", channelIds: [] },
    notificationChannelId: "old-log",
    limitForm: {
      limitsEnabled: false,
      maxReactionsPerMessage: "",
      maxReactionsPerUserPerMessage: "",
      breachThreshold: "",
      breachRoleId: "",
      breachRoleDurationMs: "",
      breachDmText: "",
    },
    limitChannelFilter: { channelMode: "include", channelIds: [] },
  };
  const submitted = {
    blocklistChannelFilter: { channelMode: "exclude" as const, channelIds: ["channel-1"] },
    notificationChannelId: "new-log",
    limitForm: {
      ...saved.limitForm,
      limitsEnabled: true,
      maxReactionsPerMessage: "5",
    },
    limitChannelFilter: { channelMode: "include" as const, channelIds: ["channel-2"] },
  };

  const reconciled = reconcileReactionRulesSnapshot(saved, "blocklistChannelFilter", submitted);

  assert.deepEqual(reconciled.blocklistChannelFilter, submitted.blocklistChannelFilter);
  assert.equal(reconciled.notificationChannelId, saved.notificationChannelId);
  assert.deepEqual(reconciled.limitForm, saved.limitForm);
  assert.deepEqual(reconciled.limitChannelFilter, saved.limitChannelFilter);
});

test("Reaction Rules limit save reconciliation updates both limit portions", () => {
  const saved: ReactionRulesSavedSnapshot = {
    blocklistChannelFilter: { channelMode: "include", channelIds: [] },
    notificationChannelId: "",
    limitForm: {
      limitsEnabled: false,
      maxReactionsPerMessage: "",
      maxReactionsPerUserPerMessage: "",
      breachThreshold: "",
      breachRoleId: "",
      breachRoleDurationMs: "",
      breachDmText: "",
    },
    limitChannelFilter: { channelMode: "include", channelIds: [] },
  };
  const submitted = {
    ...saved,
    limitForm: { ...saved.limitForm, limitsEnabled: true },
    limitChannelFilter: { channelMode: "exclude" as const, channelIds: ["channel-3"] },
  };

  const reconciled = reconcileReactionRulesSnapshot(saved, "reactionLimits", submitted);

  assert.deepEqual(reconciled.limitForm, submitted.limitForm);
  assert.deepEqual(reconciled.limitChannelFilter, submitted.limitChannelFilter);
  assert.notStrictEqual(
    reconciled.limitChannelFilter.channelIds,
    submitted.limitChannelFilter.channelIds,
  );
});

test("Image Rules saved snapshots ignore server-only fields", () => {
  const saved = normalizeImageRulesConfigSnapshot({
    guildId: "guild-1",
    enabled: true,
    topicDescription: "DayZ screenshots",
    autoDeleteThreshold: 0.85,
    modReviewThreshold: 0.65,
    targetChannelIds: ["channel-1"],
    excludedRoleIds: [],
    modQueueChannelId: null,
    modRoleIds: [],
    pingOnQueuePost: true,
    reactOnTopic: false,
    auditOnTopic: false,
    dryRun: false,
    createdAtMs: 100,
    updatedAtMs: 200,
  });

  assert.equal(
    areAdminActionSnapshotsEqual(saved, {
      enabled: true,
      topicDescription: "DayZ screenshots",
      autoDeleteThreshold: 0.85,
      modReviewThreshold: 0.65,
      targetChannelIds: ["channel-1"],
      excludedRoleIds: [],
      modQueueChannelId: "",
      modRoleIds: [],
      pingOnQueuePost: true,
      reactOnTopic: false,
      auditOnTopic: false,
      dryRun: false,
    }),
    true,
  );
});

import { AdvancedSection } from "../src/admin/components/admin-form-layout";

test("AdvancedSection renders an open disclosure with title, description, and children", () => {
  const html = renderToString(
    <AdvancedSection
      title="Advanced Image Rules behaviour"
      description="Optional tuning."
      defaultOpen
    >
      <p>Dry run mode</p>
    </AdvancedSection>,
  );

  assert.match(html, /<details open/);
  assert.match(html, /Advanced Image Rules behaviour/);
  assert.match(html, /Optional tuning\./);
  assert.match(html, /Dry run mode/);
});

test("AdvancedSection renders collapsed by default and still includes children in the DOM", () => {
  const html = renderToString(
    <AdvancedSection title="Advanced" defaultOpen={false}>
      <p>Hidden until expanded</p>
    </AdvancedSection>,
  );

  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /<details/);
  assert.match(html, />Advanced</);
  assert.match(html, /Hidden until expanded/);
});

import { InfoTooltip } from "../src/admin/components/ui/info-tooltip";

test("InfoTooltip renders an accessible trigger button with content as its aria-label", () => {
  const html = renderToString(
    <InfoTooltip content="Classifies images without deleting anything." />,
  );

  assert.match(html, /type="button"/);
  assert.match(
    html,
    /aria-label="Classifies images without deleting anything\."|aria-label='Classifies images without deleting anything\.'/,
  );
});

test("InfoTooltip trigger carries the info icon", () => {
  const html = renderToString(<InfoTooltip content="Help text" />);

  assert.match(html, /<svg/);
  assert.match(html, /aria-hidden="true"/);
});
