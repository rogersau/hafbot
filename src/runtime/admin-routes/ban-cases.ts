import { defineRoute, type Route } from "../admin-route-registry";
import type { RuntimeStores } from "../app-types";
import { z } from "zod";
import {
  guildScopedAccess,
  bodyGuildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { BanCaseConfig, BanCaseSource } from "../../types";
import { listGuildTicketResources, type DiscordChannelResource } from "../../discord/guilds";
import type { WebhookIngressGuardNamespace } from "../contracts/webhook-ingress-guard";

const GUILD_ID_MIN = 1;
const VIEW_CHANNEL = 1n << 10n;

const guildIdQuerySchema = z.object({
  guildId: z.string().min(GUILD_ID_MIN).optional(),
  workspaceId: z.string().min(GUILD_ID_MIN).optional(),
});

const publicIdFieldSchema = z
  .union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid publicId")])
  .nullish()
  .transform((value) => (value ? value : undefined));

const sourceIdFieldSchema = z
  .string()
  .min(1, "Invalid sourceId")
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid sourceId")
  .nullish()
  .transform((value) => value ?? undefined);

const compilableRegexSchema = z.string().refine(
  (pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid regex" },
);

const captureGroupNameSchema = z
  .string()
  .min(1, "Missing capture group name")
  .regex(/^[A-Za-z_]\w*$/, "Invalid capture group name");

const banCaseSourceBodySchema = z.object({
  guildId: z.string().min(GUILD_ID_MIN, "Missing guildId"),
  publicId: publicIdFieldSchema,
  sourceId: sourceIdFieldSchema,
  name: z
    .string()
    .min(1, "Missing name")
    .transform((value) => value.trim()),
  enabled: z.boolean({ error: () => "Missing enabled" }),
  platform: z.enum(["discord", "steam", "xbox", "playstation", "cftools"], {
    error: () => "Invalid platform",
  }),
  pattern: compilableRegexSchema,
  flags: z
    .string()
    .regex(/^[imsuy]*$/, "Invalid flags")
    .refine((value) => new Set(value).size === value.length, "Invalid flags")
    .optional()
    .default(""),
  subjectIdGroup: captureGroupNameSchema,
  nameGroup: captureGroupNameSchema,
  reasonGroup: captureGroupNameSchema,
});

const banCaseIngressHealthQuerySchema = guildIdQuerySchema.extend({
  publicId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

const banCaseSourceDeleteBodySchema = z.object({
  guildId: z.string().min(GUILD_ID_MIN, "Missing guildId"),
  sourceId: z.string().min(1, "Missing sourceId"),
});

const banCaseConfigForumChannelBodySchema = z.object({
  guildId: z.string().min(GUILD_ID_MIN, "Missing guildId"),
  forumChannelId: z.string().min(1, "Missing forumChannelId"),
});

const banCaseConfigModRolesBodySchema = z.object({
  guildId: z.string().min(GUILD_ID_MIN, "Missing guildId"),
  modRoleIds: z.array(z.string().min(1)),
});

export interface BanCasesAdminRoutesOptions {
  stores: RuntimeStores;
  discordBotToken: string;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  invalidateBanCaseSources?: () => void;
}

function generateId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function createBanCasesAdminRoutes(
  options: BanCasesAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/ban-cases",
      feature: "banCases",
      paidOnly: "premium-only-features",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, sources] = await Promise.all([
          options.stores.banCases.readConfig(guildId),
          options.stores.banCases.listBanCaseSources(guildId),
        ]);
        return Response.json({ guildId, config, sources });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/ban-cases/ingress-health",
      feature: "banCases",
      paidOnly: "premium-only-features",
      query: banCaseIngressHealthQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        if (!options.webhookIngressGuard) {
          return Response.json({ error: "Ingress health is unavailable" }, { status: 503 });
        }
        const sourceConfig = await options.stores.banCases.readBanCaseSourceByPublicId(
          query.publicId,
        );
        if (!sourceConfig || sourceConfig.guildId !== guildId) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const nowMs = Date.now();
        const [source, global, invalidSources] = await Promise.all([
          options.webhookIngressGuard
            .getByName(`source:v1:ban-case:${query.publicId}`)
            .snapshot(nowMs),
          options.webhookIngressGuard.getByName("global:v2:ban-case").snapshot(nowMs),
          options.webhookIngressGuard
            .getByName("invalid-source:v1:ban-case:global")
            .snapshot(nowMs),
        ]);
        return Response.json(
          {
            guildId,
            publicId: query.publicId,
            product: "ban-case",
            source,
            global,
            invalidSources,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-cases/config",
      feature: "banCases",
      paidOnly: "premium-only-features",
      body: banCaseSourceBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const now = Date.now();

        // If the publicId already exists, it must belong to the same guild.
        let existing: BanCaseSource | null = null;
        if (body.publicId) {
          existing = await options.stores.banCases.readBanCaseSourceByPublicId(body.publicId);
          if (existing && existing.guildId !== body.guildId) {
            return Response.json({ error: "Config belongs to another guild." }, { status: 409 });
          }
        }

        const publicId = body.publicId ?? generateId();
        const sourceId = existing?.sourceId ?? body.sourceId ?? generateId();

        const source: BanCaseSource = {
          guildId: body.guildId,
          sourceId,
          publicId,
          name: body.name,
          enabled: body.enabled,
          platform: body.platform,
          pattern: body.pattern,
          flags: body.flags ?? "",
          subjectIdGroup: body.subjectIdGroup,
          nameGroup: body.nameGroup,
          reasonGroup: body.reasonGroup,
          createdAtMs: existing?.createdAtMs ?? now,
          updatedAtMs: now,
        };

        await options.stores.banCases.upsertBanCaseSource(source);
        options.invalidateBanCaseSources?.();
        return Response.json({ ok: true, source });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-cases/delete",
      feature: "banCases",
      paidOnly: "premium-only-features",
      body: banCaseSourceDeleteBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        await options.stores.banCases.deleteBanCaseSource(body);
        options.invalidateBanCaseSources?.();
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-cases/config/forum-channel",
      feature: "banCases",
      paidOnly: "premium-only-features",
      body: banCaseConfigForumChannelBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const visibility = await validateBanCaseForumVisibility(
          body.guildId,
          body.forumChannelId,
          options.discordBotToken,
        );
        if (!visibility.ok) {
          return Response.json({ error: visibility.error }, { status: 400 });
        }

        const now = Date.now();
        const existing = await options.stores.banCases.readConfig(body.guildId);
        const config: BanCaseConfig = {
          guildId: body.guildId,
          enabled: existing?.enabled ?? true,
          forumChannelId: body.forumChannelId,
          modRoleIds: existing?.modRoleIds ?? [],
          updatedAtMs: now,
        };
        await options.stores.banCases.upsertConfig(config);
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-cases/config/mod-roles",
      feature: "banCases",
      paidOnly: "premium-only-features",
      body: banCaseConfigModRolesBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const now = Date.now();
        const existing = await options.stores.banCases.readConfig(body.guildId);
        const config: BanCaseConfig = {
          guildId: body.guildId,
          enabled: existing?.enabled ?? true,
          forumChannelId: existing?.forumChannelId ?? null,
          modRoleIds: body.modRoleIds,
          updatedAtMs: now,
        };
        await options.stores.banCases.upsertConfig(config);
        return Response.json({ ok: true });
      },
    }),
  ];
}

async function validateBanCaseForumVisibility(
  guildId: string,
  forumChannelId: string,
  discordBotToken: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let resources: Awaited<ReturnType<typeof listGuildTicketResources>>;
  try {
    resources = await listGuildTicketResources(guildId, discordBotToken);
  } catch {
    return {
      ok: false,
      error:
        "Could not verify the Ban Case Forum permissions. Refresh Discord access and try again.",
    };
  }

  const channel = resources.channels.find((candidate) => candidate.id === forumChannelId);
  if (!channel || channel.type !== 15) {
    return { ok: false, error: "Select a Discord forum channel for Ban Cases." };
  }

  if (appearsPubliclyVisible(guildId, channel)) {
    return {
      ok: false,
      error:
        "Ban Case Forums must be staff-scoped. Deny View Channel for @everyone on the forum, or sync it with a category that denies View Channel, then try again.",
    };
  }

  return { ok: true };
}

export function appearsPubliclyVisible(guildId: string, channel: DiscordChannelResource): boolean {
  // Category syncing copies overwrites to the channel. An unsynced forum does
  // not inherit its category's denial and may still expose every Ban Case.
  return readEveryoneViewOverwrite(guildId, channel) !== false;
}

function readEveryoneViewOverwrite(
  guildId: string,
  channel: DiscordChannelResource,
): boolean | null {
  const overwrite = (channel.permission_overwrites ?? []).find(
    (candidate) => candidate.id === guildId && candidate.type === 0,
  );
  if (!overwrite) return null;
  const allow = parsePermissionBits(overwrite.allow);
  const deny = parsePermissionBits(overwrite.deny);
  if ((deny & VIEW_CHANNEL) !== 0n) return false;
  if ((allow & VIEW_CHANNEL) !== 0n) return true;
  return null;
}

function parsePermissionBits(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
