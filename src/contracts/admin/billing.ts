import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const billingFrequencySchema = z.enum(["monthly", "yearly"]);
const billingPlanSchema = z.enum(["free", "premium", "premium_plus"]);
const paidPlanSchema = z.enum(["premium", "premium_plus"]);
const billingStatusSchema = z.enum([
  "missing",
  "incomplete",
  "active",
  "past_due",
  "unpaid",
  "cancelled",
  "quarantined",
]);
const emptyQuerySchema = z.object({});

const subscriptionSchema = z.object({
  ownerId: z.string(),
  customerId: z.string(),
  subscriptionId: z.string().nullable(),
  priceId: z.string().nullable(),
  productId: z.string().nullable(),
  plan: billingPlanSchema,
  frequency: billingFrequencySchema.nullable(),
  status: billingStatusSchema,
  currentPeriodStartMs: z.number().int().nullable(),
  currentPeriodEndMs: z.number().int().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  cancelledAtMs: z.number().int().nullable(),
  latestInvoiceId: z.string().nullable(),
  scheduleId: z.string().nullable(),
  observedAtMs: z.number().int(),
  quarantineReason: z.string().nullable(),
  graceStartedAtMs: z.number().int().nullable().optional(),
  graceEndsAtMs: z.number().int().nullable().optional(),
  graceExpiredAtMs: z.number().int().nullable().optional(),
});

const catalogEntrySchema = z.object({
  priceId: z.string(),
  productId: z.string(),
  plan: paidPlanSchema,
  frequency: billingFrequencySchema,
});

const displayPriceSchema = z.object({
  plan: paidPlanSchema,
  frequency: billingFrequencySchema,
  unitAmount: z.number().int().nonnegative(),
  currency: z.string(),
  decimalAmount: z.string(),
  formattedAmount: z.string(),
});

const ledgerOperationSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  kind: z.string(),
  source: z.enum(["operator", "scheduled", "webhook", "checkout", "support", "dashboard"]),
  correlationId: z.string().nullable(),
  summaryJson: z.string(),
  createdAtMs: z.number().int(),
});

const assignmentSchema = z.object({
  guildId: z.string(),
  ownerId: z.string(),
  subscriptionId: z.string(),
  assignedAtMs: z.number().int(),
});

const eligibleGuildSchema = z.object({
  guildId: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  effectivePlan: z.enum(["free", "premium", "premium_plus"]),
});

const assignmentResponseSchema = z.object({
  assignments: z.array(assignmentSchema),
  eligibleGuilds: z.array(eligibleGuildSchema),
  capacity: z.number().int().nonnegative(),
});

const supportCaseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  kind: z.string(),
  status: z.string(),
  safeProviderIdsJson: z.string(),
  openedAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  resolvedAtMs: z.number().int().nullable(),
});
const deliveryAttemptSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  destination: z.string(),
  outcome: z.string(),
  provider_correlation_id: z.string().nullable(),
  attempted_at_ms: z.number().int(),
});

const commonReadErrors = [
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const commonWriteErrors = [
  adminOperationErrors.invalidRequest,
  ...commonReadErrors,
  adminOperationErrors.conflict,
] as const;
const billingMetadata = { tags: ["Billing"], feature: "billing", entitlement: undefined } as const;

export const getBilling = defineAdminOperation({
  ...billingMetadata,
  operationId: "billing.get",
  method: "GET",
  path: "/admin/api/billing",
  summary: "Read Billing summary",
  query: emptyQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      subscription: subscriptionSchema.nullable(),
      catalog: z.array(catalogEntrySchema),
      prices: z.array(displayPriceSchema),
    }),
    description: "The current subscription and purchasable Billing catalogue",
  },
  errors: commonReadErrors,
  access: { scope: "customer", mode: "read" },
});

export const getBillingAssignments = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingAssignments.get",
  method: "GET",
  path: "/admin/api/billing/assignments",
  summary: "List Billing Guild Assignments",
  query: emptyQuerySchema,
  success: {
    status: 200,
    schema: assignmentResponseSchema,
    description: "Guilds assigned to the current subscription and eligible Guilds",
  },
  errors: [...commonReadErrors, adminOperationErrors.conflict],
  access: { scope: "customer", mode: "read" },
});

const billingAssignmentBodySchema = z.object({
  action: z.enum(["assign", "unassign", "move"]),
  guildId: z.string().min(1),
  fromGuildId: z.string().min(1).optional(),
});

export const mutateBillingAssignments = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingAssignments.post",
  method: "POST",
  path: "/admin/api/billing/assignments",
  summary: "Change Billing Guild Assignments",
  body: billingAssignmentBodySchema,
  success: {
    status: 200,
    schema: assignmentResponseSchema,
    description: "The updated Guild Assignments",
  },
  errors: commonWriteErrors,
  access: { scope: "customer", mode: "write" },
});

const billingIntentBodySchema = z.object({ intentId: z.string().min(1) });

export const cancelBilling = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingCancellation.post",
  method: "POST",
  path: "/admin/api/billing/cancellation",
  summary: "Set Billing cancellation",
  body: billingIntentBodySchema.extend({ cancelAtPeriodEnd: z.boolean() }),
  success: {
    status: 200,
    schema: z.object({ subscription: subscriptionSchema }),
    description: "The updated subscription projection",
  },
  errors: commonWriteErrors,
  access: { scope: "customer", mode: "write" },
});

export const changeBillingPrice = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingChangePrice.post",
  method: "POST",
  path: "/admin/api/billing/change-price",
  summary: "Change the Billing plan",
  body: billingIntentBodySchema.extend({ priceId: z.string().min(1) }),
  success: {
    status: 200,
    schema: z.union([
      z.object({
        effective: z.literal("renewal"),
        effectiveAtMs: z.number().int(),
        url: z.string(),
      }),
      z.object({
        effective: z.literal("immediate"),
        chargeImpact: z.literal("prorated"),
        url: z.string(),
      }),
    ]),
    description: "The Billing plan change result",
  },
  errors: commonWriteErrors,
  access: { scope: "customer", mode: "write" },
});

export const startBillingCheckout = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingCheckout.post",
  method: "POST",
  path: "/admin/api/billing/checkout",
  summary: "Start Billing checkout",
  body: z.object({ priceId: z.string().min(1), intentId: z.string().min(1) }),
  success: {
    status: 200,
    schema: z.object({ checkoutSessionId: z.string(), url: z.string() }),
    description: "The hosted Stripe checkout session",
  },
  errors: commonWriteErrors,
  access: { scope: "customer", mode: "write" },
});

export const getBillingHistory = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingHistory.get",
  method: "GET",
  path: "/admin/api/billing/history",
  summary: "List Billing history",
  query: emptyQuerySchema,
  success: {
    status: 200,
    schema: z.object({ events: z.array(ledgerOperationSchema) }),
    description: "Safe Billing history events for the current owner",
  },
  errors: commonReadErrors,
  access: { scope: "customer", mode: "read" },
});

export const createBillingPortal = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingPortal.post",
  method: "POST",
  path: "/admin/api/billing/portal",
  summary: "Open the Billing Portal",
  body: billingIntentBodySchema,
  success: {
    status: 200,
    schema: z.object({ url: z.string() }),
    description: "The hosted Stripe Billing Portal URL",
  },
  errors: commonWriteErrors,
  access: { scope: "customer", mode: "write" },
});

export const getBillingSupportCase = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingSupportCase.get",
  method: "GET",
  path: "/admin/api/billing-support/case",
  query: z.object({ caseId: z.string().min(1) }),
  summary: "Inspect a Billing support case",
  success: {
    status: 200,
    schema: z.object({
      case: supportCaseSchema,
      projection: subscriptionSchema.nullable(),
      operations: z.array(ledgerOperationSchema),
      assignments: z.array(assignmentSchema),
      deliveryAttempts: z.array(deliveryAttemptSchema),
    }),
    description: "Restricted Billing support case details",
  },
  errors: [...commonReadErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "customer", mode: "read" },
});

export const listBillingSupportCases = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingSupportCases.get",
  method: "GET",
  path: "/admin/api/billing-support/cases",
  summary: "List Billing support cases",
  query: emptyQuerySchema,
  success: {
    status: 200,
    schema: z.object({ cases: z.array(supportCaseSchema) }),
    description: "Restricted Billing support cases",
  },
  errors: commonReadErrors,
  access: { scope: "customer", mode: "read" },
});

const supportOperationBodySchema = z.discriminatedUnion("action", [
  z.object({ caseId: z.string().min(1), action: z.literal("reconcile") }),
  z.object({
    caseId: z.string().min(1),
    action: z.literal("billing_link"),
    intentId: z.string().min(1),
  }),
  z.object({
    caseId: z.string().min(1),
    action: z.literal("assignment_move"),
    fromGuildId: z.string().min(1),
    toGuildId: z.string().min(1),
  }),
  z.object({
    caseId: z.string().min(1),
    action: z.literal("delivery_replay"),
    operationId: z.string().min(1),
  }),
  z.object({
    caseId: z.string().min(1),
    action: z.literal("case_status"),
    status: z.string().min(1),
  }),
]);

export const operateBillingSupportCase = defineAdminOperation({
  ...billingMetadata,
  operationId: "billingSupportOperation.post",
  method: "POST",
  path: "/admin/api/billing-support/operation",
  summary: "Operate on a Billing support case",
  body: supportOperationBodySchema,
  success: {
    status: 200,
    schema: z.object({
      result: z.union([subscriptionSchema, z.object({}).passthrough().nullable()]),
    }),
    description: "The restricted Billing support operation result",
  },
  errors: [...commonWriteErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "customer", mode: "write" },
});

export const billingContracts = {
  get: getBilling,
  assignmentsGet: getBillingAssignments,
  assignmentsPost: mutateBillingAssignments,
  cancellation: cancelBilling,
  changePrice: changeBillingPrice,
  checkout: startBillingCheckout,
  history: getBillingHistory,
  portal: createBillingPortal,
  supportCase: getBillingSupportCase,
  supportCases: listBillingSupportCases,
  supportOperation: operateBillingSupportCase,
  sync: defineAdminOperation({
    ...billingMetadata,
    operationId: "billingSync.post",
    method: "POST",
    path: "/admin/api/billing/sync",
    summary: "Synchronize Billing after checkout",
    body: z.object({ checkoutSessionId: z.string().min(1) }),
    success: {
      status: 200,
      schema: z.object({ subscription: subscriptionSchema }),
      description: "The synchronized subscription projection",
    },
    errors: commonWriteErrors,
    access: { scope: "customer", mode: "write" },
  }),
} as const;
