import { DiscordApiError } from "../discord/client";
import type { ReactionRoleDiscord } from "../discord/reaction-roles";
import {
  DISCORD_PERMISSION_FLAGS,
  getBaseGuildPermissions,
  getChannelPermissions,
  getHighestBotRole,
  hasPermission,
  type GuildPermissionContext,
} from "../runtime/admin-permissions";
import type { ReactionRoleStore } from "../runtime/contracts/reaction-role-store";
import { deriveGatewayOperationNonce } from "../runtime/gateway-event-idempotency";
import { isRecord } from "../unknown-parse";
import {
  parseReactionRoleEmoji,
  isPublishedReactionRoleOption,
  reactionRoleMessage,
  reactionRoleSettingsSchema,
  MAX_REACTION_ROLE_PANELS,
  type ReactionRolePanel,
  type ReactionRoleSettings,
} from "../reaction-roles";

const STAFF_PERMISSIONS = [
  1, 2, 3, 4, 5, 7, 13, 17, 19, 22, 23, 24, 27, 28, 29, 30, 33, 34, 40, 41, 43, 51, 52,
].reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);

export class ReactionRoleError extends Error {}

function roleManagementError(context: GuildPermissionContext, roleId: string): string | null {
  const role = context.roles.find((entry) => entry.id === roleId);
  if (!role || roleId === context.guildId || role.managed)
    return "Choose an ordinary server role, not @everyone or an integration role.";
  const highest = getHighestBotRole(context);
  if (!highest || role.position >= highest.position)
    return "Move HAF Bot's role above every selectable role.";
  if (!hasPermission(getBaseGuildPermissions(context), DISCORD_PERMISSION_FLAGS.manageRoles))
    return "HAF Bot needs Manage Roles.";
  return null;
}

export function reactionRoleSafetyError(
  context: GuildPermissionContext,
  roleId: string,
  restricted: ReadonlySet<string>,
): string | null {
  const managementError = roleManagementError(context, roleId);
  if (managementError) return managementError;
  const role = context.roles.find((entry) => entry.id === roleId)!;
  if (restricted.has(roleId))
    return "This role is used by a staff, verification, linked-account, Clan, ticket, or paid-role workflow. Choose a separate game role.";
  if (
    (BigInt(role.permissions) & STAFF_PERMISSIONS) !== 0n ||
    context.channels.some((channel) =>
      channel.permission_overwrites?.some(
        (overwrite) =>
          overwrite.type === 0 &&
          overwrite.id === roleId &&
          (BigInt(overwrite.allow) & STAFF_PERMISSIONS) !== 0n,
      ),
    )
  )
    return "Roles with staff or management permissions cannot be self-assigned.";
  return null;
}

export class ReactionRoleService {
  constructor(
    private readonly store: ReactionRoleStore,
    private readonly discord: ReactionRoleDiscord,
    private readonly botUserId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async save(
    guildId: string,
    input: ReactionRoleSettings,
    panelId?: string | null,
  ): Promise<ReactionRolePanel> {
    const settings = reactionRoleSettingsSchema.parse(input);
    return this.withLease(guildId, async (lease) => {
      const current = panelId === null ? null : await this.store.readPanel(guildId, panelId);
      if (panelId && !current)
        throw new ReactionRoleError("This panel no longer exists. Refresh the page.");
      if (!current && (await this.store.listPanels(guildId)).length >= MAX_REACTION_ROLE_PANELS)
        throw new ReactionRoleError(
          `A server can keep up to ${MAX_REACTION_ROLE_PANELS} reaction-role panels.`,
        );
      if (current) this.requireBot(current);
      if (current?.messageId) {
        if (
          current.channelId !== settings.channelId ||
          current.publishedOptions.some(
            (old) =>
              !settings.options.some(
                (next) =>
                  next.roleId === old.roleId &&
                  parseReactionRoleEmoji(next.emoji)!.key ===
                    parseReactionRoleEmoji(old.emoji)!.key,
              ),
          )
        )
          throw new ReactionRoleError(
            "Published emoji-to-role mappings and the channel cannot be removed or changed. Delete the panel first, or append new choices.",
          );
      }
      await this.validate(guildId, settings, current?.id);
      const panel: ReactionRolePanel = {
        ...settings,
        guildId,
        id: current?.id ?? crypto.randomUUID(),
        botUserId: this.botUserId,
        messageId: current?.messageId ?? null,
        publishedOptions: current?.publishedOptions ?? [],
        activatedAtMs: current?.activatedAtMs ?? null,
        enabled: false,
        updatedAtMs: this.now(),
      };
      await lease.save(panel);
      return panel;
    });
  }

  async publish(guildId: string, panelId?: string): Promise<ReactionRolePanel> {
    return this.withLease(guildId, async (lease) => {
      let panel = await this.requirePanel(guildId, panelId);
      await this.validate(guildId, panel, panel.id);
      await lease.renew();
      const body = reactionRoleMessage(panel);
      if (panel.messageId) {
        await this.discord.editMessage(panel.channelId, panel.messageId, body);
      } else {
        const message = await this.discord.createMessage(panel.channelId, {
          ...body,
          nonce: await deriveGatewayOperationNonce(`reaction-role:${panel.id}`, "publish"),
          enforce_nonce: true,
        });
        panel = { ...panel, messageId: message.id };
      }
      // Only choices actually written to Discord become immutable. Keep the message
      // checkpoint even if seeding later fails, so retries continue in place.
      panel = { ...panel, publishedOptions: panel.options };
      await lease.save(panel);
      for (const option of panel.options) {
        await lease.renew();
        await this.discord.seedReaction(
          panel.channelId,
          panel.messageId!,
          parseReactionRoleEmoji(option.emoji)!.api,
        );
      }
      panel = { ...panel, enabled: true, activatedAtMs: this.now(), updatedAtMs: this.now() };
      await lease.save(panel);
      return panel;
    });
  }

  async setEnabled(guildId: string, enabled: boolean, panelId?: string) {
    return this.withLease(guildId, async (lease) => {
      const panel = await this.store.readPanel(guildId, panelId);
      if (!panel) throw new ReactionRoleError("Save a panel first.");
      if (enabled) {
        this.requireBot(panel);
        if (!panel.messageId) throw new ReactionRoleError("Publish the panel first.");
        if (
          panel.options.length !== panel.publishedOptions.length ||
          panel.options.some((option) => !isPublishedReactionRoleOption(panel, option))
        ) {
          throw new ReactionRoleError("Publish saved draft choices before enabling the panel.");
        }
        await this.validate(guildId, panel, panel.id);
      }
      const next = {
        ...panel,
        enabled,
        activatedAtMs: enabled ? this.now() : panel.activatedAtMs,
        updatedAtMs: this.now(),
      };
      await lease.save(next);
      return next;
    });
  }

  async delete(guildId: string, panelId?: string) {
    return this.withLease(guildId, async (lease) => {
      const panel = await this.store.readPanel(guildId, panelId);
      if (!panel) return;
      await lease.save({ ...panel, enabled: false, updatedAtMs: this.now() });
      // A new bot cannot delete another identity's Discord message, but Guild
      // administrators must still be able to reset the saved configuration.
      if (panel.messageId && panel.botUserId === this.botUserId) {
        try {
          await this.discord.deleteMessage(panel.channelId, panel.messageId);
        } catch (error) {
          if (!(error instanceof DiscordApiError && error.status === 404)) throw error;
        }
      }
      await lease.delete(panel.id);
    });
  }

  async reconcile(data: unknown, receivedAtMs?: number): Promise<void> {
    if (
      !isRecord(data) ||
      typeof data.guild_id !== "string" ||
      typeof data.user_id !== "string" ||
      !/^[1-9]\d{0,19}$/.test(data.user_id) ||
      !isRecord(data.emoji)
    )
      return;
    const guildId = data.guild_id;
    const userId = data.user_id;
    if (userId === this.botUserId) return;
    const key =
      typeof data.emoji.id === "string"
        ? `custom:${data.emoji.id}`
        : typeof data.emoji.name === "string"
          ? parseReactionRoleEmoji(data.emoji.name)?.key
          : null;
    if (!key) return;
    const matches = (panel: ReactionRolePanel | null) =>
      panel?.enabled &&
      (receivedAtMs === undefined ||
        panel.activatedAtMs === null ||
        receivedAtMs >= panel.activatedAtMs) &&
      panel.botUserId === this.botUserId &&
      panel.messageId === data.message_id &&
      panel.channelId === data.channel_id;
    if (typeof data.channel_id !== "string" || typeof data.message_id !== "string") return;
    const initial = await this.store.readPanelByMessage(guildId, data.channel_id, data.message_id);
    if (
      !matches(initial) ||
      !initial?.options.some((option) => parseReactionRoleEmoji(option.emoji)!.key === key)
    )
      return;
    await this.withLease(guildId, async (lease) => {
      const panel = await this.store.readPanel(guildId, initial.id);
      if (!panel || !matches(panel)) return;
      const option = panel.options.find(
        (entry) => parseReactionRoleEmoji(entry.emoji)!.key === key,
      );
      if (!option) return;
      const member = await this.discord.fetchMember(guildId, userId);
      if (!member || member.user?.bot) return;
      const context = await this.discord.loadPermissionContext(guildId, this.botUserId);
      if (roleManagementError(context, option.roleId)) return;
      // Read current Discord state rather than trusting delivery order or old event payloads.
      let selected: boolean;
      try {
        selected = await this.discord.hasReaction(
          panel.channelId,
          panel.messageId!,
          parseReactionRoleEmoji(option.emoji)!.api,
          userId,
        );
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return;
        throw error;
      }
      const hasRole = member.roles?.includes(option.roleId) ?? false;
      if (selected) {
        const memberRoles = new Set(member.roles ?? []);
        if (
          (panel.requiredRoleIds ?? []).some((id) => !memberRoles.has(id)) ||
          (panel.blockedRoleIds ?? []).some((id) => memberRoles.has(id))
        )
          return;
        const restricted = await this.store.readRestrictedRoleIds(guildId);
        if (reactionRoleSafetyError(context, option.roleId, restricted)) return;
        if (await this.store.isRoleSuspended(guildId, userId, option.roleId)) return;
        if (panel.mode === "single") {
          const channel = context.channels.find((entry) => entry.id === panel.channelId);
          if (!channel || !hasPermission(getChannelPermissions(context, channel), 1n << 13n))
            return;
          for (const other of panel.options) {
            if (other.roleId === option.roleId) continue;
            const emoji = parseReactionRoleEmoji(other.emoji)!;
            if (
              await this.discord.hasReaction(panel.channelId, panel.messageId!, emoji.api, userId)
            ) {
              await lease.renew();
              await this.discord.clearReaction(
                panel.channelId,
                panel.messageId!,
                { id: emoji.id, name: emoji.id ? emoji.api.split(":")[0] : emoji.api },
                userId,
              );
              // Do not grant a second role if Discord could not clear the previous selection.
              if (
                await this.discord.hasReaction(panel.channelId, panel.messageId!, emoji.api, userId)
              )
                throw new ReactionRoleError(
                  "Remove your previous reaction before choosing another role.",
                );
            }
            if (memberRoles.has(other.roleId)) {
              if (roleManagementError(context, other.roleId)) return;
              await lease.renew();
              await this.discord.removeRole(guildId, userId, other.roleId);
            }
          }
        }
      }
      if (selected === hasRole) return;
      await lease.renew();
      if (selected) await this.discord.addRole(guildId, userId, option.roleId);
      else await this.discord.removeRole(guildId, userId, option.roleId);
    });
  }

  private async validate(guildId: string, settings: ReactionRoleSettings, panelId?: string) {
    if (!this.botUserId) throw new ReactionRoleError("The bot identity is unavailable.");
    const [context, restricted] = await Promise.all([
      this.discord.loadPermissionContext(guildId, this.botUserId),
      this.store.readRestrictedRoleIds(guildId),
    ]);
    const channel = context.channels.find(
      (entry) => entry.id === settings.channelId && (entry.type === 0 || entry.type === 5),
    );
    if (!channel) throw new ReactionRoleError("Choose a text channel in this server.");
    const permissions = getChannelPermissions(context, channel);
    const required = [1n << 10n, 1n << 11n, 1n << 6n, 1n << 16n];
    if (required.some((flag) => !hasPermission(permissions, flag)))
      throw new ReactionRoleError(
        "HAF Bot needs View Channel, Send Messages, Add Reactions, and Read Message History in the panel channel.",
      );
    if (settings.mode === "single" && !hasPermission(permissions, 1n << 13n))
      throw new ReactionRoleError(
        "Single-choice panels need Manage Messages in the panel channel to clear previous reactions.",
      );
    for (const id of [...(settings.requiredRoleIds ?? []), ...(settings.blockedRoleIds ?? [])]) {
      if (id === guildId || !context.roles.some((role) => role.id === id))
        throw new ReactionRoleError("Choose eligibility roles that exist in this server.");
    }
    const otherPanels = (await this.store.listPanels(guildId)).filter(
      (panel) => panel.id !== panelId,
    );
    if (
      settings.options.some((option) =>
        otherPanels.some((panel) =>
          panel.options.some((choice) => choice.roleId === option.roleId),
        ),
      )
    )
      throw new ReactionRoleError(
        "A selectable role is already used by another panel. Use a separate role so panels can be managed independently.",
      );
    for (const option of settings.options) {
      const error = reactionRoleSafetyError(context, option.roleId, restricted);
      if (error) throw new ReactionRoleError(`${option.label}: ${error}`);
    }
  }

  private requireBot(panel: ReactionRolePanel) {
    if (panel.botUserId !== this.botUserId)
      throw new ReactionRoleError(
        "This panel belongs to a different bot identity. Delete its configuration to create a replacement with the current bot.",
      );
  }

  private async requirePanel(guildId: string, panelId?: string) {
    const panel = await this.store.readPanel(guildId, panelId);
    if (!panel) throw new ReactionRoleError("Save a panel first.");
    this.requireBot(panel);
    return panel;
  }

  private async withLease<T>(
    guildId: string,
    run: (lease: {
      renew(): Promise<void>;
      save(panel: ReactionRolePanel): Promise<void>;
      delete(panelId: string): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const token = crypto.randomUUID();
    const renew = async () => {
      if (!(await this.store.renewLease(guildId, token, this.now())))
        throw new ReactionRoleError("The reaction-role update lease expired. Try again.");
    };
    if (!(await this.store.claimLease(guildId, token, this.now())))
      throw new ReactionRoleError("A reaction-role update is in progress. Try again shortly.");
    try {
      return await run({
        renew,
        save: async (panel) => {
          await renew();
          if (!(await this.store.savePanel(panel, { token, nowMs: this.now() })))
            throw new ReactionRoleError("The reaction-role update lease expired. Try again.");
        },
        delete: async (panelId) => {
          await renew();
          if (!(await this.store.deletePanel(guildId, { token, nowMs: this.now() }, panelId)))
            throw new ReactionRoleError("The reaction-role update lease expired. Try again.");
        },
      });
    } finally {
      await this.store.releaseLease(guildId, token);
    }
  }
}
