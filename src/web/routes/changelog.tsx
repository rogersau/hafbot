import { createFileRoute } from "@tanstack/react-router";
import { CHANGELOG_FEED_LINK } from "../../landing/changelog-feed";
import { ChangelogPage } from "../../landing/changelog-page";
import { publicPageMiddleware } from "../../landing/public-page-middleware";
import stylesheet from "../../landing/styles.css?url";

export const Route = createFileRoute("/changelog")({
  ssr: true,
  server: { middleware: [publicPageMiddleware("/changelog")] },
  head: () => ({
    meta: [
      { title: "HAF Bot changelog" },
      { name: "description", content: "Product updates and release notes for HAF Bot." },
      { name: "robots", content: "index, follow" },
    ],
    links: [
      { rel: "canonical", href: "https://hafbot.xyz/changelog" },
      CHANGELOG_FEED_LINK,
      { rel: "stylesheet", href: stylesheet },
    ],
  }),
  component: ChangelogPage,
});
