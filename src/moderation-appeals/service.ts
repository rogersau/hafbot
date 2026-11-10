import { z } from "zod";
import { DiscordApiError } from "../discord/client";
import {
  BanAppealError,
  banAppealGuildIdSchema,
  banAppealIdSchema,
  banAppealSettingsSchema,
  type BanAppealPublicState,
  type BanAppealSettings,
  type BanAppealStore,
} from "./types";

export interface BanAppealDiscord {
  readBan(userId: string): Promise<{ reason: string | null } | null>;
  assertCapabilities(): Promise<void>;
  assertCanReview(actorUserId: string, action: "reject" | "unban"): Promise<void>;
  unban(userId: string, reason: string): Promise<void>;
}

export class BanAppealService {
  constructor(
    readonly store: BanAppealStore,
    readonly guildId: string,
    private readonly discord: BanAppealDiscord,
    private readonly now: () => number = Date.now,
    private readonly isSuspended: (guildId: string) => Promise<boolean> = async () => false,
  ) {
    banAppealGuildIdSchema.parse(guildId);
  }

  async configure(settings: BanAppealSettings, expectedRevision: number) {
    await this.available();
    const parsed = banAppealSettingsSchema.parse(settings);
    if (parsed.enabled) await this.discord.assertCapabilities();
    return this.store.saveConfig(
      this.guildId,
      parsed,
      z.number().int().nonnegative().parse(expectedRevision),
    );
  }

  async publicState(
    user: { discordUserId: string; name: string } | null,
  ): Promise<BanAppealPublicState> {
    await this.available();
    if (user) banAppealGuildIdSchema.parse(user.discordUserId);
    const config = await this.store.getConfig(this.guildId);
    const appeal = user ? await this.store.latestForUser(this.guildId, user.discordUserId) : null;
    return {
      config,
      signedInName: user ? user.name.slice(0, 100) || "Discord member" : null,
      currentBan:
        user && config.enabled ? Boolean(await this.discord.readBan(user.discordUserId)) : false,
      nextSubmissionAtMs: user
        ? await this.store.nextSubmissionAt(this.guildId, user.discordUserId)
        : 0,
      appeal: appeal
        ? {
            id: appeal.id,
            text: appeal.text,
            status: appeal.status,
            createdAtMs: appeal.createdAtMs,
            resolvedAtMs: appeal.resolvedAtMs,
          }
        : null,
    };
  }

  async submit(user: { discordUserId: string; name: string }, input: { id: string; text: string }) {
    await this.available();
    banAppealGuildIdSchema.parse(user.discordUserId);
    const id = banAppealIdSchema.parse(input.id);
    const text = z.string().trim().min(20).max(4000).parse(input.text);
    if (!(await this.store.getConfig(this.guildId)).enabled)
      throw new BanAppealError("Ban appeals are not enabled for this server.", 404);
    const ban = await this.discord.readBan(user.discordUserId);
    if (!ban)
      throw new BanAppealError("This Discord account is not currently banned from this server.");
    return this.store.submit({
      guildId: this.guildId,
      id,
      userId: user.discordUserId,
      displayName: user.name.trim().slice(0, 100) || "Discord member",
      text,
      banReason: ban.reason?.slice(0, 2000) ?? null,
      nowMs: this.now(),
    });
  }

  async adminData() {
    return {
      config: await this.store.getConfig(this.guildId),
      appeals: await this.store.list(this.guildId),
    };
  }

  async detail(id: string) {
    banAppealIdSchema.parse(id);
    const appeal = await this.store.read(this.guildId, id);
    if (!appeal) throw new BanAppealError("Ban appeal not found.", 404);
    return { appeal, operations: await this.store.operations(this.guildId, id) };
  }

  async review(input: {
    id: string;
    actorUserId: string;
    action: "reject" | "unban";
    reason: string;
    expectedRevision: number;
  }) {
    await this.available();
    banAppealIdSchema.parse(input.id);
    banAppealGuildIdSchema.parse(input.actorUserId);
    const reason = z.string().trim().min(3).max(500).parse(input.reason);
    z.number().int().positive().parse(input.expectedRevision);
    const appeal = (await this.detail(input.id)).appeal;
    await this.discord.assertCanReview(input.actorUserId, input.action);
    if (appeal.status === "unbanned" || appeal.status === "rejected") {
      return (
        await this.store.claimReview({
          ...input,
          guildId: this.guildId,
          reason,
          nowMs: this.now(),
          operationId: crypto.randomUUID(),
        })
      ).appeal;
    }
    const ban = await this.discord.readBan(appeal.userId);
    if (appeal.status === "unban_pending" && !ban && appeal.operationId) {
      return this.store.finishUnban(
        this.guildId,
        appeal.id,
        appeal.operationId,
        "succeeded",
        this.now(),
      );
    }
    const claim = await this.store.claimReview({
      ...input,
      guildId: this.guildId,
      reason,
      nowMs: this.now(),
      operationId: crypto.randomUUID(),
    });
    if (input.action === "reject") return claim.appeal;
    if (!claim.execute) {
      if (claim.appeal.status === "unbanned") return claim.appeal;
      if (claim.operation?.outcome === "started") {
        if (claim.operation.createdAtMs > this.now() - 60_000)
          throw new BanAppealError(
            "An unban request is still in progress. Refresh its status shortly.",
            409,
          );
        await this.store.finishUnban(
          this.guildId,
          appeal.id,
          claim.operation.id,
          "uncertain",
          this.now(),
        );
      }
      throw new BanAppealError(
        "The earlier unban request cannot yet be confirmed. The ban is still present. Inspect Discord before rejecting the appeal or completing an unban there; HAF will not repeat an uncertain removal.",
        409,
      );
    }
    if (!claim.operation)
      throw new BanAppealError("The review operation could not be recorded.", 503);
    if (!ban)
      return this.store.finishUnban(
        this.guildId,
        appeal.id,
        claim.operation.id,
        "succeeded",
        this.now(),
      );
    try {
      await this.discord.unban(appeal.userId, `Ban appeal ${appeal.id}: ${reason}`);
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        [400, 401, 403, 404, 405, 429].includes(error.status)
      ) {
        if (error.status === 404 && !(await this.discord.readBan(appeal.userId)))
          return this.store.finishUnban(
            this.guildId,
            appeal.id,
            claim.operation.id,
            "succeeded",
            this.now(),
          );
        await this.store.finishUnban(
          this.guildId,
          appeal.id,
          claim.operation.id,
          "failed",
          this.now(),
        );
        throw new BanAppealError(
          "Discord refused the unban request. Check bot permissions and refresh the appeal before trying again.",
          503,
        );
      }
      await this.store.finishUnban(
        this.guildId,
        appeal.id,
        claim.operation.id,
        "uncertain",
        this.now(),
      );
      throw new BanAppealError(
        "The unban result could not be confirmed. Refresh and check its status before taking another action.",
        409,
      );
    }
    return this.store.finishUnban(
      this.guildId,
      appeal.id,
      claim.operation.id,
      "succeeded",
      this.now(),
    );
  }

  private async available() {
    if (await this.isSuspended(this.guildId))
      throw new BanAppealError("Service unavailable for this server.", 503);
  }
}
