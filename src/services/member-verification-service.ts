import { verificationMemberState } from "./member-verification-state";
import { DISCORD_MESSAGE_COMPONENT_ROW, DISCORD_BUTTON_COMPONENT } from "../discord/constants";
import { DiscordApiError } from "../discord/client";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import { parseButtonEmoji } from "../discord/emoji";
import type {
  CreateChannelMessageInput,
  DiscordEmbed,
  DiscordMessageResource,
} from "../discord/messages";
import { buildEphemeralMessage } from "../discord-interactions";
import type { MemberVerificationConfig, MemberVerificationMethod } from "../types";
import type {
  MemberVerificationStore,
  GuildEntitlementStore,
  GuildAuditLogStore,
  PlatformLinkStore,
} from "../runtime/contracts";
import type { AuditEventId } from "../types";
import { getGuildEntitlementLimits } from "../types";
import { postMemberAuditEvent, type MemberAuditEventData } from "./guild-audit-log-service";
import { signAttemptToken } from "./member-verification-token";
import { createInsertionId, type ProductAnalyticsReporter } from "../product-analytics";
import type {
  ConfigurationActorContext,
  ConfigurationRevisionStore,
} from "../configuration-revisions";
import { memberVerificationRevisionAdapter } from "../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../configuration-revisions/coordinator";

export const MEMBER_VERIFICATION_BUTTON_CUSTOM_ID_PREFIX = "member_verification_verify:";

export const MEMBER_VERIFICATION_ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const MEMBER_VERIFICATION_MANUAL_DM_WINDOW_MS = 5 * 60 * 1000;

export function buildMemberVerificationCustomId(guildId: string): string {
  return `${MEMBER_VERIFICATION_BUTTON_CUSTOM_ID_PREFIX}${guildId}`;
}

export function parseMemberVerificationCustomId(customId: string): string | null {
  if (!customId.startsWith(MEMBER_VERIFICATION_BUTTON_CUSTOM_ID_PREFIX)) {
    return null;
  }
  return customId.slice(MEMBER_VERIFICATION_BUTTON_CUSTOM_ID_PREFIX.length);
}

export function isValidVerificationMethod(value: unknown): value is MemberVerificationMethod {
  return value === "discord-button" || value === "turnstile" || value === "steam-link";
}

export interface GuildMemberInfo {
  roles: string[];
}

export interface MemberVerificationServiceOptions {
  store: MemberVerificationStore;
  guildEntitlementStore: GuildEntitlementStore;
  guildAuditLogStore?: GuildAuditLogStore;
  guildResources: GuildResourceValidator;
  discordBotToken: string;
  addGuildMemberRole: (guildId: string, userId: string, roleId: string) => Promise<void>;
  guildMemberHasRole: (guildId: string, userId: string, roleId: string) => Promise<boolean>;
  readGuildMember?: (guildId: string, userId: string) => Promise<MemberVerificationUser | null>;
  resolveGuildName: (guildId: string) => Promise<string | null | undefined>;
  sendUserDm: (userId: string, body: CreateChannelMessageInput) => Promise<DiscordMessageResource>;
  createChannelMessage: (
    channelId: string,
    body: CreateChannelMessageInput,
  ) => Promise<DiscordMessageResource>;
  editChannelMessage: (
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ) => Promise<void>;
  resolveFooterText?: (guildId: string) => Promise<string | undefined>;
  postAudit?: (eventId: AuditEventId, data: MemberAuditEventData) => Promise<void>;
  publicUrl?: string;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  platformLinkStore?: PlatformLinkStore;
  /** Whether the Steam verification runtime integration is enabled. */
  steamLinkAvailable?: boolean;
  createSteamLinkState?: (guildId: string, userId: string) => Promise<string>;
  verifyTurnstileToken?: (token: string, secretKey: string) => Promise<boolean>;
  productAnalytics?: ProductAnalyticsReporter;
  configurationRevisions?: ConfigurationRevisionStore;
}

export interface MemberVerificationUser {
  id?: string;
  username?: string;
  global_name?: string | null;
}

export interface HandleMemberAddInput {
  guildId: string;
  userId: string;
  user?: MemberVerificationUser | null;
}

export interface CreateVerificationAttemptInput {
  guildId: string;
  userId: string;
  messageId?: string;
  channelId?: string;
}

export interface CompleteVerificationInput {
  guildId: string;
  userId: string;
  user?: MemberVerificationUser | null;
  messageId?: string;
  channelId?: string;
  method: MemberVerificationMethod;
}

export interface CompleteVerificationResult {
  outcome: "verified" | "already-verified" | "failed";
  message: string;
}

export type ManualWelcomeDmResult =
  | { outcome: "sent" | "undeliverable" }
  | {
      outcome:
        | "not-member"
        | "disabled"
        | "channel-mode"
        | "not-configured"
        | "paid-required"
        | "method-unavailable";
    }
  | { outcome: "rate-limited"; retryAfterMs: number };

export interface MemberVerificationAdminSnapshot {
  guildId: string;
  config: MemberVerificationConfig | null;
  paidMethodsAvailable: boolean;
  turnstileAvailable: boolean;
  steamLinkAvailable: boolean;
  steamLinkConfigured: boolean;
}

export interface SaveMemberVerificationAdminConfigInput {
  guildId: string;
  enabled: boolean;
  verifiedRoleId?: string | null;
  title?: string;
  description?: string;
  color?: number;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  rulesUrl?: string | null;
  verifyButtonEmoji?: string | null;
  deliveryMode?: MemberVerificationConfig["deliveryMode"];
  verificationMethod?: MemberVerificationMethod;
  welcomeChannelId?: string | null;
  actor: ConfigurationActorContext;
}

export type SaveMemberVerificationAdminConfigResult =
  | {
      outcome: "saved";
      config: MemberVerificationConfig;
      panelOutcome: "not-required" | "created" | "refreshed";
    }
  | {
      outcome: "saved-panel-repair-required";
      config: MemberVerificationConfig;
    }
  | {
      outcome: "invalid";
      reason: "verified-role-required" | "welcome-channel-required";
    }
  | {
      outcome: "method-unavailable";
      reason:
        | "advanced-method-paid"
        | "turnstile-runtime-unavailable"
        | "steam-link-runtime-unavailable"
        | "steam-link-guild-config-missing";
    };

type MemberVerificationPanelPublicationResult =
  | {
      outcome: "created" | "refreshed";
      panelMessageId: string;
    }
  | { outcome: "failed" };

export type RepairMemberVerificationWelcomePanelResult =
  | {
      outcome: "created" | "refreshed";
      panelMessageId: string;
    }
  | {
      outcome: "not-eligible";
      reason:
        | "not-configured"
        | "disabled"
        | "verified-role-required"
        | "channel-mode-required"
        | "welcome-channel-required"
        | "advanced-method-paid"
        | "turnstile-runtime-unavailable"
        | "steam-link-runtime-unavailable"
        | "steam-link-guild-config-missing";
    }
  | { outcome: "failed" };

export function createMemberVerificationService(
  options: MemberVerificationServiceOptions,
): MemberVerificationService {
  return new MemberVerificationService(options);
}

export class MemberVerificationService {
  private readonly guildResources: GuildResourceValidator;

  constructor(private readonly options: MemberVerificationServiceOptions) {
    this.guildResources = options.guildResources;
  }

  async getConfig(guildId: string): Promise<MemberVerificationConfig | null> {
    return this.options.store.readConfig(guildId);
  }

  async readAdminSnapshot(guildId: string): Promise<MemberVerificationAdminSnapshot> {
    const [config, entitlement, steamLinkConfig] = await Promise.all([
      this.options.store.readConfig(guildId),
      this.options.guildEntitlementStore.readGuildEntitlement(guildId),
      this.options.platformLinkStore?.readPlatformLinkConfig(guildId, "steam") ??
        Promise.resolve(null),
    ]);

    return {
      guildId,
      config,
      paidMethodsAvailable: getGuildEntitlementLimits(entitlement.tier).paidFeatures,
      turnstileAvailable: Boolean(
        this.options.turnstileSiteKey?.trim() && this.options.turnstileSecretKey?.trim(),
      ),
      steamLinkAvailable: this.options.steamLinkAvailable ?? false,
      steamLinkConfigured: Boolean(steamLinkConfig),
    };
  }

  async saveAdminConfig(
    input: SaveMemberVerificationAdminConfigInput,
  ): Promise<SaveMemberVerificationAdminConfigResult> {
    const existing = await this.options.store.readConfig(input.guildId);
    const deliveryMode = input.deliveryMode ?? existing?.deliveryMode ?? "dm";
    const verificationMethod =
      input.verificationMethod ?? existing?.verificationMethod ?? "discord-button";
    const verifiedRoleId =
      input.verifiedRoleId !== undefined
        ? input.verifiedRoleId
        : (existing?.verifiedRoleId ?? null);
    const welcomeChannelId =
      input.welcomeChannelId !== undefined
        ? input.welcomeChannelId
        : (existing?.welcomeChannelId ?? null);

    if (input.enabled && !verifiedRoleId) {
      return { outcome: "invalid", reason: "verified-role-required" };
    }
    if (input.enabled && deliveryMode === "channel" && !welcomeChannelId) {
      return { outcome: "invalid", reason: "welcome-channel-required" };
    }

    const resources = await this.guildResources.forGuild(input.guildId);
    if (verifiedRoleId) resources?.requireRole(verifiedRoleId);
    if (welcomeChannelId) resources?.requireTextChannel(welcomeChannelId);

    if (input.enabled) {
      const reason = await this.getAdminVerificationMethodBlockReason(
        input.guildId,
        verificationMethod,
      );
      if (reason) {
        return { outcome: "method-unavailable", reason };
      }
    }

    const config: MemberVerificationConfig = {
      guildId: input.guildId,
      enabled: input.enabled,
      verifiedRoleId,
      title: input.title ?? existing?.title ?? "Welcome",
      description:
        input.description ??
        existing?.description ??
        "Welcome to the Guild! Please verify to gain access.",
      color: input.color ?? existing?.color ?? 0x5865f2,
      imageUrl: input.imageUrl !== undefined ? input.imageUrl : (existing?.imageUrl ?? null),
      thumbnailUrl:
        input.thumbnailUrl !== undefined ? input.thumbnailUrl : (existing?.thumbnailUrl ?? null),
      rulesUrl: input.rulesUrl !== undefined ? input.rulesUrl : (existing?.rulesUrl ?? null),
      verifyButtonEmoji:
        input.verifyButtonEmoji !== undefined
          ? input.verifyButtonEmoji
          : (existing?.verifyButtonEmoji ?? null),
      deliveryMode,
      verificationMethod,
      welcomeChannelId,
      panelMessageId: existing?.panelMessageId ?? null,
      updatedAtMs: Date.now(),
    };

    await commitVersionedConfigurationMutation({
      revisions: this.options.configurationRevisions,
      entitlements: this.options.guildEntitlementStore,
      mutation: {
        guildId: input.guildId,
        feature: "member-verification",
        resourceKey: "default",
        current: existing,
        next: config,
        adapter: memberVerificationRevisionAdapter,
        actor: input.actor,
      },
      commitFree: () => this.options.store.upsertConfig(config),
    });

    if (
      config.enabled &&
      config.verifiedRoleId &&
      config.deliveryMode === "channel" &&
      config.welcomeChannelId
    ) {
      const publication = await this.publishWelcomePanelConfig(config);
      if (publication.outcome === "failed") {
        return { outcome: "saved-panel-repair-required", config };
      }
      return {
        outcome: "saved",
        config: { ...config, panelMessageId: publication.panelMessageId },
        panelOutcome: publication.outcome,
      };
    }

    return { outcome: "saved", config, panelOutcome: "not-required" };
  }

  async repairWelcomePanel(guildId: string): Promise<RepairMemberVerificationWelcomePanelResult> {
    const config = await this.options.store.readConfig(guildId);
    if (!config) {
      return { outcome: "not-eligible", reason: "not-configured" };
    }
    if (!config.enabled) {
      return { outcome: "not-eligible", reason: "disabled" };
    }
    if (!config.verifiedRoleId) {
      return { outcome: "not-eligible", reason: "verified-role-required" };
    }
    if (config.deliveryMode !== "channel") {
      return { outcome: "not-eligible", reason: "channel-mode-required" };
    }
    if (!config.welcomeChannelId) {
      return { outcome: "not-eligible", reason: "welcome-channel-required" };
    }
    const methodBlockReason = await this.getAdminVerificationMethodBlockReason(
      guildId,
      config.verificationMethod,
    );
    if (methodBlockReason) {
      return { outcome: "not-eligible", reason: methodBlockReason };
    }
    return this.publishWelcomePanelConfig(config);
  }

  async handleMemberAdd(input: HandleMemberAddInput): Promise<void> {
    const { guildId, userId, user } = input;
    const config = await this.getConfig(guildId);
    if (!config?.verifiedRoleId) {
      return;
    }

    const existingState = await this.options.store.readVerificationState(guildId, userId);
    if (verificationMemberState(Boolean(existingState), false) === "remembered-role-missing") {
      await this.restoreVerifiedRole({ guildId, userId, user });
      return;
    }

    if (
      !config.enabled ||
      !(await this.isVerificationMethodAvailable(guildId, config.verificationMethod))
    ) {
      return;
    }

    // In "channel" mode the welcome panel is a persistent message posted by
    // staff from the admin page; there is no per-member delivery on join.
    if (config.deliveryMode === "channel") {
      return;
    }

    await this.sendWelcomeDm({ guildId, userId, config });
  }

  async handleVerifyButton(input: {
    guildId: string;
    userId: string;
    messageId?: string;
    channelId?: string;
    user?: MemberVerificationUser | null;
  }): Promise<unknown> {
    const { guildId } = input;
    const config = await this.getConfig(guildId);

    if (!config?.enabled || !config.verifiedRoleId) {
      return buildEphemeralMessage("Member verification is not configured for this Guild.");
    }

    const method = config.verificationMethod ?? "discord-button";
    const availability = await this.getVerificationMethodBlockReason(guildId, method);
    if (availability) {
      await this.audit("member-verification.verify-failed", {
        guildId,
        user: input.user,
        reason: availability,
        context: { method },
      });
      void this.options.productAnalytics?.report({
        name: "feature_outcome",
        insertionId: createInsertionId(),
        guildId,
        feature: "member_verification",
        action: "verification_role_granted",
        status: "failure",
        reasonCode: "invalid_configuration",
      });
      return buildEphemeralMessage(
        availability === "advanced-method-paid"
          ? "This verification method requires a paid plan."
          : "Verification is currently unavailable for this server.",
      );
    }

    if (method === "turnstile") {
      return this.handleTurnstileVerification({ ...input, config });
    }

    if (method === "steam-link") {
      return this.handleSteamLinkVerification(input);
    }

    const result = await this.completeVerification({
      ...input,
      method: "discord-button",
    });
    return buildEphemeralMessage(result.message);
  }

  async createVerificationAttempt(input: CreateVerificationAttemptInput) {
    const nowMs = Date.now();
    const attempt = {
      id: crypto.randomUUID(),
      guildId: input.guildId,
      userId: input.userId,
      messageId: input.messageId ?? null,
      channelId: input.channelId ?? null,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + MEMBER_VERIFICATION_ATTEMPT_TTL_MS,
      usedAtMs: null,
    };
    await this.options.store.createVerificationAttempt(attempt);
    return attempt;
  }

  async readVerificationAttempt(id: string) {
    return this.options.store.readVerificationAttempt(id);
  }

  async markVerificationAttemptUsed(attempt: { id: string }) {
    return this.options.store.tryClaimVerificationAttempt(attempt.id, Date.now());
  }

  async completeVerification(
    input: CompleteVerificationInput,
  ): Promise<CompleteVerificationResult> {
    const { guildId, userId, user, messageId, channelId, method } = input;
    const config = await this.getConfig(guildId);
    if (!config?.enabled || !config.verifiedRoleId) {
      return {
        outcome: "failed",
        message: "Member verification is not configured for this Guild.",
      };
    }
    const availability = await this.getVerificationMethodBlockReason(guildId, method);
    if (availability) {
      await this.audit("member-verification.verify-failed", {
        guildId,
        user,
        reason: availability,
        context: { method },
      });
      void this.options.productAnalytics?.report({
        name: "feature_outcome",
        insertionId: createInsertionId(),
        guildId,
        feature: "member_verification",
        action: "verification_role_granted",
        status: "failure",
        reasonCode: "invalid_configuration",
      });
      return {
        outcome: "failed",
        message:
          availability === "advanced-method-paid"
            ? "This verification method requires a paid plan."
            : "Verification is currently unavailable for this server.",
      };
    }
    await this.guildResources.requireRole(guildId, config.verifiedRoleId);

    const alreadyHasRole = await this.options.guildMemberHasRole(
      guildId,
      userId,
      config.verifiedRoleId,
    );
    const existingState = await this.options.store.readVerificationState(guildId, userId);
    const memberState = verificationMemberState(Boolean(existingState), alreadyHasRole);
    if (memberState === "verified" || memberState === "role-only") {
      if (memberState === "role-only") {
        await this.options.store.upsertVerificationState({
          guildId,
          userId,
          verifiedAtMs: Date.now(),
        });
      }
      return { outcome: "already-verified", message: "You're already verified 👍" };
    }

    try {
      await this.options.addGuildMemberRole(guildId, userId, config.verifiedRoleId);
    } catch (error) {
      const reason = error instanceof DiscordApiError ? error.message : String(error);
      console.error("Failed to grant verified role", error);
      await this.audit("member-verification.verify-failed", {
        guildId,
        user,
        reason,
        context: { method },
      });
      void this.options.productAnalytics?.report({
        name: "feature_outcome",
        insertionId: createInsertionId(),
        guildId,
        feature: "member_verification",
        action: "verification_role_granted",
        status: "failure",
        reasonCode: "discord_rejected",
      });
      return {
        outcome: "failed",
        message: "Couldn't grant your verified role right now — staff have been notified.",
      };
    }

    await this.options.store.upsertVerificationState({
      guildId,
      userId,
      verifiedAtMs: Date.now(),
    });

    await this.audit("member-verification.verify", { guildId, user, context: { method } });
    void this.options.productAnalytics?.report({
      name: "feature_outcome",
      insertionId: createInsertionId(),
      guildId,
      feature: "member_verification",
      action: "verification_role_granted",
      status: "success",
    });

    // The welcome DM's Verify button is a one-shot: disable it once clicked.
    // The channel panel's button is shared by the whole server, so leave it
    // enabled for other members. The discriminator is whether this message IS
    // the persisted panel — not the current deliveryMode, so a panel left
    // orphaned by a switch back to "dm" still keeps its shared button enabled
    // (it's never a one-shot DM). See ADR 0017.
    const panelMessageId = config.panelMessageId;
    const isPanelMessage =
      typeof panelMessageId === "string" &&
      panelMessageId.length > 0 &&
      messageId === panelMessageId;

    if (messageId && channelId && !isPanelMessage) {
      try {
        await this.options.editChannelMessage(channelId, messageId, {
          components: [
            {
              type: DISCORD_MESSAGE_COMPONENT_ROW,
              components: [
                {
                  type: DISCORD_BUTTON_COMPONENT,
                  style: 3,
                  label: "Verified ✅",
                  custom_id: buildMemberVerificationCustomId(guildId),
                  disabled: true,
                },
              ],
            },
          ],
          allowed_mentions: { parse: [] },
        });
      } catch (error) {
        console.warn("Failed to edit welcome DM after verification", error);
      }
    }

    const guildName = await this.options.resolveGuildName(guildId);
    return {
      outcome: "verified",
      message: guildName
        ? `✅ You're now verified — welcome to ${guildName}.`
        : "✅ You're now verified — welcome.",
    };
  }

  async sendWelcomeDm(input: {
    guildId: string;
    userId: string;
    config?: MemberVerificationConfig | null;
  }): Promise<void> {
    const { guildId, userId } = input;
    const config = input.config ?? (await this.getConfig(guildId));
    if (!config?.verifiedRoleId) {
      return;
    }
    if (!config.enabled) {
      return;
    }
    if (!(await this.isVerificationMethodAvailable(guildId, config.verificationMethod))) {
      return;
    }

    await this.deliverWelcomeDm({ guildId, userId, config });
  }

  async sendManualWelcomeDm(input: {
    guildId: string;
    userId: string;
    actorUserId: string;
  }): Promise<ManualWelcomeDmResult> {
    const { guildId, userId, actorUserId } = input;
    const nowMs = Date.now();
    for (const rateLimit of [
      { scopeType: "guild" as const, scopeId: guildId, limit: 25 },
      { scopeType: "actor" as const, scopeId: actorUserId, limit: 10 },
      { scopeType: "target" as const, scopeId: userId, limit: 1 },
    ]) {
      const claim = await this.options.store.consumeManualDmRateLimit({
        guildId,
        ...rateLimit,
        nowMs,
        windowMs: MEMBER_VERIFICATION_MANUAL_DM_WINDOW_MS,
      });
      if (!claim.allowed) {
        await this.audit("member-verification.dm-blocked", {
          guildId,
          user: { id: userId },
          reason: "rate-limited",
          context: {
            source: "manual",
            outcome: "blocked",
            actorUserId,
            scope: rateLimit.scopeType,
          },
        });
        return { outcome: "rate-limited", retryAfterMs: claim.retryAfterMs };
      }
    }

    const config = await this.getConfig(guildId);
    if (!config?.verifiedRoleId) {
      return this.blockManualWelcomeDm(input, "not-configured");
    }
    if (!config.enabled) {
      return this.blockManualWelcomeDm(input, "disabled");
    }
    if (config.deliveryMode === "channel") {
      return this.blockManualWelcomeDm(input, "channel-mode");
    }
    const methodBlockReason = await this.getVerificationMethodBlockReason(
      guildId,
      config.verificationMethod,
    );
    if (methodBlockReason === "advanced-method-paid") {
      return this.blockManualWelcomeDm(input, "paid-required");
    }
    if (!this.options.readGuildMember) {
      throw new Error("Manual Member Verification membership validation is not configured.");
    }

    const member = await this.options.readGuildMember(guildId, userId);
    if (!member) {
      return this.blockManualWelcomeDm(input, "not-member");
    }
    if (methodBlockReason) {
      return this.blockManualWelcomeDm(input, "method-unavailable", member);
    }

    return this.deliverWelcomeDm({
      guildId,
      userId,
      config,
      user: member,
      context: { source: "manual", actorUserId },
    });
  }

  private async publishWelcomePanelConfig(
    config: MemberVerificationConfig,
  ): Promise<MemberVerificationPanelPublicationResult> {
    const { guildId } = config;
    try {
      const resources = await this.guildResources.forGuild(guildId);
      resources?.requireRole(config.verifiedRoleId!);
      resources?.requireTextChannel(config.welcomeChannelId!);

      const body = await this.buildWelcomeMessage(guildId, config);

      if (config.panelMessageId) {
        try {
          await this.options.editChannelMessage(
            config.welcomeChannelId!,
            config.panelMessageId,
            body,
          );
          await this.audit("member-verification.panel-published", {
            guildId,
            user: undefined,
            context: { messageId: config.panelMessageId, refreshed: true },
          });
          return { outcome: "refreshed", panelMessageId: config.panelMessageId };
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.status !== 404) {
            console.warn("Failed to refresh member verification welcome panel", error);
            return { outcome: "failed" };
          }
          // Previous panel was deleted — fall through and create a new one.
        }
      }

      const message = await this.options.createChannelMessage(config.welcomeChannelId!, body);
      await this.options.store.upsertConfig({ ...config, panelMessageId: message.id });
      await this.audit("member-verification.panel-published", {
        guildId,
        user: undefined,
        context: { messageId: message.id, refreshed: false },
      });
      return { outcome: "created", panelMessageId: message.id };
    } catch (error) {
      console.warn("Failed to publish member verification welcome panel", error);
      return { outcome: "failed" };
    }
  }

  private async handleTurnstileVerification(input: {
    guildId: string;
    userId: string;
    messageId?: string;
    channelId?: string;
    user?: MemberVerificationUser | null;
    config: MemberVerificationConfig;
  }): Promise<unknown> {
    const { guildId, userId, user, config, messageId, channelId } = input;

    if (
      !this.options.publicUrl ||
      !this.options.turnstileSiteKey ||
      !this.options.turnstileSecretKey
    ) {
      console.error("Member Verification Turnstile method is not fully configured");
      await this.audit("member-verification.verify-failed", {
        guildId,
        user,
        reason: "turnstile-not-configured",
      });
      return buildEphemeralMessage("Verification is currently unavailable for this server.");
    }

    const alreadyHasRole = await this.options.guildMemberHasRole(
      guildId,
      userId,
      config.verifiedRoleId!,
    );
    const existingState = await this.options.store.readVerificationState(guildId, userId);
    const memberState = verificationMemberState(Boolean(existingState), alreadyHasRole);
    if (memberState === "verified" || memberState === "role-only") {
      if (memberState === "role-only") {
        await this.options.store.upsertVerificationState({
          guildId,
          userId,
          verifiedAtMs: Date.now(),
        });
      }
      return buildEphemeralMessage("You're already verified 👍");
    }

    if (memberState === "remembered-role-missing") {
      const result = await this.completeVerification({
        guildId,
        userId,
        user,
        messageId,
        channelId,
        method: "turnstile",
      });
      return buildEphemeralMessage(result.message);
    }

    const activeAttempts = await this.options.store.listActiveVerificationAttempts(guildId, userId);
    const attempt =
      activeAttempts[0] ??
      (await this.createVerificationAttempt({ guildId, userId, messageId, channelId }));

    await this.audit("member-verification.attempt-created", {
      guildId,
      user,
      context: { attemptId: attempt.id, method: "turnstile" },
    });

    const verificationUrlBase = `${this.options.publicUrl.replace(/\/$/, "")}/verify/${encodeURIComponent(
      attempt.id,
    )}`;
    const signature = await signAttemptToken(attempt, this.options.turnstileSecretKey);
    const verificationUrl = `${verificationUrlBase}?sig=${encodeURIComponent(signature)}`;
    return buildEphemeralMessage(
      `Please complete verification to receive your role: ${verificationUrl}`,
    );
  }

  private async handleSteamLinkVerification(input: {
    guildId: string;
    userId: string;
    messageId?: string;
    channelId?: string;
    user?: MemberVerificationUser | null;
  }): Promise<unknown> {
    const { guildId, userId, user, messageId, channelId } = input;

    const config = await this.getConfig(guildId);
    if (!config?.enabled || !config.verifiedRoleId) {
      return buildEphemeralMessage("Member verification is not configured for this Guild.");
    }

    const alreadyHasRole = await this.options.guildMemberHasRole(
      guildId,
      userId,
      config.verifiedRoleId,
    );
    const existingState = await this.options.store.readVerificationState(guildId, userId);
    const memberState = verificationMemberState(Boolean(existingState), alreadyHasRole);
    if (memberState === "verified" || memberState === "role-only") {
      if (memberState === "role-only") {
        await this.options.store.upsertVerificationState({
          guildId,
          userId,
          verifiedAtMs: Date.now(),
        });
      }
      return buildEphemeralMessage("You're already verified 👍");
    }

    if (memberState === "remembered-role-missing") {
      const result = await this.completeVerification({
        guildId,
        userId,
        user,
        messageId,
        channelId,
        method: "steam-link",
      });
      return buildEphemeralMessage(result.message);
    }

    const platformLinkStore = this.options.platformLinkStore;
    if (!platformLinkStore) {
      console.error("Member Verification Steam Link method is missing platformLinkStore");
      await this.audit("member-verification.verify-failed", {
        guildId,
        user,
        reason: "steam-link-not-configured",
      });
      return buildEphemeralMessage("Verification is currently unavailable for this server.");
    }

    // A member-facing Steam auth URL is only actionable when this Guild has a
    // persisted Platform Link policy.  Do this check before creating the
    // pending auth state, so an invalid configuration cannot generate a
    // doomed URL.
    const platformLinkConfig = await platformLinkStore.readPlatformLinkConfig(guildId, "steam");
    if (!platformLinkConfig) {
      await this.audit("member-verification.verify-failed", {
        guildId,
        user,
        reason: "steam-link-guild-config-missing",
        context: { method: "steam-link" },
      });
      return buildEphemeralMessage("Verification is currently unavailable for this server.");
    }

    const steamLink = await platformLinkStore.readPlatformLink(guildId, userId, "steam");
    if (steamLink?.active) {
      const result = await this.completeVerification({
        guildId,
        userId,
        user,
        messageId,
        channelId,
        method: "steam-link",
      });
      return buildEphemeralMessage(result.message);
    }

    if (!this.options.createSteamLinkState || !this.options.publicUrl) {
      await this.audit("member-verification.steam-link-missing", {
        guildId,
        user,
        context: { actionable: false },
      });
      return buildEphemeralMessage(
        "A linked Steam account is required for verification. Ask a mod to set up Steam Link.",
      );
    }

    const state = await this.options.createSteamLinkState(guildId, userId);
    const steamLinkUrl = `${this.options.publicUrl.replace(/\/$/, "")}/auth/steam/start?state=${encodeURIComponent(
      state,
    )}`;

    await this.audit("member-verification.steam-link-required", {
      guildId,
      user,
      context: { hasExistingLink: false },
    });

    return buildEphemeralMessage(
      `A linked Steam account is required for verification. Link your Steam account here: ${steamLinkUrl}\n\nAfter linking, click Verify again in Discord.`,
    );
  }

  private async restoreVerifiedRole(input: {
    guildId: string;
    userId: string;
    user?: MemberVerificationUser | null;
  }): Promise<void> {
    const { guildId, userId } = input;
    const config = await this.getConfig(guildId);
    if (!config?.verifiedRoleId) {
      return;
    }
    await this.guildResources.requireRole(guildId, config.verifiedRoleId);

    try {
      await this.options.addGuildMemberRole(guildId, userId, config.verifiedRoleId);
      await this.audit("member-verification.role-restoration", { guildId, user: input.user });
    } catch (error) {
      console.warn("Failed to restore verified role", error);
    }
  }

  private async isVerificationMethodAvailable(
    guildId: string,
    method: MemberVerificationMethod | undefined,
  ): Promise<boolean> {
    if (!method || method === "discord-button") return true;
    return (await this.getVerificationMethodBlockReason(guildId, method)) === null;
  }

  private async getVerificationMethodBlockReason(
    guildId: string,
    method: MemberVerificationMethod | undefined,
  ): Promise<
    | "advanced-method-paid"
    | "steam-link-runtime-unavailable"
    | "steam-link-guild-config-missing"
    | null
  > {
    if (!method || method === "discord-button") return null;

    const entitlement = await this.options.guildEntitlementStore.readGuildEntitlement(guildId);
    if (!getGuildEntitlementLimits(entitlement.tier).paidFeatures) {
      return "advanced-method-paid";
    }

    if (method !== "steam-link") return null;
    if (this.options.steamLinkAvailable === false || !this.options.platformLinkStore) {
      return "steam-link-runtime-unavailable";
    }
    const config = await this.options.platformLinkStore.readPlatformLinkConfig(guildId, "steam");
    return config ? null : "steam-link-guild-config-missing";
  }

  private async getAdminVerificationMethodBlockReason(
    guildId: string,
    method: MemberVerificationMethod | undefined,
  ): Promise<
    | "advanced-method-paid"
    | "turnstile-runtime-unavailable"
    | "steam-link-runtime-unavailable"
    | "steam-link-guild-config-missing"
    | null
  > {
    const runtimeBlockReason = await this.getVerificationMethodBlockReason(guildId, method);
    if (runtimeBlockReason) return runtimeBlockReason;
    if (
      method === "turnstile" &&
      (!this.options.turnstileSiteKey?.trim() || !this.options.turnstileSecretKey?.trim())
    ) {
      return "turnstile-runtime-unavailable";
    }
    return null;
  }

  private async buildWelcomeMessage(
    guildId: string,
    config: MemberVerificationConfig,
  ): Promise<CreateChannelMessageInput> {
    const embed: DiscordEmbed = {
      title: config.title,
      description: config.description,
      color: config.color,
    };

    if (config.imageUrl) {
      embed.image = { url: config.imageUrl };
    }
    if (config.thumbnailUrl) {
      embed.thumbnail = { url: config.thumbnailUrl };
    }

    const footerText = await this.options.resolveFooterText?.(guildId).catch((error) => {
      console.warn("Failed to resolve member verification DM footer", error);
      return undefined;
    });
    embed.footer = { text: footerText ?? "hafbot.xyz" };
    embed.timestamp = new Date().toISOString();

    const buttonEmoji = parseButtonEmoji(config.verifyButtonEmoji);
    const verifyButton = {
      type: DISCORD_BUTTON_COMPONENT,
      style: 3,
      label: "Verify",
      custom_id: buildMemberVerificationCustomId(guildId),
      ...(buttonEmoji ? { emoji: buttonEmoji } : {}),
    };
    const rowComponents: unknown[] = [verifyButton];
    if (config.rulesUrl) {
      rowComponents.push({
        type: DISCORD_BUTTON_COMPONENT,
        style: 5,
        label: "Rules",
        url: config.rulesUrl,
      });
    }

    const components: unknown[] = [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: rowComponents,
      },
    ];

    return {
      embeds: [embed],
      components,
      allowed_mentions: { parse: [] },
    };
  }

  private async blockManualWelcomeDm(
    input: { guildId: string; userId: string; actorUserId: string },
    reason: Exclude<ManualWelcomeDmResult["outcome"], "sent" | "undeliverable" | "rate-limited">,
    user?: MemberVerificationUser | null,
  ): Promise<ManualWelcomeDmResult> {
    await this.audit("member-verification.dm-blocked", {
      guildId: input.guildId,
      user: { ...user, id: input.userId },
      reason,
      context: {
        source: "manual",
        outcome: "blocked",
        actorUserId: input.actorUserId,
      },
    });
    return { outcome: reason };
  }

  private async deliverWelcomeDm(input: {
    guildId: string;
    userId: string;
    config: MemberVerificationConfig;
    user?: MemberVerificationUser | null;
    context?: Record<string, unknown>;
  }): Promise<{ outcome: "sent" | "undeliverable" }> {
    const body = await this.buildWelcomeMessage(input.guildId, input.config);
    try {
      await this.options.sendUserDm(input.userId, body);
      await this.audit("member-verification.dm-sent", {
        guildId: input.guildId,
        user: { ...input.user, id: input.userId },
        context: { ...input.context, outcome: "delivered" },
      });
      return { outcome: "sent" };
    } catch (error) {
      console.warn("Failed to send member verification welcome DM", error);
      await this.audit("member-verification.dm-undeliverable", {
        guildId: input.guildId,
        user: { ...input.user, id: input.userId },
        context: { ...input.context, outcome: "undeliverable" },
      });
      return { outcome: "undeliverable" };
    }
  }

  async audit(
    eventId:
      | "member-verification.dm-sent"
      | "member-verification.dm-undeliverable"
      | "member-verification.dm-blocked"
      | "member-verification.verify"
      | "member-verification.verify-failed"
      | "member-verification.role-restoration"
      | "member-verification.panel-published"
      | "member-verification.attempt-created"
      | "member-verification.attempt-expired"
      | "member-verification.attempt-reused"
      | "member-verification.discord-mismatch"
      | "member-verification.turnstile-failed"
      | "member-verification.turnstile-pass"
      | "member-verification.steam-link-required"
      | "member-verification.steam-link-missing",
    data: {
      guildId: string;
      user?: MemberVerificationUser | null;
      reason?: string;
      context?: Record<string, unknown>;
    },
  ): Promise<void> {
    const memberData: MemberAuditEventData = {
      guildId: data.guildId,
      user: data.user ?? undefined,
      reason: data.reason,
      context: data.context,
    };

    if (this.options.postAudit) {
      await this.options.postAudit(eventId as AuditEventId, memberData);
      return;
    }

    if (!this.options.guildAuditLogStore) {
      return;
    }
    await postMemberAuditEvent(
      eventId,
      memberData,
      this.options.guildAuditLogStore,
      this.options.discordBotToken,
    );
  }
}
