import type { PublicLandingPrice } from "./landing-prices";

interface LandingQuestion {
  question: string;
  answer: string;
  guide?: { href: string; text: string };
}

export const LANDING_FAQ: readonly LandingQuestion[] = [
  {
    question: "What is HAF Bot?",
    answer:
      "HAF Bot is a Discord bot for gaming communities. It combines private support tickets, player account linking, LFG, Marketplace, Suggestions, moderation and audit logs with a web dashboard for staff.",
  },
  {
    question: "Can I self-host HAF Bot?",
    answer:
      "Yes. Run your own Discord application with Docker, PostgreSQL and private object storage, with optional Cloudflare Tunnel ingress. You manage hosting, credentials, backups and updates. The MIT-licensed source is available at github.com/rogersau/hafbot. The initial source release documents its live-installation testing limits. Self-hosted mode includes all core features with your own external services; resource and safety limits still apply.",
    guide: { href: "https://docs.hafbot.xyz/self-hosting", text: "Read the self-hosting guide" },
  },
  {
    question: "What happens if I cancel?",
    answer:
      "You keep paid features until the cancellation date shown in Billing. After that, saved configuration remains, paid-only processing stops and Free limits apply. HAF does not replay activity missed while paid features were inactive.",
  },
  {
    question: "How are payments handled?",
    answer:
      "Stripe handles checkout, invoices, and payment methods. HAF never stores your full card details.",
  },
];

export function landingStructuredData(prices: readonly PublicLandingPrice[]) {
  return JSON.stringify({
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
        offers: [
          { "@type": "Offer", name: "Free", price: "0.00", priceCurrency: "AUD" },
          ...prices.map((price) => ({
            "@type": "Offer",
            name: `${price.plan === "premium" ? "Premium" : "Premium Plus"} ${price.frequency}`,
            price: price.decimalAmount,
            priceCurrency: price.currency.toUpperCase(),
          })),
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: LANDING_FAQ.map(({ question, answer, guide }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: guide ? `${answer} ${guide.text}.` : answer,
          },
        })),
      },
    ],
  }).replaceAll("<", "\\u003c");
}
