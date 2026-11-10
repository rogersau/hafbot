import type {
  BotDefenseConfig,
  GuildAuditLogConfig,
  MemberVerificationConfig,
  MentionProtectionConfig,
  TicketPanelConfig,
  WebhookProxyConfig,
} from "../types";
import {
  ConfigurationRevisionAdapterRegistry,
  serializeTicketPanelConfiguration,
  type TicketPanelSnapshot,
  type ConfigurationFeatureKey,
  type ConfigurationRevisionAdapter,
  type ConfigurationSnapshotEnvelope,
  type SecretSlotSnapshot,
} from "./index";

export const ticketPanelRevisionAdapter: ConfigurationRevisionAdapter<
  TicketPanelConfig,
  TicketPanelSnapshot
> = {
  feature: "tickets",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Tickets",
    pathLabels: {
      "value.panelName": "Panel name",
      "value.panelChannelId": "Panel channel",
      "value.categoryChannelId": "Ticket category",
      "value.transcriptChannelId": "Transcript channel",
      "value.ticketTypes": "Ticket types",
    },
    unorderedArrayPaths: ["value.ticketTypes.*.allowedCreatorRoleIds"],
  },
  serialize(config, resourceKey) {
    return serializeTicketPanelConfiguration(config, resourceKey);
  },
  migrateSnapshot(snapshot) {
    return v1Migration("tickets", snapshot);
  },
};

type SafeWebhookProxySnapshot = Omit<
  WebhookProxyConfig,
  | "guildId"
  | "createdAtMs"
  | "updatedAtMs"
  | "destinations"
  | "banLookupNotificationUrl"
  | "credentialMigratedAtMs"
> & {
  destinations: Array<{ id: string; label: string }>;
};

type MentionProtectionSnapshot = Omit<
  MentionProtectionConfig,
  "guildId" | "createdAtMs" | "updatedAtMs"
>;
type BotDefenseSnapshot = Omit<BotDefenseConfig, "guildId" | "createdAtMs" | "updatedAtMs">;
type MemberVerificationSnapshot = Omit<
  MemberVerificationConfig,
  "guildId" | "panelMessageId" | "updatedAtMs"
>;
type GuildAuditLogSnapshot = Omit<GuildAuditLogConfig, "guildId" | "updatedAtMs">;

function envelope<T>(
  feature: ConfigurationFeatureKey,
  resourceKey: string,
  value: T | null,
  secretSlots: Record<string, SecretSlotSnapshot> = {},
): ConfigurationSnapshotEnvelope<T> {
  return {
    envelopeVersion: 1,
    feature,
    resourceKey,
    featureSchemaVersion: 1,
    exists: value !== null,
    value,
    secretSlots,
  };
}

function emptyEnvelope<T>(
  feature: ConfigurationFeatureKey,
  resourceKey: string,
): ConfigurationSnapshotEnvelope<T> {
  return envelope<T>(feature, resourceKey, null);
}

function v1Migration<T>(
  feature: ConfigurationFeatureKey,
  snapshot: ConfigurationSnapshotEnvelope<unknown>,
): ConfigurationSnapshotEnvelope<T> {
  if (
    snapshot.envelopeVersion !== 1 ||
    snapshot.feature !== feature ||
    snapshot.featureSchemaVersion !== 1
  ) {
    throw new Error("revision_schema_unsupported");
  }
  return snapshot as ConfigurationSnapshotEnvelope<T>;
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export const webhookProxyRevisionAdapter: ConfigurationRevisionAdapter<
  WebhookProxyConfig,
  SafeWebhookProxySnapshot
> = {
  feature: "webhook-proxy",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Webhook Proxy",
    pathLabels: {
      "value.name": "Name",
      "value.enabled": "Enabled",
      "value.destinations": "Destinations",
      "value.routingRules": "Routing rules",
      "value.contentReplacements": "Content replacements",
      "secretSlots.destinations": "Destination credentials",
      "secretSlots.banLookupNotification": "Ban notification credential",
    },
    unorderedArrayPaths: [
      "value.defaultDestinationIds",
      "value.banLookupAppIds",
      "value.routingRules.*.destinationIds",
    ],
  },
  serialize(config, resourceKey) {
    if (!config) return emptyEnvelope<SafeWebhookProxySnapshot>("webhook-proxy", resourceKey);
    const destinations = (config.destinationsV2 ?? config.destinations).map(({ id, label }) => ({
      id,
      label,
    }));
    const destinationCredentials = config.destinationsV2?.length
      ? config.destinationsV2.map((destination) => destination.credentialId)
      : config.destinations.map(() => "legacy-configured");
    const secretSlots: Record<string, SecretSlotSnapshot> = {};
    for (const [index, credential] of destinationCredentials.entries()) {
      secretSlots[`destinations.${destinations[index]?.id ?? index}`] = {
        state: "configured",
        fingerprint: safeCredentialFingerprint(credential),
        restorePolicy: "preserve-current",
      };
    }
    const banCredential = config.banLookupCredentialId
      ? config.banLookupCredentialId
      : config.banLookupNotificationUrl
        ? "legacy-configured"
        : null;
    secretSlots.banLookupNotification = banCredential
      ? {
          state: "configured",
          fingerprint: safeCredentialFingerprint(banCredential),
          restorePolicy: "preserve-current",
        }
      : { state: "not-configured" };
    return envelope(
      "webhook-proxy",
      resourceKey,
      {
        publicId: config.publicId,
        name: config.name,
        enabled: config.enabled,
        banLookupEnabled: config.banLookupEnabled,
        banLookupAppIds: [...new Set(config.banLookupAppIds)].sort((a, b) => a - b),
        destinations,
        ...(config.destinationsV2
          ? {
              destinationsV2: destinations.map((item) => ({ ...item, credentialId: "configured" })),
            }
          : {}),
        ...(config.banLookupCredentialId ? { banLookupCredentialId: "configured" } : {}),
        defaultDestinationIds: sorted(config.defaultDestinationIds),
        routingRules: config.routingRules.map((rule) => ({
          ...rule,
          destinationIds: sorted(rule.destinationIds),
        })),
        contentReplacements: config.contentReplacements?.map((replacement) => ({
          ...replacement,
        })),
      },
      secretSlots,
    );
  },
  migrateSnapshot(snapshot) {
    return v1Migration("webhook-proxy", snapshot);
  },
};

export const mentionProtectionRevisionAdapter: ConfigurationRevisionAdapter<
  MentionProtectionConfig,
  MentionProtectionSnapshot
> = {
  feature: "mention-protection",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Mention Protection",
    pathLabels: {
      "value.adminEnabled": "Admin Mention Protection",
      "value.spamEnabled": "Mention Spam Protection",
      "value.protectedAdminRoleIds": "Protected admin roles",
      "value.channelIds": "Channels",
      "value.excludedRoleIds": "Excluded roles",
    },
    unorderedArrayPaths: [
      "value.protectedAdminRoleIds",
      "value.channelIds",
      "value.excludedRoleIds",
    ],
  },
  serialize(config, resourceKey) {
    if (!config) return emptyEnvelope<MentionProtectionSnapshot>("mention-protection", resourceKey);
    const { guildId: _guildId, createdAtMs: _created, updatedAtMs: _updated, ...value } = config;
    return envelope("mention-protection", resourceKey, {
      ...value,
      protectedAdminRoleIds: sorted(value.protectedAdminRoleIds),
      channelIds: sorted(value.channelIds),
      excludedRoleIds: sorted(value.excludedRoleIds),
    });
  },
  migrateSnapshot(snapshot) {
    return v1Migration("mention-protection", snapshot);
  },
};

export const botDefenseRevisionAdapter: ConfigurationRevisionAdapter<
  BotDefenseConfig,
  BotDefenseSnapshot
> = {
  feature: "bot-defense",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Bot Defense",
    pathLabels: {
      "value.honeypotEnabled": "Honeypot Detector",
      "value.rateEnabled": "Rate Detector",
      "value.honeypotChannelIds": "Honeypot channels",
      "value.excludedRoleIds": "Excluded roles",
      "value.modRoleIds": "Moderator roles",
      "value.modQueueChannelId": "Moderator queue",
    },
    unorderedArrayPaths: ["value.honeypotChannelIds", "value.excludedRoleIds", "value.modRoleIds"],
  },
  serialize(config, resourceKey) {
    if (!config) return emptyEnvelope<BotDefenseSnapshot>("bot-defense", resourceKey);
    const { guildId: _guildId, createdAtMs: _created, updatedAtMs: _updated, ...value } = config;
    return envelope("bot-defense", resourceKey, {
      ...value,
      honeypotChannelIds: sorted(value.honeypotChannelIds),
      excludedRoleIds: sorted(value.excludedRoleIds),
      modRoleIds: sorted(value.modRoleIds),
    });
  },
  migrateSnapshot(snapshot) {
    return v1Migration("bot-defense", snapshot);
  },
};

export const memberVerificationRevisionAdapter: ConfigurationRevisionAdapter<
  MemberVerificationConfig,
  MemberVerificationSnapshot
> = {
  feature: "member-verification",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Member Verification",
    pathLabels: {
      "value.enabled": "Enabled",
      "value.verifiedRoleId": "Verified role",
      "value.deliveryMode": "Delivery mode",
      "value.verificationMethod": "Verification method",
      "value.welcomeChannelId": "Welcome channel",
    },
    unorderedArrayPaths: [],
  },
  serialize(config, resourceKey) {
    if (!config)
      return emptyEnvelope<MemberVerificationSnapshot>("member-verification", resourceKey);
    const {
      guildId: _guildId,
      panelMessageId: _panelMessageId,
      updatedAtMs: _updated,
      ...value
    } = config;
    return envelope("member-verification", resourceKey, value);
  },
  migrateSnapshot(snapshot) {
    return v1Migration("member-verification", snapshot);
  },
};

export const guildAuditLogRevisionAdapter: ConfigurationRevisionAdapter<
  GuildAuditLogConfig,
  GuildAuditLogSnapshot
> = {
  feature: "guild-audit-log",
  currentSchemaVersion: 1,
  display: {
    featureLabel: "Guild Audit Log",
    pathLabels: {
      "value.auditChannelId": "Default audit channel",
      "value.groupChannelIds": "Group channels",
      "value.eventStates": "Event states",
      "value.excludedChannelIds": "Excluded channels",
      "value.excludedRoleIds": "Excluded roles",
    },
    unorderedArrayPaths: ["value.excludedChannelIds", "value.excludedRoleIds"],
  },
  serialize(config, resourceKey) {
    if (!config) return emptyEnvelope<GuildAuditLogSnapshot>("guild-audit-log", resourceKey);
    const { guildId: _guildId, updatedAtMs: _updated, ...value } = config;
    return envelope("guild-audit-log", resourceKey, {
      ...value,
      excludedChannelIds: sorted(value.excludedChannelIds ?? []),
      excludedRoleIds: sorted(value.excludedRoleIds ?? []),
    });
  },
  migrateSnapshot(snapshot) {
    return v1Migration("guild-audit-log", snapshot);
  },
};

export const configurationRevisionAdapters = new ConfigurationRevisionAdapterRegistry()
  .register(ticketPanelRevisionAdapter)
  .register(webhookProxyRevisionAdapter)
  .register(mentionProtectionRevisionAdapter)
  .register(botDefenseRevisionAdapter)
  .register(memberVerificationRevisionAdapter)
  .register(guildAuditLogRevisionAdapter);

function safeCredentialFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (const codePoint of value) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `credential-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
