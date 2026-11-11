import type { BillingCatalogEntry } from "./types";

export interface BillingCatalogConfig {
  premiumMonthlyPriceId: string;
  premiumMonthlyProductId: string;
  premiumYearlyPriceId: string;
  premiumYearlyProductId: string;
  premiumPlusMonthlyPriceId: string;
  premiumPlusMonthlyProductId: string;
  premiumPlusYearlyPriceId: string;
  premiumPlusYearlyProductId: string;
}

export function createBillingCatalog(
  config: BillingCatalogConfig,
): ReadonlyMap<string, BillingCatalogEntry> {
  const entries: BillingCatalogEntry[] = [
    entry(config.premiumMonthlyPriceId, config.premiumMonthlyProductId, "premium", "monthly"),
    entry(config.premiumYearlyPriceId, config.premiumYearlyProductId, "premium", "yearly"),
    entry(
      config.premiumPlusMonthlyPriceId,
      config.premiumPlusMonthlyProductId,
      "premium_plus",
      "monthly",
    ),
    entry(
      config.premiumPlusYearlyPriceId,
      config.premiumPlusYearlyProductId,
      "premium_plus",
      "yearly",
    ),
  ];
  if (entries.some((candidate) => !candidate.priceId?.trim() || !candidate.productId?.trim())) {
    throw new Error(
      "All four Billing catalog Price identities and Product identities are required.",
    );
  }
  if (new Set(entries.map((candidate) => candidate.priceId)).size !== entries.length) {
    throw new Error("Billing catalog Price identities must be unique.");
  }
  return new Map(entries.map((candidate) => [candidate.priceId, candidate]));
}

function entry(
  priceId: string,
  productId: string,
  plan: BillingCatalogEntry["plan"],
  frequency: BillingCatalogEntry["frequency"],
): BillingCatalogEntry {
  return { priceId, productId, plan, frequency };
}
