import { createProductionRuntimeStores } from "./support/production-runtime-stores";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  EvidenceVaultService,
  buildEvidenceVaultImageStorageKey,
  buildEvidenceVaultPlaceholderMessage,
  extractEvidence,
  formatEvidenceForDiscord,
  hasEvidenceVaultAccess,
  parseEvidenceVaultViewCustomId,
  resolveSupportedImageContentType,
} from "../src/evidence-vault";
import { DEFAULT_IDENTITY_PATTERNS } from "../src/evidence-vault-subjects";
import type { EvidenceVaultRecord } from "../src/types";

test("extractEvidence preserves text and deduplicates HTTP links", () => {
  const result = extractEvidence({
    id: "message-1",
    content: "Proof https://clip.example/a and again https://clip.example/a.",
    attachments: [],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sourceText, "Proof https://clip.example/a and again https://clip.example/a.");
  assert.deepEqual(result.links, ["https://clip.example/a"]);
});

test("extractEvidence rejects unsupported and oversized evidence before storage", () => {
  assert.deepEqual(extractEvidence({ id: "message-1", content: "", attachments: [] }), {
    ok: false,
    message: "This message does not contain supported evidence.",
  });
  assert.deepEqual(
    extractEvidence({
      id: "message-1",
      content: "proof",
      attachments: [
        {
          id: "a",
          filename: "proof.txt",
          content_type: "text/plain",
          size: 1,
          url: "https://cdn/a",
        },
      ],
    }),
    { ok: false, message: "Unsupported attachments cannot be hidden in Evidence Vault." },
  );
});

test("image support uses content type with filename fallback", () => {
  assert.equal(
    resolveSupportedImageContentType({ filename: "x.bin", content_type: "image/png" }),
    "image/png",
  );
  assert.equal(
    resolveSupportedImageContentType({ filename: "x.webp", content_type: null }),
    "image/webp",
  );
  assert.equal(resolveSupportedImageContentType({ filename: "x.pdf", content_type: null }), null);
});

test("storage keys are Guild scoped and do not use Discord message IDs", () => {
  assert.equal(
    buildEvidenceVaultImageStorageKey(
      "guild-1",
      "record-secret",
      "image-secret",
      "proof image.png",
    ),
    "guild-1/evidence-vault/record-secret/images/image-secret/proof%20image.png",
  );
});

test("hideEvidence enforces the Free 30-record boundary and allows creation after usage falls", async () => {
  const state = { tier: "free" as const, count: 29 };
  const service = createRecordLimitService(state);

  assert.equal((await hideTextEvidence(service, "message-29")).ok, true);
  assert.equal(state.count, 30);

  const atLimit = await hideTextEvidence(service, "message-30");
  assert.equal(atLimit.ok, false);
  assert.match(atLimit.message, /Free plan limit of 30 records/);

  state.count = 31;
  assert.equal((await hideTextEvidence(service, "message-31")).ok, false);

  state.count = 29;
  assert.equal((await hideTextEvidence(service, "message-after-removal")).ok, true);
  assert.equal(state.count, 30);
});

test("hideEvidence has no paid record limit and resumes immediately after re-upgrade", async () => {
  const state: { tier: "free" | "premium"; count: number } = { tier: "free", count: 31 };
  const service = createRecordLimitService(state);

  assert.equal((await hideTextEvidence(service, "message-downgraded")).ok, false);

  state.tier = "premium";
  assert.equal((await hideTextEvidence(service, "message-upgraded")).ok, true);
  assert.equal(state.count, 32);
});

test("hideEvidence stores evidence before deleting and posting placeholder", async () => {
  const calls: string[] = [];
  let saved: EvidenceVaultRecord | null = null;
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async (record: EvidenceVaultRecord) => {
          calls.push("create-record");
          saved = record;
        },
        readRecord: async () => saved,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {
          calls.push("update-placeholder");
        },
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: "premium_plus",
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    {
      putImage: async () => {
        calls.push("put-image");
      },
      getImage: async () => null,
      deleteImage: async () => {},
    },
    {
      deleteMessage: async () => {
        calls.push("delete-message");
      },
      postPlaceholder: async () => {
        calls.push("post-placeholder");
        return { id: "placeholder-1" };
      },
      postAudit: async () => {
        calls.push("audit");
      },
    },
    { recordId: () => "record-secret", imageId: () => "image-secret" },
    { fetch: async () => new ArrayBuffer(4) },
    () => 100,
  );

  const result = await service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: { permissions: "0", roles: ["staff"], user: { id: "hider", username: "Hider" } },
    },
    sourceMessage: {
      id: "discord-message-id",
      channel_id: "source",
      content: "proof https://clip.example/a",
      timestamp: "2026-01-01T00:00:00.000Z",
      author: { id: "author", username: "Author", global_name: null },
      attachments: [
        {
          id: "att-1",
          filename: "proof.png",
          content_type: "image/png",
          size: 4,
          url: "https://cdn/proof.png",
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "put-image",
    "create-record",
    "delete-message",
    "post-placeholder",
    "update-placeholder",
    "audit",
  ]);
  assert.equal((saved as EvidenceVaultRecord | null)?.id, "record-secret");
  assert.notEqual((saved as EvidenceVaultRecord | null)?.id, "discord-message-id");
});

test("source deletion failure keeps a viewable partial record", async () => {
  let saved: EvidenceVaultRecord | null = null;
  let status: string | null = null;
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: [],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async (record: EvidenceVaultRecord) => {
          saved = record;
        },
        listRecords: async () => (saved ? [saved] : []),
        readRecord: async () => saved,
        updateRecordStatus: async (
          _recordId: string,
          nextStatus: EvidenceVaultRecord["status"],
        ) => {
          status = nextStatus;
        },
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: "premium_plus",
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {
        throw new Error("nope");
      },
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
    { recordId: () => "record", imageId: () => "image" },
  );

  const result = await service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: {
        permissions: String(1n << 5n),
        roles: [],
        user: { id: "hider", username: "Hider" },
      },
    },
    sourceMessage: { id: "message", channel_id: "source", content: "proof" },
  });

  assert.equal(result.ok, true);
  assert.equal(status, "source-delete-failed");
});

test("hideEvidence snapshots inferred subjects and viewEvidence renders them when enabled", async () => {
  let saved: EvidenceVaultRecord | null = null;
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async (record: EvidenceVaultRecord) => {
          saved = record;
        },
        listRecords: async () => (saved ? [saved] : []),
        readRecord: async () => saved,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: "free",
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
    { recordId: () => "record", imageId: () => "image" },
  );

  const hide = await service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: { permissions: "0", roles: ["staff"], user: { id: "hider" } },
    },
    sourceMessage: {
      id: "message",
      channel_id: "source",
      content: "proof about <@123456789012345678> and 76561198000000000",
    },
  });

  assert.equal(hide.ok, true);
  assert.deepEqual((saved as EvidenceVaultRecord | null)?.subjectUserIds, [
    { platform: "steam", id: "76561198000000000" },
    { platform: "discord", id: "123456789012345678" },
  ]);
  assert.equal((saved as EvidenceVaultRecord | null)?.subjectsEnabled, true);

  const view = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "",
  });

  assert.equal(view.allowed, true);
  assert.match(view.content, /Subjects: steam:76561198000000000, <@123456789012345678>/);
});

test("searchEvidence returns newest matching records and posts a search audit", async () => {
  const auditTitles: string[] = [];
  const records = Array.from({ length: 12 }, (_, index) =>
    buildRecord({
      id: `record-${index + 1}`,
      hiddenAtMs: 100 + index,
      subjectUserIds: [{ platform: "steam", id: "76561198000000000" }],
    }),
  ).sort((left, right) => right.hiddenAtMs - left.hiddenAtMs);
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => null,
        searchRecordsBySubject: async () => records,
        updateRecordStatus: async () => {},
        updateRecordSubjects: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
        listEnabledIdentityPatterns: async () => DEFAULT_IDENTITY_PATTERNS,
        listIdentityPatterns: async () => [],
        addIdentityPattern: async (input: never) => input,
        disableIdentityPattern: async () => false,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: "free",
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async (_channelId, body) => {
        auditTitles.push((body.embeds?.[0] as { title?: string } | undefined)?.title ?? "");
      },
    },
  );

  const result = await service.searchEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "searcher" } },
    },
    userInput: "76561198000000000",
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(result.records.map((record) => record.id).slice(0, 2), [
    "record-12",
    "record-11",
  ]);
  assert.equal(result.message?.embeds?.[0]?.title, "Evidence Vault Search");
  assert.equal(result.message?.embeds?.[0]?.fields?.length, 10);
  assert.equal(
    result.message?.components?.[0]?.components?.[0]?.custom_id,
    "evidence-vault:see:record-12",
  );
  assert.equal(result.message?.components?.[2]?.components?.[1]?.label, "Next");
  assert.deepEqual(auditTitles, ["Evidence Vault Search"]);
});

test("Evidence Fields modal uses configured labels and existing values", async () => {
  const record = buildRecord({
    evidenceFieldValues: [
      { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
    ],
  });
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          evidenceFields: [
            { key: "case_ref", label: "Case reference", type: "short_text" },
            {
              key: "kind",
              label: "Evidence type",
              type: "enum",
              allowedValues: ["video", "image"],
            },
          ],
          updatedAtMs: 1,
        }),
        readRecord: async () => record,
      },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
  );

  const result = await service.buildAddDetailsModal({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.modal.custom_id, "evidence-vault:details:record");
  assert.deepEqual(
    result.modal.components.map((row) => row.components[0]?.label),
    ["Case reference", "Evidence type"],
  );
  assert.equal(result.modal.components[0]?.components[0]?.value, "CASE-123");
});

test("Evidence Fields submissions validate enums persist values and post audits", async () => {
  const record = buildRecord();
  const audits: string[] = [];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          evidenceFields: [
            { key: "case_ref", label: "Case reference", type: "short_text" },
            {
              key: "kind",
              label: "Evidence type",
              type: "enum",
              allowedValues: ["video", "image"],
            },
          ],
          updatedAtMs: 1,
        }),
        readRecord: async () => record,
        updateRecordEvidenceFieldValues: async (
          _recordId: string,
          values: EvidenceVaultRecord["evidenceFieldValues"],
        ) => {
          record.evidenceFieldValues = values;
        },
      },
      guildAuditLog: {} as never,
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async (_channelId, body) => {
        audits.push((body.embeds?.[0] as { title?: string } | undefined)?.title ?? "");
      },
    },
  );
  const interaction = {
    type: 5,
    guild_id: "guild-1",
    member: { permissions: "0", roles: ["staff"], user: { id: "editor" } },
  } as const;

  const rejected = await service.submitEvidenceDetails({
    interaction,
    recordId: "record",
    values: { kind: "clip" },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Evidence type must be one of: video, image/);

  const accepted = await service.submitEvidenceDetails({
    interaction,
    recordId: "record",
    values: { case_ref: "CASE-123", kind: "Video" },
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(record.evidenceFieldValues, [
    { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
    { key: "kind", label: "Evidence type", type: "enum", value: "video" },
  ]);
  assert.deepEqual(audits, ["Evidence Vault Field Value", "Evidence Vault Field Value"]);
});

test("Evidence Fields search AND-combines subjects fields and sourceText while excluding archived values", async () => {
  const definitions = [
    { key: "case_ref", label: "Case reference", type: "short_text" as const },
    {
      key: "kind",
      label: "Evidence type",
      type: "enum" as const,
      allowedValues: ["video", "image"],
    },
  ];
  const records = [
    buildRecord({
      id: "match",
      hiddenAtMs: 300,
      sourceText: "appeal notes include raid",
      subjectUserIds: [{ platform: "discord", id: "123456789012345678" }],
      evidenceFieldValues: [
        { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
        { key: "kind", label: "Evidence type", type: "enum", value: "video" },
      ],
    }),
    buildRecord({
      id: "archived",
      hiddenAtMs: 200,
      sourceText: "appeal notes include raid",
      subjectUserIds: [{ platform: "discord", id: "123456789012345678" }],
      evidenceFieldValues: [
        { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
        { key: "kind", label: "Evidence type", type: "enum", value: "chat" },
      ],
    }),
    buildRecord({
      id: "wrong-source",
      hiddenAtMs: 100,
      sourceText: "other notes",
      subjectUserIds: [{ platform: "discord", id: "123456789012345678" }],
      evidenceFieldValues: [
        { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
        { key: "kind", label: "Evidence type", type: "enum", value: "video" },
      ],
    }),
  ];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          evidenceFields: definitions,
          updatedAtMs: 1,
        }),
        listRecords: async () => records,
        listEnabledIdentityPatterns: async () => DEFAULT_IDENTITY_PATTERNS,
      },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
  );

  const result = await service.searchEvidenceFields({
    interaction: {
      type: 5,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "searcher" } },
    },
    values: {
      subject: "<@123456789012345678>",
      sourceText: "raid",
      case_ref: "CASE",
      kind: "video",
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(
    result.records.map((record) => record.id),
    ["match"],
  );
});

test("Evidence Fields slash form maps the fifth input to the fifth configured field", async () => {
  const definitions = [1, 2, 3, 4, 5].map((position) => ({
    key: `field_${position}`,
    label: `Field ${position}`,
    type: "short_text" as const,
  }));
  const records = [
    buildRecord({
      id: "match",
      evidenceFieldValues: [
        { key: "field_5", label: "Field 5", type: "short_text", value: "final marker" },
      ],
    }),
    buildRecord({
      id: "miss",
      evidenceFieldValues: [
        { key: "field_5", label: "Field 5", type: "short_text", value: "other" },
      ],
    }),
  ];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          evidenceFields: definitions,
          updatedAtMs: 1,
        }),
        listRecords: async () => records,
        listEnabledIdentityPatterns: async () => DEFAULT_IDENTITY_PATTERNS,
      },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
  );

  const result = await service.searchEvidenceFieldForm({
    interaction: {
      type: 5,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "searcher" } },
    },
    fieldInputs: ["", "", "", "", "final"],
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(
    result.records.map((record) => record.id),
    ["match"],
  );
});

test("amendEvidenceSubjects adds and removes canonical subjects and posts amend audits", async () => {
  const record = buildRecord({ id: "record", subjectUserIds: [] });
  const audits: string[] = [];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          subjectsEnabled: true,
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => record,
        searchRecordsBySubject: async () => [],
        updateRecordStatus: async () => {},
        updateRecordSubjects: async (
          _recordId: string,
          subjects: EvidenceVaultRecord["subjectUserIds"],
        ) => {
          record.subjectUserIds = subjects;
        },
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
        listEnabledIdentityPatterns: async () => DEFAULT_IDENTITY_PATTERNS,
        listIdentityPatterns: async () => [],
        addIdentityPattern: async (input: never) => input,
        disableIdentityPattern: async () => false,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: "free",
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async (_channelId, body) => {
        audits.push((body.embeds?.[0] as { title?: string } | undefined)?.title ?? "");
      },
    },
  );

  const interaction = {
    type: 2,
    guild_id: "guild-1",
    member: { permissions: "0", roles: ["staff"], user: { id: "amender" } },
  } as const;

  await service.amendEvidenceSubjects({
    interaction,
    recordId: "record",
    action: "add",
    userInput: "<@123456789012345678>",
  });
  assert.deepEqual(record.subjectUserIds, [{ platform: "discord", id: "123456789012345678" }]);

  await service.amendEvidenceSubjects({
    interaction,
    recordId: "record",
    action: "remove",
    userInput: "123456789012345678",
  });
  assert.deepEqual(record.subjectUserIds, []);
  assert.deepEqual(audits, ["Evidence Vault Amend", "Evidence Vault Amend"]);
});

test("hideEvidence posts an Audit Embed with actor source evidence result and placeholder details", async () => {
  const auditBodies: Array<{
    embeds?: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
    allowed_mentions?: { parse?: string[] };
  }> = [];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => null,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 1 }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder-1" }),
      postAudit: async (_channelId, body) => {
        auditBodies.push(body as (typeof auditBodies)[number]);
      },
    },
    { recordId: () => "record-secret", imageId: () => "image-secret" },
    undefined,
    () => 100,
  );

  await service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: { permissions: "0", roles: ["staff"], user: { id: "hider", username: "Hider" } },
    },
    sourceMessage: {
      id: "message",
      channel_id: "source",
      content: "proof https://clip.example/a",
      timestamp: "2026-01-01T00:00:00.000Z",
      author: { id: "author", username: "Author", global_name: null },
    },
  });

  assert.deepEqual(auditBodies[0]?.allowed_mentions, { parse: [] });
  assert.equal(auditBodies[0]?.embeds?.[0]?.title, "Evidence Vault Hide");
  assert.deepEqual(auditBodies[0]?.embeds?.[0]?.fields, [
    { name: "Hider", value: "<@hider>\nID: hider", inline: false },
    { name: "Source channel", value: "<#source>", inline: false },
    { name: "Source author", value: "<@author>\nID: author", inline: false },
    {
      name: "Evidence",
      value: "Text: yes\nLinks: 1\nImages: 0\nTotal image bytes: 0",
      inline: false,
    },
    { name: "Result", value: "active", inline: false },
    {
      name: "Placeholder",
      value: "https://discord.com/channels/guild-1/source/placeholder-1",
      inline: false,
    },
  ]);
});

test("denied hideEvidence audits source author and evidence counts without granting access", async () => {
  const auditBodies: Array<{
    embeds?: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
    allowed_mentions?: { parse?: string[] };
  }> = [];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => null,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 1 }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {
        throw new Error("denied users must not delete messages");
      },
      postPlaceholder: async () => {
        throw new Error("denied users must not post placeholders");
      },
      postAudit: async (_channelId, body) => {
        auditBodies.push(body as (typeof auditBodies)[number]);
      },
    },
  );

  const result = await service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: { permissions: "0", roles: [], user: { id: "hider", username: "Hider" } },
    },
    sourceMessage: {
      id: "message",
      channel_id: "source",
      content: "proof https://clip.example/a",
      author: { id: "author", username: "Author", global_name: null },
      attachments: [
        {
          id: "att-1",
          filename: "proof.png",
          content_type: "image/png",
          size: 4,
          url: "https://cdn/proof.png",
        },
      ],
    },
  });

  assert.deepEqual(result, { ok: false, message: "You do not have access to Evidence Vault." });
  assert.equal(auditBodies[0]?.embeds?.[0]?.title, "Evidence Vault Hide");
  assert.deepEqual(auditBodies[0]?.embeds?.[0]?.fields, [
    { name: "Hider", value: "<@hider>\nID: hider", inline: false },
    { name: "Source channel", value: "<#source>", inline: false },
    { name: "Source author", value: "<@author>\nID: author", inline: false },
    {
      name: "Evidence",
      value: "Text: yes\nLinks: 1\nImages: 1\nTotal image bytes: 4",
      inline: false,
    },
    { name: "Result", value: "denied", inline: false },
    { name: "Placeholder", value: "not posted", inline: false },
  ]);
  assert.deepEqual(auditBodies[0]?.allowed_mentions, { parse: [] });
});

test("Evidence Vault access allows configured role members without generic app admin access", () => {
  assert.equal(
    hasEvidenceVaultAccess(
      {
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "0", roles: ["evidence-role"], user: { id: "staff-1" } },
      },
      ["evidence-role"],
    ),
    true,
  );
});

test("Evidence Vault access allows members with any configured access role", () => {
  assert.equal(
    hasEvidenceVaultAccess(
      {
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "0", roles: ["support-role"], user: { id: "staff-1" } },
      },
      ["evidence-role", "support-role"],
    ),
    true,
  );
});

test("viewEvidence returns evidence ephemerally for authorized users and audits denied users", async () => {
  const audits: Array<{
    embeds?: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
    allowed_mentions?: { parse?: string[] };
  }> = [];
  const record = {
    id: "record",
    guildId: "guild-1",
    sourceChannelId: "source",
    sourceMessageId: "message",
    sourceAuthorId: "author",
    sourceAuthorDisplayName: "Author",
    sourceMessageTimestamp: null,
    hiderId: "hider",
    hiderDisplayName: "Hider",
    hiddenAtMs: 1,
    status: "active" as const,
    sourceText: "secret text",
    links: ["https://clip.example/a"],
    images: [
      {
        id: "image",
        filename: "proof.png",
        contentType: "image/png",
        sizeBytes: 4,
        r2Key: "guild-1/key",
        url: "/evidence-vault/images/record/image",
      },
    ],
    totalImageBytes: 4,
    placeholderChannelId: "source",
    placeholderMessageId: "placeholder",
  };
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => record,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {} as never,
      guildR2Objects: {} as never,
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "p" }),
      postAudit: async (_c, body) => {
        audits.push(body);
      },
    },
    undefined,
    undefined,
    undefined,
  );

  const allowed = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });
  const denied = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: [], user: { id: "denied" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });

  assert.equal(allowed.allowed, true);
  assert.match(allowed.content, /secret text/);
  assert.match(allowed.content, /Protected media is temporarily unavailable/);
  assert.equal(denied.allowed, false);
  assert.doesNotMatch(denied.content, /secret text/);
  assert.equal(audits.length, 2);
  assert.equal(audits[0]?.embeds?.[0]?.title, "Evidence Vault View");
  assert.deepEqual(audits[0]?.embeds?.[0]?.fields, [
    { name: "Viewer", value: "<@viewer>\nID: viewer", inline: false },
    { name: "Evidence record", value: "record", inline: false },
    { name: "Source channel", value: "<#source>", inline: false },
    { name: "Result", value: "allowed", inline: false },
    {
      name: "Placeholder",
      value: "https://discord.com/channels/guild-1/source/placeholder",
      inline: false,
    },
  ]);
  assert.deepEqual(audits[1]?.allowed_mentions, { parse: [] });
  assert.deepEqual(audits[1]?.embeds?.[0]?.fields, [
    { name: "Viewer", value: "<@denied>\nID: denied", inline: false },
    { name: "Evidence record", value: "record", inline: false },
    { name: "Source channel", value: "<#source>", inline: false },
    { name: "Result", value: "denied", inline: false },
    {
      name: "Placeholder",
      value: "https://discord.com/channels/guild-1/source/placeholder",
      inline: false,
    },
  ]);
});

test("viewEvidence denies cross-guild component payloads", async () => {
  const record = {
    id: "record",
    guildId: "guild-1",
    sourceChannelId: "source",
    sourceMessageId: "message",
    sourceAuthorId: "author",
    sourceAuthorDisplayName: "Author",
    sourceMessageTimestamp: null,
    hiderId: "hider",
    hiderDisplayName: "Hider",
    hiddenAtMs: 1,
    status: "active" as const,
    sourceText: "secret text",
    links: [],
    images: [],
    totalImageBytes: 0,
    placeholderChannelId: "source",
    placeholderMessageId: "placeholder",
  };
  let configReads = 0;
  let updates = 0;
  let audits = 0;
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => {
          configReads += 1;
          return {
            guildId: "guild-1",
            auditChannelId: "audit",
            accessRoleIds: ["staff"],
            updatedAtMs: 1,
          };
        },
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => record,
        updateRecordEvidenceFieldValues: async () => {
          updates += 1;
        },
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {} as never,
      guildR2Objects: {} as never,
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "p" }),
      postAudit: async () => {
        audits += 1;
      },
    },
  );

  const result = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-2",
      member: { permissions: String(1n << 3n), roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });

  assert.equal(result.allowed, false);
  assert.doesNotMatch(result.content, /secret text/);
  const modal = await service.buildAddDetailsModal({
    interaction: {
      type: 3,
      guild_id: "guild-2",
      member: { permissions: String(1n << 3n), roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
  });
  const submit = await service.submitEvidenceDetails({
    interaction: {
      type: 5,
      guild_id: "guild-2",
      member: { permissions: String(1n << 3n), roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    values: { case_ref: "CASE-2" },
  });

  assert.equal(modal.ok, false);
  assert.equal(submit.ok, false);
  assert.equal(configReads, 0);
  assert.equal(updates, 0);
  assert.equal(audits, 0);
});

test("viewEvidence applies a per-button cooldown for the same viewer", async () => {
  const record = {
    id: "record",
    guildId: "guild-1",
    sourceChannelId: "source",
    sourceMessageId: "message",
    sourceAuthorId: "author",
    sourceAuthorDisplayName: "Author",
    sourceMessageTimestamp: null,
    hiderId: "hider",
    hiderDisplayName: "Hider",
    hiddenAtMs: 1,
    status: "active" as const,
    sourceText: "secret text",
    links: [],
    images: [],
    totalImageBytes: 0,
    placeholderChannelId: "source",
    placeholderMessageId: "placeholder",
  };
  let now = 1_000;
  const cooldownState = new Map<string, number>();
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async () => record,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {} as never,
      guildR2Objects: {} as never,
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "p" }),
      postAudit: async () => {},
    },
    undefined,
    undefined,
    () => now,
    {
      get: async (key) => cooldownState.get(key) ?? null,
      put: async (key, expiresAtMs) => {
        cooldownState.set(key, expiresAtMs);
      },
    },
  );

  const first = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });
  const second = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });

  now += 60_001;
  const third = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record",
    requestOrigin: "https://worker.example",
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.match(second.content, /on cooldown/);
  assert.equal(third.allowed, true);
});

test("viewEvidence cooldown is scoped per button record", async () => {
  const records: Record<string, EvidenceVaultRecord> = {
    "record-a": {
      id: "record-a",
      guildId: "guild-1",
      sourceChannelId: "source",
      sourceMessageId: "message-a",
      sourceAuthorId: "author",
      sourceAuthorDisplayName: "Author",
      sourceMessageTimestamp: null,
      hiderId: "hider",
      hiderDisplayName: "Hider",
      hiddenAtMs: 1,
      status: "active",
      sourceText: "evidence a",
      links: [],
      images: [],
      totalImageBytes: 0,
      placeholderChannelId: "source",
      placeholderMessageId: "placeholder-a",
      subjectUserIds: [],
      subjectsEnabled: false,
    },
    "record-b": {
      id: "record-b",
      guildId: "guild-1",
      sourceChannelId: "source",
      sourceMessageId: "message-b",
      sourceAuthorId: "author",
      sourceAuthorDisplayName: "Author",
      sourceMessageTimestamp: null,
      hiderId: "hider",
      hiderDisplayName: "Hider",
      hiddenAtMs: 1,
      status: "active",
      sourceText: "evidence b",
      links: [],
      images: [],
      totalImageBytes: 0,
      placeholderChannelId: "source",
      placeholderMessageId: "placeholder-b",
      subjectUserIds: [],
      subjectsEnabled: false,
    },
  };
  const cooldownState = new Map<string, number>();
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: ["staff"],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {},
        readRecord: async (recordId: string) => records[recordId] ?? null,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {} as never,
      guildR2Objects: {} as never,
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "p" }),
      postAudit: async () => {},
    },
    undefined,
    undefined,
    () => 1_000,
    {
      get: async (key) => cooldownState.get(key) ?? null,
      put: async (key, expiresAtMs) => {
        cooldownState.set(key, expiresAtMs);
      },
    },
  );

  const first = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record-a",
    requestOrigin: "https://worker.example",
  });
  const secondDifferentRecord = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record-b",
    requestOrigin: "https://worker.example",
  });
  const thirdSameRecord = await service.viewEvidence({
    interaction: {
      type: 3,
      guild_id: "guild-1",
      member: { permissions: "0", roles: ["staff"], user: { id: "viewer" } },
    },
    recordId: "record-a",
    requestOrigin: "https://worker.example",
  });

  assert.equal(first.allowed, true);
  assert.equal(secondDifferentRecord.allowed, true);
  assert.equal(thirdSameRecord.allowed, false);
});

test("hideEvidence cleans up uploaded images when persistence fails", async () => {
  const calls: string[] = [];
  const service = new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: [],
          updatedAtMs: 1,
        }),
        upsertConfig: async () => {},
        createRecord: async () => {
          calls.push("create-record");
          throw new Error("D1 unavailable");
        },
        readRecord: async () => null,
        updateRecordStatus: async () => {},
        updateRecordPlaceholder: async () => {},
        readImage: async () => null,
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 1 }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    {
      putImage: async () => {
        calls.push("put-image");
      },
      getImage: async () => null,
      deleteImage: async () => {
        calls.push("delete-image");
      },
    },
    {
      deleteMessage: async () => {
        calls.push("delete-message");
      },
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
    { recordId: () => "record", imageId: () => "image" },
    { fetch: async () => new ArrayBuffer(4) },
  );

  await assert.rejects(
    service.hideEvidence({
      interaction: {
        type: 2,
        guild_id: "guild-1",
        channel_id: "source",
        member: { permissions: String(1n << 3n), roles: [], user: { id: "hider" } },
      },
      sourceMessage: {
        id: "message",
        channel_id: "source",
        content: "proof",
        attachments: [
          {
            id: "att-1",
            filename: "proof.png",
            content_type: "image/png",
            size: 4,
            url: "https://cdn/proof.png",
          },
        ],
      },
    }),
    /D1 unavailable/,
  );

  assert.deepEqual(calls, ["put-image", "create-record", "delete-image"]);
});

test("placeholder button custom IDs use unguessable record IDs", () => {
  const message = buildEvidenceVaultPlaceholderMessage("record-secret", "Hider");
  const customId = (message.components[0]!.components[0] as { custom_id: string }).custom_id;
  assert.equal(parseEvidenceVaultViewCustomId(customId), "record-secret");
});

test("formatEvidenceForDiscord ignores stored legacy image URLs", () => {
  assert.match(
    formatEvidenceForDiscord(
      {
        id: "record",
        guildId: "guild",
        sourceChannelId: "source",
        sourceMessageId: "message",
        sourceAuthorId: "author",
        sourceAuthorDisplayName: "Author",
        sourceMessageTimestamp: null,
        hiderId: "hider",
        hiderDisplayName: "Hider",
        hiddenAtMs: 1,
        status: "active",
        sourceText: "text",
        links: ["https://example.com"],
        images: [
          {
            id: "image",
            filename: "proof.png",
            contentType: "image/png",
            sizeBytes: 1,
            r2Key: "guild/key",
            url: "/evidence-vault/images/record/image",
          },
        ],
        totalImageBytes: 1,
        placeholderChannelId: null,
        placeholderMessageId: null,
        subjectUserIds: [],
        subjectsEnabled: false,
      },
      "https://worker.example",
    ),
    /Protected media is temporarily unavailable/,
  );
});

test("formatEvidenceForDiscord hides archived values and displays current Evidence Field labels", () => {
  const record = buildRecord({
    evidenceFieldValues: [
      { key: "case_ref", label: "Old case label", type: "short_text", value: "CASE-123" },
      { key: "deleted", label: "Deleted field", type: "short_text", value: "hidden" },
    ],
  });

  const content = formatEvidenceForDiscord(record, "", [
    { key: "case_ref", label: "Case reference", type: "short_text" },
  ]);

  assert.match(content, /Case reference: CASE-123/);
  assert.doesNotMatch(content, /Old case label/);
  assert.doesNotMatch(content, /Deleted field/);
});

function createRecordLimitService(state: {
  tier: "free" | "premium" | "premium_plus";
  count: number;
}): EvidenceVaultService {
  return new EvidenceVaultService(
    {
      evidenceVault: {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit",
          accessRoleIds: [],
          subjectsEnabled: false,
          updatedAtMs: 1,
        }),
        listRecords: async () =>
          Array.from({ length: state.count }, (_, index) => buildRecord({ id: `record-${index}` })),
        createRecord: async () => {
          state.count += 1;
        },
        updateRecordPlaceholder: async () => {},
      },
      guildEntitlements: {
        readGuildEntitlement: async () => ({
          guildId: "guild-1",
          tier: state.tier,
          updatedAtMs: 1,
        }),
      },
      guildR2Objects: { getGuildUsageBytes: async () => 0 },
    } as never,
    undefined,
    {
      deleteMessage: async () => {},
      postPlaceholder: async () => ({ id: "placeholder" }),
      postAudit: async () => {},
    },
    { recordId: () => "new-record", imageId: () => "new-image" },
  );
}

function hideTextEvidence(service: EvidenceVaultService, messageId: string) {
  return service.hideEvidence({
    interaction: {
      type: 2,
      guild_id: "guild-1",
      channel_id: "source",
      member: {
        permissions: String(1n << 3n),
        roles: [],
        user: { id: "hider", username: "Hider" },
      },
    },
    sourceMessage: { id: messageId, channel_id: "source", content: "proof" },
  });
}

function buildRecord(overrides: Partial<EvidenceVaultRecord> = {}): EvidenceVaultRecord {
  return {
    id: "record",
    guildId: "guild-1",
    sourceChannelId: "source",
    sourceMessageId: "message",
    sourceAuthorId: "author",
    sourceAuthorDisplayName: "Author",
    sourceMessageTimestamp: null,
    hiderId: "hider",
    hiderDisplayName: "Hider",
    hiddenAtMs: 1,
    status: "active",
    sourceText: "proof",
    links: [],
    images: [],
    totalImageBytes: 0,
    placeholderChannelId: "source",
    placeholderMessageId: "placeholder",
    subjectUserIds: [],
    subjectsEnabled: true,
    ...overrides,
  };
}

test("disabling Evidence Vault pauses new captures while retaining authorised evidence viewing", async () => {
  const fixture = createProductionRuntimeStores();
  let deletions = 0;
  const audits: unknown[] = [];
  try {
    await fixture.stores.evidenceVault.upsertConfig({
      guildId: "guild-1",
      enabled: false,
      auditChannelId: "audit",
      accessRoleIds: [],
      subjectsEnabled: false,
      updatedAtMs: 1,
    });
    await fixture.stores.evidenceVault.createRecord(buildRecord());
    const service = new EvidenceVaultService(fixture.stores, undefined, {
      async deleteMessage() {
        deletions++;
      },
      async postPlaceholder() {
        return { id: "placeholder" };
      },
      async postAudit(...args) {
        audits.push(args);
      },
    });
    const capture = await hideTextEvidence(service, "new-message");
    assert.equal(capture.ok, false);
    assert.equal(deletions, 0);
    const view = await service.viewEvidence({
      interaction: {
        type: 3,
        guild_id: "guild-1",
        member: { permissions: String(1n << 3n), roles: [], user: { id: "admin" } },
      },
      recordId: "record",
      requestOrigin: "",
    });
    assert.equal(view.allowed, true);
    assert.equal(audits.length, 1);
    assert.equal((await fixture.stores.evidenceVault.listRecords("guild-1")).length, 1);
  } finally {
    fixture.close();
  }
});
