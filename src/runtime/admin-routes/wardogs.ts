import { validateWardogsContract } from "../../wardogs/harness";
import { z } from "zod";
import type { WardogsService } from "../../wardogs/service";
import { WardogsError } from "../../wardogs/model";
import { defineRoute, type Route } from "../admin-route-registry";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { ServerLevelsAdminRouteOptions } from "./server-levels";
import { postMemberAuditEvent } from "../../services/guild-audit-log-service";
const scope = z.object({ guildId: z.string().min(1), workspaceId: z.string().min(1).optional() });
const identity = scope.extend({
  targetId: z.string().uuid(),
  generation: z.number().int().positive(),
});
export function createWardogsAdminRoutes(
  options: Pick<
    ServerLevelsAdminRouteOptions,
    "stores" | "discordBotToken" | "readCustomerAdminSession"
  > & { wardogs?: WardogsService },
): Route<any, any, Response>[] {
  const service = options.wardogs;
  if (!service) return [];
  async function run(
    request: Request,
    guildId: string,
    action: string,
    operation: () => Promise<unknown>,
  ) {
    try {
      const target = await operation();
      const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
      await postMemberAuditEvent(
        "wardogs.target-change",
        {
          guildId,
          ...(actorUserId ? { user: { id: actorUserId } } : {}),
          context: { action },
        },
        options.stores.guildAuditLog,
        options.discordBotToken,
      );
      return Response.json({ target });
    } catch (error) {
      const safe = error instanceof WardogsError ? error : new WardogsError("provider_unavailable");
      return Response.json({ error: safe.message, code: safe.code }, { status: 409 });
    }
  }
  return [
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/validate-contract",
      body: identity
        .extend({
          roster: z.boolean(),
          operatorConfirmation: z.literal("APPROVE_READ_ONLY_VALIDATION"),
          provider: z.string().min(1).max(100),
          serverBuild: z.string().max(100).nullable(),
          sourceRevision: z.string().min(1).max(100),
        })
        .strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        run(request, body.guildId, "contract-validation", () =>
          validateWardogsContract(service, body),
        ),
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/wardogs",
      query: scope.partial(),
      access: guildScopedAccess("read"),
      handler: async ({ query }) =>
        Response.json({
          ...service.setup(),
          targets: await service.list(requireGuildQueryId(query)),
        }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/targets",
      body: scope
        .extend({
          name: z.string().trim().min(1).max(100),
          originRef: z.string().max(100).nullable(),
        })
        .strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        run(request, body.guildId, "create", () =>
          service.create(body.guildId, body.name, body.originRef),
        ),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/change",
      maxBodyBytes: 4096,
      body: identity
        .extend({
          name: z.string().trim().min(1).max(100).optional(),
          originRef: z.string().max(100).nullable().optional(),
          enabled: z.boolean().optional(),
          commerceEnabled: z.boolean().optional(),
          banCasesEnabled: z.boolean().optional(),
          secret: z.string().min(1).max(1024).optional(),
          disconnect: z.boolean().optional(),
        })
        .strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        run(
          request,
          body.guildId,
          body.disconnect
            ? "disconnect"
            : body.secret !== undefined
              ? "credential-replace"
              : body.enabled !== undefined
                ? body.enabled
                  ? "enable"
                  : "disable"
                : "change",
          () => service.change(body),
        ),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/test",
      body: identity.extend({ roster: z.boolean().default(false) }).strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        run(request, body.guildId, "verification", () =>
          service.verify({ ...body, roster: body.roster ?? false }),
        ),
    }),
  ];
}
