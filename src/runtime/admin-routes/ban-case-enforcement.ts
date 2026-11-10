import { z } from "zod";
import { defineRoute, type Route } from "../admin-route-registry";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { AdminRoutesOptions } from "./index";
const scope = z.object({ guildId: z.string().min(1), workspaceId: z.string().optional() });
export function createBanEnforcementRoutes(
  options: AdminRoutesOptions,
): Route<any, any, Response>[] {
  const service = options.services?.banCaseEnforcement;
  if (!service) return [];
  async function actor(request: Request) {
    const id = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
    if (!id) throw new Error("A signed-in Discord staff account is required.");
    return id;
  }
  async function run(work: () => Promise<unknown>) {
    try {
      return Response.json(await work());
    } catch {
      return Response.json(
        {
          error:
            "Server action rejected. Check staff access, target approval, expiry and unresolved operations.",
        },
        { status: 409 },
      );
    }
  }
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/ban-cases/server-actions",
      feature: "banCases",
      paidOnly: "premium-only-features",
      query: scope.partial(),
      access: guildScopedAccess("read"),
      handler: ({ request, query }) =>
        run(async () => {
          const guildId = requireGuildQueryId(query);
          const operations = await service!.list(guildId, await actor(request));
          const targets = [];
          for (const target of (await options.wardogs?.list(guildId)) ?? []) {
            if (!target.banCasesEnabled) continue;
            targets.push({
              id: target.id,
              name: target.name,
              ban: Boolean((await options.wardogs?.banReadiness(guildId, target.id, "ban"))?.ready),
              unban: Boolean(
                (await options.wardogs?.banReadiness(guildId, target.id, "unban"))?.ready,
              ),
            });
          }
          return {
            cases: await options.stores.banCases.listBanCases(guildId),
            operations,
            targets,
          };
        }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-cases/server-actions/prepare",
      feature: "banCases",
      paidOnly: "premium-only-features",
      body: scope
        .extend({
          caseId: z.string().min(1),
          targetId: z.string().uuid(),
          action: z.enum(["ban", "unban"]),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        run(async () => ({
          confirmation: await service!.prepare({ ...body, actorId: await actor(request) }),
        })),
    }),
    ...(["confirm", "cancel"] as const).map((action) =>
      defineRoute({
        method: "POST",
        path: `/admin/api/ban-cases/server-actions/${action}`,
        feature: "banCases",
        paidOnly: "premium-only-features",
        body: scope.extend({ id: z.string().uuid() }).strict(),
        access: bodyGuildScopedAccess("write"),
        handler: ({ request, body }) =>
          run(async () => ({
            operation: await service![action](body.id, body.guildId, await actor(request)),
          })),
      }),
    ),
  ];
}
