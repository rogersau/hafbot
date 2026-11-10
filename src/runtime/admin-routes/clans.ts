import { z } from "zod";
import { defaultClanManagementConfig } from "../../clans";
import type { ClanService } from "../../services/clan-service";
import type { ClanFeatureSetupService } from "../../services/clan-feature-setup";
import { FeatureSetupError } from "../../services/feature-setup-runner";
import type { SetupResourceChoice } from "../../feature-setup";
import type { RuntimeStores } from "../app-types";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import { defineRoute, type Route } from "../admin-route-registry";
import type { CustomerSession } from "../auth/customer-session";

const guildQuery = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});
const nullablePositive = z.number().int().positive().nullable();
const configBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  enabled: z.boolean(),
  reviewerRoleIds: z.array(z.string()),
  staffAccessRoleIds: z.array(z.string()),
  eligibilityAllowedRoleIds: z.array(z.string()),
  eligibilityRequiredRoleIds: z.array(z.string()),
  minimumAccountAgeDays: z.number().int().min(0),
  minimumGuildTenureDays: z.number().int().min(0),
  requestCooldownDays: z.number().int().min(0),
  invitationExpiryDays: z.number().int().positive(),
  applicationExpiryDays: z.number().int().positive(),
  localClansMax: nullablePositive,
  localMembersMax: nullablePositive,
  localOfficersMax: z.number().int().min(0).nullable(),
  boardEnabled: z.boolean(),
  boardChannelId: z.string().nullable(),
  boardChannelType: z.enum(["forum", "text"]).nullable(),
  roleNameTemplate: z.string().min(1).max(100),
  textChannelNameTemplate: z.string().min(1).max(100),
  voiceChannelNameTemplate: z.string().min(1).max(100),
  inactivityEnabled: z.boolean(),
  inactivityWarningDays: z.number().int().positive(),
  inactivityArchiveDays: z.number().int().positive(),
  publicLfgAttributionEnabled: z.boolean(),
  requestPanelTitle: z.string().min(1).max(256),
  requestPanelDescription: z.string().min(1).max(4000),
  requestPanelButtonLabel: z.string().min(1).max(80),
  requestPanelColor: z.number().int().min(0).max(0xffffff),
  updatedAtMs: z.number().optional(),
});
const reviewBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  requestId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["approve", "request-changes", "reject"]),
  reason: z.string().optional(),
});
const setupChoiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reuse"), resourceId: z.string().min(1) }),
  z.object({ action: z.literal("create"), name: z.string().trim().min(1).max(100) }),
]);
const setupBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  choices: z.record(z.string(), setupChoiceSchema),
  confirmationId: z.string().uuid().optional(),
});

export function createClanAdminRoutes(options: {
  stores: RuntimeStores;
  service?: ClanService;
  setupService?: ClanFeatureSetupService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  if (!options.stores.clans) return [];
  const store = options.stores.clans;
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/clans",
      query: guildQuery,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, requests, clans, setup] = await Promise.all([
          store.readConfig(guildId),
          store.listRequests(guildId),
          store.listClans(guildId),
          options.setupService?.readState(guildId) ?? null,
        ]);
        return Response.json({
          guildId,
          config: config ?? defaultClanManagementConfig(guildId),
          requests,
          clans,
          setup,
          recommendedSetupChoices: options.setupService?.recommendedChoices() ?? null,
        });
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/admin/api/clans/config",
      body: configBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        if (!options.service)
          return Response.json({ error: "Clan Management service unavailable" }, { status: 503 });
        const { workspaceId: _workspaceId, ...editable } = body;
        const current = await options.service.getConfig(body.guildId);
        if (editable.enabled && !current.enabled) {
          if (!options.setupService) {
            return Response.json(
              { error: "Clan resource setup is unavailable; Clan Management cannot be enabled." },
              { status: 503 },
            );
          }
          const state = await options.setupService.readState(body.guildId);
          if (state.readiness !== "ready_disabled" && state.readiness !== "enabled") {
            return Response.json(
              { error: "Finish Clan resource setup before enabling Clan Management." },
              { status: 409 },
            );
          }
        }
        return Response.json({
          config: await options.service.updateConfig({
            ...current,
            ...editable,
            categoryId: current.categoryId,
            requestPanelChannelId: current.requestPanelChannelId,
            requestReviewCategoryId: current.requestReviewCategoryId,
            requestPanelMessageId: current.requestPanelMessageId,
            updatedAtMs: editable.updatedAtMs ?? Date.now(),
          }),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/clans/panel/publish",
      body: z.object({
        guildId: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service)
          return Response.json({ error: "Clan Management service unavailable" }, { status: 503 });
        const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
        return Response.json({
          config: await options.service.publishRequestPanel(body.guildId, actorUserId),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/clans/setup/preview",
      body: setupBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        if (!options.setupService) {
          return Response.json({ error: "Clan resource setup is unavailable" }, { status: 503 });
        }
        try {
          const preview = await options.setupService.preview(
            body.guildId,
            body.choices as Record<string, SetupResourceChoice>,
          );
          return Response.json({ preview: { ...preview, confirmationId: crypto.randomUUID() } });
        } catch (cause) {
          return featureSetupErrorResponse(cause);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/clans/setup/execute",
      body: setupBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.setupService) {
          return Response.json({ error: "Clan resource setup is unavailable" }, { status: 503 });
        }
        try {
          const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
          const run = await options.setupService.execute(
            body.guildId,
            actorUserId,
            body.choices as Record<string, SetupResourceChoice>,
            body.confirmationId,
          );
          return Response.json({
            run,
            setup: await options.setupService.readState(body.guildId),
            config: await options.service?.getConfig(body.guildId),
          });
        } catch (cause) {
          return featureSetupErrorResponse(cause);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/clans/setup",
      body: z.object({
        guildId: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.setupService)
          return Response.json({ error: "Clan resource setup is unavailable" }, { status: 503 });
        const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
        const current = await store.readConfig(body.guildId);
        const choices = options.setupService.recommendedChoices();
        if (current?.categoryId)
          choices.managed_category = { action: "reuse", resourceId: current.categoryId };
        if (current?.requestPanelChannelId)
          choices.panel_channel = { action: "reuse", resourceId: current.requestPanelChannelId };
        if (current?.requestReviewCategoryId)
          choices.review_category = {
            action: "reuse",
            resourceId: current.requestReviewCategoryId,
          };
        if (current?.reviewerRoleIds[0])
          choices.reviewer_role = { action: "reuse", resourceId: current.reviewerRoleIds[0] };
        const run = await options.setupService.execute(body.guildId, actorUserId, choices);
        return Response.json({
          run,
          setup: await options.setupService.readState(body.guildId),
          config: await options.service?.getConfig(body.guildId),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/clans/requests/review",
      body: reviewBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service)
          return Response.json({ error: "Clan Management service unavailable" }, { status: 503 });
        const { workspaceId: _workspaceId, ...review } = body;
        const reviewerId = await readActorUserId(options.readCustomerAdminSession, request);
        const result = await options.service.reviewRequest({
          ...review,
          reviewerId,
          reviewerRoleIds: [],
          isGuildAdmin: true,
        });
        return Response.json({ result });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/clans/:clanId/history",
      query: guildQuery,
      access: guildScopedAccess("read"),
      handler: async ({ params, query }) => {
        const guildId = requireGuildQueryId(query);
        return Response.json({
          guildId,
          clanId: params.clanId,
          history: await store.listHistory(guildId, params.clanId),
        });
      },
    }),
  ];
}

async function readActorUserId(
  reader: ((request: Request) => Promise<CustomerSession | null>) | undefined,
  request: Request,
): Promise<string> {
  const session = await reader?.(request);
  return session?.user.discordUserId ?? session?.user.id ?? "admin-ui";
}

function featureSetupErrorResponse(cause: unknown): Response {
  if (cause instanceof FeatureSetupError) {
    return Response.json(
      { error: cause.message, code: cause.code },
      { status: cause.code === "active_run_conflict" ? 409 : 400 },
    );
  }
  throw cause;
}
