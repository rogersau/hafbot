import { createFileRoute } from "@tanstack/react-router";
import { CHANGELOG_FEED_LINK } from "../../landing/changelog-feed";
import { landingCommunity } from "../../landing/community";
import { landingStructuredData } from "../../landing/home-content";
import { LandingHomePage } from "../../landing/home-page";
import { getLandingPrices } from "../../landing/landing-prices";
import { publicPageMiddleware } from "../../landing/public-page-middleware";
import ticketsDashboard from "../../../docs-site/public/images/generated/admin-tickets.png";
import stylesheet from "../../landing/styles.css?url";

const TITLE = "HAF Bot | Discord tickets, player links & community tools";
const SOCIAL_DESCRIPTION =
  "Private support tickets, player links, LFG and moderation for gaming Discords. Start free on hosted HAF or self-host with Docker.";

export const Route = createFileRoute("/")({
  ssr: true,
  server: { middleware: [publicPageMiddleware("/")] },
  loader: () => getLandingPrices(),
  head: ({ loaderData }) => ({
    meta: [
      { title: TITLE },
      {
        name: "description",
        content:
          "A Discord bot for gaming communities: tickets, player links, LFG, moderation and a web dashboard. Use hosted HAF or self-host with Docker.",
      },
      { name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: SOCIAL_DESCRIPTION },
      { property: "og:url", content: "https://hafbot.xyz/" },
      { property: "og:image", content: "https://hafbot.xyz/banner.png" },
      { property: "og:image:alt", content: "HAF Bot (Helpful as F**K)" },
      { property: "og:site_name", content: "HAF Bot" },
      { property: "og:locale", content: "en_AU" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: SOCIAL_DESCRIPTION },
      { name: "twitter:image", content: "https://hafbot.xyz/banner.png" },
    ],
    links: [
      { rel: "canonical", href: "https://hafbot.xyz/" },
      CHANGELOG_FEED_LINK,
      { rel: "stylesheet", href: stylesheet },
    ],
    scripts: [
      {
        id: "landing-structured-data",
        type: "application/ld+json",
        children: landingStructuredData(loaderData ?? []),
      },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <LandingHomePage
      prices={Route.useLoaderData()}
      discordScreenshot={landingCommunity.discordScreenshot}
      dashboardScreenshot={landingCommunity.dashboardScreenshot ?? ticketsDashboard}
    />
  );
}
