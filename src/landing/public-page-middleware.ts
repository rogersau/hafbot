import { createMiddleware } from "@tanstack/react-start";
import { reportPublicPageView } from "../routes/public-analytics";

export function publicPageMiddleware(path: "/" | "/changelog") {
  return createMiddleware().server(async ({ context, request, next }) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Not found", { status: 404 });
    }

    const site = context?.selfHostedSite;
    if (site) {
      const location =
        path === "/"
          ? new URL("/admin", site.publicUrl ?? request.url).href
          : "https://github.com/rogersau/hafbot/releases";
      return new Response(null, {
        status: 302,
        headers: { location, "cache-control": "no-store" },
      });
    }

    const result = await next();
    if (result.response.ok && context) reportPublicPageView(context, request, path);
    return result;
  });
}
