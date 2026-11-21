import { z } from "zod";
import { DiscordApiError } from "../discord/client";
import type { CustomerSession } from "../runtime/auth/customer-session";
import { readBoundedUtf8Body } from "../runtime/bounded-request-body";
import { bodyGuildScopedAccess, guildScopedAccess } from "../runtime/admin-route-guards";
import { defineRoute, type Route } from "../runtime/admin-route-registry";
import type { BanAppealService } from "./service";
import {
  BanAppealError,
  banAppealGuildIdSchema,
  banAppealIdSchema,
  banAppealSettingsSchema,
} from "./types";
import { BAN_APPEAL_CLIENT_SCRIPT, renderBanAppealPage } from "./public-page";

export type BanAppealServiceFactory = (
  guildId: string,
) => BanAppealService | Promise<BanAppealService>;
const scope = z.object({
  guildId: banAppealGuildIdSchema,
  workspaceId: z.string().min(1).optional(),
});
const submission = z
  .object({ id: banAppealIdSchema, text: z.string().trim().min(20).max(4000) })
  .strict();
const privateJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });

interface BanAppealPublicRouteOptions {
  serviceForGuild: BanAppealServiceFactory;
  readCustomerSession: (request: Request) => Promise<CustomerSession | null>;
  publicBaseUrl: string;
  now?: () => number;
}

export function createBanAppealPublicEndpoints(options: BanAppealPublicRouteOptions) {
  const base = new URL(options.publicBaseUrl);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))
  )
    throw new Error("Ban appeal publicBaseUrl must use HTTPS or local development HTTP.");
  async function handleAppeal(
    request: Request,
    guildId: string,
    operation?: "page" | "submission",
  ): Promise<Response> {
    if (!banAppealGuildIdSchema.safeParse(guildId).success)
      return privateJson({ error: "Invalid ban appeal link." }, 404);
    if (new URL(request.url).origin !== base.origin)
      return privateJson({ error: "Use the official HAF Bot address for ban appeals." }, 403);
    if (!operation) return privateJson({ error: "Method not allowed." }, 405);
    const page = operation === "page";
    if (
      !page &&
      (request.headers.get("origin") !== base.origin ||
        request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
          "application/json")
    )
      return privateJson({ error: "The appeal request origin or format was rejected." }, 403);
    try {
      const session = await options.readCustomerSession(request);
      if (!page && !session)
        return privateJson({ error: "Sign in with Discord before submitting an appeal." }, 401);
      const service = await options.serviceForGuild(guildId);
      if (page)
        return renderBanAppealPage({
          guildId,
          state: await service.publicState(session?.user ?? null),
          publicBaseUrl: base.origin,
          nowMs: options.now?.(),
        });
      const body = await readBoundedUtf8Body(request, {
        maxBytes: 16_384,
        canonicalMediaType: "application/json",
      });
      if (!body.ok)
        return privateJson(
          {
            error:
              body.reason === "too_large"
                ? "The appeal request is too large."
                : "Invalid appeal text encoding.",
          },
          body.reason === "too_large" ? 413 : 400,
        );
      let raw: unknown;
      try {
        raw = JSON.parse(body.text);
      } catch {
        return privateJson({ error: "Invalid JSON request." }, 400);
      }
      const parsed = submission.safeParse(raw);
      if (!parsed.success)
        return privateJson(
          {
            error:
              "Use a valid submission identity and 20–4000 characters of appeal text. User identities cannot be supplied in the form.",
          },
          400,
        );
      const appeal = await service.submit(session!.user, parsed.data);
      return privateJson({
        appeal: { id: appeal.id, status: appeal.status, createdAtMs: appeal.createdAtMs },
      });
    } catch (error) {
      const message =
        error instanceof BanAppealError
          ? error.message
          : "Ban appeals are temporarily unavailable. Please try again later.";
      const status = error instanceof BanAppealError ? error.status : 503;
      return page
        ? renderBanAppealPage({ guildId, error: message, publicBaseUrl: base.origin, status })
        : privateJson({ error: message }, status);
    }
  }

  return {
    banAppealScript: () =>
      new Response(BAN_APPEAL_CLIENT_SCRIPT, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      }),
    banAppealScriptMethodNotAllowed: () =>
      new Response(null, { status: 405, headers: { allow: "GET" } }),
    banAppealPage: (request: Request, guildId: string) => handleAppeal(request, guildId, "page"),
    banAppealSubmission: (request: Request, guildId: string) =>
      handleAppeal(request, guildId, "submission"),
    banAppealMethodNotAllowed: (request: Request, guildId: string) =>
      handleAppeal(request, guildId),
  };
}

export function createBanAppealAdminRoutes(options: {
  serviceForGuild: BanAppealServiceFactory;
  readCustomerSession: (request: Request) => Promise<CustomerSession | null>;
}): Route<any, any, Response>[] {
  const handle = async (action: () => Promise<unknown>) => {
    try {
      return privateJson(await action());
    } catch (error) {
      if (error instanceof BanAppealError)
        return privateJson({ error: error.message }, error.status);
      if (error instanceof DiscordApiError)
        return privateJson(
          {
            error:
              "Discord could not verify the review permissions or ban status. Try again later.",
          },
          503,
        );
      throw error;
    }
  };
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/ban-appeals",
      query: scope,
      access: guildScopedAccess("read"),
      handler: ({ query }) =>
        handle(async () => ({
          guildId: query.guildId,
          ...(await (await options.serviceForGuild(query.guildId)).adminData()),
        })),
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/ban-appeals/detail",
      query: scope.extend({ appealId: banAppealIdSchema }),
      access: guildScopedAccess("read"),
      handler: ({ query }) =>
        handle(async () => (await options.serviceForGuild(query.guildId)).detail(query.appealId)),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-appeals/config",
      body: scope.extend({
        settings: banAppealSettingsSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
      maxBodyBytes: 8192,
      access: bodyGuildScopedAccess("write"),
      handler: ({ body }) =>
        handle(async () => ({
          config: await (
            await options.serviceForGuild(body.guildId)
          ).configure(body.settings, body.expectedRevision),
        })),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/ban-appeals/review",
      body: scope.extend({
        appealId: banAppealIdSchema,
        action: z.enum(["reject", "unban"]),
        reason: z.string().trim().min(3).max(500),
        expectedRevision: z.number().int().positive(),
      }),
      maxBodyBytes: 4096,
      access: bodyGuildScopedAccess("write"),
      handler: ({ body, request }) =>
        handle(async () => {
          const session = await options.readCustomerSession(request);
          if (!session)
            throw new BanAppealError("Sign in with Discord before reviewing an appeal.", 401);
          const service = await options.serviceForGuild(body.guildId);
          return {
            appeal: await service.review({
              id: body.appealId,
              actorUserId: session.user.discordUserId,
              action: body.action,
              reason: body.reason,
              expectedRevision: body.expectedRevision,
            }),
          };
        }),
    }),
  ];
}
