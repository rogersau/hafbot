import { postMemberAuditEvent } from "../services/guild-audit-log-service";
import type { OperationalIncidentService } from "../operations/incidents";
import { BanCaseEnforcement } from "../ban-case-enforcement/service";
import { createWardogsBanProvider } from "../ban-case-enforcement/provider";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import type { WardogsService } from "../wardogs/service";
import type { RuntimeStores } from "./app-types";
import { fetchGuildMemberResource, fetchGuildSummary, listGuildRoles } from "../discord/guilds";
import { createChannelMessage } from "../discord";
import { editChannelMessage, listChannelMessages } from "../discord/messages";
import { GuildServicePolicy } from "./guild-service-policy";
import { getGuildEntitlementLimits } from "../types";

export function createBanCaseEnforcementRuntime(options: {
  operationalIncidentService?: OperationalIncidentService;
  stores: RuntimeStores;
  discordBotToken: string;
  wardogs?: WardogsService;
  banEnforcementStore?: EnforcementStore;
  banCasesEnabled?: boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}) {
  if (!options.wardogs || !options.banEnforcementStore) return undefined;
  const token = options.discordBotToken;
  return new BanCaseEnforcement({
    store: options.banEnforcementStore,
    now: options.now,
    wait: options.wait,
    cases: options.stores.banCases,
    provider: createWardogsBanProvider(options.wardogs),
    async authorize(guildId, actorId) {
      try {
        const config = await options.stores.banCases.readConfig(guildId);
        const member = await fetchGuildMemberResource(guildId, actorId, token);
        if (!config || !member.roles) return false;
        if (config.modRoleIds.length)
          return member.roles.some((id) => config.modRoleIds.includes(id));
        const [guild, roles, appRole] = await Promise.all([
          fetchGuildSummary(guildId, token),
          listGuildRoles(guildId, token),
          options.stores.guildRbac.readGuildAdminRoleId(guildId),
        ]);
        return (
          guild.owner_id === actorId ||
          Boolean(appRole && member.roles.includes(appRole)) ||
          roles.some(
            (role) =>
              (role.id === guildId || member.roles.includes(role.id)) &&
              (BigInt(role.permissions ?? "0") & (8n | 32n)) !== 0n,
          )
        );
      } catch {
        return false;
      }
    },
    async available(guildId) {
      return (
        options.banCasesEnabled === true &&
        Boolean((await options.stores.banCases.readConfig(guildId))?.enabled) &&
        !(await new GuildServicePolicy(options.stores.guildServiceSuspensions).isGuildSuspended(
          guildId,
        )) &&
        getGuildEntitlementLimits(
          (await options.stores.guildEntitlements.readGuildEntitlement(guildId))?.tier ?? "free",
        ).paidFeatures
      );
    },
    audit: (op, kind) =>
      postMemberAuditEvent(
        "ban-case.server-action",
        {
          guildId: op.guildId,
          user: { id: op.actorId },
          reason: op.reason,
          context: {
            stage: kind,
            operationId: op.id,
            caseId: op.caseId,
            target: op.targetLabel,
            steamId: op.subject,
            action: op.action,
            outcome: kind === "request" ? "requested" : op.outcome,
          },
        },
        options.stores.guildAuditLog,
        token,
        true,
      ),
    async notify(op, beforeCreate) {
      const key = {
        feature: "ban-cases" as const,
        resourceKind: "server-action",
        resourceId: op.id,
        condition: "enforcement-uncertain",
      };
      if (op.state === "needs-attention")
        await options.operationalIncidentService?.observeFailure({
          guildId: op.guildId,
          key,
          summaryCode: "ban_case_enforcement_uncertain",
          safeArgs: { operationId: op.id },
          remediationCode: "operator_intervention_required",
          observationId: `${op.id}:${op.revision}`,
        });
      else if (op.state === "succeeded")
        await options.operationalIncidentService?.observeHealthy({ guildId: op.guildId, key });
      const c = await options.stores.banCases.readBanCase(op.guildId, op.caseId);
      if (!c?.threadChannelId) return null;
      const body = {
        content: `Server action ${op.id}\nRequested by <@${op.actorId}>: ${op.action} ${op.subject}\nTarget: ${op.targetLabel}\nReason: ${op.reason}\n${op.state}: ${op.outcome}\nExternal report subject; ownership is not verified.`,
        allowed_mentions: { parse: [] as never[] },
      };
      if (op.messageId) {
        await editChannelMessage(c.threadChannelId, op.messageId, body, token);
        return op.messageId;
      }
      if (op.notificationStarted) {
        const existing = (await listChannelMessages(c.threadChannelId, token, { limit: 100 })).find(
          (m) => m.content?.startsWith(`Server action ${op.id}\n`),
        );
        if (!existing)
          throw new Error(
            "Notification creation unresolved; staff can inspect the durable operation.",
          );
        await editChannelMessage(c.threadChannelId, existing.id, body, token);
        return existing.id;
      }
      // Discord nonce deduplicates a repeated create after a lost acknowledgement.
      await beforeCreate();
      const message = await createChannelMessage(
        c.threadChannelId,
        { ...body, nonce: op.id.replaceAll("-", "").slice(0, 25), enforce_nonce: true },
        token,
      );
      return message.id;
    },
  });
}
