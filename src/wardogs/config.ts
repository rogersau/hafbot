import { z } from "zod";
import { DISABLED_NETWORK, type NetworkPolicy } from "./model";
import { approvedOrigin } from "./transport";
const config = z
  .object({
    origins: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            origin: z.string().max(300),
            securePathEvidence: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(100),
    approvals: z
      .array(
        z
          .object({
            targetId: z.string().uuid(),
            generation: z.number().int().positive(),
            originRef: z.string().min(1).max(100),
            origin: z.string().url().max(300),
            banContract: z
              .object({
                physicalTargetId: z.string().trim().min(1).max(100),
                evidence: z.string().trim().min(1).max(2000),
                completeList: z.literal(true),
                synchronousMutations: z.literal(true),
                ban: z.boolean(),
                unban: z.boolean(),
              })
              .strict()
              .optional(),
            attendanceContract: z
              .object({ completeRoster: z.boolean(), evidence: z.string().trim().min(1).max(2000) })
              .strict()
              .optional(),
            reservedContract: z
              .object({
                physicalTargetId: z.string().trim().min(1).max(100),
                evidence: z.string().trim().min(1).max(2000),
                completeList: z.literal(true),
                capacityMeaning: z.literal("saleable-entries"),
                entryCapacity: z.number().int().positive().max(2000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export function wardogsNetworkPolicy(env: {
  WARDOGS_NETWORK_ENABLED?: string;
  WARDOGS_NETWORK_POLICY?: string;
}): NetworkPolicy {
  if (!env.WARDOGS_NETWORK_POLICY) return DISABLED_NETWORK;
  try {
    const parsed = config.parse(JSON.parse(env.WARDOGS_NETWORK_POLICY));
    for (const entry of parsed.origins) approvedOrigin(entry);
    if (new Set(parsed.origins.map((entry) => entry.id)).size !== parsed.origins.length)
      return DISABLED_NETWORK;
    return { ...parsed, enabled: env.WARDOGS_NETWORK_ENABLED === "true" };
  } catch {
    return DISABLED_NETWORK;
  }
}
