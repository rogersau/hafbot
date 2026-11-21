import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const assetRoot = new URL("../../dist-admin/", import.meta.url);
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export async function serveAdmin({
  userProfile = { name: "Fictional Admin", email: "qa@example.invalid" },
} = {}) {
  await access(new URL(".vite/manifest.json", assetRoot));
  const { default: start } = await import("../../dist/server/server.js");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${server.address().port}`);
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
        ["/favicon.ico", "/logo.png", "/banner.png"].includes(url.pathname)
      ) {
        const file = fileURLToPath(new URL(`.${url.pathname}`, assetRoot));
        if (!file.startsWith(fileURLToPath(assetRoot)) || file.endsWith(sep)) {
          response.writeHead(403).end();
          return;
        }
        const bytes = await readFile(file).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!bytes) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
          .end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        const rendered = await start.fetch(
          new Request(url, { method: request.method, headers: request.headers }),
          {
            context: {
              admin: {
                authenticated: true,
                userProfile,
                playstationLinkEnabled: true,
                workerVersion: "",
              },
              nonce: randomBytes(16).toString("base64"),
            },
          },
        );
        response.writeHead(rendered.status, Object.fromEntries(rendered.headers));
        if (rendered.body && request.method !== "HEAD") {
          await pipeline(Readable.fromWeb(rendered.body), response);
        } else {
          response.end();
          await rendered.body?.cancel();
        }
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else response.writeHead(500).end("Admin fixture server failed to handle the request");
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
