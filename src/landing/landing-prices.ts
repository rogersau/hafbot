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
