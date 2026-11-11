import type { GuildPlan } from "../../types";

export type BillingFrequency = "monthly" | "yearly";

export interface BillingAuditIdentity {
  discordUserId: string;
  displayName: string;
}

export interface BillingAuditGuild {
  guildId: string;
  name: string;
}
export type BillingSubscriptionStatus =
  | "missing"
  | "incomplete"
  | "active"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "quarantined";

export interface BillingCatalogEntry {
  priceId: string;
  productId: string;
  plan: Exclude<GuildPlan, "free">;
  frequency: BillingFrequency;
}

export interface StripeOwnerState {
  customer: { id: string; email: string | null };
  subscriptions: StripeSubscriptionState[];
  observedAtMs: number;
}

export interface StripeSubscriptionState {
  id: string;
  customerId: string;
  priceId: string;
  productId: string;
  status: "incomplete" | "active" | "past_due" | "unpaid" | "canceled";
  currentPeriodStartMs: number | null;
  currentPeriodEndMs: number | null;
  cancelAtPeriodEnd: boolean;
  cancelledAtMs: number | null;
  latestInvoiceId: string | null;
  scheduleId: string | null;
}

export interface BillingSubscriptionProjection {
  ownerId: string;
  customerId: string;
  subscriptionId: string | null;
  priceId: string | null;
  productId: string | null;
  plan: GuildPlan;
  frequency: BillingFrequency | null;
  status: BillingSubscriptionStatus;
  currentPeriodStartMs: number | null;
  currentPeriodEndMs: number | null;
  cancelAtPeriodEnd: boolean;
  cancelledAtMs: number | null;
  latestInvoiceId: string | null;
  scheduleId: string | null;
  observedAtMs: number;
  quarantineReason: string | null;
  graceStartedAtMs?: number | null;
  graceEndsAtMs?: number | null;
  graceExpiredAtMs?: number | null;
}

export interface BillingLedgerOperation {
  id: string;
  ownerId: string;
  kind: string;
  source: "operator" | "scheduled" | "webhook" | "checkout" | "support" | "dashboard";
  correlationId: string | null;
  summaryJson: string;
  createdAtMs: number;
}
