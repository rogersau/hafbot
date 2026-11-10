import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function serveAdmin(assetRoot) {
  assetRoot = resolve(assetRoot);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      if (url.pathname.startsWith("/admin/api/")) {
        response
          .writeHead(501, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "API request escaped the QA fixture" }));
        return;
      }
      if (
        url.pathname.startsWith("/admin/assets/") ||
        ["/favicon.ico", "/logo.png"].includes(url.pathname)
      ) {
        const file = resolve(assetRoot, `.${decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(`${assetRoot}${sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const bytes = await readFile(file);
        response
          .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
          .end(bytes);
        return;
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictional Admin QA</title><link rel="stylesheet" href="/admin/assets/admin.css"></head><body><div id="admin-root" data-authenticated="true" data-initial-path="${escapeAttribute(url.pathname)}" data-initial-search="${escapeAttribute(url.search)}" data-user-name="Fictional Admin" data-user-email="qa@example.invalid"></div><script type="module" src="/admin/assets/admin.js"></script></body></html>`,
          );
        return;
      }
      response.writeHead(404).end();
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  };
}
