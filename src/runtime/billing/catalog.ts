import type { BillingCatalogEntry } from "./types";

export interface BillingCatalogConfig {
  founderPremiumMonthlyPriceId: string;
  founderPremiumYearlyPriceId: string;
  legacyFounderPremiumYearlyPriceId?: string;
  founderPremiumPlusMonthlyPriceId: string;
  founderPremiumPlusYearlyPriceId: string;
  legacyFounderPremiumPlusYearlyPriceId?: string;
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
  // Keep the existing configuration keys and immutable Price identities. The
  // former launch rates are now the standard offer; earlier rates remain valid
  // for existing subscriptions but cannot be selected for a new purchase.
  const entries: BillingCatalogEntry[] = [
    entry(
      config.founderPremiumMonthlyPriceId,
      config.premiumMonthlyProductId,
      "premium",
      "monthly",
      "standard",
    ),
    entry(
      config.founderPremiumYearlyPriceId,
      config.premiumYearlyProductId,
      "premium",
      "yearly",
      "standard",
    ),
    entry(
      config.founderPremiumPlusMonthlyPriceId,
      config.premiumPlusMonthlyProductId,
      "premium_plus",
      "monthly",
      "standard",
    ),
    entry(
      config.founderPremiumPlusYearlyPriceId,
      config.premiumPlusYearlyProductId,
      "premium_plus",
      "yearly",
      "standard",
    ),
    entry(
      config.premiumMonthlyPriceId,
      config.premiumMonthlyProductId,
      "premium",
      "monthly",
      "standard",
      true,
    ),
    entry(
      config.premiumYearlyPriceId,
      config.premiumYearlyProductId,
      "premium",
      "yearly",
      "standard",
      true,
    ),
    entry(
      config.premiumPlusMonthlyPriceId,
      config.premiumPlusMonthlyProductId,
      "premium_plus",
      "monthly",
      "standard",
      true,
    ),
    entry(
      config.premiumPlusYearlyPriceId,
      config.premiumPlusYearlyProductId,
      "premium_plus",
      "yearly",
      "standard",
      true,
    ),
  ];
  if (config.legacyFounderPremiumYearlyPriceId) {
    entries.push(
      entry(
        config.legacyFounderPremiumYearlyPriceId,
        config.premiumYearlyProductId,
        "premium",
        "yearly",
        "founder",
        true,
      ),
    );
  }
  if (config.legacyFounderPremiumPlusYearlyPriceId) {
    entries.push(
      entry(
        config.legacyFounderPremiumPlusYearlyPriceId,
        config.premiumPlusYearlyProductId,
        "premium_plus",
        "yearly",
        "founder",
        true,
      ),
    );
  }
  if (entries.some((candidate) => !candidate.priceId || !candidate.productId)) {
    throw new Error(
      "All eight Billing catalog Price identities and Product identities are required.",
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
  cohort: BillingCatalogEntry["cohort"],
  legacy = false,
): BillingCatalogEntry {
  const value = { priceId, productId, plan, frequency, cohort };
  return legacy ? { ...value, legacy: true } : value;
}
