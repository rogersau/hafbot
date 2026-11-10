import type { BillingSubscriptionProjection } from "./types";

export interface BillingGraceStore {
  listDueGraceOwners(nowMs: number): Promise<string[]>;
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  expireGrace(ownerId: string, nowMs: number): Promise<void>;
  recordFailure(
    ownerId: string,
    reason: string,
    nowMs: number,
    terminalAttempt: number,
  ): Promise<void>;
  clearFailure(ownerId: string): Promise<void>;
}

export function createBillingGraceProcessor(options: {
  store: BillingGraceStore;
  syncOwner(input: {
    ownerId: string;
    source: "scheduled";
    correlationId: string;
  }): Promise<BillingSubscriptionProjection>;
  now?: () => number;
  terminalAttempt?: number;
}) {
  const now = options.now ?? Date.now;
  return async (): Promise<void> => {
    const checkedAt = now();
    for (const ownerId of await options.store.listDueGraceOwners(checkedAt)) {
      try {
        const projection = await options.syncOwner({
          ownerId,
          source: "scheduled",
          correlationId: `grace-expiry:${ownerId}:${checkedAt}`,
        });
        await options.store.clearFailure(ownerId);
        if (
          (projection.status === "past_due" || projection.status === "unpaid") &&
          (projection.graceEndsAtMs ?? checkedAt) <= checkedAt
        ) {
          await options.store.expireGrace(ownerId, checkedAt);
        }
      } catch (error) {
        await options.store.recordFailure(
          ownerId,
          error instanceof Error ? error.message : "sync_failed",
          checkedAt,
          options.terminalAttempt ?? 5,
        );
      }
    }
  };
}
