import type { BillingCatalogEntry, FounderAdmission } from "./types";

export interface LandingPrice {
  plan: BillingCatalogEntry["plan"];
  frequency: BillingCatalogEntry["frequency"];
  unitAmount: number;
  currency: string;
  decimalAmount: string;
  formattedAmount: string;
}

export interface LandingPriceCatalog {
  read(): Promise<readonly LandingPrice[] | null>;
  readFounderAdmission?(): Promise<FounderAdmission>;
}

export interface StripeDisplayPrice {
  id: string;
  productId: string;
  active: boolean;
  unitAmount: number;
  currency: string;
  interval: "month" | "year";
}

export interface StripeDisplayPriceReader {
  readPrice(priceId: string): Promise<StripeDisplayPrice>;
}

interface CachedLandingPrices {
  readAtMs: number;
  prices: readonly LandingPrice[];
}

const sharedCache = new Map<string, CachedLandingPrices>();

export function createLandingPriceCatalog(options: {
  catalog: ReadonlyMap<string, BillingCatalogEntry>;
  stripe: StripeDisplayPriceReader;
  now?: () => number;
  freshForMs?: number;
  staleForMs?: number;
  cache?: Map<string, CachedLandingPrices>;
  onError?: (message: string, error: unknown) => void;
  countFounderPlaces?: () => Promise<number>;
}): LandingPriceCatalog {
  const now = options.now ?? Date.now;
  const freshForMs = options.freshForMs ?? 15 * 60 * 1_000;
  const staleForMs = options.staleForMs ?? 24 * 60 * 60 * 1_000;
  const cache = options.cache ?? sharedCache;
  const onError = options.onError ?? console.error;
  const catalogKey = [...options.catalog.values()]
    .sort((left, right) => left.priceId.localeCompare(right.priceId))
    .map(
      (entry) =>
        `${entry.priceId}:${entry.productId}:${entry.plan}:${entry.frequency}:${entry.cohort}`,
    )
    .join("|");

  async function admission(): Promise<FounderAdmission> {
    const historicalCount = Math.max(
      0,
      await (options.countFounderPlaces?.() ?? Promise.resolve(50)),
    );
    return {
      historicalCount,
      publicCount: Math.min(historicalCount, 50),
      limit: 50,
      open: historicalCount < 50,
    };
  }

  return {
    readFounderAdmission: admission,
    async read() {
      const founderAdmission = await admission();
      const cohort = founderAdmission.open ? "founder" : "standard";
      const selectedCatalog = new Map(
        [...options.catalog].filter(
          ([, entry]) => entry.cohort === cohort && entry.legacy !== true,
        ),
      );
      const cacheKey = `${catalogKey}:${cohort}`;
      const cached = cache.get(cacheKey);
      const ageMs = cached ? now() - cached.readAtMs : Number.POSITIVE_INFINITY;
      if (cached && ageMs <= freshForMs) return cached.prices;

      try {
        const prices = await readCompleteCatalog(selectedCatalog, options.stripe);
        cache.set(cacheKey, { readAtMs: now(), prices });
        return prices;
      } catch (error) {
        if (cached && ageMs <= staleForMs) return cached.prices;
        onError("Stripe landing Price catalogue is unavailable", error);
        return null;
      }
    },
  };
}

async function readCompleteCatalog(
  catalog: ReadonlyMap<string, BillingCatalogEntry>,
  stripe: StripeDisplayPriceReader,
): Promise<readonly LandingPrice[]> {
  const entries = [...catalog.values()];
  const values = await Promise.all(
    entries.map(async (entry): Promise<LandingPrice> => {
      const price = await stripe.readPrice(entry.priceId);
      const expectedInterval = entry.frequency === "monthly" ? "month" : "year";
      if (
        price.id !== entry.priceId ||
        price.productId !== entry.productId ||
        !price.active ||
        !Number.isSafeInteger(price.unitAmount) ||
        price.unitAmount < 0 ||
        !/^[a-z]{3}$/i.test(price.currency) ||
        price.interval !== expectedInterval
      ) {
        throw new Error(
          `Stripe Price ${entry.priceId} does not match the approved Billing catalogue.`,
        );
      }
      return {
        plan: entry.plan,
        frequency: entry.frequency,
        unitAmount: price.unitAmount,
        currency: price.currency.toLowerCase(),
        ...formatAmount(price.unitAmount, price.currency),
      };
    }),
  );
  if (values.length !== 4) {
    throw new Error("The landing Price catalogue requires all four approved Stripe Prices.");
  }
  return values;
}

function formatAmount(
  unitAmount: number,
  currency: string,
): Pick<LandingPrice, "decimalAmount" | "formattedAmount"> {
  const formatter = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const majorAmount = unitAmount / 10 ** fractionDigits;
  return {
    decimalAmount: majorAmount.toFixed(fractionDigits),
    formattedAmount: formatter.format(majorAmount),
  };
}
