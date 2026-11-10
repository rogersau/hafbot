import { isRecord } from "../unknown-parse";
import {
  READ_ROUTES,
  WARDOGS_POLICY,
  WardogsError,
  type ApprovedOrigin,
  type ReadOperation,
  type ReadResults,
} from "./model";

// No DNS preflight is presented as pinning. Only operator-owned fixed public DNS
// endpoints with runtime-specific secure-path evidence can pass this boundary.
export function approvedOrigin(entry: ApprovedOrigin): string {
  const raw = entry.origin;
  if (!entry.securePathEvidence.trim() || !/^https:\/\/[a-zA-Z0-9.-]+(?::443)?\/?$/.test(raw))
    throw new WardogsError("unapproved_target");
  const url = new URL(raw);
  const host = url.hostname;
  if (
    url.port ||
    host.length > 253 ||
    !host.includes(".") ||
    host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    host === "metadata.google.internal"
  )
    throw new WardogsError("unapproved_target");
  return url.origin;
}
export function validateSecret(secret: string): void {
  if (
    secret.length < 1 ||
    secret.length > 1024 ||
    /[^\x20-\x7e]/.test(secret) ||
    secret.trim() !== secret
  ) {
    throw new WardogsError("invalid_response");
  }
}
export type ReadTransport = (url: string, init: RequestInit) => Promise<Response>;

export async function readWdrcon<K extends ReadOperation>(input: {
  origin: ApprovedOrigin;
  secret: string;
  operation: K;
  transport?: ReadTransport;
  now?: () => number;
}): Promise<ReadResults[K]> {
  return decode(
    input.operation,
    await requestWdrcon({ ...input, request: { kind: "read", operation: input.operation } }),
  );
}

export type AccessRequest =
  | { kind: "reserved-list" }
  | { kind: "reserved-capabilities" }
  | { kind: "reserved-mutation"; action: "grant" | "remove"; steamId: string };

export type BanRequest =
  | { kind: "bans" }
  | { kind: "ban-capabilities" }
  | { kind: "mutation"; action: "ban" | "unban"; steamId: string; reason: string };
export async function requestWdrcon(input: {
  origin: ApprovedOrigin;
  secret: string;
  request: BanRequest | AccessRequest | { kind: "read"; operation: ReadOperation };
  reservedAccessEnabled?: boolean;
  mutationsEnabled?: boolean;
  targetOptIn?: boolean;
  transport?: ReadTransport;
  now?: () => number;
}): Promise<unknown> {
  const origin = approvedOrigin(input.origin);
  validateSecret(input.secret);
  const request = input.request;
  let path: string;
  let method = "GET";
  let requestBody: string | undefined;
  if (request.kind === "mutation") {
    if (!input.mutationsEnabled || !input.targetOptIn) throw new WardogsError("disabled");
    if (
      !/^7656119\d{10}$/.test(request.steamId) ||
      !request.reason.trim() ||
      request.reason.length > 500 ||
      !["ban", "unban"].includes(request.action)
    )
      throw new WardogsError("invalid_response");
    method = request.action === "ban" ? "POST" : "DELETE";
    path =
      request.action === "ban" ? "/v1/bans" : `/v1/bans/${encodeURIComponent(request.steamId)}`;
    if (request.action === "ban")
      requestBody = JSON.stringify({ steamId: request.steamId, reason: request.reason });
  } else if (request.kind === "bans") path = "/v1/bans";
  else if (request.kind === "ban-capabilities") path = "/v1/capabilities";
  else if (request.kind !== "read") {
    if (!input.reservedAccessEnabled || !input.targetOptIn) throw new WardogsError("disabled");
    if (request.kind === "reserved-capabilities") path = "/v1/capabilities";
    else if (request.kind === "reserved-list") path = "/v1/reserved-slots";
    else if (request.kind === "reserved-mutation") {
      if (!input.mutationsEnabled) throw new WardogsError("disabled");
      if (!/^7656119\d{10}$/.test(request.steamId) || !["grant", "remove"].includes(request.action))
        throw new WardogsError("invalid_response");
      method = request.action === "grant" ? "POST" : "DELETE";
      path =
        request.action === "grant"
          ? "/v1/reserved-slots"
          : `/v1/reserved-slots/${encodeURIComponent(request.steamId)}`;
      if (request.action === "grant") requestBody = JSON.stringify({ steamId: request.steamId });
    } else throw new WardogsError("unsupported_operation");
  } else {
    if (!Object.hasOwn(READ_ROUTES, request.operation))
      throw new WardogsError("unsupported_operation");
    path = READ_ROUTES[request.operation];
  }
  const controller = new AbortController();
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener("abort", () => reject(new WardogsError("timeout")), {
      once: true,
    }),
  );
  // Both fetch and body reads are bounded even if a transport ignores abort.
  const timer = setTimeout(() => controller.abort(), WARDOGS_POLICY.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([
      (input.transport ?? fetch)(origin + path, {
        method,
        body: requestBody,
        headers: {
          Authorization: `Bearer ${input.secret}`,
          Accept: "application/json",
          ...(requestBody ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "manual",
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (response.status >= 300 && response.status < 400)
      throw new WardogsError("unapproved_target");
    if (response.status === 401) throw new WardogsError("authentication_failed");
    if (response.status === 403) throw new WardogsError("forbidden");
    if (response.status === 404 || response.status === 405)
      throw new WardogsError("unsupported_operation");
    if (response.status === 429) {
      const now = input.now?.() ?? Date.now();
      const value = response.headers.get("retry-after") ?? "";
      const retry = /^\d+$/.test(value)
        ? now + Number(value) * 1000
        : HTTP_DATE.test(value)
          ? Date.parse(value)
          : NaN;
      throw new WardogsError(
        "rate_limited",
        Number.isSafeInteger(retry) && retry > now ? retry : now + 60_000,
      );
    }
    if (response.status >= 500) throw new WardogsError("provider_unavailable");
    if (request.kind === "reserved-mutation" && response.ok) {
      await Promise.race([response.body?.cancel() ?? Promise.resolve(), aborted]);
      return null;
    }
    if (request.kind === "mutation" && response.ok) {
      // Accepted/queued responses cannot establish that a command finished applying.
      if (response.status !== 200 && response.status !== 204)
        throw new WardogsError("provider_unavailable");
      // Acknowledgement content is irrelevant: only a fresh complete-list read proves state.
      await Promise.race([response.body?.cancel() ?? Promise.resolve(), aborted]);
      return null;
    }
    if (
      request.kind === "bans" &&
      (response.status !== 200 ||
        ["link", "content-range", "x-next-page", "x-next-cursor", "x-pagination"].some((header) =>
          response.headers.has(header),
        ))
    )
      throw new WardogsError("invalid_response");
    if (!response.ok || !response.body) throw new WardogsError("invalid_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > WARDOGS_POLICY.maxResponseBytes) throw new WardogsError("oversized_response");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      throw new WardogsError("invalid_response");
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new WardogsError("timeout");
    if (error instanceof WardogsError) throw error;
    const code = isRecord(error) ? error.code : undefined;
    if (typeof code === "string" && /CERT|TLS|SSL/i.test(code)) throw new WardogsError("tls_error");
    throw new WardogsError("unreachable");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      try {
        await Promise.race([reader.cancel(), Promise.resolve()]);
      } catch {
        /* No provider errors escape. */
      }
    }
  }
}

function decode<K extends ReadOperation>(operation: K, body: unknown): ReadResults[K] {
  const invalid = (): never => {
    throw new WardogsError("invalid_response");
  };
  if (!isRecord(body)) return invalid();
  let result: ReadResults[ReadOperation];
  if (operation === "capabilities") {
    if (
      !Array.isArray(body.routes) ||
      body.routes.length > WARDOGS_POLICY.maxCapabilityRoutes ||
      !body.routes.every((route) => typeof route === "string" && route.length <= 200)
    )
      return invalid();
    result = {
      routes: (Object.keys(READ_ROUTES) as ReadOperation[]).filter((key) =>
        (body.routes as string[]).includes(`GET ${READ_ROUTES[key]}`),
      ),
    };
  } else if (operation === "status") {
    if (
      !isRecord(body.players) ||
      !count(body.players.current) ||
      !count(body.players.max) ||
      body.players.max === 0
    )
      return invalid();
    for (const field of ["serverName", "map"] as const)
      if (
        body[field] !== undefined &&
        (typeof body[field] !== "string" || body[field].length > 200)
      )
        return invalid();
    if (body.matchSeconds !== undefined && !count(body.matchSeconds)) return invalid();
    result = {
      players: { current: body.players.current, max: body.players.max },
      queue: null,
      ...(typeof body.serverName === "string" ? { serverName: body.serverName } : {}),
      ...(typeof body.map === "string" ? { map: body.map } : {}),
      ...(typeof body.matchSeconds === "number" ? { matchSeconds: body.matchSeconds } : {}),
    };
  } else {
    // The supported roster contract has one players envelope. Do not erase
    // pagination, partial or truncation metadata and then admit an empty/full snapshot.
    if (
      Object.keys(body).some((key) => key !== "players") ||
      !Array.isArray(body.players) ||
      body.players.length > WARDOGS_POLICY.maxRosterRows
    )
      return invalid();
    const identities = new Set<string>();
    const players = body.players.map((row) => {
      if (
        !isRecord(row) ||
        typeof row.steamId !== "string" ||
        !/^7656119\d{10}$/.test(row.steamId) ||
        identities.has(row.steamId)
      )
        return invalid();
      identities.add(row.steamId);
      return { steamId: row.steamId };
    });
    result = { players };
  }
  return result as ReadResults[K];
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
