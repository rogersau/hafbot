import type { GuildPermissionContext } from "../runtime/admin-permissions";
import type { GatewayEventOperationRunner } from "../runtime/gateway-event-idempotency";
import { deriveGatewayOperationNonce } from "../runtime/gateway-event-idempotency";
import type { DiscordInteraction } from "../runtime/app-types";
import { isRecord } from "../unknown-parse";
import { ContentFeedReader, contentFeedUrl } from "./feeds";
import {
  CommunityToolsError,
  matchesReply,
  moderationMatches,
  parseCommunityConfig,
  recurringOccurrence,
  snowflake,
  type AutomationConfig,
  type CommunityFeature,
  type CommunityMessage,
  type ModerationConfig,
} from "./config";
import type { CommunityToolsStore, CommunityDelivery } from "./store";

export interface CommunityMember {
  roles: string[];
  bot: boolean;
}
export interface CommunityDiscord {
  resources(): Promise<GuildPermissionContext>;
  member(userId: string): Promise<CommunityMember | null>;
  send(channelId: string, content: string, roleIds: string[], nonce: string): Promise<void>;
  delete(channelId: string, messageId: string): Promise<void>;
  timeout(userId: string, untilMs: number): Promise<void>;
  validateChannel(channelId: string, privateOnly?: boolean): Promise<void>;
  moderate(action: "kick" | "ban" | "unban", userId: string, reason: string): Promise<void>;
  messages(
    channelId: string,
    limit: number,
  ): Promise<Array<{ id: string; userId: string; content: string; bot: boolean }>>;
  assertStaffTarget(
    actorId: string,
    targetId: string,
    permission: bigint,
    channelId?: string,
  ): Promise<void>;
}
export interface CommunityToolsOptions {
  store: CommunityToolsStore;
  discordForGuild(guildId: string): Promise<CommunityDiscord>;
  operationsFor(eventKey: string): GatewayEventOperationRunner;
  isSuspended(guildId: string): Promise<boolean>;
  authorizeAdmin(interaction: DiscordInteraction): Promise<boolean>;
  feedReader: ContentFeedReader;
  now?: () => number;
}
export class CommunityToolsService {
  readonly store: CommunityToolsStore;
  constructor(private readonly options: CommunityToolsOptions) {
    this.store = options.store;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async read(guildId: string, feature: CommunityFeature) {
    return this.store.read(guildId, feature);
  }
  async dashboard(guildId: string, feature: CommunityFeature) {
    const [snapshot, status] = await Promise.all([
      this.read(guildId, feature),
      this.store.status(guildId),
    ]);
    return { ...snapshot, status, twitchAvailable: this.options.feedReader.twitchAvailable };
  }
  async save(guildId: string, feature: CommunityFeature, value: unknown, revision: number) {
    const config = parseCommunityConfig(feature, value);
    const discord = await this.options.discordForGuild(guildId);
    const resources = await discord.resources();
    const roles = new Set(resources.roles.map((role) => role.id));
    const requireRoles = (ids: string[]) => {
      if (ids.some((roleId) => !roles.has(roleId)))
        throw new CommunityToolsError("One of the selected roles no longer exists in this server.");
    };
    if ("commands" in config) {
      for (const command of config.commands) {
        requireRoles(command.requiredRoleIds);
        for (const channel of command.channelIds) await discord.validateChannel(channel);
      }
      for (const schedule of config.schedules) {
        requireRoles(schedule.notifyRoleIds);
        await discord.validateChannel(schedule.channelId);
      }
    } else if ("rules" in config) {
      requireRoles(config.moderatorRoleIds);
      for (const rule of config.rules) {
        requireRoles(rule.excludedRoleIds);
        for (const channel of rule.channelIds) await discord.validateChannel(channel);
      }
      if (config.reportChannelId) await discord.validateChannel(config.reportChannelId, true);
    } else {
      for (const feed of config.feeds) {
        contentFeedUrl(feed);
        requireRoles(feed.notifyRoleIds);
        await discord.validateChannel(feed.channelId);
        if (
          config.enabled &&
          feed.enabled &&
          feed.provider === "twitch" &&
          !this.options.feedReader.twitchAvailable
        )
          throw new CommunityToolsError(
            "Twitch feeds are unavailable until the HAF operator configures Twitch credentials.",
            503,
          );
      }
    }
    return this.store.save(guildId, feature, config, revision);
  }
  async onMessage(
    message: CommunityMessage,
    operations: GatewayEventOperationRunner,
  ): Promise<void> {
    if (
      this.now() - message.receivedAtMs > 5 * 60000 ||
      (await this.options.isSuspended(message.guildId))
    )
      return;
    const [moderationSnapshot, automationSnapshot] = await Promise.all([
      this.read(message.guildId, "moderation"),
      this.read(message.guildId, "automation"),
    ]);
    const moderation = moderationSnapshot.config as ModerationConfig;
    const config = automationSnapshot.config as AutomationConfig;
    if (!moderation.enabled && !config.enabled) return;
    const discord = await this.options.discordForGuild(message.guildId);
    const member = await discord.member(message.userId);
    if (!member || member.bot) return;
    let blocked = false;
    if (moderation.enabled) {
      const resources = await discord.resources();
      const staffRoles = resources.roles
        .filter((role) => (BigInt(role.permissions) & 8n) !== 0n)
        .map((role) => role.id);
      for (const rule of moderation.rules) {
        if (
          !rule.enabled ||
          (rule.channelIds.length && !rule.channelIds.includes(message.channelId)) ||
          member.roles.some(
            (role) =>
              rule.excludedRoleIds.includes(role) ||
              moderation.moderatorRoleIds.includes(role) ||
              staffRoles.includes(role),
          ) ||
          !moderationMatches(rule, message.content)
        )
          continue;
        const result = await operations.runResult(`community:rule:${rule.id}:count`, () =>
          this.store.recordCase({
            id: `${message.eventKey}:rule:${rule.id}`,
            guildId: message.guildId,
            userId: message.userId,
            actorUserId: null,
            action: rule.trigger === "message-rate" ? "rate-observation" : "rule-violation",
            reason: rule.name,
            ruleId: rule.id,
            windowSeconds: rule.windowSeconds,
            createdAtMs: message.receivedAtMs,
          }),
        );
        if (rule.trigger === "message-rate" && result.count < rule.messageLimit) continue;
        blocked = true;
        if (rule.deleteMessage)
          await operations.run("community:delete-message", () =>
            discord.delete(message.channelId, message.messageId),
          );
        if (rule.warn)
          await operations.run("community:warning", () =>
            discord.send(
              message.channelId,
              `<@${message.userId}>: your message triggered a server rule (${rule.name}).`,
              [],
              deriveGatewayOperationNonce(message.eventKey, "community:warning"),
            ),
          );
        if (rule.timeoutAfter > 0 && result.count >= rule.timeoutAfter)
          await operations.run(`community:timeout:${rule.id}`, () =>
            discord.timeout(message.userId, message.receivedAtMs + rule.timeoutMinutes * 60000),
          );
      }
    }
    if (blocked) return;
    if (!config.enabled) return;
    for (const command of config.commands) {
      if (
        !command.enabled ||
        !matchesReply(message.content, command.trigger, command.match) ||
        !eligible(command, member.roles, message.channelId)
      )
        continue;
      const allowed = await operations.runResult(`community:reply:${command.id}:cooldown`, () =>
        this.store.claim(
          `reply:${message.guildId}:${command.id}:${message.userId}`,
          this.now() + command.cooldownSeconds * 1000,
          this.now(),
        ),
      );
      if (allowed)
        await operations.run(`community:reply:${command.id}`, () =>
          discord.send(
            message.channelId,
            renderReply(command.response, message.userId),
            [],
            deriveGatewayOperationNonce(message.eventKey, `community:reply:${command.id}`),
          ),
        );
      break;
    }
  }
  async customReply(input: {
    guildId: string;
    userId: string;
    channelId: string;
    name: string;
    interactionId: string;
  }): Promise<string> {
    const { config } = (await this.read(input.guildId, "automation")) as {
      config: AutomationConfig;
    };
    const command = config.commands.find((item) => item.id === input.name && item.enabled);
    if (!config.enabled || !command)
      throw new CommunityToolsError("That custom command is not available.", 404);
    const member = await (await this.options.discordForGuild(input.guildId)).member(input.userId);
    if (!member || member.bot || !eligible(command, member.roles, input.channelId))
      throw new CommunityToolsError("This command is not available to you in this channel.", 403);
    const ops = this.options.operationsFor(`custom:${input.interactionId}`);
    const allowed = await ops.runResult("cooldown", () =>
      this.store.claim(
        `reply:${input.guildId}:${command.id}:${input.userId}`,
        this.now() + command.cooldownSeconds * 1000,
        this.now(),
      ),
    );
    if (!allowed)
      throw new CommunityToolsError("Please wait before using this command again.", 429);
    return renderReply(command.response, input.userId);
  }
  async sweep(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    for (const { guildId, config, revision, updatedAtMs } of await this.store.enabled(
      "automation",
    )) {
      signal?.throwIfAborted();
      if (await this.options.isSuspended(guildId)) continue;
      for (const schedule of (config as AutomationConfig).schedules) {
        if (!schedule.enabled) continue;
        const occurrence = recurringOccurrence(now, schedule.startsAtMs, schedule.intervalMinutes);
        if (occurrence === null || occurrence < updatedAtMs) continue;
        await this.store.enqueue({
          id: `schedule:${guildId}:${schedule.id}:${occurrence}`,
          guildId,
          feature: "automation",
          itemId: schedule.id,
          channelId: schedule.channelId,
          content: schedule.content,
          roleIds: schedule.notifyRoleIds,
          createdAtMs: occurrence,
          configRevision: revision,
        });
      }
    }
    for (const { guildId, feed, revision } of await this.store.dueFeeds(now)) {
      signal?.throwIfAborted();
      const fingerprint = `${revision}:${feed.provider}:${feed.source}:${feed.channelId}`;
      if (await this.options.isSuspended(guildId)) {
        await this.store.recordFeedFailure(
          guildId,
          feed.id,
          fingerprint,
          now,
          "Service unavailable for this server.",
        );
        continue;
      }
      const previous = await this.store.feedState(guildId, feed.id);
      if (previous && now - previous.checkedAtMs < 5 * 60000) continue;
      if (!(await this.store.claim(`feed-poll:${guildId}:${feed.id}`, now + 60000, now))) continue;
      try {
        const entries = await this.options.feedReader.read(feed);
        signal?.throwIfAborted();
        const fresh = previous?.initialized && previous.fingerprint === fingerprint;
        const unseen = fresh
          ? entries
              .filter((entry) => !previous.seen.includes(entry.id))
              .slice(0, 3)
              .reverse()
          : [];
        for (const entry of unseen)
          await this.store.enqueue({
            id: `feed:${guildId}:${feed.id}:${await digest(fingerprint + ":" + entry.id)}`,
            guildId,
            feature: "feeds",
            itemId: feed.id,
            channelId: feed.channelId,
            content: `**${escapeMarkdown(feed.name)}**\n${escapeMarkdown(entry.title)}\n<${entry.url}>`,
            roleIds: feed.notifyRoleIds,
            createdAtMs: now,
            configRevision: revision,
          });
        await this.store.saveFeedState(
          guildId,
          feed.id,
          fingerprint,
          [...entries.map((entry) => entry.id), ...(fresh ? previous.seen : [])].filter(
            (item, index, all) => all.indexOf(item) === index,
          ),
          now,
        );
      } catch {
        signal?.throwIfAborted();
        await this.store.recordFeedFailure(guildId, feed.id, fingerprint, now);
      }
    }
    for (const delivery of await this.store.deliveries(now)) {
      signal?.throwIfAborted();
      await this.deliver(delivery, signal);
    }
    await this.store.prune(now);
  }
  private async deliver(
    delivery: CommunityDelivery & { token: string },
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.options.isSuspended(delivery.guildId)) {
      await this.store.finishDelivery(delivery.id, delivery.token, "cancelled");
      return;
    }
    const { config, revision } = await this.read(delivery.guildId, delivery.feature);
    const current =
      "schedules" in config
        ? config.schedules.find((item) => item.id === delivery.itemId)
        : "feeds" in config
          ? config.feeds.find((item) => item.id === delivery.itemId)
          : null;
    if (
      !config.enabled ||
      !current?.enabled ||
      current.channelId !== delivery.channelId ||
      revision !== delivery.configRevision
    ) {
      await this.store.finishDelivery(delivery.id, delivery.token, "cancelled");
      return;
    }
    try {
      const discord = await this.options.discordForGuild(delivery.guildId);
      const { botUserId } = await discord.resources();
      signal?.throwIfAborted();
      if (!(await this.store.bindDeliveryBot(delivery.id, delivery.token, botUserId))) {
        await this.store.finishDelivery(
          delivery.id,
          delivery.token,
          "cancelled",
          "Settings, delivery ownership or bot identity changed; this delivery was not replayed.",
        );
        return;
      }
      await discord.send(
        delivery.channelId,
        delivery.content,
        delivery.roleIds.filter((id) => current.notifyRoleIds.includes(id)),
        deriveGatewayOperationNonce(delivery.id, "community:delivery"),
      );
      await this.store.finishDelivery(delivery.id, delivery.token, "delivered");
    } catch {
      signal?.throwIfAborted();
      await this.store.finishDelivery(
        delivery.id,
        delivery.token,
        "pending",
        "Discord could not accept the message. Check channel permissions.",
      );
    }
  }
  async staffAction(input: {
    guildId: string;
    actorId: string;
    userId?: string;
    action: string;
    reason: string;
    interactionId: string;
    channelId: string;
    minutes?: number;
    count?: number;
    filter?: string;
    adminAuthorized: boolean;
  }): Promise<string> {
    const { config } = (await this.read(input.guildId, "moderation")) as {
      config: ModerationConfig;
    };
    if (!config.enabled)
      throw new CommunityToolsError("Chat Moderation is not enabled for this server.", 409);
    const discord = await this.options.discordForGuild(input.guildId);
    const actor = await discord.member(input.actorId);
    if (
      !actor ||
      (!input.adminAuthorized &&
        !actor.roles.some((role) => config.moderatorRoleIds.includes(role)))
    )
      throw new CommunityToolsError(
        "You need the configured moderation access to use this command.",
        403,
      );
    if (input.action === "history")
      return (
        (await this.store.history(input.guildId, input.userId))
          .slice(0, 10)
          .map(
            (entry) =>
              `${entry.action}: ${entry.reason} (<t:${Math.floor(entry.createdAtMs / 1000)}:R>)`,
          )
          .join("\n") || "No moderation history found."
      );
    const ops = this.options.operationsFor(`moderation:${input.interactionId}`);
    if (input.action === "purge") {
      await discord.assertStaffTarget(input.actorId, input.actorId, 1n << 13n, input.channelId);
      const selected = await ops.runResult("purge-selection", async () =>
        (await discord.messages(input.channelId, Math.max(1, Math.min(100, input.count ?? 10))))
          .filter(
            (message) =>
              (!input.userId || message.userId === input.userId) &&
              (!input.filter || message.content.toLowerCase().includes(input.filter.toLowerCase())),
          )
          .map((message) => ({ id: message.id })),
      );
      for (const message of selected)
        await ops.run(`purge:${message.id}`, () => discord.delete(input.channelId, message.id));
      await this.store.recordCase({
        id: `staff:${input.interactionId}`,
        guildId: input.guildId,
        userId: input.userId ?? input.actorId,
        actorUserId: input.actorId,
        action: "purge",
        reason: `${input.reason} (${selected.length} messages)`,
        createdAtMs: this.now(),
      });
      return `Removed ${selected.length} matching messages from the selected channel.`;
    }
    if (!input.userId || !snowflake.safeParse(input.userId).success)
      throw new CommunityToolsError("Choose a valid Discord member ID.");
    if (input.userId === input.actorId)
      throw new CommunityToolsError("You cannot apply this action to yourself.");
    const permission =
      input.action === "kick"
        ? 2n
        : input.action === "ban" || input.action === "unban"
          ? 4n
          : input.action === "timeout"
            ? 1n << 40n
            : 0n;
    await discord.assertStaffTarget(input.actorId, input.userId, permission);
    const accountAction = async (apply: () => Promise<void>) => {
      const key = `account:${input.action}`;
      await this.store.recordCase({
        id: `staff-request:${input.interactionId}`,
        guildId: input.guildId,
        userId: input.userId!,
        actorUserId: input.actorId,
        action: `${input.action}-requested`,
        reason: input.reason,
        createdAtMs: this.now(),
      });
      // A lost response can follow a successful mutation. Replaying it could undo
      // a later staff decision or affect a member who has since rejoined.
      const confirmed = await ops.runResult(key, async () => {
        if (
          !(await this.store.claim(
            `account-action:${input.guildId}:${input.interactionId}`,
            Number.MAX_SAFE_INTEGER,
            this.now(),
          ))
        )
          return false;
        await apply();
        return true;
      });
      if (!confirmed)
        throw new CommunityToolsError(
          "This account action was already attempted and its result is uncertain. It was not repeated. Check Discord before issuing a new command.",
          409,
        );
    };
    if (input.action === "timeout") {
      const minutes = input.minutes ?? 10;
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 40320)
        throw new CommunityToolsError("Timeouts must be between 1 and 40320 minutes.");
      const untilMs = await ops.runResult("timeout-until", () =>
        Promise.resolve(this.now() + minutes * 60000),
      );
      await accountAction(() => discord.timeout(input.userId!, untilMs));
    } else if (input.action === "kick" || input.action === "ban" || input.action === "unban") {
      const action = input.action;
      await accountAction(() => discord.moderate(action, input.userId!, input.reason));
    } else if (input.action !== "warn")
      throw new CommunityToolsError("Unsupported moderation action.");
    await this.store.recordCase({
      id: `staff:${input.interactionId}`,
      guildId: input.guildId,
      userId: input.userId,
      actorUserId: input.actorId,
      action: input.action,
      reason: input.reason,
      createdAtMs: this.now(),
    });
    return `Moderation action recorded: ${input.action}.`;
  }
  async report(input: {
    guildId: string;
    actorId: string;
    channelId: string;
    messageId: string;
    userId: string;
    reason: string;
    interactionId: string;
  }): Promise<string> {
    const { config } = (await this.read(input.guildId, "moderation")) as {
      config: ModerationConfig;
    };
    if (!config.enabled || !config.reportChannelId)
      throw new CommunityToolsError(
        "Member reporting has not been configured for this server.",
        409,
      );
    const discord = await this.options.discordForGuild(input.guildId);
    if (!(await discord.member(input.actorId)))
      throw new CommunityToolsError("You must be a current member to report a message.", 403);
    const ops = this.options.operationsFor(`report:${input.interactionId}`);
    if (
      !(await ops.runResult("report-cooldown", () =>
        this.store.claim(
          `report:${input.guildId}:${input.actorId}`,
          this.now() + 60000,
          this.now(),
        ),
      ))
    )
      throw new CommunityToolsError("Please wait a minute before sending another report.", 429);
    await discord.validateChannel(config.reportChannelId, true);
    await ops.run("report", () =>
      discord.send(
        config.reportChannelId!,
        `**Member report**\nReporter: <@${input.actorId}>\nReported member: <@${input.userId}>\n${escapeMarkdown(input.reason)}\nhttps://discord.com/channels/${input.guildId}/${input.channelId}/${input.messageId}`,
        [],
        deriveGatewayOperationNonce(input.interactionId, "community:report"),
      ),
    );
    await this.store.recordCase({
      id: `report:${input.interactionId}`,
      guildId: input.guildId,
      userId: input.userId,
      actorUserId: input.actorId,
      action: "member-report",
      reason: input.reason,
      createdAtMs: this.now(),
    });
    return "Your report was sent privately to the server moderators.";
  }
  async handleInteraction(interaction: DiscordInteraction): Promise<Response | null> {
    if (
      !isRecord(interaction.data) ||
      typeof interaction.data.name !== "string" ||
      !["custom", "mod", "Report Message"].includes(interaction.data.name)
    )
      return null;
    const reply = (content: string) =>
      Response.json({
        type: 4,
        data: { content: content.slice(0, 1950), flags: 64, allowed_mentions: { parse: [] } },
      });
    const guildId = interaction.guild_id;
    const actorId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !actorId || !interaction.id || !interaction.channel_id)
      return reply("This command can only be used in a server.");
    if (await this.options.isSuspended(guildId))
      return reply("Service unavailable for this server.");
    try {
      const options = Array.isArray(interaction.data.options)
        ? interaction.data.options.filter(isRecord)
        : [];
      const command = options.find((item) => item.type === 1);
      const values =
        command && Array.isArray(command.options) ? command.options.filter(isRecord) : options;
      const string = (key: string) => {
        const value = values.find((item) => item.name === key)?.value;
        return typeof value === "string" ? value : undefined;
      };
      const number = (key: string) => {
        const value = values.find((item) => item.name === key)?.value;
        return typeof value === "number" ? value : undefined;
      };
      if (interaction.data.name === "custom")
        return reply(
          await this.customReply({
            guildId,
            userId: actorId,
            channelId: interaction.channel_id,
            name: string("name") ?? "",
            interactionId: interaction.id,
          }),
        );
      if (interaction.data.name === "Report Message") {
        const resolved = interaction.data.resolved;
        const target = interaction.data.target_id;
        const message =
          isRecord(resolved) && isRecord(resolved.messages) && typeof target === "string"
            ? resolved.messages[target]
            : null;
        if (
          !isRecord(message) ||
          !isRecord(message.author) ||
          typeof message.author.id !== "string" ||
          typeof target !== "string"
        )
          throw new CommunityToolsError("The message could not be identified.");
        return reply(
          await this.report({
            guildId,
            actorId,
            channelId: interaction.channel_id,
            messageId: target,
            userId: message.author.id,
            reason: "Reported through the message menu",
            interactionId: interaction.id,
          }),
        );
      }
      return reply(
        await this.staffAction({
          guildId,
          actorId,
          channelId: interaction.channel_id,
          userId: string("user"),
          action: typeof command?.name === "string" ? command.name : "",
          reason: (string("reason") ?? "Staff action").slice(0, 500),
          minutes: number("minutes"),
          count: number("count"),
          filter: string("contains"),
          interactionId: interaction.id,
          adminAuthorized: await this.options.authorizeAdmin(interaction),
        }),
      );
    } catch (error) {
      if (error instanceof CommunityToolsError) return reply(error.message);
      throw error;
    }
  }
}
function eligible(
  command: { channelIds: string[]; requiredRoleIds: string[] },
  roles: string[],
  channelId: string,
) {
  return (
    (!command.channelIds.length || command.channelIds.includes(channelId)) &&
    (!command.requiredRoleIds.length || command.requiredRoleIds.some((id) => roles.includes(id)))
  );
}
function renderReply(content: string, userId: string) {
  return content.replaceAll("{user}", `<@${userId}>`).slice(0, 1800);
}
function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_~|>]/g, "\\$&");
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
