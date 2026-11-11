/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  buildTicketClaimCustomId,
  buildTicketTranscriptAttachmentPath,
  buildTicketTranscriptAttachmentStorageKey,
  buildTicketTranscriptPath,
  buildTicketChannelName,
  buildTicketCloseConfirmCustomId,
  buildTicketCloseCustomId,
  buildTicketCloseDeclineCustomId,
  buildTicketModalResponse,
  buildTicketOpenCustomId,
  buildTicketTranscriptStorageKey,
  buildTicketTranscriptSummaryEmbed,
  extractSteamId64FromTicketAnswer,
  extractTicketAnswersFromModal,
  formatTicketNumber,
  generateTicketTranscriptAccessToken,
  parseTicketCustomId,
  parseTicketPanelStorage,
  renderTicketAutoReply,
  renderTicketTranscriptHtml,
  renderTicketTranscript,
  serializeTicketPanelStorage,
  selectMatchingResponseRules,
} from "../src/tickets";
import { ticketPanelConfigSchema } from "../src/contracts/admin/tickets";
import type { TicketInstance } from "../src/types";

test("buildTicketModalResponse uses modal questions and Discord text input rows", () => {
  const response = buildTicketModalResponse({
    id: "appeals",
    label: "Appeal",
    emoji: "🧾",
    buttonStyle: "primary",
    supportRoleId: "role-1",
    channelNamePrefix: "appeal",
    anonymousSupportEnabled: false,
    staffDiscussionThreadEnabled: false,
    limitExclusion: false,
    questions: [
      {
        id: "reason",
        label: "Why are you opening this ticket?",
        style: "paragraph",
        placeholder: "Explain the issue",
        required: true,
      },
    ],
    responseRules: [],
  });

  assert.equal(response.type, 9);
  assert.equal(response.data.custom_id, buildTicketOpenCustomId("appeals"));
  assert.equal(response.data.title, "Appeal");
  assert.equal(response.data.components[0].components[0].custom_id, "reason");
  assert.equal(response.data.components[0].components[0].label, "Why are you opening this ticket?");
  assert.equal(response.data.components[0].components[0].placeholder, "Explain the issue");
  assert.equal(response.data.components[0].components[0].required, true);
});

test("buildTicketModalResponse preserves configured modal question order", () => {
  const response = buildTicketModalResponse({
    id: "support",
    label: "Support",
    emoji: null,
    buttonStyle: "primary",
    supportRoleId: "role-1",
    channelNamePrefix: "support",
    limitExclusion: false,
    questions: [
      {
        id: "first",
        label: "First question",
        style: "short",
        placeholder: null,
        required: true,
      },
      {
        id: "second",
        label: "Second question",
        style: "paragraph",
        placeholder: "Add context",
        required: false,
      },
      {
        id: "third",
        label: "Third question",
        style: "short",
        placeholder: null,
        required: true,
      },
    ],
    responseRules: [],
  });

  assert.deepEqual(
    response.data.components.map((row) => row.components[0].custom_id),
    ["first", "second", "third"],
  );
});

test("parseTicketCustomId parses open and close custom IDs", () => {
  assert.deepEqual(parseTicketCustomId(buildTicketOpenCustomId("appeals")), {
    action: "open",
    ticketTypeId: "appeals",
  });

  assert.deepEqual(parseTicketCustomId(buildTicketOpenCustomId("appeals", "panel-staff")), {
    action: "open",
    panelId: "panel-staff",
    ticketTypeId: "appeals",
  });

  assert.deepEqual(parseTicketCustomId(buildTicketCloseCustomId("channel-1")), {
    action: "close",
    channelId: "channel-1",
  });

  assert.deepEqual(parseTicketCustomId(buildTicketClaimCustomId("channel-1")), {
    action: "claim",
    channelId: "channel-1",
  });
});

test("buildTicketChannelName prefixes and zero-pads ticket numbers", () => {
  assert.equal(buildTicketChannelName("Support", 1), "support-001");
  assert.equal(buildTicketChannelName("Appeals Team", 12), "appeals-team-012");
  assert.equal(buildTicketChannelName("***", 123), "ticket-123");
  assert.equal(formatTicketNumber(1000), "1000");
});

test("parseTicketPanelStorage rejects retired array-only payloads", () => {
  assert.throws(
    () => parseTicketPanelStorage(JSON.stringify([])),
    /Invalid stored ticket panel payload/,
  );
});

test("serializeTicketPanelStorage preserves current response rules", () => {
  const serialized = serializeTicketPanelStorage({
    guildId: "guild-1",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "appeals",
        label: "Appeal",
        emoji: "🧾",
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "appeal",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
        responseRules: [],
      },
    ],
  });

  assert.deepEqual(JSON.parse(serialized).ticketTypes[0]?.responseRules, []);
});

test("parseTicketPanelStorage keeps stored responseRules and condition order", () => {
  const parsed = parseTicketPanelStorage(
    JSON.stringify({
      ticketTypes: [
        {
          id: "appeals",
          label: "Appeal",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "appeal",
          responseRules: [
            {
              id: "rule-1",
              conditions: [
                { kind: "lacks-role", roleId: "steam-linked" },
                { kind: "has-role", roleId: "verified" },
              ],
              message: "Please run /steamlink",
            },
            {
              id: "rule-2",
              conditions: [],
              message: "Welcome!",
            },
          ],
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: false,
          questions: [],
        },
      ],
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
    }),
  );

  assert.deepEqual(parsed.ticketTypes[0]?.responseRules, [
    {
      id: "rule-1",
      conditions: [
        { kind: "lacks-role", roleId: "steam-linked" },
        { kind: "has-role", roleId: "verified" },
      ],
      message: "Please run /steamlink",
    },
    {
      id: "rule-2",
      conditions: [],
      message: "Welcome!",
    },
  ]);
});

test("parseTicketPanelStorage preserves independent anonymous support and staff discussion settings", () => {
  const parsed = parseTicketPanelStorage(
    JSON.stringify({
      ticketTypes: [
        {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: true,
          ticketHistoryPromptVisibility: "staff-thread",
          questions: [],
          responseRules: [],
        },
      ],
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
    }),
  );

  assert.equal(parsed.ticketTypes[0]?.anonymousSupportEnabled, false);
  assert.equal(parsed.ticketTypes[0]?.staffDiscussionThreadEnabled, true);
  assert.equal(parsed.ticketTypes[0]?.ticketHistoryPromptVisibility, "staff-thread");
});

test("parseTicketPanelStorage defaults mentionSupportRole to false for legacy stored ticket types", () => {
  const parsed = parseTicketPanelStorage(
    JSON.stringify({
      ticketTypes: [
        {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          questions: [],
          responseRules: [],
        },
      ],
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
    }),
  );

  assert.equal(parsed.ticketTypes[0]?.mentionSupportRole, false);
});

test("parseTicketPanelStorage defaults participant management to disabled", () => {
  const parsed = parseTicketPanelStorage(
    JSON.stringify({
      ticketTypes: [
        {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          questions: [],
          responseRules: [],
        },
      ],
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
    }),
  );

  assert.equal(parsed.ticketTypes[0]?.participantManagementEnabled, false);
});

test("Ticket admin contract preserves enabled participant management", () => {
  const parsed = ticketPanelConfigSchema.parse({
    guildId: "guild-1",
    panelId: "main",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelMessageId: null,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        questions: [],
        participantManagementEnabled: true,
      },
    ],
  });

  assert.equal(parsed.ticketTypes[0]?.participantManagementEnabled, true);
});

test("Ticket admin contract accepts questions at Discord modal limits", () => {
  const parsed = ticketPanelConfigSchema.parse({
    guildId: "guild-1",
    panelId: "main",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelMessageId: null,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        questions: [
          {
            id: "q".repeat(100),
            label: "L".repeat(45),
            style: "short",
            placeholder: "P".repeat(100),
            required: true,
          },
        ],
      },
    ],
  });

  const question = parsed.ticketTypes[0]?.questions[0];
  assert.deepEqual(
    {
      id: question?.id.length,
      label: question?.label.length,
      placeholder: question?.placeholder?.length,
    },
    { id: 100, label: 45, placeholder: 100 },
  );
});

test("serializeTicketPanelStorage preserves mentionSupportRole", () => {
  const serialized = serializeTicketPanelStorage({
    guildId: "guild-1",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        mentionSupportRole: true,
        questions: [],
        responseRules: [],
      },
    ],
  });

  assert.equal(JSON.parse(serialized).ticketTypes[0]?.mentionSupportRole, true);
});

test("ticket transcript path helpers build stable public paths and storage keys", () => {
  assert.equal(
    buildTicketTranscriptStorageKey("guild-1", "channel-1", "token-1"),
    "guild-1/channel-1/token-1.html",
  );
  assert.equal(
    buildTicketTranscriptPath("guild-1", "channel-1", "token-1"),
    "/transcripts/guild-1/channel-1/token-1",
  );
  assert.equal(
    buildTicketTranscriptAttachmentStorageKey(
      "guild-1",
      "channel-1",
      "token-1",
      "attachment-1",
      "proof image.png",
    ),
    "guild-1/channel-1/token-1/attachments/attachment-1/proof%20image.png",
  );
  assert.equal(
    buildTicketTranscriptAttachmentPath(
      "guild-1",
      "channel-1",
      "token-1",
      "attachment-1",
      "proof image.png",
    ),
    "/transcripts/guild-1/channel-1/token-1/media/attachment-1/proof%20image.png",
  );
});

test("generateTicketTranscriptAccessToken preserves 128 bits in base64url", () => {
  const token = generateTicketTranscriptAccessToken();
  assert.equal(token.length, 22);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(token, "base64url").byteLength, 16);
});

test("extractTicketAnswersFromModal reads submitted modal fields", () => {
  const answers = extractTicketAnswersFromModal(
    {
      data: {
        components: [
          {
            components: [{ custom_id: "reason", value: "I need help" }],
          },
          {
            components: [{ custom_id: "details", value: "More details" }],
          },
        ],
      },
    },
    [
      {
        id: "reason",
        label: "Reason",
        style: "paragraph",
        placeholder: null,
        required: true,
      },
      {
        id: "details",
        label: "Details",
        style: "short",
        placeholder: null,
        required: false,
      },
    ],
  );

  assert.deepEqual(answers, [
    { questionId: "reason", label: "Reason", value: "I need help" },
    { questionId: "details", label: "Details", value: "More details" },
  ]);
});

test("extractSteamId64FromTicketAnswer accepts SteamID64 values and profile URLs", () => {
  assert.equal(extractSteamId64FromTicketAnswer("76561198000000000"), "76561198000000000");
  assert.equal(
    extractSteamId64FromTicketAnswer("https://steamcommunity.com/profiles/76561198000000000"),
    "76561198000000000",
  );
  assert.equal(
    extractSteamId64FromTicketAnswer(
      "Profile: https://steamcommunity.com/profiles/76561198000000000/",
    ),
    "76561198000000000",
  );
});

test("extractSteamId64FromTicketAnswer rejects invalid Steam ID values", () => {
  assert.equal(extractSteamId64FromTicketAnswer("not-a-steam-id"), null);
  assert.equal(extractSteamId64FromTicketAnswer("12345678901234567"), null);
  assert.equal(extractSteamId64FromTicketAnswer("https://steamcommunity.com/id/custom-name"), null);
});

test("renderTicketTranscript includes ticket metadata, answers, and chronological messages", () => {
  const transcript = renderTicketTranscript(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [{ questionId: "reason", label: "Reason", value: "I need help" }],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        authorId: "staff-1",
        authorTag: "Support#0002",
        content: "First reply",
        createdAtMs: 1_700_000_000_400,
      },
      {
        authorId: "user-1",
        authorTag: "User#0001",
        content: "Hello",
        createdAtMs: 1_700_000_000_500,
      },
    ],
    [
      {
        id: "participant-event-1",
        guildId: "guild-1",
        ticketChannelId: "channel-1",
        ticketTypeId: "appeals",
        action: "participant-added",
        targetUserId: "participant-1",
        actorUserId: "staff-1",
        createdAtMs: 1_700_000_000_300,
        notificationState: "delivered",
        notificationClaimedAtMs: null,
      },
    ],
  );

  assert.match(transcript, /Guild: guild-1/);
  assert.match(transcript, /Ticket Type: Appeal \(appeals\)/);
  assert.match(transcript, /Opened by: user-1/);
  assert.match(transcript, /Opened at: /);
  assert.match(transcript, /Closed at: /);
  assert.match(transcript, /Closed by: staff-1/);
  assert.match(transcript, /Reason: I need help/);
  assert.match(transcript, /Participant Access History/);
  assert.match(transcript, /participant-added: participant-1 \(staff actor: staff-1\)/);
  assert.match(transcript, /Support#0002: First reply/);
  assert.match(transcript, /User#0001: Hello/);
  assert.ok(
    transcript.indexOf("Support#0002: First reply") < transcript.indexOf("User#0001: Hello"),
  );
});

test("renderTicketTranscript omits answers block when no answers were submitted", () => {
  const instance: TicketInstance = {
    guildId: "guild-1",
    channelId: "channel-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "closed",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: 1_700_000_001_000,
    closedByUserId: "staff-1",
    transcriptMessageId: "msg-1",
    staffThreadId: null,
  };

  const transcript = renderTicketTranscript(instance, []);
  const html = renderTicketTranscriptHtml(instance, []);

  assert.doesNotMatch(transcript, /## Answers/);
  assert.doesNotMatch(transcript, /No answers provided/);
  assert.doesNotMatch(html, /<h2>Answers<\/h2>/);
  assert.doesNotMatch(html, /No answers provided/);
});

test("renderTicketTranscript includes attachment links below their messages", () => {
  const transcript = renderTicketTranscript(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        authorId: "user-1",
        authorTag: "User#0001",
        content: "Here is the proof",
        createdAtMs: 1_700_000_000_500,
        attachments: [
          {
            id: "attachment-1",
            filename: "proof.png",
            url: "https://cdn.example/proof.png",
            proxyUrl: null,
            contentType: "image/png",
            size: 1536,
            width: 640,
            height: 480,
          },
          {
            id: "attachment-2",
            filename: "clip.mp4",
            url: "https://cdn.example/clip.mp4",
            proxyUrl: null,
            contentType: "video/mp4",
            size: 1_048_576,
            width: 1280,
            height: 720,
          },
        ],
      },
    ],
  );

  assert.match(transcript, /User#0001: Here is the proof/);
  assert.ok(
    transcript.includes("  Image: proof.png (image/png, 1.5 KB) - https://cdn.example/proof.png"),
  );
  assert.ok(
    transcript.includes("  Video: clip.mp4 (video/mp4, 1 MB) - https://cdn.example/clip.mp4"),
  );
});

test("renderTicketTranscriptHtml escapes content and includes transcript metadata", () => {
  const html = renderTicketTranscriptHtml(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [{ questionId: "reason", label: "Reason", value: "Need <help> & support" }],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        authorId: "user-1",
        authorTag: "User#0001",
        content: "Hello <script>alert('x')</script>",
        createdAtMs: 1_700_000_000_500,
      },
    ],
  );

  assert.match(html, /<title>Ticket Transcript channel-1<\/title>/);
  assert.match(html, /Ticket Type<\/dt><dd>Appeal \(appeals\)<\/dd>/);
  assert.match(html, /Need &lt;help&gt; &amp; support/);
  assert.match(html, /Hello &lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\('x'\)<\/script>/);
});

test("renderTicketTranscriptHtml renders image and video attachments inline", () => {
  const html = renderTicketTranscriptHtml(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        authorId: "user-1",
        authorTag: "User#0001",
        content: "",
        createdAtMs: 1_700_000_000_500,
        attachments: [
          {
            id: "attachment-1",
            filename: "proof <image>.png",
            url: "https://cdn.example/proof.png?ex=1&is=2",
            proxyUrl: null,
            contentType: "image/png",
            size: 1536,
            width: 640,
            height: 480,
          },
          {
            id: "attachment-2",
            filename: "clip.mp4",
            url: "https://cdn.example/clip.mp4",
            proxyUrl: null,
            contentType: "video/mp4",
            size: 1_048_576,
            width: 1280,
            height: 720,
          },
          {
            id: "attachment-3",
            filename: "unsafe.png",
            url: "javascript:alert(1)",
            proxyUrl: null,
            contentType: "image/png",
            size: null,
            width: null,
            height: null,
          },
        ],
      },
    ],
  );

  assert.ok(
    html.includes(
      '<img src="https://cdn.example/proof.png?ex=1&amp;is=2" alt="proof &lt;image&gt;.png" loading="lazy" />',
    ),
  );
  assert.ok(
    html.includes(
      '<video controls preload="metadata"><source src="https://cdn.example/clip.mp4" type="video/mp4" /></video>',
    ),
  );
  assert.match(html, /Attachment URL unavailable/);
  assert.doesNotMatch(html, /javascript:alert/);
});

test("renderTicketTranscriptHtml prefers display names for opener and closer metadata", () => {
  const html = renderTicketTranscriptHtml(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [],
    {
      guildName: "Guild Name",
      channelName: "ticket-001",
      openerDisplayName: "Alice",
      closerDisplayName: "Support",
    },
  );

  assert.match(html, /Guild<\/dt><dd>Guild Name \(guild-1\)<\/dd>/);
  assert.match(html, /Channel<\/dt><dd>#ticket-001 \(channel-1\)<\/dd>/);
  assert.match(html, /Opened by<\/dt><dd>Alice \(user-1\)<\/dd>/);
  assert.match(html, /Closed by<\/dt><dd>Support \(staff-1\)<\/dd>/);
});

test("renderTicketTranscriptHtml renders Discord-like message layout and reply references", () => {
  const html = renderTicketTranscriptHtml(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        messageId: "msg-1",
        authorId: "user-1",
        authorTag: "User One",
        authorAvatarUrl: "https://cdn.discordapp.com/avatars/user-1/abc.png",
        content: "Original message",
        createdAtMs: 1_700_000_000_500,
      },
      {
        messageId: "msg-2",
        authorId: "user-2",
        authorTag: "User Two",
        authorAvatarUrl: null,
        content: "This is a reply",
        createdAtMs: 1_700_000_001_500,
        replyToMessageId: "msg-1",
        replyTo: {
          authorTag: "User One",
          authorAvatarUrl: "https://cdn.discordapp.com/avatars/user-1/abc.png",
          content: "Original message",
        },
      },
    ],
  );

  assert.match(html, /class="message-avatar"/);
  assert.match(html, /src="https:\/\/cdn\.discordapp\.com\/avatars\/user-1\/abc\.png"/);
  assert.match(html, /class="message-author"/);
  assert.match(html, /class="message-author-id"/);
  assert.match(html, /user-1/);
  assert.match(html, /user-2/);
  assert.match(html, /class="message-reply"/);
  assert.match(html, /href="#message-msg-1"/);
  assert.match(html, /User One/);
  assert.match(html, /Original message/);
});

test("renderTicketTranscriptHtml truncates long reply previews", () => {
  const longContent = "a".repeat(120);
  const html = renderTicketTranscriptHtml(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "closed",
      answers: [],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        messageId: "msg-1",
        authorId: "user-1",
        authorTag: "User One",
        content: longContent,
        createdAtMs: 1_700_000_000_500,
      },
      {
        messageId: "msg-2",
        authorId: "user-2",
        authorTag: "User Two",
        content: "Reply",
        createdAtMs: 1_700_000_001_500,
        replyToMessageId: "msg-1",
        replyTo: { authorTag: "User One", content: longContent },
      },
    ],
  );

  assert.match(html, /class="message-reply-content"[^>]*>a{70,80}…/);
});

test("buildTicketTranscriptSummaryEmbed includes transcript overview and identifier search keys", () => {
  const embed = buildTicketTranscriptSummaryEmbed(
    {
      guildId: "guild-1",
      channelId: "channel-1",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "1493598719340318791",
      supportRoleId: "role-1",
      status: "closed",
      answers: [
        { questionId: "discord-id", label: "Discord ID", value: "1493598719340318791" },
        { questionId: "steam64", label: "Steam64", value: "76561198439127312" },
        { questionId: "in-game-name", label: "In-game name", value: "biubiu" },
      ],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: 1_700_000_001_000,
      closedByUserId: "staff-1",
      transcriptMessageId: "msg-1",
      staffThreadId: null,
    },
    [
      {
        authorId: "staff-1",
        authorTag: "Support",
        content: "Reply",
        createdAtMs: 1_700_000_000_500,
      },
      {
        authorId: "1493598719340318791",
        authorTag: "summertrain",
        content: "Help",
        createdAtMs: 1_700_000_000_400,
      },
    ],
    {
      guildName: "COLD AS FK",
      channelName: "ticket-0011",
      openerDisplayName: "summertrain",
      closerDisplayName: "Postal",
    },
  );

  assert.equal(embed.title, "Ticket Transcript");
  assert.equal(embed.footer?.text, "hafbot.xyz");
  assert.equal(embed.timestamp, "2023-11-14T22:13:21.000Z");
  assert.ok(embed.fields?.every((field) => field.inline === false));
  assert.equal(
    embed.fields?.find((field) => field.name === "Server")?.value,
    "COLD AS FK (guild-1)",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Channel")?.value,
    "#ticket-0011 (channel-1)",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Search keys")?.value,
    "discord:1493598719340318791 steam64:76561198439127312",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Users in transcript")?.value,
    "1 - summertrain\n1 - Support",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Ticket Owner")?.value,
    "<@1493598719340318791>\nID: 1493598719340318791",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Closed by")?.value,
    "<@staff-1>\nID: staff-1",
  );
});

test("renderTicketAutoReply replaces {{answer.<questionId>}} with submitted values", () => {
  const rendered = renderTicketAutoReply(
    "Thanks {{answer.ign}}! Your Steam ID {{answer.steam_id}} has been noted.",
    [
      { questionId: "ign", label: "In-game Name", value: "Alice" },
      { questionId: "steam_id", label: "Steam ID", value: "76561198000000000" },
    ],
    "user-1",
    1700000000000,
  );

  assert.equal(rendered, "Thanks Alice! Your Steam ID 76561198000000000 has been noted.");
});

test("renderTicketAutoReply leaves unknown variables untouched", () => {
  const rendered = renderTicketAutoReply(
    "Hello {{answer.ign}}, {{unknown}} stays as is.",
    [{ questionId: "ign", label: "In-game Name", value: "Bob" }],
    "user-2",
    1700000000000,
  );

  assert.equal(rendered, "Hello Bob, {{unknown}} stays as is.");
});

test("renderTicketAutoReply handles template with no variables", () => {
  const rendered = renderTicketAutoReply(
    "Your ticket has been opened. An agent will be with you shortly.",
    [{ questionId: "ign", label: "In-game Name", value: "Charlie" }],
    "user-3",
    1700000000000,
  );

  assert.equal(rendered, "Your ticket has been opened. An agent will be with you shortly.");
});

test("renderTicketAutoReply replaces {{who}} with Discord user mention", () => {
  const rendered = renderTicketAutoReply(
    "Ticket opened by {{who}}. An agent will assist you.",
    [],
    "123456789012345678",
    1712345678000,
  );

  assert.equal(rendered, "Ticket opened by <@123456789012345678>. An agent will assist you.");
});

test("renderTicketAutoReply replaces {{when}} with Discord timestamp", () => {
  const rendered = renderTicketAutoReply(
    "Ticket opened at {{when}}.",
    [],
    "user-id",
    1712345678000,
  );

  assert.equal(rendered, "Ticket opened at <t:1712345678:F>.");
});

test("renderTicketAutoReply combines {{who}}, {{when}} and {{answer}}", () => {
  const rendered = renderTicketAutoReply(
    "{{who}} opened a ticket at {{when}} for {{answer.reason}}.",
    [{ questionId: "reason", label: "Reason", value: "game ban appeal" }],
    "111122223333444455",
    1712345678000,
  );

  assert.equal(
    rendered,
    "<@111122223333444455> opened a ticket at <t:1712345678:F> for game ban appeal.",
  );
});

test("selectMatchingResponseRules matches has-role, lacks-role, and match-all conditions", () => {
  const rules = [
    {
      id: "match-all",
      conditions: [],
      message: "Welcome",
    },
    {
      id: "has-steam",
      conditions: [{ kind: "has-role", roleId: "steam-linked" as const }],
      message: "Thanks for linking Steam",
    },
    {
      id: "lacks-steam",
      conditions: [{ kind: "lacks-role", roleId: "steam-linked" as const }],
      message: "Please run /steamlink",
    },
    {
      id: "verified-and-lacks-steam",
      conditions: [
        { kind: "has-role", roleId: "verified" as const },
        { kind: "lacks-role", roleId: "steam-linked" as const },
      ],
      message: "Verified but not linked",
    },
  ] satisfies Parameters<typeof selectMatchingResponseRules>[0];

  assert.deepEqual(
    selectMatchingResponseRules(rules, ["verified", "member"]).map((rule) => rule.id),
    ["match-all", "lacks-steam", "verified-and-lacks-steam"],
  );
  assert.deepEqual(
    selectMatchingResponseRules(rules, ["verified", "steam-linked"]).map((rule) => rule.id),
    ["match-all", "has-steam"],
  );
});

test("selectMatchingResponseRules matches lacks-platform-linked-role only when configured and missing", () => {
  const rules = [
    {
      id: "needs-steam",
      conditions: [{ kind: "lacks-platform-linked-role", platform: "steam" as const }],
      message: "Please link Steam",
    },
    {
      id: "needs-default",
      conditions: [{ kind: "lacks-platform-linked-role" as const }],
      message: "Please link the default platform",
    },
  ] satisfies Parameters<typeof selectMatchingResponseRules>[0];

  assert.deepEqual(
    selectMatchingResponseRules(rules, ["member"], {
      defaultTicketLinkPlatform: "xbox",
      platformLinkedRoleIds: { steam: "steam-linked", xbox: "xbox-linked" },
    }).map((rule) => rule.id),
    ["needs-steam", "needs-default"],
  );
  assert.deepEqual(
    selectMatchingResponseRules(rules, ["steam-linked", "xbox-linked"], {
      defaultTicketLinkPlatform: "xbox",
      platformLinkedRoleIds: { steam: "steam-linked", xbox: "xbox-linked" },
    }).map((rule) => rule.id),
    [],
  );
  assert.deepEqual(
    selectMatchingResponseRules(rules, ["member"], {
      defaultTicketLinkPlatform: "xbox",
      platformLinkedRoleIds: { steam: null, xbox: null },
    }).map((rule) => rule.id),
    [],
  );
});

test("openTicket sends auto-reply message when autoReplyMessage is configured", async () => {
  const calls: Array<{ type: string; content?: unknown; body?: unknown }> = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => {
        calls.push({ type: "create-channel" });
        return { id: "channel-1" };
      },
      deleteChannel: async () => {
        calls.push({ type: "delete-channel" });
      },
      createOpeningMessage: async (_channelId, _ticketNumber, body) => {
        calls.push({ type: "opening-message", body });
      },
      createAutoReplyMessage: async (_channelId, content) => {
        calls.push({ type: "auto-reply", content });
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [
          { id: "ign", label: "In-game Name", style: "short", placeholder: null, required: true },
        ],
        responseRules: [
          {
            id: "welcome",
            conditions: [],
            message: "Thanks {{answer.ign}}! An agent will be with you shortly.",
          },
        ],
      },
      answers: [{ questionId: "ign", label: "In-game Name", value: "Alice" }],
    },
  );

  assert.equal(instance.channelId, "channel-1");
  assert.equal(calls[0]?.type, "create-channel");
  assert.deepEqual(calls[1], {
    type: "opening-message",
    body: {
      content: "Created ticket #1 for <@user-1>.",
      allowed_mentions: { parse: [], users: ["user-1"] },
      components: [],
    },
  });
  assert.deepEqual(calls[2], {
    type: "auto-reply",
    content: "Thanks Alice! An agent will be with you shortly.",
  });
  assert.doesNotMatch(JSON.stringify(calls[1]), /\nID:/);
});

test("openTicket sends all matching response rules in configured order", async () => {
  const calls: Array<{ type: string; content?: unknown }> = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => ({ id: "channel-1" }),
      deleteChannel: async () => {},
      createOpeningMessage: async () => {
        calls.push({ type: "opening-message" });
      },
      createAutoReplyMessage: async (_channelId, content) => {
        calls.push({ type: "response", content });
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      openerRoleIds: ["verified"],
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        responseRules: [
          {
            id: "rule-1",
            conditions: [{ kind: "has-role", roleId: "verified" }],
            message: "Welcome {{who}}.",
          },
          {
            id: "rule-2",
            conditions: [{ kind: "lacks-role", roleId: "steam-linked" }],
            message: "Please run /steamlink.",
          },
          {
            id: "rule-3",
            conditions: [{ kind: "has-role", roleId: "steam-linked" }],
            message: "Already linked.",
          },
        ],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
      },
      answers: [],
    },
  );

  assert.deepEqual(calls, [
    { type: "opening-message" },
    { type: "response", content: "Welcome <@user-1>." },
    { type: "response", content: "Please run /steamlink." },
  ]);
});

test("openTicket sends a link reminder response with the platform link button", async () => {
  const calls: Array<{ type: string; body?: unknown; platform?: string; ruleId?: string }> = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => ({ id: "channel-1" }),
      deleteChannel: async () => {},
      createOpeningMessage: async () => {
        calls.push({ type: "opening-message" });
      },
      createAutoReplyMessage: async (_channelId, body) => {
        calls.push({ type: "response", body });
      },
      recordLinkReminder: async ({ platform, rule }) => {
        calls.push({ type: "audit", platform, ruleId: rule.id });
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      openerRoleIds: ["member"],
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        defaultTicketLinkPlatform: "steam",
        responseRules: [
          {
            id: "needs-steam",
            conditions: [{ kind: "lacks-platform-linked-role" }],
            message: "Please link your Steam account, {{who}}.",
          },
        ],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
      },
      answers: [],
      platformLinkConfigs: {
        steam: {
          linkedRoleId: "steam-linked",
          panelButtonLabel: "Link Steam Now",
          panelButtonStyle: "Success",
        },
      },
    },
  );

  assert.deepEqual(calls[0], { type: "opening-message" });
  assert.deepEqual(calls[1], {
    type: "response",
    body: {
      content: "Please link your Steam account, <@user-1>.",
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: "steam_link_button",
              label: "Link Steam Now",
              style: 3,
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(calls[2], { type: "audit", platform: "steam", ruleId: "needs-steam" });
});

test("openTicket skips response messages when no response rules match", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => {
        calls.push("create-channel");
        return { id: "channel-1" };
      },
      deleteChannel: async () => {},
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAutoReplyMessage: async () => {
        calls.push("response-message");
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      openerRoleIds: ["steam-linked"],
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        responseRules: [
          {
            id: "rule-1",
            conditions: [{ kind: "lacks-role", roleId: "steam-linked" }],
            message: "Please run /steamlink.",
          },
        ],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
      },
      answers: [],
    },
  );

  assert.deepEqual(calls, ["create-channel", "opening-message"]);
});

test("openTicket mentions support role when ticket type enables it", async () => {
  const calls: Array<{ type: string; body?: unknown }> = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => ({ id: "channel-1" }),
      deleteChannel: async () => {},
      createOpeningMessage: async (_channelId, _ticketNumber, body) => {
        calls.push({ type: "opening-message", body });
      },
      createAutoReplyMessage: async () => {},
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        mentionSupportRole: true,
        questions: [],
        responseRules: [],
      },
      answers: [],
    },
  );

  assert.deepEqual(calls[0], {
    type: "opening-message",
    body: {
      content: "Created ticket #1 for <@user-1>. <@&role-1>",
      allowed_mentions: { parse: [], users: ["user-1"], roles: ["role-1"] },
      components: [],
    },
  });
});

test("openTicket skips auto-reply when autoReplyMessage is null", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => {
        calls.push("create-channel");
        return { id: "channel-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAutoReplyMessage: async () => {
        calls.push("auto-reply");
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
        responseRules: [],
      },
      answers: [{ questionId: "ign", label: "In-game Name", value: "Bob" }],
    },
  );

  assert.equal(instance.channelId, "channel-1");
  assert.deepEqual(calls, ["create-channel", "opening-message"]);
});

test("openTicket rejects before creating a channel when the opener is at the configured limit", async () => {
  const calls: string[] = [];
  const { openTicket, TicketCreationLimitError } =
    await import("../src/services/tickets/open-ticket");

  await assert.rejects(
    openTicket(
      {
        readConfig: async () => ({ botUserId: "bot", guilds: {} }),
        reserveNextTicketNumber: async () => {
          calls.push("reserve-number");
          return 1;
        },
        countOpenTicketsByUser: async (guildId, openerUserId) => {
          calls.push(`count:${guildId}:${openerUserId}`);
          return 2;
        },
        createTicketInstance: async () => {
          calls.push("create-instance");
        },
        deleteTicketInstance: async () => {
          calls.push("delete-instance");
        },
      },
      {
        createChannel: async () => {
          calls.push("create-channel");
          return { id: "channel-1" };
        },
        deleteChannel: async () => {
          calls.push("delete-channel");
        },
        createOpeningMessage: async () => {
          calls.push("opening-message");
        },
        createAutoReplyMessage: async () => {
          calls.push("auto-reply");
        },
      },
      {
        guildId: "guild-1",
        openerUserId: "user-1",
        panel: {
          guildId: "guild-1",
          panelChannelId: "panel",
          categoryChannelId: "category",
          transcriptChannelId: "transcripts",
          panelEmoji: null,
          panelTitle: null,
          panelDescription: null,
          panelFooter: null,
          panelMessageId: null,
          ticketCreationLimit: 2,
          ticketLimitRejectionMessage: "Close one first.",
          enableTicketClaiming: false,
          ticketTypes: [],
        },
        ticketType: {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: false,
          limitExclusion: false,
          questions: [],
          responseRules: [],
        },
        answers: [],
      },
    ),
    (error: unknown) =>
      error instanceof TicketCreationLimitError && error.rejectionMessage === "Close one first.",
  );

  assert.deepEqual(calls, ["count:guild-1:user-1"]);
});

test("openTicket bypasses the creation limit when the requested ticket type is excluded", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => {
        calls.push("reserve-number");
        return 1;
      },
      countOpenTicketsByUser: async () => {
        calls.push("count");
        return 2;
      },
      createTicketInstance: async () => {
        calls.push("create-instance");
      },
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => {
        calls.push("create-channel");
        return { id: "channel-1" };
      },
      deleteChannel: async () => {},
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAutoReplyMessage: async () => {},
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: 2,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "appeal",
        label: "Appeal",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "appeal",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: true,
        questions: [],
        responseRules: [],
      },
      answers: [],
    },
  );

  assert.equal(instance.channelId, "channel-1");
  for (const action of ["reserve-number", "create-channel", "create-instance", "opening-message"])
    assert.ok(calls.includes(action), `Expected ${action} to complete`);
});

test("openTicket skips auto-reply when autoReplyEnabled is false", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
    },
    {
      createChannel: async () => {
        calls.push("create-channel");
        return { id: "channel-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAutoReplyMessage: async () => {
        calls.push("auto-reply");
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [
          { id: "ign", label: "In-game Name", style: "short", placeholder: null, required: true },
        ],
        responseRules: [],
      },
      answers: [{ questionId: "ign", label: "In-game Name", value: "Bob" }],
    },
  );

  assert.equal(instance.channelId, "channel-1");
  assert.ok(calls.includes("create-channel"));
  assert.ok(calls.includes("opening-message"));
  assert.equal(calls.includes("auto-reply"), false);
});

test("openTicket creates a staff thread and helper when Anonymous Support is enabled", async () => {
  const calls: string[] = [];
  const helperThreadIds: string[] = [];
  const persistedInstances: Array<{ staffThreadId: string | null }> = [];
  const channelConfigs: Array<{ anonymousEnabled?: boolean }> = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async (ticket) => {
        calls.push("create-instance");
        persistedInstances.push({ staffThreadId: ticket.staffThreadId });
      },
      deleteTicketInstance: async () => {
        calls.push("delete-instance");
      },
    },
    {
      createChannel: async (config) => {
        calls.push("create-channel");
        channelConfigs.push({ anonymousEnabled: config.anonymousEnabled });
        return { id: "channel-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      createStaffThread: async (channelId, name) => {
        calls.push(`create-staff-thread:${channelId}:${name}`);
        return { id: "thread-1" };
      },
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAnonymousSupportHelper: async (staffThreadId) => {
        helperThreadIds.push(staffThreadId);
      },
      createAutoReplyMessage: async () => {
        calls.push("auto-reply");
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: true,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
        responseRules: [],
      },
      answers: [],
    },
  );

  assert.equal(instance.staffThreadId, "thread-1");
  assert.deepEqual(persistedInstances, [{ staffThreadId: "thread-1" }]);
  assert.deepEqual(channelConfigs, [{ anonymousEnabled: true }]);
  assert.deepEqual(helperThreadIds, ["thread-1"]);
  assert.ok(calls.includes("create-channel"));
  assert.ok(calls.includes("create-staff-thread:channel-1:staff-discussion"));
  assert.ok(calls.includes("create-instance"));
  assert.ok(calls.includes("opening-message"));
});

test("openTicket posts Ticket History Prompt only in the configured staff discussion thread", async () => {
  const prompts: Array<{ threadId: string; count: number; ticketChannelId: string }> = [];
  const helperThreadIds: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {},
      deleteTicketInstance: async () => {},
      listMemberTicketHistory: async () => ({ tickets: [], total: 2, nextCursor: null }),
    },
    {
      createChannel: async () => ({ id: "channel-1" }),
      deleteChannel: async () => {},
      createStaffThread: async () => ({ id: "thread-1" }),
      createOpeningMessage: async () => {},
      createAutoReplyMessage: async () => {},
      createAnonymousSupportHelper: async (staffThreadId) => {
        helperThreadIds.push(staffThreadId);
      },
      createTicketHistoryPrompt: async (threadId, count, ticketChannelId) => {
        prompts.push({ threadId, count, ticketChannelId });
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: true,
        ticketHistoryPromptVisibility: "staff-thread",
        limitExclusion: false,
        questions: [],
        responseRules: [],
      },
      answers: [],
    },
  );

  assert.deepEqual(prompts, [{ threadId: "thread-1", count: 2, ticketChannelId: "channel-1" }]);
  assert.deepEqual(helperThreadIds, []);
});

test("openTicket keeps the ticket open when auto-reply delivery fails", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  const instance = await openTicket(
    {
      readConfig: async () => ({ botUserId: "bot", guilds: {} }),
      reserveNextTicketNumber: async () => 1,
      countOpenTicketsByUser: async () => 0,
      createTicketInstance: async () => {
        calls.push("create-instance");
      },
      deleteTicketInstance: async () => {
        calls.push("delete-instance");
      },
    },
    {
      createChannel: async () => {
        calls.push("create-channel");
        return { id: "channel-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      createOpeningMessage: async () => {
        calls.push("opening-message");
      },
      createAutoReplyMessage: async () => {
        calls.push("auto-reply");
        throw new Error("auto reply failed");
      },
    },
    {
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: {
        guildId: "guild-1",
        panelChannelId: "panel",
        categoryChannelId: "category",
        transcriptChannelId: "transcripts",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      },
      ticketType: {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [
          { id: "ign", label: "In-game Name", style: "short", placeholder: null, required: true },
        ],
        responseRules: [{ id: "welcome", conditions: [], message: "Thanks {{answer.ign}}!" }],
      },
      answers: [{ questionId: "ign", label: "In-game Name", value: "Alice" }],
    },
  );

  assert.equal(instance.channelId, "channel-1");
  for (const action of ["create-channel", "create-instance", "opening-message", "auto-reply"])
    assert.ok(calls.includes(action), `Expected ${action} to complete`);
});

test("openTicket deletes the created channel when persistence fails", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await assert.rejects(
    openTicket(
      {
        readConfig: async () => ({ botUserId: "bot", guilds: {} }),
        reserveNextTicketNumber: async () => 1,
        countOpenTicketsByUser: async () => 0,
        createTicketInstance: async () => {
          throw new Error("persist failed");
        },
        deleteTicketInstance: async () => {
          calls.push("delete-instance");
        },
      },
      {
        createChannel: async () => {
          calls.push("create-channel");
          return { id: "channel-1" };
        },
        deleteChannel: async () => {
          calls.push("delete-channel");
        },
        createOpeningMessage: async () => {
          calls.push("opening-message");
        },
        createAutoReplyMessage: async () => {
          calls.push("auto-reply");
        },
      },
      {
        guildId: "guild-1",
        openerUserId: "user-1",
        panel: {
          guildId: "guild-1",
          panelChannelId: "panel",
          categoryChannelId: "category",
          transcriptChannelId: "transcripts",
          panelEmoji: null,
          panelTitle: null,
          panelDescription: null,
          panelFooter: null,
          panelMessageId: null,
          ticketCreationLimit: null,
          ticketLimitRejectionMessage: null,
          enableTicketClaiming: false,
          ticketTypes: [],
        },
        ticketType: {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          anonymousSupportEnabled: false,
          staffDiscussionThreadEnabled: false,
          limitExclusion: false,
          questions: [],
          responseRules: [],
        },
        answers: [],
      },
    ),
    /persist failed/,
  );

  assert.ok(calls.includes("create-channel"));
  assert.ok(calls.includes("delete-channel"));
});

test("openTicket deletes staff thread when anonymous ticket persistence fails", async () => {
  const calls: string[] = [];
  const { openTicket } = await import("../src/services/tickets/open-ticket");

  await assert.rejects(
    openTicket(
      {
        readConfig: async () => ({ botUserId: "bot", guilds: {} }),
        reserveNextTicketNumber: async () => 1,
        countOpenTicketsByUser: async () => 0,
        createTicketInstance: async () => {
          calls.push("create-instance");
          throw new Error("persist failed");
        },
        deleteTicketInstance: async () => {
          calls.push("delete-instance");
        },
      },
      {
        createChannel: async () => {
          calls.push("create-channel");
          return { id: "channel-1" };
        },
        deleteChannel: async (channelId) => {
          calls.push(`delete-channel:${channelId}`);
        },
        createStaffThread: async () => {
          calls.push("create-staff-thread");
          return { id: "thread-1" };
        },
        deleteStaffThread: async (threadId) => {
          calls.push(`delete-staff-thread:${threadId}`);
        },
        createOpeningMessage: async () => {
          calls.push("opening-message");
        },
        createAutoReplyMessage: async () => {
          calls.push("auto-reply");
        },
      },
      {
        guildId: "guild-1",
        openerUserId: "user-1",
        panel: {
          guildId: "guild-1",
          panelChannelId: "panel",
          categoryChannelId: "category",
          transcriptChannelId: "transcripts",
          panelEmoji: null,
          panelTitle: null,
          panelDescription: null,
          panelFooter: null,
          panelMessageId: null,
          ticketCreationLimit: null,
          ticketLimitRejectionMessage: null,
          enableTicketClaiming: false,
          ticketTypes: [],
        },
        ticketType: {
          id: "support",
          label: "Support",
          emoji: null,
          buttonStyle: "primary",
          supportRoleId: "role-1",
          channelNamePrefix: "support",
          anonymousSupportEnabled: true,
          staffDiscussionThreadEnabled: true,
          limitExclusion: false,
          questions: [],
          responseRules: [],
        },
        answers: [],
      },
    ),
    /persist failed/,
  );

  assert.ok(calls.includes("create-channel"));
  assert.ok(calls.includes("create-staff-thread"));
  assert.ok(calls.includes("create-instance"));
  assert.ok(calls.includes("delete-staff-thread:thread-1"));
  assert.ok(calls.includes("delete-channel:channel-1"));
});

test("requestTicketClose posts member-visible mentions without broad pings or raw IDs", async () => {
  const messages: Array<{ channelId: string; body: unknown }> = [];
  const { requestTicketClose } = await import("../src/services/tickets/request-ticket-close");

  await requestTicketClose(
    {
      createChannelMessage: async (channelId, body) => {
        messages.push({ channelId, body });
      },
    },
    {
      ticket: buildCloseWorkflowTicket({ channelId: "ticket-1", openerUserId: "member-1" }),
      requesterUserId: "staff-1",
    },
  );

  assert.deepEqual(messages[0], {
    channelId: "ticket-1",
    body: {
      content:
        "<@member-1> <@staff-1> requested to close this ticket. Do you want to close it now?",
      allowed_mentions: { parse: [], users: ["member-1"] },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: buildTicketCloseConfirmCustomId("ticket-1"),
              label: "Yes, close ticket",
              style: 4,
            },
            {
              type: 2,
              custom_id: buildTicketCloseDeclineCustomId("ticket-1"),
              label: "No, keep open",
              style: 2,
            },
          ],
        },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(messages[0]), /\nID:/);
});

test("closeTicket deletes staff thread and cleans staff messages after successful close", async () => {
  const calls: string[] = [];
  const { closeTicket } = await import("../src/services/tickets/close-ticket");

  await closeTicket(
    {
      closeTicketInstance: async () => {
        calls.push("close-ticket");
      },
      cleanupStaffMessages: async (body) => {
        calls.push(`cleanup-staff:${body.ticketChannelId}`);
      },
      updateTicketInstanceStaffThreadId: async (body) => {
        calls.push(`clear-staff-thread:${body.channelId}:${body.staffThreadId}`);
      },
    },
    {
      buildTranscriptArtifacts: async () => {
        calls.push("build-transcript");
        return { messages: [], presentation: {} };
      },
      uploadTranscript: async () => {
        calls.push("upload-transcript");
        return { id: "transcript-1" };
      },
      deleteStaffThread: async (threadId) => {
        calls.push(`delete-staff-thread:${threadId}`);
      },
      deleteChannel: async (channelId) => {
        calls.push(`delete-channel:${channelId}`);
      },
    },
    {
      ticket: buildCloseWorkflowTicket({ staffThreadId: "thread-1" }),
      closedByUserId: "staff-1",
      closerDisplayName: "Staff",
      panel: buildCloseWorkflowPanel(),
    },
  );

  for (const action of [
    "build-transcript",
    "upload-transcript",
    "close-ticket",
    "delete-staff-thread:thread-1",
    "cleanup-staff:channel-1",
    "clear-staff-thread:channel-1:null",
    "delete-channel:channel-1",
  ])
    assert.ok(calls.includes(action), `Expected ${action} to complete`);
});

test("closeTicket does not delete staff resources when transcript build fails", async () => {
  const calls: string[] = [];
  const { closeTicket, TranscriptUploadError } =
    await import("../src/services/tickets/close-ticket");

  await assert.rejects(
    closeTicket(
      {
        closeTicketInstance: async () => {
          calls.push("close-ticket");
        },
        cleanupStaffMessages: async () => {
          calls.push("cleanup-staff");
        },
        updateTicketInstanceStaffThreadId: async () => {
          calls.push("clear-staff-thread");
        },
      },
      {
        buildTranscriptArtifacts: async () => {
          calls.push("build-transcript");
          throw new Error("transcript failed");
        },
        uploadTranscript: async () => {
          calls.push("upload-transcript");
          return { id: "transcript-1" };
        },
        deleteStaffThread: async () => {
          calls.push("delete-staff-thread");
        },
        deleteChannel: async () => {
          calls.push("delete-channel");
        },
      },
      {
        ticket: buildCloseWorkflowTicket({ staffThreadId: "thread-1" }),
        closedByUserId: "staff-1",
        closerDisplayName: "Staff",
        panel: buildCloseWorkflowPanel(),
      },
    ),
    TranscriptUploadError,
  );

  assert.ok(calls.includes("build-transcript"));
  assert.equal(calls.includes("upload-transcript"), false);
  assert.equal(calls.includes("delete-staff-thread"), false);
  assert.equal(calls.includes("delete-channel"), false);
});

test("closeTicket discards unpublished transcript artifacts when upload fails", async () => {
  const calls: string[] = [];
  const { closeTicket, TranscriptUploadError } =
    await import("../src/services/tickets/close-ticket");

  await assert.rejects(
    closeTicket(
      {
        closeTicketInstance: async () => {
          calls.push("close-ticket");
        },
        cleanupStaffMessages: async () => {},
        updateTicketInstanceStaffThreadId: async () => {},
      },
      {
        buildTranscriptArtifacts: async () => ({
          messages: [],
          presentation: {},
          discard: async () => {
            calls.push("discard-transcript");
          },
        }),
        uploadTranscript: async () => {
          calls.push("upload-transcript");
          throw new Error("Discord unavailable");
        },
        deleteChannel: async () => {
          calls.push("delete-channel");
        },
      },
      {
        ticket: buildCloseWorkflowTicket(),
        closedByUserId: "staff-1",
        closerDisplayName: "Staff",
        panel: buildCloseWorkflowPanel(),
      },
    ),
    TranscriptUploadError,
  );

  assert.deepEqual(calls, ["upload-transcript", "discard-transcript"]);
});

test("closeTicket does not cleanup staff messages when staff thread deletion fails", async () => {
  const calls: string[] = [];
  const { closeTicket, ChannelDeletionError } =
    await import("../src/services/tickets/close-ticket");

  await assert.rejects(
    closeTicket(
      {
        closeTicketInstance: async () => {
          calls.push("close-ticket");
        },
        cleanupStaffMessages: async () => {
          calls.push("cleanup-staff");
        },
        updateTicketInstanceStaffThreadId: async () => {
          calls.push("clear-staff-thread");
        },
      },
      {
        buildTranscriptArtifacts: async () => {
          calls.push("build-transcript");
          return { messages: [], presentation: {} };
        },
        uploadTranscript: async () => {
          calls.push("upload-transcript");
          return { id: "transcript-1" };
        },
        deleteStaffThread: async () => {
          calls.push("delete-staff-thread");
          throw new Error("delete failed");
        },
        deleteChannel: async () => {
          calls.push("delete-channel");
        },
      },
      {
        ticket: buildCloseWorkflowTicket({ staffThreadId: "thread-1" }),
        closedByUserId: "staff-1",
        closerDisplayName: "Staff",
        panel: buildCloseWorkflowPanel(),
      },
    ),
    ChannelDeletionError,
  );

  for (const action of [
    "build-transcript",
    "upload-transcript",
    "close-ticket",
    "delete-staff-thread",
  ])
    assert.ok(calls.includes(action), `Expected ${action} to complete`);
  assert.equal(calls.includes("cleanup-staff"), false);
  assert.equal(calls.includes("delete-channel"), false);
});

test("closeTicket includes AI summary and keywords in transcript embed when enabled and premium guild", async () => {
  const calls: string[] = [];
  const { closeTicket } = await import("../src/services/tickets/close-ticket");
  const embeds: import("../src/discord/messages").DiscordEmbed[] = [];

  await closeTicket(
    {
      closeTicketInstance: async () => {
        calls.push("close-ticket");
      },
      cleanupStaffMessages: async () => {},
      updateTicketInstanceStaffThreadId: async () => {},
    },
    {
      buildTranscriptArtifacts: async () => {
        calls.push("build-transcript");
        return {
          messages: [
            {
              authorId: "user-1",
              authorTag: "Member",
              content: "I cannot log in.",
              createdAtMs: 1_700_000_000_000,
            },
          ],
          presentation: {},
        };
      },
      uploadTranscript: async (_channelId, _filename, _transcript, options) => {
        calls.push("upload-transcript");
        embeds.push(...(options.embeds ?? []));
        return { id: "transcript-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      summarizeTranscript: async () => {
        calls.push("summarize-transcript");
        return {
          summary: "Member could not log in and was advised to reset their password.",
          keywords: ["login issue", "password reset"],
        };
      },
    },
    {
      ticket: buildCloseWorkflowTicket(),
      closedByUserId: "staff-1",
      closerDisplayName: "Staff",
      panel: { ...buildCloseWorkflowPanel(), aiTranscriptSummariesEnabled: true },
      isPremiumGuild: true,
    },
  );

  assert.equal(calls.includes("summarize-transcript"), true);
  assert.equal(embeds.length, 1);
  assert.equal(
    embeds[0]?.description,
    "Member could not log in and was advised to reset their password.",
  );
  const keywordField = embeds[0]?.fields?.find((field) => field.name === "AI Keywords");
  assert.equal(keywordField?.value, "login issue, password reset");
});

test("closeTicket skips AI summary when the guild is not premium", async () => {
  const calls: string[] = [];
  const { closeTicket } = await import("../src/services/tickets/close-ticket");
  const embeds: import("../src/discord/messages").DiscordEmbed[] = [];

  await closeTicket(
    {
      closeTicketInstance: async () => {
        calls.push("close-ticket");
      },
      cleanupStaffMessages: async () => {},
      updateTicketInstanceStaffThreadId: async () => {},
    },
    {
      buildTranscriptArtifacts: async () => {
        calls.push("build-transcript");
        return {
          messages: [
            {
              authorId: "user-1",
              authorTag: "Member",
              content: "I cannot log in.",
              createdAtMs: 1_700_000_000_000,
            },
          ],
          presentation: {},
        };
      },
      uploadTranscript: async (_channelId, _filename, _transcript, options) => {
        calls.push("upload-transcript");
        embeds.push(...(options.embeds ?? []));
        return { id: "transcript-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      summarizeTranscript: async () => {
        calls.push("summarize-transcript");
        return {
          summary: "Should not appear.",
          keywords: ["ignored"],
        };
      },
    },
    {
      ticket: buildCloseWorkflowTicket(),
      closedByUserId: "staff-1",
      closerDisplayName: "Staff",
      panel: { ...buildCloseWorkflowPanel(), aiTranscriptSummariesEnabled: true },
      isPremiumGuild: false,
    },
  );

  assert.equal(calls.includes("summarize-transcript"), false);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0]?.description, undefined);
  const keywordField = embeds[0]?.fields?.find((field) => field.name === "AI Keywords");
  assert.equal(keywordField, undefined);
});

test("closeTicket proceeds without AI content when summarization fails", async () => {
  const calls: string[] = [];
  const { closeTicket } = await import("../src/services/tickets/close-ticket");
  const embeds: import("../src/discord/messages").DiscordEmbed[] = [];

  await closeTicket(
    {
      closeTicketInstance: async () => {
        calls.push("close-ticket");
      },
      cleanupStaffMessages: async () => {},
      updateTicketInstanceStaffThreadId: async () => {},
    },
    {
      buildTranscriptArtifacts: async () => {
        calls.push("build-transcript");
        return {
          messages: [
            {
              authorId: "user-1",
              authorTag: "Member",
              content: "I cannot log in.",
              createdAtMs: 1_700_000_000_000,
            },
          ],
          presentation: {},
        };
      },
      uploadTranscript: async (_channelId, _filename, _transcript, options) => {
        calls.push("upload-transcript");
        embeds.push(...(options.embeds ?? []));
        return { id: "transcript-1" };
      },
      deleteChannel: async () => {
        calls.push("delete-channel");
      },
      summarizeTranscript: async () => {
        calls.push("summarize-transcript");
        throw new Error("AI provider unavailable");
      },
    },
    {
      ticket: buildCloseWorkflowTicket(),
      closedByUserId: "staff-1",
      closerDisplayName: "Staff",
      panel: { ...buildCloseWorkflowPanel(), aiTranscriptSummariesEnabled: true },
      isPremiumGuild: true,
    },
  );

  assert.equal(calls.includes("summarize-transcript"), true);
  assert.equal(calls.includes("close-ticket"), true);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0]?.description, undefined);
  const keywordField = embeds[0]?.fields?.find((field) => field.name === "AI Keywords");
  assert.equal(keywordField, undefined);
});

function buildCloseWorkflowTicket(overrides: Partial<import("../src/types").TicketInstance> = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open" as const,
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    ...overrides,
  };
}

function buildCloseWorkflowPanel(): import("../src/types").TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "panel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcripts-1",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [],
  };
}
