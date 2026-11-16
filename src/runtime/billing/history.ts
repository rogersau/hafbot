import type { BillingLedgerOperation } from "./types";

export interface BillingHistoryStore {
  listOwnerHistory(ownerId: string, limit?: number): Promise<BillingLedgerOperation[]>;
}
