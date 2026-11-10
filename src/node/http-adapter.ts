import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FetchHandler } from "./static-assets";

export interface FetchRequestListenerOptions {
  handler: FetchHandler;
  maxRequestBytes?: number;
  publicOrigin?: string;
  trustProxy?: boolean;
  onError?: (error: unknown) => void;
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestTargetError extends Error {
  constructor(message = "Invalid HTTP request target.") {
    super(message);
    this.name = "InvalidRequestTargetError";
  }
}

export function createFetchRequestListener(options: FetchRequestListenerOptions): RequestListener {
  const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error("Maximum request bytes must be a positive integer.");
  }
  const publicOrigin = options.publicOrigin
    ? normalizePublicOrigin(options.publicOrigin)
    : undefined;

  return (incoming, outgoing) => {
    void handleRequest(incoming, outgoing, { ...options, maxRequestBytes, publicOrigin }).catch(
      (error) => {
        options.onError?.(error);
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        const status =
          error instanceof RequestBodyTooLargeError
            ? 413
            : error instanceof InvalidRequestTargetError
              ? 400
              : 500;
        writePlainResponse(
          outgoing,
          status,
          status === 413
            ? "Request body too large"
            : status === 400
              ? "Invalid request"
              : "Internal error",
          status === 413 ? () => incoming.destroy() : undefined,
        );
      },
    );
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: FetchRequestListenerOptions & { maxRequestBytes: number },
): Promise<void> {
  const request = toFetchRequest(incoming, options);
  const response = await options.handler(request);
  await writeFetchResponse(incoming, outgoing, response);
}

export function toFetchRequest(
  incoming: IncomingMessage,
  options: Pick<
    FetchRequestListenerOptions,
    "maxRequestBytes" | "publicOrigin" | "trustProxy"
  > = {},
): Request {
  const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  const contentLength = readContentLength(incoming.headers["content-length"]);
  if (contentLength !== null && contentLength > maxRequestBytes) {
    throw new RequestBodyTooLargeError(maxRequestBytes);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const origin = options.publicOrigin ?? readRequestOrigin(incoming, options.trustProxy ?? false);
  const target = incoming.url ?? "/";
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    [...target].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new InvalidRequestTargetError();
  }
  const url = new URL(target, origin);
  const method = incoming.method?.toUpperCase() ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = createBoundedRequestBody(incoming, maxRequestBytes);
    init.duplex = "half";
  }
  return new Request(url, init);
}

export async function writeFetchResponse(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies = getSetCookie?.call(response.headers) ?? [];
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);

  const method = incoming.method?.toUpperCase() ?? "GET";
  if (method === "HEAD" || !response.body || response.status === 204 || response.status === 304) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }

  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  try {
    await pipeline(body, outgoing);
  } catch (error) {
    if (!outgoing.destroyed) throw error;
  }
}

function createBoundedRequestBody(
  incoming: IncomingMessage,
  maxRequestBytes: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  const source = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxRequestBytes) {
          controller.error(new RequestBodyTooLargeError(maxRequestBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function readRequestOrigin(incoming: IncomingMessage, trustProxy: boolean): string {
  const forwardedProtocol = trustProxy ? firstHeader(incoming.headers["x-forwarded-proto"]) : null;
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http" ? forwardedProtocol : "http";
  const forwardedHost = trustProxy ? firstHeader(incoming.headers["x-forwarded-host"]) : null;
  const host = forwardedHost ?? firstHeader(incoming.headers.host) ?? "127.0.0.1";
  try {
    return normalizePublicOrigin(`${protocol}://${host}`);
  } catch {
    throw new InvalidRequestTargetError("Invalid HTTP Host header.");
  }
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("publicOrigin must be an HTTP(S) origin without credentials or a path.");
  }
  return url.origin;
}

function firstHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(",", 1)[0]?.trim();
  return first || null;
}

function readContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error("Invalid Content-Length header.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid Content-Length header.");
  return parsed;
}

function writePlainResponse(
  outgoing: ServerResponse,
  status: number,
  message: string,
  afterWrite?: () => void,
): void {
  outgoing.statusCode = status;
  outgoing.setHeader("content-type", "text/plain; charset=utf-8");
  outgoing.setHeader("cache-control", "no-store");
  if (afterWrite) outgoing.setHeader("connection", "close");
  outgoing.end(message, afterWrite);
}
