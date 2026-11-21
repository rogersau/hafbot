import { createFileRoute } from "@tanstack/react-router";
import changelog from "../../../changelog.json";
import { renderChangelogFeed } from "../../landing/changelog-feed";

const FEED = renderChangelogFeed(changelog);

export const Route = createFileRoute("/changelog.xml")({
  server: {
    handlers: {
      ANY: () => new Response("Not found", { status: 404 }),
      GET: ({ request }) =>
        new Response(request.method === "HEAD" ? null : FEED, {
          headers: {
            "content-type": "application/atom+xml; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          },
        }),
    },
  },
});
