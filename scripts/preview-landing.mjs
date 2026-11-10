import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const root = process.cwd();
const routes = new Map([
  ["/landing/assets/landing.css", "dist-landing/landing.css"],
  ["/landing/assets/home.js", "dist-landing/home.js"],
  ["/landing/assets/changelog.js", "dist-landing/changelog.js"],
  ["/logo.png", "assets/logo.png"],
  ["/favicon.ico", "assets/favicon.ico"],
  ["/banner.png", "assets/banner.png"],
]);

const homeHtml = (await readFile(resolve(root, "src/landing/home.html"), "utf8"))
  .replace("{{STRUCTURED_DATA}}", "{}")
  .replace("{{PREMIUM_PRICES}}", '<p class="price-fallback">View current price in Billing</p>')
  .replace("{{PREMIUM_PLUS_PRICES}}", '<p class="price-fallback">View current price in Billing</p>')
  .replace(
    "{{PRICING_NOTE}}",
    "Local preview uses the production fallback because Stripe is not connected.",
  );
const changelogHtml = await readFile(resolve(root, "src/landing/changelog.html"), "utf8");

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(homeHtml);
    return;
  }
  if (pathname === "/changelog") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(changelogHtml);
    return;
  }

  const relativePath = routes.get(pathname);
  if (!relativePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const body = await readFile(resolve(root, relativePath));
    const headers = { "content-type": contentType(relativePath) };
    if (pathname === "/logo.png") {
      headers["cache-control"] = "public, max-age=86400, stale-while-revalidate=604800";
    }
    response.writeHead(200, headers);
    response.end(body);
  } catch (error) {
    console.error(`Could not serve ${relativePath}`, error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Preview asset unavailable");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Landing page preview: http://localhost:${port}/`);
  console.log("Press Ctrl+C to stop.");
});

function contentType(path) {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}
