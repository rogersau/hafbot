import type { GuildPermissionContext } from "../runtime/admin-permissions";
import { reactionRoleSafetyError } from "../services/reaction-role-service";
import {
  ReputationError,
  reputationSettingsSchema,
  reputationSnowflakeSchema,
  type ReputationMember,
  type ReputationRewardJob,
  type ReputationSettings,
  type ReputationStore,
} from "./types";

export interface ReputationDiscord {
  fetchMember(guildId: string, userId: string): Promise<ReputationMember | null>;
  loadPermissionContext(guildId: string): Promise<GuildPermissionContext>;
  readRestrictedRoleIds(guildId: string): Promise<Set<string>>;
  isRoleSuspended(guildId: string, userId: string, roleId: string): Promise<boolean>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
}

export class ReputationService {
  constructor(
    readonly store: ReputationStore,
    private readonly discord: ReputationDiscord,
    private readonly now: () => number = Date.now,
    private readonly isSuspended: (guildId: string) => Promise<boolean> = async () => false,
  ) {}

  getConfig(guildId: string) {
    reputationSnowflakeSchema.parse(guildId);
    return this.store.getConfig(guildId);
  }

  async saveConfig(guildId: string, input: ReputationSettings, expectedRevision: number) {
    reputationSnowflakeSchema.parse(guildId);
    await this.requireAvailable(guildId);
    const settings = reputationSettingsSchema.parse(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new ReputationError("Reload Reputation settings before saving.", "conflict");
    const context = await this.discord.loadPermissionContext(guildId);
    const roleIds = new Set(context.roles.map((role) => role.id));
    if (
      [...settings.giverRoleIds, ...settings.excludedRoleIds].some(
        (id) => id === guildId || !roleIds.has(id),
      )
    )
      throw new ReputationError("Choose existing server roles for reputation eligibility.");
    const restricted = await this.discord.readRestrictedRoleIds(guildId);
    for (const reward of settings.rewards) {
      const error = reactionRoleSafetyError(context, reward.roleId, restricted);
      if (error) throw new ReputationError(error);
    }
    return this.store.saveConfig(guildId, settings, expectedRevision);
  }

  async give(input: {
    guildId: string;
    interactionId: string;
    giverId: string;
    recipientId: string;
    reason?: string;
  }) {
    for (const id of [input.guildId, input.interactionId, input.giverId, input.recipientId])
      reputationSnowflakeSchema.parse(id);
    if (input.giverId === input.recipientId)
      throw new ReputationError("You cannot give reputation to yourself.");
    const reason = input.reason?.trim() || null;
    if (reason && reason.length > 300)
      throw new ReputationError("Keep the reputation reason to 300 characters.");
    await this.requireEnabled(input.guildId);
    const [giver, recipient] = await Promise.all([
      this.discord.fetchMember(input.guildId, input.giverId),
      this.discord.fetchMember(input.guildId, input.recipientId),
    ]);
    if (!giver || !recipient)
      throw new ReputationError("Both members must currently belong to this server.", "member");
    const award = await this.store.award({
      guildId: input.guildId,
      interactionId: input.interactionId,
      giver,
      recipient,
      reason,
      nowMs: this.now(),
    });
    // Role delivery is retried independently; a Discord failure cannot turn a committed award into a failed request.
    await this.processRewards(20, input.guildId).catch(() => undefined);
    return { ...award, displayName: recipient.displayName };
  }

  async profile(guildId: string, userId: string) {
    reputationSnowflakeSchema.parse(userId);
    await this.requireEnabled(guildId);
    const member = await this.discord.fetchMember(guildId, userId);
    if (!member || member.bot)
      throw new ReputationError("Choose a current server member.", "member");
    await this.store.setMembership(guildId, userId, true);
    return {
      userId,
      displayName: member.displayName,
      total: await this.store.score(guildId, userId),
    };
  }

  async leaderboard(guildId: string) {
    await this.requireEnabled(guildId);
    const leaders: Array<{ displayName: string; total: number }> = [];
    // Verify a bounded set against Discord; stored membership events avoid repeatedly scanning departed members.
    for (const candidate of await this.store.topScores(guildId, 40)) {
      const member = await this.discord.fetchMember(guildId, candidate.userId);
      if (!member || member.bot) {
        await this.store.setMembership(guildId, candidate.userId, false);
        continue;
      }
      leaders.push({ displayName: member.displayName, total: candidate.total });
      if (leaders.length === 10) break;
    }
    return leaders;
  }

  setMembership(guildId: string, userId: string, current: boolean) {
    return this.store.setMembership(guildId, userId, current);
  }

  eraseMember(guildId: string, userId: string) {
    return this.store.eraseMember(guildId, userId);
  }

  async processRewards(limit = 20, guildId?: string) {
    let delivered = 0;
    let deferred = 0;
    for (const job of await this.store.pendingRewards(this.now(), limit, guildId)) {
      try {
        if (await this.deliverReward(job)) delivered += 1;
        else {
          await this.store.deferReward(job, this.now() + 60 * 60_000);
          deferred += 1;
        }
      } catch {
        await this.store.deferReward(job, this.now() + 5 * 60_000);
        deferred += 1;
      }
    }
    return { delivered, deferred };
  }

  private async requireEnabled(guildId: string) {
    await this.requireAvailable(guildId);
    const config = await this.getConfig(guildId);
    if (!config.enabled)
      throw new ReputationError("Reputation is disabled in this server.", "disabled");
    return config;
  }

  private async requireAvailable(guildId: string) {
    if (await this.isSuspended(guildId))
      throw new ReputationError("Service unavailable for this server.", "disabled");
  }

  private async deliverReward(job: ReputationRewardJob) {
    if (await this.isSuspended(job.guildId)) return false;
    const config = await this.store.getConfig(job.guildId);
    const reward = config.rewards.find((entry) => entry.roleId === job.roleId);
    if (
      !config.enabled ||
      !reward ||
      (await this.store.score(job.guildId, job.userId)) < reward.threshold
    )
      return false;
    const member = await this.discord.fetchMember(job.guildId, job.userId);
    if (
      !member ||
      member.bot ||
      config.excludedRoleIds.some((roleId) => member.roleIds.includes(roleId))
    )
      return false;
    const [context, restricted] = await Promise.all([
      this.discord.loadPermissionContext(job.guildId),
      this.discord.readRestrictedRoleIds(job.guildId),
    ]);
    if (reactionRoleSafetyError(context, job.roleId, restricted)) return false;
    if (await this.discord.isRoleSuspended(job.guildId, job.userId, job.roleId)) return false;
    if (!member.roleIds.includes(job.roleId))
      await this.discord.addRole(job.guildId, job.userId, job.roleId);
    await this.store.completeReward(job, this.now());
    return true;
  }
}
