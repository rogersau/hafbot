import type {
  CreateChannelMessageInput,
  DiscordMessageAttachmentResource,
} from "./discord/messages";
import { buildAuditEmbed, formatStaffUserReference, suppressMentions } from "./discord/messages";
import {
  DISCORD_BUTTON_COMPONENT,
  DISCORD_MESSAGE_COMPONENT_ROW,
  DISCORD_TEXT_INPUT_COMPONENT,
} from "./discord/constants";
import type {
  DiscordInteraction,
  EvidenceVaultBlobStore,
  RuntimeStores,
} from "./runtime/app-types";
import { resolveInteractionDisplayName, resolveMessageDisplayName } from "./runtime/discord-user";
import { isInteractionBoundToGuild } from "./runtime/interaction-guild-binding";
import {
  DEFAULT_IDENTITY_PATTERNS,
  formatSubjectsForEmbed,
  parseUserInput,
  scanSourceText,
} from "./evidence-vault-subjects";
import type {
  EvidenceVaultImage,
  EvidenceVaultRecord,
  EvidenceFieldDefinition,
  EvidenceFieldValue,
  IdentityPattern,
  SubjectIdentifier,
} from "./types";
import { getGuildEntitlementLimits } from "./types";

import { resolveAuditChannelId } from "./services/guild-audit-log-service";

export const HIDE_EVIDENCE_COMMAND_NAME = "Hide Evidence";
export const EVIDENCE_VAULT_PLACEHOLDER_CUSTOM_ID_PREFIX = "evidence-vault:see";
export const EVIDENCE_VAULT_SEARCH_CUSTOM_ID_PREFIX = "evidence-vault:search";
export const EVIDENCE_VAULT_DETAILS_CUSTOM_ID_PREFIX = "evidence-vault:details";
export const EVIDENCE_VAULT_FIELD_SEARCH_CUSTOM_ID = "evidence-vault:field-search";

const HTTP_LINK_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const MAX_TEXT_LENGTH = 1_500;
const MAX_LINKS = 20;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const EVIDENCE_VAULT_VIEW_COOLDOWN_MS = 60_000;

export interface EvidenceVaultSourceMessage {
  id: string;
  channel_id?: string;
  content?: string;
  timestamp?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
  attachments?: DiscordMessageAttachmentResource[];
}

export interface EvidenceVaultDiscordAdapter {
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  postPlaceholder(
    channelId: string,
    recordId: string,
    hiderDisplayName: string,
    hasEvidenceFields?: boolean,
    guildId?: string,
  ): Promise<{ id: string }>;
  postAudit(channelId: string, body: CreateChannelMessageInput): Promise<void>;
}

export interface EvidenceVaultIdGenerator {
  recordId(): string;
  imageId(): string;
}

export interface EvidenceVaultImageFetcher {
  fetch(url: string): Promise<ArrayBuffer>;
}

export interface EvidenceVaultViewCooldownStore {
  get(key: string): Promise<number | null>;
  put(key: string, expiresAtMs: number, ttlSeconds: number): Promise<void>;
}

export interface EvidenceMediaLinkIssuer {
  issue(input: {
    guildId: string;
    recordId: string;
    imageId: string;
    expiresAtSeconds: number;
  }): Promise<string>;
}

export class EvidenceVaultService {
  constructor(
    private readonly stores: Pick<
      RuntimeStores,
      "evidenceVault" | "guildEntitlements" | "guildR2Objects" | "guildAuditLog"
    >,
    private readonly blobs: EvidenceVaultBlobStore | undefined,
    private readonly discord: EvidenceVaultDiscordAdapter,
    private readonly ids: EvidenceVaultIdGenerator = defaultEvidenceVaultIdGenerator,
    private readonly imageFetcher: EvidenceVaultImageFetcher = defaultImageFetcher,
    private readonly now: () => number = () => Date.now(),
    private readonly viewCooldownStore?: EvidenceVaultViewCooldownStore,
    private readonly evidenceMediaLinkIssuer?: EvidenceMediaLinkIssuer,
  ) {}

  async hideEvidence(input: {
    interaction: DiscordInteraction;
    sourceMessage: EvidenceVaultSourceMessage;
  }): Promise<
    { ok: true; record: EvidenceVaultRecord; message: string } | { ok: false; message: string }
  > {
    const guildId = input.interaction.guild_id;
    const channelId = input.sourceMessage.channel_id ?? input.interaction.channel_id;
    if (!guildId || !channelId) {
      return { ok: false, message: "Could not determine the source message location." };
    }

    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config) {
      return {
        ok: false,
        message: "Evidence Vault needs an audit channel before evidence can be hidden.",
      };
    }

    if (config.enabled === false) {
      return {
        ok: false,
        message: "Evidence Vault is disabled. Existing evidence remains available.",
      };
    }

    const auditChannelId =
      config.auditChannelId ??
      (await resolveAuditChannelId(
        guildId,
        null,
        this.stores.guildAuditLog,
        "evidence-vault.hide",
      ));
    if (!auditChannelId) {
      return {
        ok: false,
        message: "Evidence Vault needs an audit channel before evidence can be hidden.",
      };
    }

    if (!hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      await this.discord.postAudit(
        auditChannelId,
        buildDeniedHideAudit(input.interaction, input.sourceMessage, channelId),
      );
      return { ok: false, message: "You do not have access to Evidence Vault." };
    }

    if (isEvidenceVaultSystemMessage(input.sourceMessage)) {
      return {
        ok: false,
        message: "Evidence Vault placeholders and audit messages cannot be hidden.",
      };
    }

    const extracted = extractEvidence(input.sourceMessage);
    if (!extracted.ok) return extracted;

    const entitlement = await this.stores.guildEntitlements.readGuildEntitlement(guildId);
    const entitlementLimits = getGuildEntitlementLimits(entitlement.tier);
    const recordLimit = entitlementLimits.evidenceVaultMaxRecords;
    if (
      typeof recordLimit === "number" &&
      (await this.stores.evidenceVault.listRecords(guildId)).length >= recordLimit
    ) {
      return {
        ok: false,
        message: `Evidence Vault is at the Free plan limit of ${recordLimit} records. Remove records or upgrade before hiding more evidence.`,
      };
    }

    const quotaUsedBytes = await this.stores.guildR2Objects.getGuildUsageBytes(guildId);
    const quota = entitlementLimits.r2MaxBytes;
    if (quotaUsedBytes + extracted.totalImageBytes > quota) {
      return { ok: false, message: "This evidence would exceed the Guild R2 quota." };
    }

    if (extracted.attachments.length > 0 && !this.blobs) {
      return { ok: false, message: "Evidence image storage is not configured." };
    }

    const recordId = this.ids.recordId();
    const images: EvidenceVaultImage[] = [];
    let record: EvidenceVaultRecord;
    try {
      for (const attachment of extracted.attachments) {
        const imageId = this.ids.imageId();
        const contentType = resolveSupportedImageContentType(attachment)!;
        const filename =
          attachment.filename || `${imageId}.${extensionForContentType(contentType)}`;
        const r2Key = buildEvidenceVaultImageStorageKey(guildId, recordId, imageId, filename);
        const data = await this.imageFetcher.fetch(attachment.url);
        await this.blobs!.putImage(r2Key, data, {
          contentType,
          sizeBytes: attachment.size ?? data.byteLength,
        });
        images.push({
          id: imageId,
          filename,
          contentType,
          sizeBytes: attachment.size ?? data.byteLength,
          r2Key,
        });
      }

      record = {
        id: recordId,
        guildId,
        sourceChannelId: channelId,
        sourceMessageId: input.sourceMessage.id,
        sourceAuthorId: input.sourceMessage.author?.id ?? "unknown",
        sourceAuthorDisplayName: resolveDiscordMessageDisplayName(input.sourceMessage),
        sourceMessageTimestamp: input.sourceMessage.timestamp ?? null,
        hiderId: getInteractionUserId(input.interaction) ?? "unknown",
        hiderDisplayName:
          resolveInteractionDisplayName(input.interaction, { terminalFallback: "unknown" }) ??
          "unknown",
        hiddenAtMs: this.now(),
        status: "active",
        sourceText: extracted.sourceText,
        links: extracted.links,
        images,
        totalImageBytes: extracted.totalImageBytes,
        placeholderChannelId: null,
        placeholderMessageId: null,
        subjectUserIds: config.subjectsEnabled
          ? scanSourceText(
              extracted.sourceText,
              extracted.links,
              await readEnabledIdentityPatterns(this.stores.evidenceVault),
            )
          : [],
        subjectsEnabled: config.subjectsEnabled,
        evidenceFieldValues: [],
      };

      await this.stores.evidenceVault.createRecord(record);
    } catch (error) {
      await this.deleteUploadedImages(guildId, images);
      throw error;
    }

    try {
      await this.discord.deleteMessage(channelId, input.sourceMessage.id);
    } catch {
      await this.stores.evidenceVault.updateRecordStatus(recordId, "source-delete-failed");
      record.status = "source-delete-failed";
      await this.discord.postAudit(auditChannelId, buildHideAudit(record));
      return {
        ok: true,
        record,
        message:
          "Evidence was saved, but the original message could not be deleted. Delete it manually.",
      };
    }

    try {
      const placeholder = await this.discord.postPlaceholder(
        channelId,
        recordId,
        record.hiderDisplayName,
        (config.evidenceFields ?? []).length > 0,
        guildId,
      );
      await this.stores.evidenceVault.updateRecordPlaceholder(recordId, {
        channelId,
        messageId: placeholder.id,
        status: "active",
      });
      record.placeholderChannelId = channelId;
      record.placeholderMessageId = placeholder.id;
    } catch {
      await this.stores.evidenceVault.updateRecordStatus(recordId, "placeholder-post-failed");
      record.status = "placeholder-post-failed";
      await this.discord.postAudit(auditChannelId, buildHideAudit(record));
      return {
        ok: true,
        record,
        message: "Evidence was saved, but the placeholder could not be posted.",
      };
    }

    await this.discord.postAudit(auditChannelId, buildHideAudit(record));
    return { ok: true, record, message: "Evidence hidden in the Evidence Vault." };
  }

  async viewEvidence(input: {
    interaction: DiscordInteraction;
    recordId: string;
    requestOrigin: string;
  }): Promise<{ content: string; allowed: boolean }> {
    const record = await this.stores.evidenceVault.readRecord(input.recordId);
    if (!record) {
      return { allowed: false, content: "Evidence is not available." };
    }
    if (!isInteractionBoundToGuild(input.interaction, record.guildId)) {
      return { allowed: false, content: "You do not have access to Evidence Vault." };
    }

    const config = await this.stores.evidenceVault.readConfig(record.guildId);
    const auditChannelId =
      config?.auditChannelId ??
      (await resolveAuditChannelId(
        record.guildId,
        null,
        this.stores.guildAuditLog,
        "evidence-vault.view",
      ));
    const allowed = Boolean(
      config && hasEvidenceVaultAccess(input.interaction, config.accessRoleIds),
    );
    const blockedByCooldown = allowed
      ? await this.consumeEvidenceViewCooldown(input.recordId, input.interaction)
      : false;
    const permitted = allowed && !blockedByCooldown;
    if (auditChannelId) {
      await this.discord.postAudit(
        auditChannelId,
        buildViewAudit(record, input.interaction, permitted),
      );
    }
    if (!allowed) {
      return { allowed: false, content: "You do not have access to Evidence Vault." };
    }
    if (!permitted) {
      return {
        allowed: false,
        content: "This evidence view is on cooldown. Try again in about 60 seconds.",
      };
    }

    const imageUrls = new Map<string, string>();
    if (this.evidenceMediaLinkIssuer) {
      const expiresAtSeconds = Math.floor(this.now() / 1000) + 10 * 60;
      for (const image of record.images) {
        const access = await this.evidenceMediaLinkIssuer.issue({
          guildId: record.guildId,
          recordId: record.id,
          imageId: image.id,
          expiresAtSeconds,
        });
        imageUrls.set(
          image.id,
          `${input.requestOrigin}${buildEvidenceVaultImagePath(record.id, image.id)}?access=${encodeURIComponent(access)}`,
        );
      }
    }
    return {
      allowed: true,
      content: formatEvidenceForDiscord(
        record,
        input.requestOrigin,
        config?.evidenceFields ?? [],
        imageUrls,
      ),
    };
  }

  async searchEvidence(input: { interaction: DiscordInteraction; userInput: string }): Promise<{
    allowed: boolean;
    content: string;
    message: EvidenceVaultSearchMessage | null;
    records: EvidenceVaultRecord[];
  }> {
    const guildId = input.interaction.guild_id;
    if (!guildId)
      return {
        allowed: false,
        content: "This command can only be used inside a server.",
        message: null,
        records: [],
      };

    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config)
      return {
        allowed: false,
        content: "Evidence Vault needs an audit channel before search can run.",
        message: null,
        records: [],
      };
    const auditChannelId =
      config.auditChannelId ??
      (await resolveAuditChannelId(
        guildId,
        null,
        this.stores.guildAuditLog,
        "evidence-vault.search",
      ));
    if (!auditChannelId)
      return {
        allowed: false,
        content: "Evidence Vault needs an audit channel before search can run.",
        message: null,
        records: [],
      };
    if (!config.subjectsEnabled) {
      return {
        allowed: false,
        content: "Evidence Vault subjects are not enabled for this server.",
        message: null,
        records: [],
      };
    }

    if (!hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      await this.discord.postAudit(
        auditChannelId,
        buildSearchAudit(input.interaction, input.userInput, null, 0, null, false),
      );
      return {
        allowed: false,
        content: "You do not have access to Evidence Vault.",
        message: null,
        records: [],
      };
    }

    const patterns = await readEnabledIdentityPatterns(this.stores.evidenceVault);
    const resolved = parseUserInput(input.userInput, patterns);
    if (!resolved) {
      await this.discord.postAudit(
        auditChannelId,
        buildSearchAudit(input.interaction, input.userInput, null, 0, null, true),
      );
      return {
        allowed: true,
        content:
          "Supported identifiers: Discord mention or ID; SteamID64 or steamcommunity.com/profiles/<id>; raw Xbox XUID; cftools URL.",
        message: null,
        records: [],
      };
    }

    const records = await this.stores.evidenceVault.searchRecordsBySubject(guildId, resolved);
    await this.discord.postAudit(
      auditChannelId,
      buildSearchAudit(
        input.interaction,
        input.userInput,
        resolved,
        records.length,
        records[0] ?? null,
        true,
      ),
    );
    return {
      allowed: true,
      content:
        records.length === 0
          ? `No Evidence Vault records found for ${formatSubjectIdentifier(resolved)}.`
          : "",
      message: buildEvidenceSearchMessage(resolved, records, 0),
      records,
    };
  }

  async renderEvidenceSearchPage(input: {
    interaction: DiscordInteraction;
    subject: SubjectIdentifier;
    page: number;
  }): Promise<EvidenceVaultSearchMessage | null> {
    const guildId = input.interaction.guild_id;
    if (!guildId) return null;
    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (
      !config?.subjectsEnabled ||
      !hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)
    ) {
      return null;
    }
    const records = await this.stores.evidenceVault.searchRecordsBySubject(guildId, input.subject);
    return buildEvidenceSearchMessage(input.subject, records, input.page);
  }

  async buildEvidenceFieldSearchModal(input: {
    interaction: DiscordInteraction;
  }): Promise<
    { ok: true; modal: EvidenceVaultModalResponseData } | { ok: false; message: string }
  > {
    const guildId = input.interaction.guild_id;
    if (!guildId) return { ok: false, message: "This command can only be used inside a server." };
    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config)
      return { ok: false, message: "Evidence Vault needs an audit channel before search can run." };
    if (!hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      return { ok: false, message: "You do not have access to Evidence Vault." };
    }
    const fields = normalizeEvidenceFieldDefinitions(config.evidenceFields);
    if (fields.length === 0) return { ok: false, message: "Evidence Fields are not configured." };
    return { ok: true, modal: buildEvidenceFieldSearchModal(fields) };
  }

  async buildAddDetailsModal(input: {
    interaction: DiscordInteraction;
    recordId: string;
  }): Promise<
    { ok: true; modal: EvidenceVaultModalResponseData } | { ok: false; message: string }
  > {
    const record = await this.stores.evidenceVault.readRecord(input.recordId);
    if (!record) return { ok: false, message: "Evidence is not available." };
    if (!isInteractionBoundToGuild(input.interaction, record.guildId)) {
      return { ok: false, message: "You do not have access to Evidence Vault." };
    }
    const config = await this.stores.evidenceVault.readConfig(record.guildId);
    if (!config || !hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      return { ok: false, message: "You do not have access to Evidence Vault." };
    }
    const fields = normalizeEvidenceFieldDefinitions(config.evidenceFields);
    if (fields.length === 0) return { ok: false, message: "Evidence Fields are not configured." };
    return {
      ok: true,
      modal: buildEvidenceDetailsModal(input.recordId, fields, record.evidenceFieldValues ?? []),
    };
  }

  async submitEvidenceDetails(input: {
    interaction: DiscordInteraction;
    recordId: string;
    values: Record<string, string>;
  }): Promise<{ ok: boolean; message: string; record: EvidenceVaultRecord | null }> {
    const record = await this.stores.evidenceVault.readRecord(input.recordId);
    if (!record) return { ok: false, message: "Evidence is not available.", record: null };
    if (!isInteractionBoundToGuild(input.interaction, record.guildId)) {
      return { ok: false, message: "You do not have access to Evidence Vault.", record };
    }
    const config = await this.stores.evidenceVault.readConfig(record.guildId);
    const auditChannelId =
      config?.auditChannelId ??
      (await resolveAuditChannelId(
        record.guildId,
        null,
        this.stores.guildAuditLog,
        "evidence-vault.subject-amend",
      ));
    if (!config || !hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      return { ok: false, message: "You do not have access to Evidence Vault.", record };
    }

    const fields = normalizeEvidenceFieldDefinitions(config.evidenceFields);
    if (fields.length === 0)
      return { ok: false, message: "Evidence Fields are not configured.", record };

    const current = record.evidenceFieldValues ?? [];
    const next = new Map(current.map((value) => [value.key, value]));
    const changes: Array<{ field: EvidenceFieldDefinition; before: string | null; after: string }> =
      [];
    for (const field of fields) {
      const raw = input.values[field.key]?.trim();
      if (!raw) continue;
      const normalized = normalizeEvidenceFieldInput(field, raw);
      if (!normalized.ok) {
        return { ok: false, message: normalized.message, record };
      }
      const before = next.get(field.key)?.value ?? null;
      if (before === normalized.value) continue;
      next.set(field.key, {
        key: field.key,
        label: field.label,
        type: field.type,
        value: normalized.value,
      });
      changes.push({ field, before, after: normalized.value });
    }

    const nextValues = [...next.values()];
    await this.stores.evidenceVault.updateRecordEvidenceFieldValues(record.id, nextValues);
    record.evidenceFieldValues = nextValues;
    if (auditChannelId) {
      for (const change of changes) {
        await this.discord.postAudit(
          auditChannelId,
          buildFieldValueAudit(input.interaction, record, change),
        );
      }
    }
    return {
      ok: true,
      message:
        changes.length === 0 ? "No Evidence Field values changed." : "Evidence Field values saved.",
      record,
    };
  }

  async searchEvidenceFields(input: {
    interaction: DiscordInteraction;
    values: Record<string, string>;
  }): Promise<{
    allowed: boolean;
    content: string;
    message: EvidenceVaultSearchMessage | null;
    records: EvidenceVaultRecord[];
  }> {
    const guildId = input.interaction.guild_id;
    if (!guildId)
      return {
        allowed: false,
        content: "This command can only be used inside a server.",
        message: null,
        records: [],
      };
    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config)
      return {
        allowed: false,
        content: "Evidence Vault needs an audit channel before search can run.",
        message: null,
        records: [],
      };
    if (!hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      return {
        allowed: false,
        content: "You do not have access to Evidence Vault.",
        message: null,
        records: [],
      };
    }
    const fields = normalizeEvidenceFieldDefinitions(config.evidenceFields);
    if (fields.length === 0)
      return {
        allowed: false,
        content: "Evidence Fields are not configured.",
        message: null,
        records: [],
      };

    const criteria = buildEvidenceFieldSearchCriteria(fields, input.values);
    const subjectInput = input.values.subject?.trim() ?? "";
    const sourceText = input.values.sourceText?.trim() ?? "";
    const patterns = await readEnabledIdentityPatterns(this.stores.evidenceVault);
    const subject = subjectInput ? parseUserInput(subjectInput, patterns) : null;
    if (subjectInput && !subject) {
      return {
        allowed: true,
        content:
          "Supported identifiers: Discord mention or ID; SteamID64 or steamcommunity.com/profiles/<id>; raw Xbox XUID; cftools URL.",
        message: null,
        records: [],
      };
    }
    const records = (await this.stores.evidenceVault.listRecords(guildId)).filter((record) =>
      evidenceRecordMatchesCriteria(record, fields, {
        fields: criteria,
        sourceText,
        subject,
      }),
    );
    return {
      allowed: true,
      content: records.length === 0 ? "No Evidence Vault records found." : "",
      message: buildEvidenceFieldSearchMessage(records, 0),
      records,
    };
  }

  async searchEvidenceFieldForm(input: {
    interaction: DiscordInteraction;
    subjectInput?: string | null;
    sourceText?: string | null;
    fieldInputs: string[];
  }): Promise<{
    allowed: boolean;
    content: string;
    message: EvidenceVaultSearchMessage | null;
    records: EvidenceVaultRecord[];
  }> {
    const guildId = input.interaction.guild_id;
    if (!guildId)
      return {
        allowed: false,
        content: "This command can only be used inside a server.",
        message: null,
        records: [],
      };

    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config)
      return {
        allowed: false,
        content: "Evidence Vault needs an audit channel before search can run.",
        message: null,
        records: [],
      };

    const fields = normalizeEvidenceFieldDefinitions(config.evidenceFields);
    const values: Record<string, string> = {};
    if (input.subjectInput?.trim()) values.subject = input.subjectInput.trim();
    if (input.sourceText?.trim()) values.sourceText = input.sourceText.trim();
    for (let index = 0; index < fields.length; index += 1) {
      const value = input.fieldInputs[index]?.trim();
      if (value) values[fields[index].key] = value;
    }

    return this.searchEvidenceFields({ interaction: input.interaction, values });
  }

  async amendEvidenceSubjects(input: {
    interaction: DiscordInteraction;
    recordId: string;
    action: "add" | "remove";
    userInput: string;
  }): Promise<{ ok: boolean; message: string; record: EvidenceVaultRecord | null }> {
    const guildId = input.interaction.guild_id;
    if (!guildId)
      return { ok: false, message: "This command can only be used inside a server.", record: null };

    const config = await this.stores.evidenceVault.readConfig(guildId);
    if (!config)
      return {
        ok: false,
        message: "Evidence Vault needs an audit channel before subjects can be amended.",
        record: null,
      };
    const auditChannelId =
      config.auditChannelId ??
      (await resolveAuditChannelId(
        guildId,
        null,
        this.stores.guildAuditLog,
        "evidence-vault.subject-amend",
      ));
    if (!auditChannelId)
      return {
        ok: false,
        message: "Evidence Vault needs an audit channel before subjects can be amended.",
        record: null,
      };
    if (!config.subjectsEnabled) {
      return {
        ok: false,
        message: "Evidence Vault subjects are not enabled for this server.",
        record: null,
      };
    }
    if (!hasEvidenceVaultAccess(input.interaction, config.accessRoleIds)) {
      return { ok: false, message: "You do not have access to Evidence Vault.", record: null };
    }

    const record = await this.stores.evidenceVault.readRecord(input.recordId);
    if (!record || record.guildId !== guildId) {
      return { ok: false, message: "Evidence is not available.", record: null };
    }
    const patterns = await readEnabledIdentityPatterns(this.stores.evidenceVault);
    const resolved = parseUserInput(input.userInput, patterns);
    if (!resolved) {
      return { ok: false, message: "Unsupported subject identifier.", record };
    }

    const before = record.subjectUserIds;
    const matches = (subject: SubjectIdentifier) =>
      subject.platform === resolved.platform && subject.id === resolved.id;
    const next =
      input.action === "add"
        ? before.some(matches)
          ? before
          : [...before, resolved]
        : before.filter((subject) => !matches(subject));
    await this.stores.evidenceVault.updateRecordSubjects(record.id, next);
    record.subjectUserIds = next;
    await this.discord.postAudit(
      auditChannelId,
      buildAmendAudit(
        input.interaction,
        record.id,
        `${input.action === "add" ? "+" : "-"}${formatSubjectIdentifier(resolved)}`,
      ),
    );
    return {
      ok: true,
      message: `Evidence Vault subjects updated: ${formatSubjectsForEmbed(next)}.`,
      record,
    };
  }

  private async consumeEvidenceViewCooldown(
    recordId: string,
    interaction: DiscordInteraction,
  ): Promise<boolean> {
    if (!this.viewCooldownStore) return false;

    const viewerId = getInteractionUserId(interaction) ?? "unknown";
    const key = `evidence-vault:view-cooldown:${recordId}:${viewerId}`;
    const now = this.now();
    const expiresAtMs = (await this.viewCooldownStore.get(key)) ?? 0;
    if (expiresAtMs > now) {
      return true;
    }

    const nextExpiresAtMs = now + EVIDENCE_VAULT_VIEW_COOLDOWN_MS;
    await this.viewCooldownStore.put(
      key,
      nextExpiresAtMs,
      Math.ceil(EVIDENCE_VAULT_VIEW_COOLDOWN_MS / 1000),
    );
    return false;
  }

  private async deleteUploadedImages(guildId: string, images: EvidenceVaultImage[]): Promise<void> {
    if (!this.blobs?.deleteImage) return;
    await Promise.all(
      images.map(async (image) => {
        try {
          await this.blobs!.deleteImage!(image.r2Key, {
            guildId,
            sizeBytes: image.sizeBytes,
          });
        } catch (error) {
          console.error("Failed to clean up Evidence Vault image after hide failure", error);
        }
      }),
    );
  }
}

async function readEnabledIdentityPatterns(
  store: RuntimeStores["evidenceVault"],
): Promise<IdentityPattern[]> {
  return "listEnabledIdentityPatterns" in store
    ? store.listEnabledIdentityPatterns()
    : DEFAULT_IDENTITY_PATTERNS;
}

export function extractEvidence(message: EvidenceVaultSourceMessage):
  | {
      ok: true;
      sourceText: string;
      links: string[];
      attachments: DiscordMessageAttachmentResource[];
      totalImageBytes: number;
    }
  | { ok: false; message: string } {
  const sourceText = message.content ?? "";
  if (sourceText.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      message: "Evidence text is too long. Split or summarize it before hiding.",
    };
  }

  const links = dedupeLinks(sourceText.match(HTTP_LINK_PATTERN) ?? []);
  if (links.length > MAX_LINKS) {
    return { ok: false, message: "Evidence has too many links. Split it before hiding." };
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const totalImageBytes = attachments.reduce((sum, attachment) => sum + (attachment.size ?? 0), 0);
  if (attachments.length > MAX_IMAGES) {
    return { ok: false, message: "Evidence can include at most 4 images." };
  }
  if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
    return { ok: false, message: "Evidence images are too large in total." };
  }
  for (const attachment of attachments) {
    if (!resolveSupportedImageContentType(attachment)) {
      return { ok: false, message: "Unsupported attachments cannot be hidden in Evidence Vault." };
    }
    if ((attachment.size ?? 0) > MAX_IMAGE_BYTES) {
      return { ok: false, message: "Each evidence image must be 8 MB or smaller." };
    }
  }

  if (!sourceText.trim() && links.length === 0 && attachments.length === 0) {
    return { ok: false, message: "This message does not contain supported evidence." };
  }

  return { ok: true, sourceText, links, attachments, totalImageBytes };
}

export function resolveSupportedImageContentType(
  attachment: Pick<DiscordMessageAttachmentResource, "content_type" | "filename">,
): string | null {
  const normalized = attachment.content_type?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (isSupportedImageContentType(normalized)) return normalized;
  const filename = attachment.filename.toLowerCase();
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".gif")) return "image/gif";
  if (filename.endsWith(".webp")) return "image/webp";
  return null;
}

export function buildEvidenceVaultImageStorageKey(
  guildId: string,
  recordId: string,
  imageId: string,
  filename: string,
): string {
  return `${guildId}/evidence-vault/${recordId}/images/${imageId}/${encodeURIComponent(filename)}`;
}

export function buildEvidenceVaultImagePath(recordId: string, imageId: string): string {
  return `/evidence-vault/images/${encodeURIComponent(recordId)}/${encodeURIComponent(imageId)}`;
}

export function buildEvidenceVaultPlaceholderMessage(recordId: string, hiderDisplayName: string) {
  return buildEvidenceVaultPlaceholderMessageWithOptions(recordId, hiderDisplayName, false);
}

export function buildEvidenceVaultPlaceholderMessageWithOptions(
  recordId: string,
  hiderDisplayName: string,
  hasEvidenceFields: boolean,
) {
  const components = [
    {
      type: DISCORD_BUTTON_COMPONENT,
      style: 1,
      label: "See Evidence",
      custom_id: `${EVIDENCE_VAULT_PLACEHOLDER_CUSTOM_ID_PREFIX}:${recordId}`,
    },
  ];
  if (hasEvidenceFields) {
    components.push({
      type: DISCORD_BUTTON_COMPONENT,
      style: 2,
      label: "Add Details",
      custom_id: buildEvidenceVaultDetailsCustomId(recordId),
    });
  }
  return {
    content: `Evidence hidden by ${hiderDisplayName}.`,
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function parseEvidenceVaultViewCustomId(customId: string): string | null {
  const prefix = `${EVIDENCE_VAULT_PLACEHOLDER_CUSTOM_ID_PREFIX}:`;
  return customId.startsWith(prefix) ? customId.slice(prefix.length) || null : null;
}

export function buildEvidenceVaultDetailsCustomId(recordId: string): string {
  return `${EVIDENCE_VAULT_DETAILS_CUSTOM_ID_PREFIX}:${recordId}`;
}

export function parseEvidenceVaultDetailsCustomId(customId: string): string | null {
  const prefix = `${EVIDENCE_VAULT_DETAILS_CUSTOM_ID_PREFIX}:`;
  return customId.startsWith(prefix) ? customId.slice(prefix.length) || null : null;
}

export function isEvidenceVaultFieldSearchCustomId(customId: string): boolean {
  return customId === EVIDENCE_VAULT_FIELD_SEARCH_CUSTOM_ID;
}

export interface EvidenceVaultModalResponseData {
  title: string;
  custom_id: string;
  components: Array<{
    type: number;
    components: Array<{
      type: number;
      custom_id: string;
      label: string;
      style: number;
      required: boolean;
      value?: string;
      placeholder?: string;
    }>;
  }>;
}

export function buildEvidenceDetailsModal(
  recordId: string,
  fields: EvidenceFieldDefinition[],
  values: EvidenceFieldValue[] = [],
): EvidenceVaultModalResponseData {
  const byKey = new Map(values.map((value) => [value.key, value.value]));
  return {
    title: "Add Evidence Details",
    custom_id: buildEvidenceVaultDetailsCustomId(recordId),
    components: normalizeEvidenceFieldDefinitions(fields).map((field) => ({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: [
        {
          type: DISCORD_TEXT_INPUT_COMPONENT,
          custom_id: field.key,
          label: field.label,
          style: field.type === "text" ? 2 : 1,
          required: false,
          ...(byKey.has(field.key) ? { value: byKey.get(field.key)! } : {}),
          ...(field.type === "enum"
            ? { placeholder: `Allowed: ${(field.allowedValues ?? []).join(", ")}`.slice(0, 100) }
            : {}),
        },
      ],
    })),
  };
}

export function buildEvidenceFieldSearchModal(
  fields: EvidenceFieldDefinition[],
): EvidenceVaultModalResponseData {
  return {
    title: "Search Evidence Vault",
    custom_id: EVIDENCE_VAULT_FIELD_SEARCH_CUSTOM_ID,
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_TEXT_INPUT_COMPONENT,
            custom_id: "sourceText",
            label: "Message text",
            style: 1,
            required: false,
          },
        ],
      },
      ...normalizeEvidenceFieldDefinitions(fields)
        .slice(0, 4)
        .map((field) => ({
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_TEXT_INPUT_COMPONENT,
              custom_id: field.key,
              label: field.label,
              style: field.type === "text" ? 2 : 1,
              required: false,
              ...(field.type === "enum"
                ? {
                    placeholder: `Allowed: ${(field.allowedValues ?? []).join(", ")}`.slice(0, 100),
                  }
                : {}),
            },
          ],
        })),
    ],
  };
}

export function buildEvidenceVaultSearchCustomId(subject: SubjectIdentifier, page: number): string {
  return `${EVIDENCE_VAULT_SEARCH_CUSTOM_ID_PREFIX}:${subject.platform}:${encodeURIComponent(subject.id)}:${page}`;
}

export function parseEvidenceVaultSearchCustomId(
  customId: string,
): { subject: SubjectIdentifier; page: number } | null {
  const prefix = `${EVIDENCE_VAULT_SEARCH_CUSTOM_ID_PREFIX}:`;
  if (!customId.startsWith(prefix)) return null;
  const [platform, encodedId, pageText] = customId.slice(prefix.length).split(":");
  if (!isSubjectPlatform(platform)) return null;
  const page = Number.parseInt(pageText ?? "", 10);
  if (!Number.isSafeInteger(page) || page < 0) return null;
  return { subject: { platform, id: decodeURIComponent(encodedId ?? "") }, page };
}

export function hasEvidenceVaultAccess(
  interaction: DiscordInteraction,
  accessRoleIds: string[],
): boolean {
  if (hasGuildAdminPermissionBits(interaction.member?.permissions ?? "")) return true;
  const memberRoles = interaction.member?.roles;
  return Boolean(
    accessRoleIds.length > 0 &&
    Array.isArray(memberRoles) &&
    accessRoleIds.some((roleId) => memberRoles.includes(roleId)),
  );
}

export function formatEvidenceForDiscord(
  record: EvidenceVaultRecord,
  _origin = "",
  evidenceFields: EvidenceFieldDefinition[] = [],
  protectedImageUrls?: ReadonlyMap<string, string>,
): string {
  const sections = ["Evidence Vault record:"];
  if (record.sourceText.trim()) sections.push(`Text:\n${record.sourceText}`);
  if (record.links.length > 0)
    sections.push(`Links:\n${record.links.map((link) => `- ${link}`).join("\n")}`);
  if (record.images.length > 0) {
    sections.push(
      `Images:\n${record.images
        .map((image) => {
          const protectedUrl = protectedImageUrls?.get(image.id);
          return protectedUrl
            ? `- ${protectedUrl}`
            : "- Protected media is temporarily unavailable.";
        })
        .join("\n")}`,
    );
  }
  if (record.subjectsEnabled) {
    sections.push(`Subjects: ${formatSubjectsForEmbed(record.subjectUserIds)}`);
  }
  const fieldValues =
    evidenceFields.length > 0
      ? getConformantEvidenceFieldValues(record, normalizeEvidenceFieldDefinitions(evidenceFields))
      : [];
  if (fieldValues.length > 0) {
    sections.push(
      `Evidence Fields:\n${fieldValues.map((field) => `${field.label}: ${field.value}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function formatEvidenceSearchResults(
  subject: SubjectIdentifier,
  records: EvidenceVaultRecord[],
  page: number,
): string {
  const pageRecords = records.slice(page * 10, page * 10 + 10);
  if (pageRecords.length === 0) {
    return `No Evidence Vault records found for ${formatSubjectIdentifier(subject)}.`;
  }
  const lines = [`Evidence Vault records for ${formatSubjectIdentifier(subject)}:`];
  for (const record of pageRecords) {
    lines.push(
      `- ${record.id} | Source: ${formatStaffUserReference(record.sourceAuthorId)} in <#${record.sourceChannelId}> | Hidden by ${formatStaffUserReference(record.hiderId)} | <t:${Math.floor(record.hiddenAtMs / 1000)}:R>`,
    );
  }
  return lines.join("\n");
}

export interface EvidenceVaultSearchMessage {
  content?: string;
  embeds?: Array<{
    title: string;
    description?: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
  }>;
  components?: Array<{
    type: number;
    components: Array<{
      type: number;
      style: number;
      label: string;
      custom_id: string;
      disabled?: boolean;
    }>;
  }>;
}

export function buildEvidenceSearchMessage(
  subject: SubjectIdentifier,
  records: EvidenceVaultRecord[],
  page: number,
): EvidenceVaultSearchMessage {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageRecords = records.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const embeds = [
    {
      title: "Evidence Vault Search",
      description:
        records.length === 0
          ? `No Evidence Vault records found for ${formatSubjectIdentifier(subject)}.`
          : `Records for ${formatSubjectIdentifier(subject)}. Newest first.`,
      color: 0xfee75c,
      fields: pageRecords.map((record, index) => ({
        name: `${safePage * pageSize + index + 1}. ${record.id}`,
        value: [
          `Source author: ${formatStaffUserReference(record.sourceAuthorId)}`,
          `Source channel: <#${record.sourceChannelId}>`,
          `Hider: ${formatStaffUserReference(record.hiderId)}`,
          `Hidden: <t:${Math.floor(record.hiddenAtMs / 1000)}:R>`,
        ].join("\n"),
        inline: false,
      })),
      footer: {
        text: `Page ${safePage + 1} of ${pageCount} | ${records.length} result${records.length === 1 ? "" : "s"}`,
      },
    },
  ];
  const components = buildEvidenceSearchComponents(subject, pageRecords, safePage, pageCount);
  return components.length > 0 ? { embeds, components } : { embeds };
}

function buildEvidenceFieldSearchMessage(
  records: EvidenceVaultRecord[],
  page: number,
): EvidenceVaultSearchMessage {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageRecords = records.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const embeds = [
    {
      title: "Evidence Vault Search",
      description:
        records.length === 0
          ? "No Evidence Vault records found."
          : "Records matching all filled Evidence Field search criteria. Newest first.",
      color: 0xfee75c,
      fields: pageRecords.map((record, index) => ({
        name: `${safePage * pageSize + index + 1}. ${record.id}`,
        value: [
          `Source author: ${formatStaffUserReference(record.sourceAuthorId)}`,
          `Source channel: <#${record.sourceChannelId}>`,
          `Hider: ${formatStaffUserReference(record.hiderId)}`,
          `Hidden: <t:${Math.floor(record.hiddenAtMs / 1000)}:R>`,
        ].join("\n"),
        inline: false,
      })),
      footer: {
        text: `Page ${safePage + 1} of ${pageCount} | ${records.length} result${records.length === 1 ? "" : "s"}`,
      },
    },
  ];
  const rows: NonNullable<EvidenceVaultSearchMessage["components"]> = [];
  for (let index = 0; index < pageRecords.length; index += 5) {
    rows.push({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: pageRecords.slice(index, index + 5).map((record, offset) => ({
        type: DISCORD_BUTTON_COMPONENT,
        style: 1,
        label: `View ${index + offset + 1}`,
        custom_id: `${EVIDENCE_VAULT_PLACEHOLDER_CUSTOM_ID_PREFIX}:${record.id}`,
      })),
    });
  }
  return rows.length > 0 ? { embeds, components: rows } : { embeds };
}

function normalizeEvidenceFieldDefinitions(
  fields: EvidenceFieldDefinition[] | undefined,
): EvidenceFieldDefinition[] {
  const seen = new Set<string>();
  const normalized: EvidenceFieldDefinition[] = [];
  for (const field of fields ?? []) {
    if (normalized.length >= 5) break;
    const key = field.key.trim();
    const label = field.label.trim();
    if (!key || !label || seen.has(key)) continue;
    if (field.type !== "text" && field.type !== "short_text" && field.type !== "enum") continue;
    const allowedValues =
      field.type === "enum"
        ? (field.allowedValues ?? []).map((value) => value.trim()).filter(Boolean)
        : undefined;
    if (field.type === "enum" && (!allowedValues || allowedValues.length === 0)) continue;
    seen.add(key);
    normalized.push({ key, label, type: field.type, ...(allowedValues ? { allowedValues } : {}) });
  }
  return normalized;
}

function normalizeEvidenceFieldInput(
  field: EvidenceFieldDefinition,
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (field.type !== "enum") return { ok: true, value: trimmed };
  const allowed = field.allowedValues ?? [];
  const matched = allowed.find((entry) => entry.toLowerCase() === trimmed.toLowerCase());
  if (!matched) {
    return {
      ok: false,
      message: `${field.label} must be one of: ${allowed.join(", ")}.`,
    };
  }
  return { ok: true, value: matched };
}

function buildEvidenceFieldSearchCriteria(
  fields: EvidenceFieldDefinition[],
  values: Record<string, string>,
): Array<{ field: EvidenceFieldDefinition; value: string }> {
  return fields.flatMap((field) => {
    const raw = values[field.key]?.trim();
    if (!raw) return [];
    const normalized = normalizeEvidenceFieldInput(field, raw);
    return normalized.ok ? [{ field, value: normalized.value }] : [];
  });
}

function evidenceRecordMatchesCriteria(
  record: EvidenceVaultRecord,
  definitions: EvidenceFieldDefinition[],
  criteria: {
    fields: Array<{ field: EvidenceFieldDefinition; value: string }>;
    sourceText: string;
    subject: SubjectIdentifier | null;
  },
): boolean {
  if (
    criteria.subject &&
    !record.subjectUserIds.some(
      (subject) =>
        subject.platform === criteria.subject!.platform && subject.id === criteria.subject!.id,
    )
  ) {
    return false;
  }
  if (
    criteria.sourceText &&
    !record.sourceText.toLowerCase().includes(criteria.sourceText.toLowerCase())
  ) {
    return false;
  }
  const conformantValues = getConformantEvidenceFieldValues(record, definitions);
  for (const criterion of criteria.fields) {
    const value = conformantValues.find((entry) => entry.key === criterion.field.key);
    if (!value) return false;
    if (criterion.field.type === "enum") {
      if (value.value !== criterion.value) return false;
    } else if (!value.value.toLowerCase().includes(criterion.value.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function getConformantEvidenceFieldValues(
  record: EvidenceVaultRecord,
  definitions: EvidenceFieldDefinition[],
): EvidenceFieldValue[] {
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  return (record.evidenceFieldValues ?? []).flatMap((value) => {
    const definition = definitionsByKey.get(value.key);
    if (!definition || definition.type !== value.type) return [];
    if (definition.type === "enum" && !(definition.allowedValues ?? []).includes(value.value)) {
      return [];
    }
    return [
      {
        key: value.key,
        label: definition.label,
        type: definition.type,
        value: value.value,
      },
    ];
  });
}

function buildEvidenceSearchComponents(
  subject: SubjectIdentifier,
  records: EvidenceVaultRecord[],
  page: number,
  pageCount: number,
): NonNullable<EvidenceVaultSearchMessage["components"]> {
  const rows: NonNullable<EvidenceVaultSearchMessage["components"]> = [];
  for (let index = 0; index < records.length; index += 5) {
    rows.push({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: records.slice(index, index + 5).map((record, offset) => ({
        type: DISCORD_BUTTON_COMPONENT,
        style: 1,
        label: `View ${index + offset + 1}`,
        custom_id: `${EVIDENCE_VAULT_PLACEHOLDER_CUSTOM_ID_PREFIX}:${record.id}`,
      })),
    });
  }
  if (pageCount > 1) {
    rows.push({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: [
        {
          type: DISCORD_BUTTON_COMPONENT,
          style: 2,
          label: "Previous",
          custom_id: buildEvidenceVaultSearchCustomId(subject, Math.max(0, page - 1)),
          disabled: page === 0,
        },
        {
          type: DISCORD_BUTTON_COMPONENT,
          style: 2,
          label: "Next",
          custom_id: buildEvidenceVaultSearchCustomId(subject, page + 1),
          disabled: page >= pageCount - 1,
        },
      ],
    });
  }
  return rows;
}

function formatSubjectIdentifier(subject: SubjectIdentifier): string {
  return subject.platform === "discord" ? `<@${subject.id}>` : `${subject.platform}:${subject.id}`;
}

function isSubjectPlatform(value: string | undefined): value is SubjectIdentifier["platform"] {
  return (
    value === "discord" ||
    value === "steam" ||
    value === "xbox" ||
    value === "playstation" ||
    value === "cftools"
  );
}

function dedupeLinks(links: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const link of links) {
    const normalized = link.replace(/[.,!?;:]+$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function isSupportedImageContentType(value: string): boolean {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/gif") return "gif";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

function resolveDiscordMessageDisplayName(message: EvidenceVaultSourceMessage): string {
  return (
    resolveMessageDisplayName(
      {
        member: message.member,
        author: message.author,
      },
      { terminalFallback: "unknown" },
    ) ?? "unknown"
  );
}

function getInteractionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function isEvidenceVaultSystemMessage(message: EvidenceVaultSourceMessage): boolean {
  return Boolean(
    message.content?.startsWith("Evidence hidden by ") ||
    message.content?.includes("Evidence Vault record") ||
    message.content?.includes("Evidence Vault hide"),
  );
}

function buildHideAudit(record: EvidenceVaultRecord): CreateChannelMessageInput {
  const fields = [
    { name: "Hider", value: formatStaffUserReference(record.hiderId) },
    { name: "Source channel", value: `<#${record.sourceChannelId}>` },
    { name: "Source author", value: formatStaffUserReference(record.sourceAuthorId) },
    {
      name: "Evidence",
      value: [
        `Text: ${record.sourceText.trim().length > 0 ? "yes" : "no"}`,
        `Links: ${record.links.length}`,
        `Images: ${record.images.length}`,
        `Total image bytes: ${record.totalImageBytes}`,
      ].join("\n"),
    },
  ];
  if (record.subjectsEnabled) {
    fields.push({ name: "Subjects", value: formatSubjectsForEmbed(record.subjectUserIds) });
  }
  fields.push(
    { name: "Result", value: record.status },
    { name: "Placeholder", value: formatEvidenceVaultPlaceholderLink(record) },
  );

  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault Hide",
        color: 0x5865f2,
        fields,
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function buildDeniedHideAudit(
  interaction: DiscordInteraction,
  sourceMessage: EvidenceVaultSourceMessage,
  channelId: string,
): CreateChannelMessageInput {
  const extracted = extractEvidence(sourceMessage);
  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault Hide",
        color: 0xed4245,
        fields: [
          {
            name: "Hider",
            value: formatStaffUserReference(getInteractionUserId(interaction) ?? "unknown"),
          },
          { name: "Source channel", value: `<#${channelId}>` },
          {
            name: "Source author",
            value: sourceMessage.author?.id
              ? formatStaffUserReference(sourceMessage.author.id)
              : "unknown",
          },
          {
            name: "Evidence",
            value: extracted.ok ? formatEvidenceCounts(extracted) : "not extracted",
          },
          { name: "Result", value: "denied" },
          { name: "Placeholder", value: "not posted" },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function formatEvidenceCounts(input: {
  sourceText: string;
  links: string[];
  attachments: DiscordMessageAttachmentResource[];
  totalImageBytes: number;
}): string {
  return [
    `Text: ${input.sourceText.trim().length > 0 ? "yes" : "no"}`,
    `Links: ${input.links.length}`,
    `Images: ${input.attachments.length}`,
    `Total image bytes: ${input.totalImageBytes}`,
  ].join("\n");
}

function buildViewAudit(
  record: EvidenceVaultRecord,
  interaction: DiscordInteraction,
  allowed: boolean,
): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault View",
        color: allowed ? 0x57f287 : 0xed4245,
        fields: [
          {
            name: "Viewer",
            value: formatStaffUserReference(getInteractionUserId(interaction) ?? "unknown"),
          },
          { name: "Evidence record", value: record.id },
          { name: "Source channel", value: `<#${record.sourceChannelId}>` },
          { name: "Result", value: allowed ? "allowed" : "denied" },
          { name: "Placeholder", value: formatEvidenceVaultPlaceholderLink(record) },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function buildSearchAudit(
  interaction: DiscordInteraction,
  query: string,
  resolved: SubjectIdentifier | null,
  resultCount: number,
  firstRecord: EvidenceVaultRecord | null,
  allowed: boolean,
): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault Search",
        color: allowed ? 0xfee75c : 0xed4245,
        fields: [
          {
            name: "Searcher",
            value: formatStaffUserReference(getInteractionUserId(interaction) ?? "unknown"),
          },
          { name: "Query", value: query || "empty" },
          {
            name: "Resolved identifiers",
            value: resolved ? formatSubjectIdentifier(resolved) : "none",
          },
          { name: "Result count", value: String(resultCount) },
          {
            name: "First result",
            value: firstRecord ? formatEvidenceVaultPlaceholderLink(firstRecord) : "none",
          },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function buildAmendAudit(
  interaction: DiscordInteraction,
  recordId: string,
  change: string,
): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault Amend",
        color: 0xfee75c,
        fields: [
          {
            name: "Amender",
            value: formatStaffUserReference(getInteractionUserId(interaction) ?? "unknown"),
          },
          { name: "Record", value: recordId },
          { name: "Change", value: change },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function buildFieldValueAudit(
  interaction: DiscordInteraction,
  record: EvidenceVaultRecord,
  change: { field: EvidenceFieldDefinition; before: string | null; after: string },
): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: "Evidence Vault Field Value",
        color: 0xfee75c,
        fields: [
          {
            name: "Editor",
            value: formatStaffUserReference(getInteractionUserId(interaction) ?? "unknown"),
          },
          { name: "Record", value: record.id },
          { name: "Field", value: change.field.label },
          { name: "Prior value", value: change.before ?? "none" },
          { name: "New value", value: change.after },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

function formatEvidenceVaultPlaceholderLink(record: EvidenceVaultRecord): string {
  return record.placeholderMessageId
    ? `https://discord.com/channels/${record.guildId}/${record.sourceChannelId}/${record.placeholderMessageId}`
    : "not posted";
}

function hasGuildAdminPermissionBits(permissions: string): boolean {
  try {
    const bits = BigInt(permissions);
    return (bits & ((1n << 3n) | (1n << 5n))) !== 0n;
  } catch {
    return false;
  }
}

const defaultEvidenceVaultIdGenerator: EvidenceVaultIdGenerator = {
  recordId: () => crypto.randomUUID().replace(/-/g, ""),
  imageId: () => crypto.randomUUID().replace(/-/g, ""),
};

const defaultImageFetcher: EvidenceVaultImageFetcher = {
  async fetch(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch evidence image attachment");
    return response.arrayBuffer();
  },
};
