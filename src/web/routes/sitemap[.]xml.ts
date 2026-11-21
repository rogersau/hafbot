import { createFileRoute } from "@tanstack/react-router";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://hafbot.xyz/</loc></url>
  <url><loc>https://hafbot.xyz/changelog</loc></url>
  <url><loc>https://hafbot.xyz/terms</loc></url>
  <url><loc>https://hafbot.xyz/privacy</loc></url>
</urlset>
`;

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      ANY: () => new Response("Not found", { status: 404 }),
      GET: () =>
        new Response(SITEMAP, { headers: { "content-type": "application/xml; charset=utf-8" } }),
    },
  },
});
