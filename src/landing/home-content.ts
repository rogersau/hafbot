import { landingCommunity } from "./community";
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
      "HAF helps you run a gaming Discord. Give players a place to find a squad, open a private ticket or link their game account. Your mods manage it all from one dashboard.",
  },
  {
    question: "Can I self-host HAF Bot?",
    answer:
      "Yes. Run the MIT-licensed Docker version on your own infrastructure. You get all the core features and manage your own Discord app, storage, backups and updates.",
    guide: { href: "https://docs.hafbot.xyz/self-hosting", text: "Read the self-hosting guide" },
  },
  {
    question: "What happens if I cancel?",
    answer:
      "You keep paid features until the date shown in Billing. Then your server goes back to Free. Your settings stay saved, Free limits apply and paid features stop processing new activity. If you resubscribe, they pick up from there.",
  },
  {
    question: "How are payments handled?",
    answer:
      "Stripe handles checkout, invoices and card details. You can manage your subscription in Billing.",
  },
  {
    question: "What Discord permissions does HAF actually need?",
    answer:
      "It depends on what you turn on. Tickets needs Manage Channels to open private channels. Verification and Timed Roles need Manage Roles, with HAF’s role above the roles it hands out. You can set up one feature at a time and review the invite’s permissions before adding HAF.",
    guide: { href: "/install", text: "Review install permissions" },
  },
  {
    question: "Can I run HAF alongside my existing bots?",
    answer:
      "Yes. Keep your current bots and give HAF one job, like Tickets or LFG. Move another job over whenever you’re ready.",
  },
  {
    question: "Which platforms does Player Link support?",
    answer:
      "Players sign in through Steam or Xbox to link those accounts. PlayStation players enter their own PSN Online ID.",
  },
  {
    question: "Can I test HAF before adding it to my live server?",
    answer:
      "Yes. Add HAF to a private test server and try tickets, LFG or verification on the Free forever plan. No card required.",
    guide: landingCommunity.demoDiscordUrl
      ? { href: landingCommunity.demoDiscordUrl, text: "Try HAF in our demo Discord" }
      : { href: "/install", text: "Add HAF to your test server" },
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
