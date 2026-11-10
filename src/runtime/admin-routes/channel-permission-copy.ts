import { z } from "zod";
import {
  fetchChannelPermissionCopyResources,
  fetchGuildMemberResource,
  replaceChannelPermissionOverwrites,
  type DiscordChannelResource,
  type DiscordGuildMemberResource,
} from "../../discord";
import {
  ChannelPermissionCopyError,
  SUPPORTED_CHANNEL_PERMISSION_COPY_TYPES,
  createPreviewTokenManager,
  diffPermissionOverwrites,
  evaluatePermissionCopySafety,
  evaluatePreviewFreshness,
  fingerprintChannelPermissionState,
  mergePermissionOverwrites,
  preserveBotRecoveryAccess,
  validateChannelPermissionCopySelection,
  type ChannelPermissionCopyMode,
  type NormalizedPermissionOverwrite,
} from "../../services/channel-permission-copy-service";
import { postChannelPermissionsCopiedAuditEvent } from "../../services/guild-audit-log-service";
import {
  getBaseGuildPermissions,
  getChannelPermissions,
  getHighestBotRole,
  getMemberBaseGuildPermissions,
  type GuildPermissionContext,
} from "../admin-permissions";
import type { CustomerSession } from "../auth/customer-session";
import { DiscordApiError } from "../../discord/client";
import { defineRoute, type Route, type RouteAccess } from "../admin-route-registry";
import type { RuntimeStores } from "../app-types";
import { AdminRouteError } from "../admin-errors/admin-route-error";

const snowflake = z.string().regex(/^[1-9][0-9]{0,19}$/);
const querySchema = z.object({ workspaceId: z.string().min(1).max(128).optional() }).strict();
const previewSchema = z
  .object({
    sourceChannelId: snowflake,
    targetChannelId: snowflake,
    mode: z.enum(["roles_only", "exact"]),
  })
  .strict();
const applySchema = z
  .object({
    previewToken: z.string().min(20).max(4096),
    confirmationTargetName: z.string().min(1).max(100),
  })
  .strict();

export interface ChannelPermissionCopyRoutesOptions {
  stores: RuntimeStores;
  discordBotToken: string;
  discordBotUserId?: string;
  configurationRevisionSigningSecret?: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}

export function createChannelPermissionCopyAdminRoutes(
  options: ChannelPermissionCopyRoutesOptions,
): Array<Route<any, any, Response>> {
  const tokenManager = options.configurationRevisionSigningSecret
    ? createPreviewTokenManager(options.configurationRevisionSigningSecret)
    : null;
  const base = "/admin/api/guilds/:guildId/channel-permission-copy";
  return [
    defineRoute({
      operationId: "channelPermissionCopy.resources.get",
      method: "GET",
      path: `${base}/resources`,
      query: querySchema,
      access: pathGuildWriteAccess,
      handler: async ({ request, params }) => {
        const loaded = await loadAuthoritative(options, request, params.guildId!);
        const denied = actorPermissionResponse(loaded);
        if (denied) return denied;
        return Response.json({
          version: 1,
          channels: loaded.channels
            .filter((channel) => SUPPORTED_CHANNEL_PERMISSION_COPY_TYPES.has(channel.type))
            .map((channel) => channelSummary(channel, loaded.channels)),
        });
      },
    }),
    defineRoute({
      operationId: "channelPermissionCopy.preview.post",
      method: "POST",
      path: `${base}/preview`,
      query: querySchema,
      body: previewSchema,
      maxBodyBytes: 1024,
      access: pathGuildWriteAccess,
      handler: async ({ request, params, body }) => {
        if (!tokenManager) return unavailable("Preview signing is unavailable.");
        try {
          const loaded = await loadAuthoritative(options, request, params.guildId!);
          const denied = actorPermissionResponse(loaded);
          if (denied) return denied;
          const preview = await buildPreview(
            loaded,
            body.sourceChannelId,
            body.targetChannelId,
            body.mode,
          );
          const expiresAtMs = Date.now() + 5 * 60_000;
          const previewToken = await tokenManager.sign({
            guildId: loaded.guildId,
            actorUserId: loaded.actorUserId,
            sourceChannelId: body.sourceChannelId,
            targetChannelId: body.targetChannelId,
            mode: body.mode,
            sourceFingerprint: preview.sourceFingerprint,
            targetFingerprint: preview.targetFingerprint,
            expiresAtMs,
          });
          return Response.json({
            ...preview.response,
            previewToken,
            expiresAt: new Date(expiresAtMs).toISOString(),
          });
        } catch (error) {
          throw mapDomainError(error);
        }
      },
    }),
    defineRoute({
      operationId: "channelPermissionCopy.apply.post",
      method: "POST",
      path: `${base}/apply`,
      query: querySchema,
      body: applySchema,
      maxBodyBytes: 6144,
      access: pathGuildWriteAccess,
      handler: async ({ request, params, body, adminRequest }) => {
        if (!tokenManager) return unavailable("Preview signing is unavailable.");
        try {
          const claims = await tokenManager.verify(body.previewToken);
          const loaded = await loadAuthoritative(options, request, params.guildId!);
          if (claims.guildId !== loaded.guildId || claims.actorUserId !== loaded.actorUserId) {
            return problem(
              403,
              "preview_actor_mismatch",
              "This preview belongs to another administrator or Guild.",
            );
          }
          const denied = actorPermissionResponse(loaded);
          if (denied) return denied;
          const preview = await buildPreview(
            loaded,
            claims.sourceChannelId,
            claims.targetChannelId,
            claims.mode,
          );
          const freshness = evaluatePreviewFreshness(claims, preview);
          if (!freshness.ok) {
            throw new AdminRouteError({
              code: "stale_preview",
              status: 409,
              safeMessage: "Discord channel state changed after preview. Preview the copy again.",
              retryable: false,
              action: "retry",
              staleReason: staleReason(freshness.code),
            });
          }
          if (preview.target.name !== body.confirmationTargetName) {
            return problem(
              400,
              "confirmation_mismatch",
              "The confirmation must match the current target channel name.",
            );
          }
          if (preview.response.blockers.length) {
            return problem(409, "copy_blocked", "Discord safety checks block this copy.", {
              blockers: preview.response.blockers,
            });
          }
          const consumedAtMs = Date.now();
          const consumed = await options.stores.oneTimeTokens.consume({
            nonce: claims.nonce,
            expiresAtMs: claims.expiresAtMs,
            consumedAtMs,
          });
          if (!consumed) {
            throw new AdminRouteError({
              code: "conflict",
              status: 409,
              safeMessage: "This preview has already been used. Preview the copy again.",
              retryable: false,
              action: "retry",
            });
          }
          const committed = await replaceChannelPermissionOverwrites(
            preview.target.id,
            preview.resulting,
            `HAF Bot: permissions copied from #${preview.source.name} by ${loaded.actorUserId}`,
            options.discordBotToken,
          );
          const counts = countOverwriteChanges(preview.response.changes);
          await postChannelPermissionsCopiedAuditEvent(
            {
              guildId: loaded.guildId,
              actorUserId: loaded.actorUserId,
              sourceChannelId: preview.source.id,
              sourceChannelName: preview.source.name,
              targetChannelId: preview.target.id,
              targetChannelName: preview.target.name,
              mode: claims.mode,
              ...counts,
              timestampMs: Date.now(),
              correlationId: adminRequest?.correlationId ?? crypto.randomUUID(),
            },
            options.stores.guildAuditLog,
            options.discordBotToken,
          );
          return Response.json({
            version: 1,
            source: channelSummary(preview.source, loaded.channels),
            target: channelSummary(committed, loaded.channels),
            mode: claims.mode,
          });
        } catch (error) {
          throw mapDomainError(error);
        }
      },
    }),
  ];
}

const pathGuildWriteAccess: RouteAccess = ({ params, query }) => {
  const guildId = params.guildId;
  if (!snowflake.safeParse(guildId).success)
    return problem(400, "invalid_guild", "A valid Guild ID is required.");
  const workspaceId = (query as { workspaceId?: string } | undefined)?.workspaceId;
  return workspaceId ? { mode: "write", guildId, workspaceId } : { mode: "write", guildId };
};

async function loadAuthoritative(
  options: ChannelPermissionCopyRoutesOptions,
  request: Request,
  guildId: string,
) {
  if (!options.discordBotUserId || !options.readCustomerAdminSession)
    throw new Error("Channel permission copy dependencies are unavailable.");
  const session = await options.readCustomerAdminSession(request);
  if (!session)
    throw new ChannelPermissionCopyError(
      "preview_token_invalid",
      "Authenticated administrator identity is required.",
    );
  const actorUserId = session.user.discordUserId;
  const resources = await fetchChannelPermissionCopyResources(
    guildId,
    actorUserId,
    options.discordBotUserId,
    options.discordBotToken,
  );
  const actorPermissions = getMemberBaseGuildPermissions({
    guildId,
    roles: resources.roles,
    memberRoleIds: resources.actorMember.roles,
  });
  return {
    ...resources,
    guildId,
    actorUserId,
    actorPermissions,
    botUserId: options.discordBotUserId,
    botToken: options.discordBotToken,
  };
}

type Loaded = Awaited<ReturnType<typeof loadAuthoritative>>;

function actorPermissionResponse(loaded: Loaded): Response | null {
  const allowed =
    loaded.guild.owner_id === loaded.actorUserId ||
    (loaded.actorPermissions & ((1n << 3n) | (1n << 4n))) !== 0n;
  return allowed
    ? null
    : problem(
        403,
        "actor_permission_missing",
        "You currently need Discord Administrator or Manage Channels.",
      );
}

async function buildPreview(
  loaded: Loaded,
  sourceId: string,
  targetId: string,
  mode: ChannelPermissionCopyMode,
) {
  const source = requireChannel(loaded.channels, sourceId);
  const target = requireChannel(loaded.channels, targetId);
  const sourceState = state(loaded.guildId, source);
  const targetState = state(loaded.guildId, target);
  validateChannelPermissionCopySelection(loaded.guildId, sourceState, targetState);
  let resulting = mergePermissionOverwrites(
    source.permission_overwrites ?? [],
    target.permission_overwrites ?? [],
    mode,
  );
  const botContext: GuildPermissionContext = {
    guildId: loaded.guildId,
    botUserId: loaded.botUserId,
    channels: loaded.channels,
    roles: loaded.roles,
    member: loaded.botMember,
  };
  const initialResultChannel = { ...target, permission_overwrites: resulting };
  const recovery = preserveBotRecoveryAccess(
    resulting,
    loaded.botUserId,
    String(getChannelPermissions(botContext, initialResultChannel)),
  );
  resulting = recovery.overwrites;
  const memberIds = [
    ...new Set(
      resulting.filter((overwrite) => overwrite.type === 1).map((overwrite) => overwrite.id),
    ),
  ];
  const members = await loadReferencedMembers(loaded.guildId, memberIds, loaded);
  const resultChannel = { ...target, permission_overwrites: resulting };
  const highest = getHighestBotRole(botContext);
  const botBasePermissions = getBaseGuildPermissions(botContext);
  const botPermissionsBefore = getChannelPermissions(botContext, target);
  const parent = target.parent_id
    ? loaded.channels.find((channel) => channel.id === target.parent_id)
    : null;
  const botSettablePermissions =
    botBasePermissions |
    botPermissionsBefore |
    (parent ? getChannelPermissions(botContext, parent) : 0n);
  const safety = evaluatePermissionCopySafety({
    guildId: loaded.guildId,
    actorIsOwner: loaded.guild.owner_id === loaded.actorUserId,
    actorPermissions: String(loaded.actorPermissions),
    botPermissionsBefore: String(botPermissionsBefore),
    botPermissionsAfter: String(getChannelPermissions(botContext, resultChannel)),
    botSettablePermissions: String(botSettablePermissions),
    botHighestRolePosition: highest?.position ?? null,
    roles: loaded.roles,
    validMemberIds: new Set(members.keys()),
    resultingOverwrites: resulting,
    botRecoveryPermissions: recovery.preservedPermissions,
    targetIsCategory: target.type === 4,
    targetWasCategorySynced: isCategorySynced(target, loaded.channels),
    resultMatchesCategory: resultMatchesParent(resulting, target, loaded.channels),
  });
  const roleNames = new Map(loaded.roles.map((role) => [role.id, role.name]));
  const changes = diffPermissionOverwrites(target.permission_overwrites ?? [], resulting, { mode })
    .filter((change) => change.status !== "unchanged" || change.retainedFromTarget)
    .map((change) => ({
      targetId: change.id,
      targetName:
        change.id === loaded.guildId
          ? "@everyone"
          : change.type === 0
            ? (roleNames.get(change.id) ?? `Role ${change.id}`)
            : memberName(members.get(change.id), change.id),
      targetType: change.id === loaded.guildId ? "everyone" : change.type === 0 ? "role" : "member",
      change: change.retainedFromTarget ? "retained" : change.status,
      allow: change.toAllow,
      deny: change.toDeny,
      inherit: change.toInherit,
    }));
  return {
    source,
    target,
    resulting,
    sourceFingerprint: await fingerprintChannelPermissionState(sourceState),
    targetFingerprint: await fingerprintChannelPermissionState(targetState),
    response: {
      version: 1,
      source: channelSummary(source, loaded.channels),
      target: channelSummary(target, loaded.channels),
      mode,
      changes,
      warnings: safety.warnings,
      blockers: safety.blockers,
    },
  };
}

async function loadReferencedMembers(guildId: string, ids: string[], loaded: Loaded) {
  const entries = await Promise.all(
    ids.map(async (id) => {
      if (id === loaded.actorUserId) return [id, loaded.actorMember] as const;
      if (id === loaded.botUserId) return [id, loaded.botMember] as const;
      try {
        return [id, await fetchGuildMemberResource(guildId, id, loaded.botToken)] as const;
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return [id, null] as const;
        throw error;
      }
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, DiscordGuildMemberResource] => entry[1] !== null,
    ),
  );
}

function state(guildId: string, channel: DiscordChannelResource) {
  return {
    id: channel.id,
    guildId,
    type: channel.type,
    parentId: channel.parent_id ?? null,
    permissionOverwrites: channel.permission_overwrites ?? [],
  };
}
function requireChannel(channels: DiscordChannelResource[], id: string) {
  const channel = channels.find((candidate) => candidate.id === id);
  if (!channel)
    throw new ChannelPermissionCopyError(
      "unsupported_channel_type",
      "The selected channel is unavailable.",
    );
  return channel;
}
function channelSummary(channel: DiscordChannelResource, channels: DiscordChannelResource[]) {
  const parent = channel.parent_id
    ? channels.find((candidate) => candidate.id === channel.parent_id)
    : null;
  return {
    id: channel.id,
    name: channel.name,
    type: String(channel.type),
    categoryId: channel.parent_id ?? null,
    categoryName: parent?.name ?? null,
  };
}
function memberName(member: DiscordGuildMemberResource | undefined, id: string) {
  return member?.user?.global_name ?? member?.user?.username ?? `Member ${id}`;
}
function isCategorySynced(channel: DiscordChannelResource, channels: DiscordChannelResource[]) {
  if (!channel.parent_id) return false;
  const parent = channels.find((candidate) => candidate.id === channel.parent_id);
  return parent
    ? JSON.stringify(channel.permission_overwrites ?? []) ===
        JSON.stringify(parent.permission_overwrites ?? [])
    : false;
}
function resultMatchesParent(
  result: NormalizedPermissionOverwrite[],
  channel: DiscordChannelResource,
  channels: DiscordChannelResource[],
) {
  const parent = channels.find((candidate) => candidate.id === channel.parent_id);
  if (!parent) return false;
  try {
    return (
      JSON.stringify(mergePermissionOverwrites(parent.permission_overwrites ?? [], [], "exact")) ===
      JSON.stringify(result)
    );
  } catch {
    return false;
  }
}
function problem(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error, code, ...extra }, { status });
}
function unavailable(error: string) {
  return problem(503, "service_unavailable", error);
}
function mapDomainError(error: unknown): unknown {
  if (error instanceof ChannelPermissionCopyError) {
    if (error.code === "preview_token_expired") {
      return new AdminRouteError({
        code: "conflict",
        status: 409,
        safeMessage: "This preview has expired. Preview the copy again.",
        retryable: false,
        action: "retry",
      });
    }
    if (error.code === "preview_token_invalid") {
      return new AdminRouteError({
        code: "invalid_request",
        status: 400,
        safeMessage: "The preview token is invalid.",
        retryable: false,
        action: "fix_fields",
      });
    }
    return new AdminRouteError({
      code: "invalid_request",
      status: 400,
      safeMessage: error.message,
      retryable: false,
      action: "fix_fields",
    });
  }
  return error;
}

function staleReason(
  code: "stale_source" | "stale_target" | "stale_source_and_target",
): "source" | "target" | "source_and_target" {
  return code === "stale_source_and_target"
    ? "source_and_target"
    : code === "stale_source"
      ? "source"
      : "target";
}

function countOverwriteChanges(changes: Array<{ change: string; targetType: string }>): {
  addedCount: number;
  changedCount: number;
  removedCount: number;
  retainedCount: number;
  memberOverwritesAffected: boolean;
} {
  return {
    addedCount: changes.filter((change) => change.change === "added").length,
    changedCount: changes.filter((change) => change.change === "changed").length,
    removedCount: changes.filter((change) => change.change === "removed").length,
    retainedCount: changes.filter((change) => change.change === "retained").length,
    memberOverwritesAffected: changes.some(
      (change) => change.targetType === "member" && change.change !== "retained",
    ),
  };
}
