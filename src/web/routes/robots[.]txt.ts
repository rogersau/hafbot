import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      ANY: () => new Response("Not found", { status: 404 }),
      GET: () =>
        new Response("User-agent: *\nAllow: /\nSitemap: https://hafbot.xyz/sitemap.xml\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
