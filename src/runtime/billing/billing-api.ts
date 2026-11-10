import type { CustomerSession } from "../auth/customer-session";
import { BillingCheckoutError, type BillingCheckoutService } from "./checkout";
import { AssignmentError, type BillingAssignmentService } from "./assignments";
import { ManagementError } from "./management";
import type { ReturnTypeBillingManagement } from "./management-types";
import type { BillingHistoryStore } from "./history";
import { SupportError } from "./support";
import type { ReturnTypeBillingSupport } from "./support-types";
import type { LandingPriceCatalog } from "./landing-catalog";
import { billingContracts } from "../../contracts/admin/billing";
import type { AdminOperationContract } from "../../contracts/admin/core";
import { parseAdminBody, parseAdminQuery, parseErrorResponse } from "../admin-route-parsers";
import { createAdminRequestContext } from "../admin-errors/admin-request-context";
import { mapAdminFailure, normalizeAdminErrorResponse } from "../admin-errors/admin-error-mapper";

type BillingOperationContract = AdminOperationContract;
type BillingAssignmentBody = {
  action: "assign" | "unassign" | "move";
  guildId: string;
  fromGuildId?: string;
};
type BillingIntentBody = { intentId: string };
type SupportOperationBody =
  | { action: "reconcile"; caseId: string }
  | { action: "billing_link"; caseId: string; intentId: string }
  | {
      action: "assignment_move";
      caseId: string;
      fromGuildId: string;
      toGuildId: string;
    }
  | { action: "delivery_replay"; caseId: string; operationId: string }
  | { action: "case_status"; caseId: string; status: string };

export function createBillingApiHandler(options: {
  service: BillingCheckoutService;
  assignments?: BillingAssignmentService;
  management?: ReturnTypeBillingManagement;
  history?: BillingHistoryStore;
  prices?: LandingPriceCatalog;
  support?: ReturnTypeBillingSupport;
  authorizeSupport?(session: CustomerSession): Promise<boolean>;
  readSession(request: Request): Promise<CustomerSession | null>;
}) {
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/admin/api/billing")) return null;
    const contract = findBillingContract(request.method, path);
    if (!contract) return Response.json({ error: "Method not allowed" }, { status: 405 });
    const adminRequest = createAdminRequestContext(request, contract);
    try {
      const session = await options.readSession(request);
      if (!session) {
        return normalizeAdminErrorResponse(
          Response.json({ error: "Unauthorized" }, { status: 401 }),
          adminRequest,
        );
      }
      if (path.startsWith("/admin/api/billing-support")) {
        if (
          !options.support ||
          !options.authorizeSupport ||
          !(await options.authorizeSupport(session))
        ) {
          return normalizeAdminErrorResponse(
            Response.json({ error: "Forbidden" }, { status: 403 }),
            adminRequest,
          );
        }
      }

      const query = await parseBillingQuery(request, contract);
      if (!query.ok)
        return normalizeAdminErrorResponse(parseErrorResponse(query.error), adminRequest);
      const body = await parseBillingBody(request, contract);
      if (!body.ok)
        return normalizeAdminErrorResponse(parseErrorResponse(body.error), adminRequest);

      let response: Response;
      if (path === "/admin/api/billing-support/cases") {
        response = Response.json({ cases: await options.support!.listCases() });
      } else if (path === "/admin/api/billing-support/case") {
        const supportQuery = query.value as { caseId: string };
        response = Response.json(await options.support!.inspect(supportQuery.caseId));
      } else if (path === "/admin/api/billing-support/operation") {
        const supportBody = body.value as SupportOperationBody;
        let result: unknown;
        if (supportBody.action === "reconcile")
          result = await options.support!.reconcile(supportBody.caseId, session.user.id);
        else if (supportBody.action === "billing_link")
          result = await options.support!.billingLink(
            supportBody.caseId,
            session.user.id,
            supportBody.intentId,
          );
        else if (supportBody.action === "assignment_move")
          result = await options.support!.moveAssignment(
            supportBody.caseId,
            session.user.id,
            supportBody.fromGuildId,
            supportBody.toGuildId,
          );
        else if (supportBody.action === "delivery_replay")
          result = await options.support!.replayDelivery(
            supportBody.caseId,
            session.user.id,
            supportBody.operationId,
          );
        else
          result = await options.support!.setStatus(
            supportBody.caseId,
            session.user.id,
            supportBody.status,
          );
        response = Response.json({ result: result ?? null });
      } else if (path === "/admin/api/billing") {
        const founderAdmission = await options.prices?.readFounderAdmission?.();
        response = Response.json({
          subscription: await options.service.readSummary(session.user.id),
          catalog: await options.service.listCatalog(session.user.id),
          prices: (await options.prices?.read()) ?? [],
          founderAdmission: founderAdmission ?? null,
        });
      } else if (path === "/admin/api/billing/history") {
        if (!options.history) return unavailableResponse(adminRequest);
        response = Response.json({
          events: await options.history.listOwnerHistory(session.user.id),
        });
      } else if (path === "/admin/api/billing/checkout") {
        const checkoutBody = body.value as { priceId: string; intentId: string };
        response = Response.json(
          await options.service.startCheckout({
            ownerId: session.user.id,
            email: session.user.email ?? null,
            priceId: checkoutBody.priceId,
            intentId: checkoutBody.intentId,
          }),
        );
      } else if (path === "/admin/api/billing/assignments") {
        if (!options.assignments) return unavailableResponse(adminRequest);
        if (request.method === "GET") {
          response = Response.json(
            await options.assignments.read(session.user.id, session.user.discordUserId),
          );
        } else {
          const assignmentBody = body.value as BillingAssignmentBody;
          if (assignmentBody.action === "assign")
            await options.assignments.assign(
              session.user.id,
              { discordUserId: session.user.discordUserId, displayName: session.user.name },
              assignmentBody.guildId,
            );
          else if (assignmentBody.action === "unassign")
            await options.assignments.unassign(
              session.user.id,
              { discordUserId: session.user.discordUserId, displayName: session.user.name },
              assignmentBody.guildId,
            );
          else
            await options.assignments.move(
              session.user.id,
              { discordUserId: session.user.discordUserId, displayName: session.user.name },
              assignmentBody.fromGuildId!,
              assignmentBody.guildId,
            );
          response = Response.json(
            await options.assignments.read(session.user.id, session.user.discordUserId),
          );
        }
      } else if (path === "/admin/api/billing/sync") {
        const syncBody = body.value as { checkoutSessionId: string };
        response = Response.json({
          subscription: await options.service.requestSync(
            session.user.id,
            syncBody.checkoutSessionId,
          ),
        });
      } else if (path === "/admin/api/billing/portal") {
        if (!options.management) return unavailableResponse(adminRequest);
        const portalBody = body.value as BillingIntentBody;
        response = Response.json(
          await options.management.createPortal(session.user.id, portalBody.intentId),
        );
      } else if (path === "/admin/api/billing/change-price") {
        if (!options.management) return unavailableResponse(adminRequest);
        const changeBody = body.value as { priceId: string; intentId: string };
        response = Response.json(
          await options.management.changePrice(
            session.user.id,
            changeBody.priceId,
            changeBody.intentId,
          ),
        );
      } else if (path === "/admin/api/billing/cancellation") {
        if (!options.management) return unavailableResponse(adminRequest);
        const cancellationBody = body.value as BillingIntentBody & { cancelAtPeriodEnd: boolean };
        response = Response.json({
          subscription: await options.management.setCancellation(
            session.user.id,
            cancellationBody.cancelAtPeriodEnd,
            cancellationBody.intentId,
          ),
        });
      } else {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      return finalizeBillingResponse(response, contract, adminRequest);
    } catch (error) {
      if (
        error instanceof BillingCheckoutError ||
        error instanceof AssignmentError ||
        error instanceof ManagementError ||
        error instanceof SupportError
      ) {
        return normalizeAdminErrorResponse(
          Response.json({ error: error.message }, { status: error.status }),
          adminRequest,
        );
      }
      return mapAdminFailure(error, adminRequest);
    }
  };
}

function findBillingContract(method: string, path: string): BillingOperationContract | null {
  return (
    Object.values(billingContracts).find(
      (contract) => contract.method === method && contract.path === path,
    ) ?? null
  );
}

async function parseBillingQuery(request: Request, contract: BillingOperationContract) {
  return contract.query
    ? parseAdminQuery(new URL(request.url), contract.query)
    : { ok: true as const, value: undefined };
}

async function parseBillingBody(request: Request, contract: BillingOperationContract) {
  return contract.body
    ? parseAdminBody(request, contract.body)
    : { ok: true as const, value: undefined };
}

function unavailableResponse(adminRequest: ReturnType<typeof createAdminRequestContext>) {
  return normalizeAdminErrorResponse(
    Response.json({ error: "Billing service is unavailable." }, { status: 503 }),
    adminRequest,
  );
}

async function finalizeBillingResponse(
  response: Response,
  contract: BillingOperationContract,
  adminRequest: ReturnType<typeof createAdminRequestContext>,
) {
  const normalized = await normalizeAdminErrorResponse(response, adminRequest);
  if (normalized.status !== contract.success.status) {
    throw new Error(`Invalid response status for ${contract.operationId}: ${normalized.status}`);
  }
  const result = contract.success.schema.safeParse(await normalized.clone().json());
  if (!result.success) {
    throw new Error(`Invalid response for ${contract.operationId}: ${result.error.message}`);
  }
  return normalized;
}
