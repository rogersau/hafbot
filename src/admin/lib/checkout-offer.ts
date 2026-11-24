import type { LandingPrice } from "../../runtime/billing/landing-catalog";

type CheckoutOffer = Pick<LandingPrice, "plan" | "frequency" | "currency" | "formattedAmount">;

export function formatCheckoutOffer(price: CheckoutOffer): string {
  return `${price.formattedAmount} ${price.currency.toUpperCase()} / ${price.frequency === "monthly" ? "month" : "year"}`;
}

export function formatCheckoutAssignment(plan: CheckoutOffer["plan"]): string {
  const servers =
    plan === "premium_plus"
      ? "up to three eligible Discord servers"
      : "one eligible Discord server";
  return `After purchase, choose ${servers} in Billing to receive paid features. Buying a plan does not upgrade all your servers.`;
}

export function readCheckoutIntent(next: string | null | undefined): {
  plan: "premium" | "premium_plus";
  planLabel: "Premium" | "Premium Plus";
  frequency: "monthly" | "yearly";
} | null {
  if (!next?.startsWith("/") || next.startsWith("//")) return null;
  const base = "https://admin.hafbot.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return null;
  }
  if (url.origin !== base || url.pathname !== "/admin/billing") {
    return null;
  }
  const plan = url.searchParams.get("plan");
  if (plan !== "premium" && plan !== "premium_plus") return null;
  const frequency = url.searchParams.get("frequency") === "monthly" ? "monthly" : "yearly";
  return {
    plan,
    planLabel: plan === "premium_plus" ? "Premium Plus" : "Premium",
    frequency,
  };
}
