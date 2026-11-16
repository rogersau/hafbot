/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  TicketSetupWizard,
  formatTicketSetupWizardMinimumErrors,
  validateTicketSetupWizardMinimum,
} from "../src/admin/components/ticket-setup-wizard";
import type { GuildResources } from "../src/admin/components/ticket-panel-editor";
import type { TicketPanelConfig } from "../src/types";

const guildResources: GuildResources = {
  guildId: "guild-1",
  roles: [
    { id: "role-1", name: "Support" },
    { id: "role-2", name: "Mods" },
  ],
  categories: [{ id: "cat-1", name: "Tickets" }],
  textChannels: [
    { id: "ch-1", name: "panel-channel" },
    { id: "ch-2", name: "transcripts" },
  ],
};

function baseValue(overrides: Partial<TicketPanelConfig> = {}): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "",
    categoryChannelId: "",
    transcriptChannelId: "",
    panelEmoji: null,
    panelTitle: "Support tickets",
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [],
    ...overrides,
  };
}

function renderWizard(props: {
  value?: TicketPanelConfig;
  defaultStep?: number | string;
  moreOptionsOpen?: boolean;
  onSaveDraft?: () => void;
  onSaveAndPublish?: () => void;
}) {
  return renderToString(
    <TicketSetupWizard
      guildResources={guildResources}
      value={props.value ?? baseValue()}
      onChange={() => undefined}
      defaultStep={props.defaultStep ?? 0}
      moreOptionsOpen={props.moreOptionsOpen ?? false}
      onSaveDraft={props.onSaveDraft ?? (() => undefined)}
      onSaveAndPublish={props.onSaveAndPublish ?? (() => undefined)}
    />,
  );
}

test("TicketSetupWizard member entry step configures the public panel", () => {
  const html = renderWizard({ defaultStep: "ticket-panel" });

  assert.match(html, /Panel channel/);
  assert.match(html, /Create panel channel/);
  assert.doesNotMatch(html, /Reuse an existing/);
  assert.doesNotMatch(html, /Name for new panel channel/);
});

test("TicketSetupWizard member entry step offers understandable panel copy", () => {
  const html = renderWizard({ defaultStep: "ticket-panel" });

  assert.match(html, /Panel content/);
  assert.match(html, /Suggested panel copy/);
  assert.match(html, /Use suggested copy/);
  assert.match(html, /Need help from staff\?/);
  assert.match(html, /Panel description/);
});

test("TicketSetupWizard staff step routes each request type", () => {
  const html = renderWizard({
    defaultStep: "ticket-types",
    value: baseValue({
      ticketTypes: [
        {
          id: "ticket-type-1",
          label: "Bug report",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          allowedCreatorRoleIds: [],
          channelNamePrefix: "bug",
          questions: [],
          responseRules: [],
          defaultTicketLinkPlatform: null,
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: false,
          limitExclusion: false,
          mentionSupportRole: false,
        },
      ],
    }),
  });

  assert.match(html, /Bug report/);
  assert.match(html, /Support role/);
  assert.match(html, /Channel name prefix/);
});

test("TicketSetupWizard staff step prompts to add a ticket type when none exist", () => {
  const html = renderWizard({ defaultStep: "ticket-types" });

  assert.match(html, /Add a ticket type|Add ticket type|No ticket types/i);
});

test("TicketSetupWizard panel options are collapsed by default", () => {
  const html = renderWizard({ defaultStep: "ticket-panel", moreOptionsOpen: false });

  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /More options/);
});

test("TicketSetupWizard panel options render when expanded", () => {
  const html = renderWizard({ defaultStep: "ticket-panel", moreOptionsOpen: true });

  assert.match(html, /<details open/);
  assert.match(html, /Embed emoji/);
});

test("TicketSetupWizard private-space step explains and selects the ticket category", () => {
  const html = renderWizard({ defaultStep: "ticket-private-space" });

  assert.match(html, /Ticket category/);
  assert.match(html, /Create ticket category/);
  assert.match(html, /Members cannot see one another/);
});

test("TicketSetupWizard closure step includes the required transcript channel", () => {
  const html = renderWizard({ defaultStep: "ticket-closure" });

  assert.match(html, /Transcript channel/);
  assert.match(html, /Create transcript channel/);
});

test("validateTicketSetupWizardMinimum reports the server-required minimum fields", () => {
  assert.deepEqual(validateTicketSetupWizardMinimum(baseValue()), [
    "Select a panel channel.",
    "Select a ticket category.",
    "Select a transcript channel.",
    "Add at least one ticket type.",
  ]);

  assert.deepEqual(
    validateTicketSetupWizardMinimum(
      baseValue({
        panelChannelId: "ch-1",
        categoryChannelId: "cat-1",
        transcriptChannelId: "ch-2",
        ticketTypes: [
          {
            id: "ticket-type-1",
            label: "",
            emoji: null,
            buttonStyle: "primary",
            supportRoleId: "",
            allowedCreatorRoleIds: [],
            channelNamePrefix: "",
            questions: [],
            responseRules: [],
            defaultTicketLinkPlatform: null,
            anonymousSupportEnabled: false,
            staffDiscussionThreadEnabled: false,
            limitExclusion: false,
            mentionSupportRole: false,
          },
        ],
      }),
    ),
    [
      "Enter a label for ticket type 1.",
      "Select a support role for ticket type 1.",
      "Enter a channel name prefix for ticket type 1.",
    ],
  );
});

test("formatTicketSetupWizardMinimumErrors lists missing fields instead of Invalid body", () => {
  assert.equal(
    formatTicketSetupWizardMinimumErrors(["Select a panel channel.", "Select a ticket category."]),
    "Complete the required ticket panel fields before saving: Select a panel channel. Select a ticket category.",
  );

  assert.equal(formatTicketSetupWizardMinimumErrors([]), null);
});

test("TicketSetupWizard disables final actions until the minimum config is complete", () => {
  const invalidHtml = renderWizard({ defaultStep: "ticket-review" });

  assert.match(invalidHtml, /Complete the required setup fields before saving/);
  assert.match(invalidHtml, /disabled=""/);

  const validHtml = renderWizard({
    defaultStep: "ticket-review",
    value: baseValue({
      panelChannelId: "ch-1",
      categoryChannelId: "cat-1",
      transcriptChannelId: "ch-2",
      ticketTypes: [
        {
          id: "ticket-type-1",
          label: "Bug report",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          allowedCreatorRoleIds: [],
          channelNamePrefix: "bug",
          questions: [],
          responseRules: [],
          defaultTicketLinkPlatform: null,
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: false,
          limitExclusion: false,
          mentionSupportRole: false,
        },
      ],
    }),
  });

  assert.doesNotMatch(validHtml, /Complete the required setup fields before saving/);
});

test("TicketSetupWizard final step previews, publishes, and explains the first-success test", () => {
  const html = renderWizard({
    defaultStep: "ticket-review",
    value: baseValue({ panelTitle: "My Support Panel" }),
  });

  assert.match(html, /Panel preview/);
  assert.match(html, /Save draft/);
  assert.match(html, /Save and publish/);
  assert.match(html, /Load message preview/);
  assert.doesNotMatch(html, /discord-embed/);
  assert.match(html, /After publishing, test the flow/);
  assert.match(html, /close the ticket and confirm its transcript/i);
});
