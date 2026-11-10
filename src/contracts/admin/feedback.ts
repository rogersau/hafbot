import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const safeText = (max: number) => z.string().min(1).max(max);
const id = z.string().regex(/^\d{1,25}$/);
const machineId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const diagnostic = z
  .object({
    included: z.boolean(),
    browser: safeText(80).optional(),
    os: safeText(80).optional(),
  })
  .strict();

export const adminFeedbackBodySchema = z
  .object({
    version: z.literal(1),
    category: z.enum(["problem", "suggestion", "other"]),
    summary: safeText(200),
    description: safeText(4_000),
    route: safeText(200),
    pageLabel: safeText(120).optional(),
    guildId: id.optional(),
    workspaceId: safeText(80).optional(),
    correlationId: machineId.optional(),
    errorCode: machineId.optional(),
    workerVersion: machineId.optional(),
    diagnostics: diagnostic.optional(),
  })
  .strict();

export const createAdminFeedback = defineAdminOperation({
  tags: ["Feedback"],
  operationId: "feedback.create.v1",
  method: "POST",
  path: "/admin/api/feedback",
  summary: "Submit bounded admin feedback",
  body: adminFeedbackBodySchema,
  success: {
    status: 201,
    schema: z.object({
      ok: z.literal(true),
      reference: z.string(),
      receivedAtMs: z.number().int(),
    }),
    description: "Feedback accepted for processing",
  },
  errors: [
    adminOperationErrors.invalidRequest,
    adminOperationErrors.authenticationRequired,
    adminOperationErrors.permissionDenied,
    adminOperationErrors.feedbackRateLimited,
    adminOperationErrors.unavailable,
    adminOperationErrors.internal,
  ],
  access: { scope: "customer", mode: "read" },
  feature: undefined,
  entitlement: undefined,
});
export const feedbackContracts = { create: createAdminFeedback };
