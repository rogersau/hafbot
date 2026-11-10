import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface DynamicFirstHandlerOptions {
  dynamic: FetchHandler;
  staticRoot?: string;
}

const PUBLIC_ROOT_FILES = new Set(["/banner.png", "/favicon.ico", "/logo.png"]);
const CONTENT_TYPES: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Matches Workers static asset fallback: application routes get first refusal. */
export function createDynamicFirstHandler(options: DynamicFirstHandlerOptions): FetchHandler {
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : undefined;
  return async (request) => {
    const dynamicResponse = await options.dynamic(request);
    if (dynamicResponse.status !== 404 || !staticRoot) return dynamicResponse;
    return (await serveStaticAsset(request, staticRoot)) ?? dynamicResponse;
  };
}

export async function serveStaticAsset(
  request: Request,
  staticRoot: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const pathname = decodePathname(url.pathname);
  if (!pathname || !isPublicAssetPath(pathname)) return null;

  const root = resolve(staticRoot);
  const filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;

  let metadata;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (!metadata.isFile()) return null;

  const etag = `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    "content-length": String(metadata.size),
    "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    etag,
    "last-modified": metadata.mtime.toUTCString(),
    "x-content-type-options": "nosniff",
  });
  if (request.headers.get("if-none-match") === etag) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isPublicAssetPath(pathname: string): boolean {
  if (PUBLIC_ROOT_FILES.has(pathname)) return true;
  if (!pathname.startsWith("/admin/assets/")) return false;
  const relativePath = pathname.slice("/admin/assets/".length);
  return (
    relativePath.length > 0 &&
    !relativePath.split("/").some((part) => part === ".." || part.startsWith("."))
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
