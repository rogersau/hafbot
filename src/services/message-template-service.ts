import type {
  GuildAuditLogStore,
  GuildEntitlementStore,
  MessageTemplateStore,
} from "../runtime/contracts";
import { isAtLimit, QuantityLimitError } from "../runtime/entitlement-checks";
import type { ManagedMessageEmbed, MessageTemplate } from "../types";
import { getGuildEntitlementLimits } from "../types";
import { postMessageTemplateAuditEvent } from "./guild-audit-log-service";
import {
  ManagedMessageError,
  normalizeManagedMessageEmbeds,
  validateManagedMessageEmbeds,
} from "./managed-message-service";

export interface MessageTemplateSaveInput {
  guildId: string;
  id?: string | null;
  internalName: string;
  embeds: ManagedMessageEmbed[];
  availableForTicketReplies: boolean;
}

export class MessageTemplateService {
  constructor(
    private readonly options: {
      store: MessageTemplateStore;
      guildEntitlements: GuildEntitlementStore;
      guildAuditLog: GuildAuditLogStore;
      discordBotToken: string;
    },
  ) {}

  list(guildId: string) {
    return this.options.store.listByGuild(guildId);
  }
  listTicketReplyTemplates(guildId: string) {
    return this.options.store.listTicketReplyTemplates(guildId);
  }
  read(guildId: string, id: string) {
    return this.options.store.readById(guildId, id);
  }

  async save(input: MessageTemplateSaveInput, actorUserId?: string): Promise<MessageTemplate> {
    const guildId = input.guildId.trim();
    const internalName = input.internalName.trim();
    const embeds = normalizeManagedMessageEmbeds(input.embeds);
    if (!guildId) throw new ManagedMessageError("Missing guildId.");
    if (!internalName || internalName.length > 100) {
      throw new ManagedMessageError(
        "Internal name is required and must be 100 characters or fewer.",
      );
    }
    validateManagedMessageEmbeds(embeds);
    const id = input.id?.trim() || null;
    const existing = id ? await this.options.store.readById(guildId, id) : null;
    if (id && !existing) throw new ManagedMessageError("Message Template was not found.", 404);
    const nameOwner = (await this.options.store.listByGuild(guildId)).find(
      (template) => template.internalName.toLowerCase() === internalName.toLowerCase(),
    );
    if (nameOwner && nameOwner.id !== id) {
      throw new ManagedMessageError("Internal name must be unique within this Guild.");
    }
    if (!existing) {
      const entitlement = await this.options.guildEntitlements.readGuildEntitlement(guildId);
      const max = getGuildEntitlementLimits(entitlement?.tier ?? "free").messageTemplatesMax ?? 3;
      if (isAtLimit(await this.options.store.countByGuild(guildId), max)) {
        throw new QuantityLimitError(
          "Free-tier Guilds can keep up to 3 Message Templates. Upgrade to premium for unlimited templates.",
        );
      }
    }
    const nowMs = Date.now();
    const template: MessageTemplate = {
      id: existing?.id ?? crypto.randomUUID(),
      guildId,
      internalName,
      embeds,
      availableForTicketReplies: input.availableForTicketReplies === true,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    await this.options.store.upsert(template);
    await postMessageTemplateAuditEvent(
      existing ? "message-template.update" : "message-template.create",
      { guildId, internalName, actorUserId },
      this.options.guildAuditLog,
      this.options.discordBotToken,
    );
    return template;
  }

  async duplicate(guildId: string, id: string, internalName: string, actorUserId?: string) {
    const existing = await this.options.store.readById(guildId, id);
    if (!existing) throw new ManagedMessageError("Message Template was not found.", 404);
    return this.save(
      {
        guildId,
        internalName,
        embeds: existing.embeds,
        availableForTicketReplies: existing.availableForTicketReplies,
      },
      actorUserId,
    );
  }

  async delete(guildId: string, id: string, actorUserId?: string): Promise<MessageTemplate> {
    const existing = await this.options.store.readById(guildId, id);
    if (!existing) throw new ManagedMessageError("Message Template was not found.", 404);
    await this.options.store.delete(guildId, id);
    await postMessageTemplateAuditEvent(
      "message-template.delete",
      { guildId, internalName: existing.internalName, actorUserId },
      this.options.guildAuditLog,
      this.options.discordBotToken,
    );
    return existing;
  }
}
