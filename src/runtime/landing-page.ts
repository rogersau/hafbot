import type { LandingPrice, LandingPriceCatalog } from "./billing/landing-catalog";
import { LANDING_HTML } from "./landing-bundle";

export async function renderLandingPage(catalog?: LandingPriceCatalog): Promise<string> {
  const prices = await readLandingPrices(catalog);
  const offers = [
    { "@type": "Offer", name: "Free", price: "0.00", priceCurrency: "AUD" },
    ...prices.map((price) => ({
      "@type": "Offer",
      name: `${planName(price.plan)} ${price.frequency}`,
      price: price.decimalAmount,
      priceCurrency: price.currency.toUpperCase(),
    })),
  ];
  const structuredData = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": "https://hafbot.xyz/#application",
        name: "HAF Bot",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Discord",
        description:
          "A Discord bot for gaming communities with private support tickets, player account linking, LFG, moderation and a web dashboard. Use hosted HAF or self-host with Docker.",
        url: "https://hafbot.xyz/",
        offers,
      },
      {
        "@type": "FAQPage",
        mainEntity: [
          question(
            "What is HAF Bot?",
            "HAF Bot is a Discord bot for gaming communities. It combines private support tickets, player account linking, LFG, Marketplace, Suggestions, moderation and audit logs with a web dashboard for staff.",
          ),
          question(
            "Can I self-host HAF Bot?",
            "Yes. Run your own Discord application with Docker, PostgreSQL and private object storage, with optional Cloudflare Tunnel ingress. You manage hosting, credentials, backups and updates. The MIT-licensed source is available at github.com/rogersau/hafbot. The initial source release documents its live-installation testing limits. Self-hosted mode includes all core features with your own external services; resource and safety limits still apply. Read the self-hosting guide.",
          ),
          question(
            "What happens if I cancel?",
            "You keep paid features until the cancellation date shown in Billing. After that, saved configuration remains, paid-only processing stops and Free limits apply. HAF does not replay activity missed while paid features were inactive.",
          ),
          question(
            "How are payments handled?",
            "Stripe handles checkout, invoices, and payment methods. HAF never stores your full card details.",
          ),
        ],
      },
    ],
  }).replaceAll("<", "\\u003c");
  const fallback = '<p class="price-fallback">View current price in Billing</p>';
  const premiumPrices = renderPlanPrices(prices, "premium") || fallback;
  const premiumPlusPrices = renderPlanPrices(prices, "premium_plus") || fallback;
  let pricingNote = "Log in to Billing to see the current paid prices.";
  if (prices.length > 0) {
    pricingNote = "Standard subscription prices. Prices come straight from Stripe.";
  }
  return LANDING_HTML.replace("{{STRUCTURED_DATA}}", structuredData)
    .replace("{{PREMIUM_PRICES}}", premiumPrices)
    .replace("{{PREMIUM_PLUS_PRICES}}", premiumPlusPrices)
    .replace("{{PRICING_NOTE}}", pricingNote);
}

async function readLandingPrices(
  catalog: LandingPriceCatalog | undefined,
): Promise<readonly LandingPrice[]> {
  if (!catalog) return [];
  try {
    return (await catalog.read()) ?? [];
  } catch (error) {
    console.error("Landing Price catalogue could not be read", error);
    return [];
  }
}

function renderPlanPrices(prices: readonly LandingPrice[], plan: LandingPrice["plan"]): string {
  return prices
    .filter((price) => price.plan === plan)
    .sort((left, right) =>
      left.frequency === "monthly" ? -1 : right.frequency === "monthly" ? 1 : 0,
    )
    .map((price) => {
      const currency = price.currency.toUpperCase();
      const interval = price.frequency === "monthly" ? "month" : "year";
      return `<p class="stripe-price"><strong>${price.formattedAmount}</strong><span>${currency} / ${interval}</span></p>`;
    })
    .join("");
}

function planName(plan: LandingPrice["plan"]): string {
  return plan === "premium" ? "Premium" : "Premium Plus";
}

function question(name: string, text: string) {
  return { "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } };
}
