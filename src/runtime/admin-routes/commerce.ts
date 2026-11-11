import { GameAccessError } from "../../commerce/game-access/model";
import { z } from "zod";

import type {
  CommerceOfferingService,
  CommerceOfferingStore,
} from "../../commerce/offering-service";
import type { CommerceSalesPanelService } from "../../commerce/sales-panel";
import type { CommerceSellerLifecycleService } from "../../commerce/seller-lifecycle";
import type { CommerceSellerReviewNotificationService } from "../../commerce/seller-review-notifications";
import type { CommerceCapability } from "../../commerce/types";
import type { CommerceSupportService } from "../../commerce/support-payments";
import type { CommerceFinancialOperationsService } from "../../commerce/financial-operations";
import type { CommerceSafeguardsService } from "../../commerce/safeguards";
import type { CommerceStore } from "../../commerce/store";
import { validateCommerceBrandingInput, type CommerceBrandingStore } from "../../commerce/branding";
import type { GuildResourceValidator } from "../../discord/guild-resource-validator";
import type { CustomerSession } from "../auth/customer-session";
import {
  DISCORD_PERMISSION_FLAGS,
  getBaseGuildPermissions,
  getChannelPermissions,
  getHighestBotRole,
  hasPermission,
  loadGuildPermissionContext,
} from "../admin-permissions";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import { defineRoute, type Route } from "../admin-route-registry";
import { adminRouteErrors } from "../admin-errors/admin-route-error";

const guildId = z.string().min(1);
const offeringId = z.string().uuid();
const workspaceId = z.string().min(1).optional();
const currency = z.enum(["AUD", "USD"]);
const recurringInterval = z.enum(["month", "year"]);
const commerceCapability = z.enum([
  "commerce.read",
  "commerce.offerings.manage",
  "commerce.subscribers.manage",
  "commerce.finance.refund",
  "commerce.finance.cancel",
  "commerce.seller.manage",
  "commerce.risk.manage",
]);
const commerceReadAccess = { mode: "read", customerSessionOnly: true } as const;
const commerceWriteAccess = { mode: "write", customerSessionOnly: true } as const;

const guildQuery = z.object({ guildId, workspaceId });
const financialActionQuery = z.object({
  guildId,
  workspaceId,
  actionId: z.string().min(1).max(200),
});
const createOfferingBody = z.object({
  guildId,
  workspaceId,
  discordRoleId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).nullable().optional(),
  includedBenefits: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  currency,
  unitAmountMinor: z.number().int().min(500),
  recurringInterval,
});
const offeringActionBody = z.object({ guildId, workspaceId, offeringId });
const retireOfferingBody = offeringActionBody.extend({
  reasonCode: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,79}$/)
    .default("seller_offering_retired"),
});
const replacePriceBody = offeringActionBody.extend({
  currency,
  unitAmountMinor: z.number().int().min(500),
  recurringInterval,
});
const replaceRoleBody = offeringActionBody.extend({
  discordRoleId: z.string().min(1).max(100),
});
const salesPanelPublishBody = z.object({
  guildId,
  workspaceId,
  channelId: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().max(4_096),
});
const salesPanelActionBody = z.object({ guildId, workspaceId });
const editOfferingBody = offeringActionBody.extend({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).nullable(),
  includedBenefits: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  discordRoleId: z.string().min(1).max(100),
});
const supportConfigBody = z.object({
  guildId,
  workspaceId,
  enabled: z.boolean(),
  explanation: z.string().trim().min(10).max(500),
  currency,
  suggestedAmountsMinor: z.array(z.number().int().min(200).max(50_000)).min(1).max(3),
  supportContact: z.string().trim().min(3).max(200),
});
const supportRefundBody = z.object({
  guildId,
  workspaceId,
  paymentId: z.string().min(1).max(100),
  amountMinor: z.number().int().positive(),
  reasonCode: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,79}$/)
    .optional(),
});
const subscriptionRefundBody = supportRefundBody.extend({
  cancellation: z.enum(["default", "none", "immediate", "period_end"]).default("default"),
});
const subscriptionCancelBody = z.object({
  guildId,
  workspaceId,
  subscriptionId: z.string().min(1).max(100),
  mode: z.enum(["immediate", "period_end"]),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
});
const offboardingBody = z.object({
  guildId,
  workspaceId,
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
});
const safeguardControlBody = z.object({
  guildId,
  workspaceId,
  scopeType: z.enum(["guild", "seller", "offering"]),
  scopeId: z.string().min(1).max(100).optional(),
  controlType: z.enum([
    "commerce_kill",
    "new_checkout",
    "sales_suspension",
    "offering_suspension",
    "renewal_shutdown",
    "support_shutdown",
    "webhook_quarantine",
  ]),
  enabled: z.boolean(),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
  expiresAtMs: z.number().int().positive().nullable().optional(),
});
const sellerConnectBody = z.object({
  guildId,
  workspaceId,
  supportContact: z.string().trim().min(3).max(320),
  adultAttested: z.literal(true),
  twoFactorEvidence: z.enum(["discord_verified", "seller_attested"]),
  termsAccepted: z.literal(true),
  sellerAcknowledged: z.literal(true),
  feesAcknowledged: z.literal(true),
});
const authorityGrantBody = z.object({
  guildId,
  workspaceId,
  discordUserId: z.string().min(1).max(100),
  capability: commerceCapability,
  enabled: z.boolean(),
});
const platformSellerQuery = z.object({
  state: z.enum(["pending", "approved", "rejected"]).optional(),
});
const platformSellerReviewBody = z.object({
  guildId,
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
});
const platformSellerSuspensionBody = platformSellerReviewBody.extend({ suspended: z.boolean() });
const platformControlBody = z.object({
  actionId: z.string().min(1).max(100),
  controlType: z.enum([
    "commerce_kill",
    "new_checkout",
    "sales_suspension",
    "renewal_shutdown",
    "support_shutdown",
    "webhook_quarantine",
  ]),
  enabled: z.boolean(),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
  expiresAtMs: z.number().int().positive().nullable().optional(),
});
const brandingBody = z.object({
  guildId,
  workspaceId,
  accentColor: z.number().int().min(0).max(0xffffff),
  tagline: z.string().trim().max(160),
});

export interface CommerceAdminServices {
  gameAccess?: ReturnType<
    typeof import("../postgres/postgres-commerce-game-access-runtime").createGameAccessRuntime
  >;
  store: Pick<
    CommerceStore,
    | "readConnectedAccountByGuild"
    | "readSellerProfile"
    | "readSellerAcceptance"
    | "readSellerCapabilities"
    | "saveAuthorityGrant"
    | "listSellerProfiles"
    | "appendOperation"
  >;
  catalog: CommerceOfferingStore;
  offerings: CommerceOfferingService;
  sellerLifecycle?: Pick<
    CommerceSellerLifecycleService,
    | "beginOnboarding"
    | "evaluateOnboarding"
    | "refreshAccount"
    | "createAccountManagementLink"
    | "reviewSeller"
    | "setSuspension"
  >;
  sellerReviews?: Pick<
    CommerceSellerReviewNotificationService,
    "syncSeller" | "retryPending" | "decide"
  >;
  support?: Pick<CommerceSupportService, "page" | "saveConfig" | "readReport" | "refund">;
  financialOperations?: Pick<
    CommerceFinancialOperationsService,
    | "refundSubscription"
    | "refundSupport"
    | "cancelSubscription"
    | "beginOffboarding"
    | "completeOffboarding"
    | "readOffboardingForGuild"
    | "readActionForGuild"
    | "shutdownRenewals"
  >;
  safeguards?: Pick<CommerceSafeguardsService, "readDashboard" | "setControl">;
  salesPanel?: Pick<
    CommerceSalesPanelService,
    "read" | "publish" | "unpublish" | "removeForOffboarding" | "refreshForGuild"
  >;
  branding?: CommerceBrandingStore;
  currentTermsVersion: string;
}

export interface CommerceAdminRoutesOptions {
  services?: CommerceAdminServices;
  discordBotToken: string;
  discordBotUserId?: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  isGuildOwner?: (guildId: string, discordUserId: string) => Promise<boolean>;
  isPlatformOperator?: (discordUserId: string) => Promise<boolean>;
  publicBaseUrl?: string;
  guildResources?: GuildResourceValidator;
}

export function createCommerceAdminRoutes(
  options: CommerceAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/commerce/game-access",
      query: guildQuery,
      access: commerceReadAccess,
      handler: async ({ query, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, query.guildId);
        const actor = await requireActorUserId(options, request);
        if (!(await hasCommerceCapability(services, account.id, actor, "commerce.read")))
          return forbidden();
        return Response.json({
          targets: (await services.gameAccess?.targets(query.guildId)) ?? [],
          configurations: (await services.gameAccess?.store.configs(query.guildId)) ?? [],
          assignments: (await services.gameAccess?.store.list(query.guildId)) ?? [],
          readiness: services.gameAccess
            ? await Promise.all(
                (await services.gameAccess.store.configs(query.guildId)).map((c) =>
                  services.gameAccess!.service.readiness(c.offeringId),
                ),
              )
            : [],
          salesEnabled: false,
          notice:
            "Provider validation is required before sales. List membership does not guarantee admission. Hard disconnect requires manual cleanup of outstanding access.",
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/game-access/configure",
      body: z.object({
        guildId,
        workspaceId,
        offeringId,
        targetId: z.string().min(1),
        allocationCeiling: z.number().int().min(1).max(2000),
        acceptingSales: z.boolean(),
      }),
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(services, account.id, actorId, "commerce.offerings.manage"))
        )
          return forbidden();
        if (!services.gameAccess) throw new Error("commerce_reserved_access_unavailable");
        try {
          return Response.json(await services.gameAccess.service.configure({ ...body, actorId }));
        } catch (error) {
          if (error instanceof GameAccessError)
            return Response.json({ error: error.message }, { status: 409 });
          throw error;
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/game-access/repair",
      body: z.object({
        guildId,
        workspaceId,
        id: z.string().uuid(),
        reason: z.string().trim().min(10).max(500),
        handoff: z.boolean().optional(),
      }),
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorId,
            "commerce.subscribers.manage",
          ))
        )
          return forbidden();
        if (!services.gameAccess) throw new Error("commerce_reserved_access_unavailable");
        try {
          await services.gameAccess.service.repair({ ...body, actorId });
          return Response.json({ accepted: true });
        } catch (error) {
          if (error instanceof GameAccessError)
            return Response.json({ error: error.message }, { status: 409 });
          throw error;
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/commerce",
      query: guildQuery,
      access: commerceReadAccess,
      handler: async ({ query, request }) => {
        const services = requireServices(options.services);
        const session = await options.readCustomerAdminSession?.(request);
        const actorUserId = session?.user.discordUserId;
        if (!actorUserId) return forbidden();
        const account = await services.store.readConnectedAccountByGuild(query.guildId);
        if (!account) {
          if (!(await options.isGuildOwner?.(query.guildId, actorUserId))) {
            return sellerOnboardingOwnerRequired();
          }
          return Response.json({
            guildId: query.guildId,
            sellerProfile: null,
            dashboard: null,
            support: null,
            supportReport: [],
            branding: null,
            offboarding: null,
            safeguards: null,
            salesPanel: null,
            panelChannels: await listSalesPanelChannels(options, query.guildId),
            manageableRoles: await listManageableRoles(options, query.guildId),
            currentTermsVersion: services.currentTermsVersion,
            activeOfferingLimit: 5,
            stripeDashboardAvailable: false,
            sellerOnboardingAvailable: Boolean(services.sellerLifecycle && options.publicBaseUrl),
            sellerOwner: true,
            sellerSuggestedSupportContact: sellerPrefillEmail(session.user.email),
          });
        }
        if (!(await hasCommerceCapability(services, account.id, actorUserId, "commerce.read"))) {
          return forbidden();
        }
        const [
          dashboard,
          sellerProfile,
          manageableRoles,
          support,
          supportReport,
          offboarding,
          safeguards,
          salesPanel,
          panelChannels,
          branding,
        ] = await Promise.all([
          services.offerings.dashboard(account.id),
          services.store.readSellerProfile(account.id),
          listManageableRoles(options, query.guildId),
          services.support?.page(query.guildId).catch(() => null) ?? null,
          services.support?.readReport(account.id) ?? [],
          services.financialOperations?.readOffboardingForGuild(query.guildId) ?? null,
          services.safeguards?.readDashboard(query.guildId) ?? null,
          services.salesPanel?.read(account.id) ?? null,
          listSalesPanelChannels(options, query.guildId),
          services.branding?.readByGuild(query.guildId) ?? null,
        ]);
        const profile = sellerProfile;
        return Response.json({
          guildId: query.guildId,
          sellerProfile,
          dashboard,
          support,
          supportReport,
          offboarding,
          safeguards,
          salesPanel,
          panelChannels,
          branding,
          manageableRoles,
          currentTermsVersion: services.currentTermsVersion,
          activeOfferingLimit: 5,
          stripeDashboardAvailable: Boolean(services.sellerLifecycle),
          sellerOnboardingAvailable: Boolean(services.sellerLifecycle && options.publicBaseUrl),
          sellerOwner: profile?.sellerOwnerUserId === actorUserId,
        });
      },
    }),
    salesPanelPublishRoute("/admin/api/commerce/panel/publish", options),
    salesPanelPublishRoute("/admin/api/commerce/panel/refresh", options),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/panel/unpublish",
      body: salesPanelActionBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.salesPanel) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        return Response.json({
          salesPanel: await services.salesPanel.unpublish({
            connectedAccountId: account.id,
            guildId: body.guildId,
          }),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/branding",
      body: brandingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.branding) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        const validated = validateCommerceBrandingInput(body);
        const branding = await services.branding.save({
          guildId: body.guildId,
          connectedAccountId: account.id,
          accentColor: validated.accentColor,
          tagline: validated.tagline,
          actorUserId,
          nowMs: Date.now(),
        });
        return Response.json({ branding });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/branding/reset",
      body: guildQuery,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.branding) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        await services.branding.reset(body.guildId, account.id);
        return Response.json({ branding: null });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/support/refund",
      body: supportRefundBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.finance.refund",
          ))
        ) {
          return forbidden();
        }
        if (services.financialOperations) {
          const actionId = requireIdempotencyKey(request);
          return Response.json(
            await services.financialOperations.refundSupport({
              guildId: body.guildId,
              paymentId: body.paymentId,
              amountMinor: body.amountMinor,
              actorUserId,
              reasonCode: body.reasonCode ?? "admin_support_refund",
              actionId,
            }),
            { status: 202 },
          );
        }
        if (!services.support) return unavailable();
        const result = await services.support.refund({
          connectedAccountId: account.id,
          paymentId: body.paymentId,
          amountMinor: body.amountMinor,
          intentId: crypto.randomUUID(),
        });
        return Response.json(result, { status: 202 });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/safeguards/control",
      body: safeguardControlBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.safeguards) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(services, account.id, actorUserId, "commerce.risk.manage"))
        ) {
          return forbidden();
        }
        let scopeId: string;
        if (body.scopeType === "guild") {
          scopeId = body.guildId;
        } else if (body.scopeType === "seller") {
          scopeId = account.id;
        } else {
          if (!body.scopeId) throw new Error("Commerce offering scope is required.");
          await requireGuildOffering(services, body.guildId, body.scopeId);
          scopeId = body.scopeId;
        }
        const control = await services.safeguards.setControl({
          scopeType: body.scopeType,
          scopeId,
          controlType: body.controlType,
          enabled: body.enabled,
          reasonCode: body.reasonCode,
          actorUserId,
          expiresAtMs: body.expiresAtMs,
        });
        if (
          body.enabled &&
          (body.controlType === "renewal_shutdown" || body.controlType === "commerce_kill") &&
          services.financialOperations
        ) {
          const actionId = requireIdempotencyKey(request);
          await services.financialOperations.shutdownRenewals({
            guildId: body.guildId,
            actorUserId,
            reasonCode: body.reasonCode ?? "seller_offering_retired",
            actionId,
          });
        }
        await refreshSalesPanel(services, body.guildId);
        return Response.json({ control });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/financial/refund",
      body: subscriptionRefundBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.finance.refund",
          ))
        ) {
          return forbidden();
        }
        const service = requireFinancialOperations(services);
        const actionId = requireIdempotencyKey(request);
        return Response.json(
          await service.refundSubscription({
            guildId: body.guildId,
            paymentId: body.paymentId,
            amountMinor: body.amountMinor,
            cancellation: body.cancellation ?? "default",
            actorUserId,
            reasonCode: body.reasonCode ?? "admin_subscription_refund",
            actionId,
          }),
          { status: 202 },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/financial/cancel",
      body: subscriptionCancelBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.finance.cancel",
          ))
        ) {
          return forbidden();
        }
        const actionId = requireIdempotencyKey(request);
        await requireFinancialOperations(services).cancelSubscription({
          guildId: body.guildId,
          subscriptionId: body.subscriptionId,
          mode: body.mode,
          actorUserId,
          reasonCode: body.reasonCode,
          actionId,
        });
        return Response.json({ accepted: true, actionId }, { status: 202 });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offboarding/start",
      body: offboardingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.seller.manage",
          )) ||
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.finance.cancel",
          ))
        ) {
          return forbidden();
        }
        const actionId = requireIdempotencyKey(request);
        const result = await requireFinancialOperations(services).beginOffboarding({
          guildId: body.guildId,
          actorUserId,
          reasonCode: body.reasonCode,
          actionId,
        });
        await refreshSalesPanel(services, body.guildId);
        return Response.json(result, { status: 202 });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offboarding/complete",
      body: offboardingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.seller.manage",
          )) ||
          !(await hasCommerceCapability(
            services,
            account.id,
            actorUserId,
            "commerce.finance.cancel",
          ))
        ) {
          return forbidden();
        }
        const actionId = requireIdempotencyKey(request);
        await services.salesPanel?.removeForOffboarding({
          connectedAccountId: account.id,
          guildId: body.guildId,
        });
        await requireFinancialOperations(services).completeOffboarding({
          guildId: body.guildId,
          actorUserId,
          reasonCode: body.reasonCode,
          actionId,
        });
        return Response.json({ completed: true, actionId });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/support",
      body: supportConfigBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.support) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            await requireActorUserId(options, request),
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        const config = await services.support.saveConfig({
          guildId: body.guildId,
          enabled: body.enabled,
          explanation: body.explanation,
          currency: body.currency,
          suggestedAmountsMinor: body.suggestedAmountsMinor,
          supportContact: body.supportContact,
        });
        await refreshSalesPanel(services, body.guildId);
        return Response.json({ config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offerings",
      body: createOfferingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, body.guildId);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            await requireActorUserId(options, request),
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        const profile = await services.store.readSellerProfile(account.id);
        if (!profile)
          return Response.json({ error: "Seller profile is missing." }, { status: 409 });
        const roleManageable = await isRoleManageable(options, body.guildId, body.discordRoleId);
        if (!roleManageable) {
          return Response.json(
            {
              error: "That role is missing, managed by Discord, or above HAF's highest role.",
            },
            { status: 409 },
          );
        }
        const result = await services.offerings.createDraft({
          connectedAccountId: account.id,
          guildId: body.guildId,
          discordRoleId: body.discordRoleId,
          name: body.name,
          description: body.description,
          includedBenefits: body.includedBenefits,
          supportContact: profile.supportContact,
          currency: body.currency,
          unitAmountMinor: body.unitAmountMinor,
          recurringInterval: body.recurringInterval,
          roleManageable,
          termsVersion: services.currentTermsVersion,
        });
        return Response.json(result, { status: 201 });
      },
    }),
    actionRoute("/admin/api/commerce/offerings/publish", options, async (service, id) =>
      service.publish(id),
    ),
    actionRoute("/admin/api/commerce/offerings/unpublish", options, async (service, id) =>
      service.unpublish(id),
    ),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offerings/retire",
      body: retireOfferingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const offering = await requireGuildOffering(services, body.guildId, body.offeringId);
        const actorUserId = await requireActorUserId(options, request);
        if (
          !(await hasCommerceCapability(
            services,
            offering.connectedAccountId,
            actorUserId,
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        return Response.json({
          lifecycle: await services.offerings.retire({
            offeringId: body.offeringId,
            actorUserId,
            reasonCode: body.reasonCode ?? "seller_offering_retired",
            actionId: requireIdempotencyKey(request),
          }),
        });
      },
    }),
    actionRoute("/admin/api/commerce/offerings/archive", options, async (service, id) =>
      service.archive(id),
    ),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offerings/edit",
      body: editOfferingBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const offering = await requireGuildOffering(services, body.guildId, body.offeringId);
        if (
          !(await hasCommerceCapability(
            services,
            offering.connectedAccountId,
            await requireActorUserId(options, request),
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        if (!(await isRoleManageable(options, body.guildId, body.discordRoleId))) {
          return Response.json(
            {
              error: "That role is missing, managed by Discord, or above HAF's highest role.",
            },
            { status: 409 },
          );
        }
        const result = await services.offerings.updateDraft({
          offeringId: body.offeringId,
          name: body.name,
          description: body.description,
          includedBenefits: body.includedBenefits,
          discordRoleId: body.discordRoleId,
          roleManageable: true,
          termsVersion: services.currentTermsVersion,
        });
        return Response.json(result);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offerings/replace-price",
      body: replacePriceBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const offering = await requireGuildOffering(services, body.guildId, body.offeringId);
        if (
          !(await hasCommerceCapability(
            services,
            offering.connectedAccountId,
            await requireActorUserId(options, request),
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        const price = await services.offerings.replacePrice(body);
        return Response.json({ price });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/offerings/replace-role",
      body: replaceRoleBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const offering = await requireGuildOffering(services, body.guildId, body.offeringId);
        if (
          !(await hasCommerceCapability(
            services,
            offering.connectedAccountId,
            await requireActorUserId(options, request),
            "commerce.offerings.manage",
          ))
        ) {
          return forbidden();
        }
        if (!(await isRoleManageable(options, body.guildId, body.discordRoleId))) {
          return Response.json(
            {
              error: "That role is missing, managed by Discord, or above HAF's highest role.",
            },
            { status: 409 },
          );
        }
        const result = await services.offerings.replaceRole({
          offeringId: body.offeringId,
          discordRoleId: body.discordRoleId,
        });
        return Response.json(result);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/commerce/financial/action",
      query: financialActionQuery,
      access: commerceReadAccess,
      handler: async ({ query, request }) => {
        const services = requireServices(options.services);
        const account = await requireGuildAccount(services, query.guildId);
        const actorUserId = await requireActorUserId(options, request);
        if (!(await hasCommerceCapability(services, account.id, actorUserId, "commerce.read"))) {
          return forbidden();
        }
        const action = await requireFinancialOperations(services).readActionForGuild(
          query.actionId,
          query.guildId,
        );
        return action
          ? Response.json({ action })
          : Response.json({ error: "Commerce financial action was not found." }, { status: 404 });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/commerce/seller/eligibility",
      query: guildQuery,
      access: guildScopedAccess("read"),
      handler: async ({ query, request }) => {
        const lifecycle = requireServices(options.services).sellerLifecycle;
        if (!lifecycle) return unavailable();
        const actorUserId = await requireActorUserId(options, request);
        const ownerAuthorized = await options.isGuildOwner?.(query.guildId, actorUserId);
        return Response.json({
          eligibility: await lifecycle.evaluateOnboarding({
            guildId: query.guildId,
            ownerAuthorized: ownerAuthorized === true,
            supportContact: "",
            adultAttestedAtMs: null,
            twoFactorEvidence: null,
            guildCreatedAtMs: discordSnowflakeCreatedAtMs(query.guildId),
            termsAccepted: false,
          }),
          ownerAuthorized: ownerAuthorized === true,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/seller/connect",
      body: sellerConnectBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const lifecycle = services.sellerLifecycle;
        if (!lifecycle || !options.publicBaseUrl) return unavailable();
        const session = await requireActorSession(options, request);
        const actorUserId = session.user.discordUserId;
        if (!(await options.isGuildOwner?.(body.guildId, actorUserId))) {
          return sellerOnboardingOwnerRequired();
        }
        const base = options.publicBaseUrl.replace(/\/$/, "");
        const result = await lifecycle.beginOnboarding({
          guildId: body.guildId,
          sellerUserId: actorUserId,
          ownerAuthorized: true,
          supportContact: body.supportContact,
          adultAttestedAtMs: Date.now(),
          twoFactorEvidence: body.twoFactorEvidence,
          guildCreatedAtMs: discordSnowflakeCreatedAtMs(body.guildId),
          ownershipTransferredAtMs: null,
          guildGoodStanding: true,
          sellerGoodStanding: true,
          termsVersion: services.currentTermsVersion,
          termsAccepted: body.termsAccepted,
          refreshUrl: `${base}/admin/${encodeURIComponent(body.guildId)}/commerce?commerceConnect=refresh`,
          returnUrl: `${base}/admin/${encodeURIComponent(body.guildId)}/commerce?commerceConnect=return`,
          attemptId: crypto.randomUUID(),
          sellerEmail:
            sellerPrefillEmail(session.user.email) ?? sellerPrefillEmail(body.supportContact),
          businessProfileUrl: commerceStorefrontUrl(base, body.guildId),
        });
        return Response.json(result, { status: 201 });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/authority",
      body: authorityGrantBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const actorUserId = await requireActorUserId(options, request);
        const account = await requireGuildAccount(services, body.guildId);
        if (!(await isSellerOwner(services, body.guildId, actorUserId))) return forbidden();
        const nowMs = Date.now();
        await services.store.saveAuthorityGrant({
          connectedAccountId: account.id,
          discordUserId: body.discordUserId,
          capability: body.capability,
          grantedByUserId: actorUserId,
          grantedAtMs: nowMs,
          revokedAtMs: body.enabled ? null : nowMs,
        });
        await services.store.appendOperation({
          id: crypto.randomUUID(),
          connectedAccountId: account.id,
          guildId: body.guildId,
          operationKey: `authority:${account.id}:${body.discordUserId}:${body.capability}:${nowMs}`,
          operationType: body.enabled ? "authority.granted" : "authority.revoked",
          entityType: "commerce_authority",
          entityId: body.discordUserId,
          actorType: "seller",
          actorId: actorUserId,
          payloadJson: JSON.stringify({ capability: body.capability }),
          createdAtMs: nowMs,
        });
        return Response.json({ updated: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/platform/commerce/sellers",
      query: platformSellerQuery,
      access: commerceReadAccess,
      handler: async ({ query, request }) => {
        const services = requireServices(options.services);
        if (!(await readPlatformOperator(options, request))) return forbidden();
        const profiles = await services.store.listSellerProfiles(query.state);
        const sellers = await Promise.all(
          profiles.map(async (profile) => ({
            profile,
            account: await services.store.readConnectedAccountByGuild(profile.guildId),
          })),
        );
        return Response.json({ sellers });
      },
    }),
    platformSellerReviewRoute("approve", "approved", options),
    platformSellerReviewRoute("reject", "rejected", options),
    defineRoute({
      method: "POST",
      path: "/admin/api/platform/commerce/sellers/suspend",
      body: platformSellerSuspensionBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const lifecycle = services.sellerLifecycle;
        if (!lifecycle) return unavailable();
        const actorUserId = await readPlatformOperator(options, request);
        if (!actorUserId) return forbidden();
        await requireGuildAccount(services, body.guildId);
        await lifecycle.setSuspension({
          scopeType: "guild",
          scopeId: body.guildId,
          suspended: body.suspended,
          reasonCode: body.suspended ? body.reasonCode : null,
          actorUserId,
        });
        await refreshSalesPanel(services, body.guildId);
        return Response.json({ suspended: body.suspended });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/platform/commerce/controls",
      body: platformControlBody,
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        if (!services.safeguards) return unavailable();
        const actorUserId = await readPlatformOperator(options, request);
        if (!actorUserId) return forbidden();
        const control = await services.safeguards.setControl({
          scopeType: "global",
          scopeId: "commerce",
          controlType: body.controlType,
          enabled: body.enabled,
          reasonCode: body.reasonCode,
          actorUserId,
          expiresAtMs: body.expiresAtMs,
        });
        if (
          body.enabled &&
          (body.controlType === "commerce_kill" || body.controlType === "renewal_shutdown") &&
          services.financialOperations
        ) {
          const profiles = await services.store.listSellerProfiles();
          const accounts = await Promise.all(
            profiles.map((profile) => services.store.readConnectedAccountByGuild(profile.guildId)),
          );
          await Promise.all(
            accounts
              .filter((account) => account && account.status !== "disconnected")
              .map((account) =>
                services.financialOperations!.shutdownRenewals({
                  guildId: account!.guildId,
                  actorUserId,
                  reasonCode: body.reasonCode,
                  actionId: `commerce:global-control:${body.actionId}:${account!.id}`,
                }),
              ),
          );
        }
        const sellerProfiles = await services.store.listSellerProfiles();
        await Promise.all(
          sellerProfiles.map((profile) => refreshSalesPanel(services, profile.guildId)),
        );
        return Response.json({ control });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/seller/refresh",
      body: z.object({ guildId, workspaceId }),
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const lifecycle = services.sellerLifecycle;
        if (!lifecycle) return unavailable();
        const account = await requireGuildAccount(services, body.guildId);
        if (
          !(await hasCommerceCapability(
            services,
            account.id,
            await requireActorUserId(options, request),
            "commerce.seller.manage",
          ))
        ) {
          return forbidden();
        }
        const sellerProfile = await lifecycle.refreshAccount(body.guildId);
        const refreshedAccount = await requireGuildAccount(services, body.guildId);
        await services.sellerReviews?.syncSeller({
          account: refreshedAccount,
          profile: sellerProfile,
        });
        await refreshSalesPanel(services, body.guildId);
        return Response.json({ sellerProfile });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/commerce/seller/stripe-dashboard",
      body: z.object({ guildId, workspaceId }),
      access: commerceWriteAccess,
      handler: async ({ body, request }) => {
        const services = requireServices(options.services);
        const lifecycle = services.sellerLifecycle;
        if (!lifecycle) return unavailable();
        const actorUserId = await requireActorUserId(options, request);
        if (!(await isSellerOwner(services, body.guildId, actorUserId))) return forbidden();
        const link = await lifecycle.createAccountManagementLink(body.guildId);
        return Response.json(link);
      },
    }),
  ];
}

function actionRoute(
  path: string,
  options: CommerceAdminRoutesOptions,
  action: (service: CommerceOfferingService, offeringId: string) => Promise<unknown>,
): Route<any, any, Response> {
  return defineRoute({
    method: "POST",
    path,
    body: offeringActionBody,
    access: commerceWriteAccess,
    handler: async ({ body, request }) => {
      const services = requireServices(options.services);
      const offering = await requireGuildOffering(services, body.guildId, body.offeringId);
      if (
        !(await hasCommerceCapability(
          services,
          offering.connectedAccountId,
          await requireActorUserId(options, request),
          "commerce.offerings.manage",
        ))
      ) {
        return forbidden();
      }
      return Response.json({
        lifecycle: await action(services.offerings, body.offeringId),
      });
    },
  });
}

function salesPanelPublishRoute(
  path: string,
  options: CommerceAdminRoutesOptions,
): Route<any, any, Response> {
  return defineRoute({
    method: "POST",
    path,
    body: salesPanelPublishBody,
    access: commerceWriteAccess,
    handler: async ({ body, request }) => {
      const services = requireServices(options.services);
      if (!services.salesPanel) return unavailable();
      const account = await requireGuildAccount(services, body.guildId);
      const actorUserId = await requireActorUserId(options, request);
      if (
        !(await hasCommerceCapability(
          services,
          account.id,
          actorUserId,
          "commerce.offerings.manage",
        ))
      ) {
        return forbidden();
      }
      return Response.json({
        salesPanel: await services.salesPanel.publish({
          connectedAccountId: account.id,
          guildId: body.guildId,
          channelId: body.channelId,
          title: body.title,
          description: body.description,
        }),
      });
    },
  });
}

function platformSellerReviewRoute(
  action: "approve" | "reject",
  approvalState: "approved" | "rejected",
  options: CommerceAdminRoutesOptions,
): Route<any, any, Response> {
  return defineRoute({
    method: "POST",
    path: `/admin/api/platform/commerce/sellers/${action}`,
    body: platformSellerReviewBody,
    access: commerceWriteAccess,
    handler: async ({ body, request }) => {
      const lifecycle = requireServices(options.services).sellerLifecycle;
      if (!lifecycle) return unavailable();
      const actorUserId = await readPlatformOperator(options, request);
      if (!actorUserId) return forbidden();
      const sellerProfile = await lifecycle.reviewSeller({
        guildId: body.guildId,
        approvalState,
        actorUserId,
        reasonCode: body.reasonCode,
      });
      await refreshSalesPanel(requireServices(options.services), body.guildId);
      return Response.json({
        sellerProfile,
      });
    },
  });
}

function requireServices(services: CommerceAdminServices | undefined): CommerceAdminServices {
  if (!services) throw new Error("Commerce administration is not configured.");
  return services;
}

function requireFinancialOperations(
  services: CommerceAdminServices | undefined,
): NonNullable<CommerceAdminServices["financialOperations"]> {
  const service = requireServices(services).financialOperations;
  if (!service) throw new Error("Commerce financial operations are unavailable.");
  return service;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value || value.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(value)) {
    throw adminRouteErrors.invalidRequest([
      {
        path: "headers.Idempotency-Key",
        code: "invalid_format",
        message: "A stable Idempotency-Key header is required.",
      },
    ]);
  }
  return value;
}

async function requireActorUserId(
  options: CommerceAdminRoutesOptions,
  request: Request,
): Promise<string> {
  return (await requireActorSession(options, request)).user.discordUserId;
}

async function requireActorSession(
  options: CommerceAdminRoutesOptions,
  request: Request,
): Promise<CustomerSession> {
  const session = await options.readCustomerAdminSession?.(request);
  if (!session?.user.discordUserId) {
    throw new Error("Authenticated Commerce operator identity is required.");
  }
  return session;
}

async function hasCommerceCapability(
  services: CommerceAdminServices,
  connectedAccountId: string,
  actorUserId: string,
  capability: CommerceCapability,
): Promise<boolean> {
  const profile = await services.store.readSellerProfile(connectedAccountId);
  if (!profile) return false;
  if (profile.sellerOwnerUserId === actorUserId) return true;
  return (await services.store.readSellerCapabilities(connectedAccountId, actorUserId)).includes(
    capability,
  );
}

async function isSellerOwner(
  services: CommerceAdminServices,
  guildId: string,
  actorUserId: string,
): Promise<boolean> {
  const account = await services.store.readConnectedAccountByGuild(guildId);
  if (!account) return false;
  return (await services.store.readSellerProfile(account.id))?.sellerOwnerUserId === actorUserId;
}

async function refreshSalesPanel(services: CommerceAdminServices, guildId: string): Promise<void> {
  await services.salesPanel?.refreshForGuild(guildId);
}

async function readPlatformOperator(
  options: CommerceAdminRoutesOptions,
  request: Request,
): Promise<string | null> {
  const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
  if (!actorUserId || !(await options.isPlatformOperator?.(actorUserId))) return null;
  return actorUserId;
}

async function requireGuildAccount(services: CommerceAdminServices, guildId: string) {
  const account = await services.store.readConnectedAccountByGuild(guildId);
  if (!account) throw new Error("Commerce seller is not connected.");
  return account;
}

async function requireGuildOffering(
  services: CommerceAdminServices,
  guildId: string,
  offeringIdValue: string,
) {
  const offering = await services.catalog.readOffering(offeringIdValue);
  if (!offering) throw new Error("Commerce offering was not found.");
  if (offering.guildId !== guildId) throw new Error("Commerce offering scope mismatch.");
  const account = await requireGuildAccount(services, guildId);
  if (offering.connectedAccountId !== account.id)
    throw new Error("Commerce seller scope mismatch.");
  return offering;
}

async function listManageableRoles(
  options: CommerceAdminRoutesOptions,
  targetGuildId: string,
): Promise<Array<{ id: string; name: string }>> {
  if (!options.discordBotUserId) return [];
  try {
    const context = await loadGuildPermissionContext(
      targetGuildId,
      options.discordBotUserId,
      options.discordBotToken,
    );
    const highest = getHighestBotRole(context);
    if (
      !highest ||
      !hasPermission(getBaseGuildPermissions(context), DISCORD_PERMISSION_FLAGS.manageRoles)
    ) {
      return [];
    }
    return context.roles
      .filter(
        (role) =>
          role.id !== targetGuildId && role.managed !== true && role.position < highest.position,
      )
      .map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

async function listSalesPanelChannels(
  options: CommerceAdminRoutesOptions,
  targetGuildId: string,
): Promise<Array<{ id: string; name: string }>> {
  if (!options.discordBotUserId) return [];
  try {
    const context = await loadGuildPermissionContext(
      targetGuildId,
      options.discordBotUserId,
      options.discordBotToken,
    );
    return context.channels
      .filter((channel) => channel.type === 0 || channel.type === 5)
      .filter((channel) => {
        const permissions = getChannelPermissions(context, channel);
        return (
          hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel) &&
          hasPermission(permissions, DISCORD_PERMISSION_FLAGS.sendMessages)
        );
      })
      .sort((left, right) => {
        const positionDelta = (left.position ?? 0) - (right.position ?? 0);
        return positionDelta || left.name.localeCompare(right.name);
      })
      .map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

async function isRoleManageable(
  options: CommerceAdminRoutesOptions,
  targetGuildId: string,
  roleId: string,
): Promise<boolean> {
  return (await listManageableRoles(options, targetGuildId)).some((role) => role.id === roleId);
}

function unavailable(): Response {
  return Response.json({ error: "Commerce seller management is unavailable." }, { status: 503 });
}

function forbidden(): Response {
  return Response.json({ error: "Commerce authority is required." }, { status: 403 });
}

function sellerOnboardingOwnerRequired(): Response {
  return Response.json(
    {
      error:
        "Only this Discord server's owner can set up Commerce. Ask the owner to open this page and submit the Stripe seller request.",
    },
    { status: 403 },
  );
}

function sellerPrefillEmail(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
    normalized.toLowerCase().endsWith("@discord.local")
  ) {
    return undefined;
  }
  return normalized;
}

function commerceStorefrontUrl(base: string, guildId: string): string | undefined {
  const url = new URL(`/commerce/stores/${encodeURIComponent(guildId)}`, `${base}/`);
  return url.protocol === "https:" ? url.toString() : undefined;
}

function discordSnowflakeCreatedAtMs(value: string): number {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) return 0;
  try {
    return Number((BigInt(value) >> 22n) + 1_420_070_400_000n);
  } catch {
    return 0;
  }
}
