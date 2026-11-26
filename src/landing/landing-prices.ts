import { createServerFn } from "@tanstack/react-start";
import type { LandingPrice } from "../runtime/billing/landing-catalog";

export type PublicLandingPrice = Pick<
  LandingPrice,
  "plan" | "frequency" | "currency" | "decimalAmount" | "formattedAmount"
>;

export const getLandingPrices = createServerFn().handler(async ({ context }) => {
  if (context?.selfHostedSite) return [];
  try {
    const prices = await context?.landingPriceCatalog?.read();
    return (
      prices?.map(({ plan, frequency, currency, decimalAmount, formattedAmount }) => ({
        plan,
        frequency,
        currency,
        decimalAmount,
        formattedAmount,
      })) ?? []
    );
  } catch (error) {
    console.error("Landing Price catalogue could not be read", error);
    return [];
  }
});

type LandingRates = { USD: number; EUR: number };
let cachedRates: { rates: LandingRates; expiresAt: number } | undefined;

export const getLandingExchangeRates = createServerFn().handler(async () => {
  if (cachedRates && cachedRates.expiresAt > Date.now()) return cachedRates.rates;
  try {
    const response = await fetch("https://api.frankfurter.dev/v1/latest?base=AUD&symbols=USD,EUR", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { base?: string; rates?: Partial<LandingRates> };
    const { USD, EUR } = data.rates ?? {};
    if (
      data.base !== "AUD" ||
      !USD ||
      !EUR ||
      !Number.isFinite(USD) ||
      !Number.isFinite(EUR) ||
      USD <= 0 ||
      EUR <= 0
    )
      return null;
    const rates = { USD, EUR };
    cachedRates = { rates, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    return rates;
  } catch {
    return null;
  }
});
