import { isRecord } from "../../unknown-parse";
import type { BillingCatalogEntry } from "./types";

export interface BillingCatalogConfig {
  /** Reviewed recognition-only identities; never offered for purchase. */
  historicalPricesJson?: string;
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
  const historical = parseHistoricalPrices(config.historicalPricesJson);
  const all = [...entries, ...historical];
  if (new Set(all.map((candidate) => candidate.priceId)).size !== all.length) {
    throw new Error(
      "Billing catalog Price identities must be unique, including historical aliases.",
    );
  }
  const productPlans = new Map<string, BillingCatalogEntry["plan"]>();
  for (const candidate of all) {
    const plan = productPlans.get(candidate.productId);
    if (plan && plan !== candidate.plan) {
      throw new Error("Billing catalog Product identities must map to only one plan.");
    }
    productPlans.set(candidate.productId, candidate.plan);
  }
  return new Map(all.map((candidate) => [candidate.priceId, candidate]));
}

function entry(
  priceId: string,
  productId: string,
  plan: BillingCatalogEntry["plan"],
  frequency: BillingCatalogEntry["frequency"],
): BillingCatalogEntry {
  return { priceId, productId, plan, frequency };
}

/** Filter recognition-only aliases at every purchase/display boundary. */
export function currentBillingPrices(
  catalog: ReadonlyMap<string, BillingCatalogEntry>,
): BillingCatalogEntry[] {
  return [...catalog.values()].filter((candidate) => !candidate.historical);
}

function parseHistoricalPrices(json: string | undefined): BillingCatalogEntry[] {
  if (json === undefined) return [];
  const invalid = () =>
    new Error(
      "Invalid STRIPE_HISTORICAL_PRICES_JSON: expected an array of Price/Product/plan/frequency aliases.",
    );
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(value)) throw invalid();
  return value.map((alias: unknown) => {
    if (!isRecord(alias)) throw invalid();
    const record = alias;
    if (
      Object.keys(record).sort().join(",") !== "frequency,plan,priceId,productId" ||
      typeof record.priceId !== "string" ||
      !/^price_[A-Za-z0-9_]+$/.test(record.priceId) ||
      typeof record.productId !== "string" ||
      !/^prod_[A-Za-z0-9_]+$/.test(record.productId) ||
      (record.plan !== "premium" && record.plan !== "premium_plus") ||
      (record.frequency !== "monthly" && record.frequency !== "yearly")
    )
      throw invalid();
    return {
      priceId: record.priceId,
      productId: record.productId,
      plan: record.plan,
      frequency: record.frequency,
      historical: true,
    };
  });
}
