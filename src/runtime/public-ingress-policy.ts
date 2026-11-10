export type PublicIngressProduct = "webhook-proxy" | "ban-case";

export interface PublicIngressPolicy {
  version: 1;
  maxBytes: number;
  sourceRequestsPerMinute: number;
  sourceBurst: number;
  sourceConcurrency: number;
  globalRequestsPerMinute: number;
  globalBurst: number;
  globalConcurrency: number;
  invalidSourceRequestsPerMinute: number;
  invalidSourceBurst: number;
  invalidSourceConcurrency: number;
  invalidSourceGlobalRequestsPerMinute: number;
  invalidSourceGlobalBurst: number;
  invalidSourceGlobalConcurrency: number;
  leaseTimeoutMs: number;
  duplicateWindowMs: number;
}

const SHARED = {
  version: 1 as const,
  sourceRequestsPerMinute: 120,
  sourceBurst: 40,
  sourceConcurrency: 8,
  // Equal product partitions preserve the previous platform-wide ceiling:
  // 1,200 requests/minute, burst 200, and concurrency 100 in aggregate.
  globalRequestsPerMinute: 600,
  globalBurst: 100,
  globalConcurrency: 50,
  invalidSourceRequestsPerMinute: 60,
  invalidSourceBurst: 20,
  invalidSourceConcurrency: 5,
  invalidSourceGlobalRequestsPerMinute: 600,
  invalidSourceGlobalBurst: 100,
  invalidSourceGlobalConcurrency: 50,
  leaseTimeoutMs: 30_000,
  duplicateWindowMs: 60_000,
};

export const PUBLIC_INGRESS_POLICIES: Record<PublicIngressProduct, PublicIngressPolicy> = {
  "webhook-proxy": { ...SHARED, maxBytes: 256 * 1024 },
  "ban-case": { ...SHARED, maxBytes: 64 * 1024 },
};

export type ContentTypeResult =
  | { ok: true; canonicalMediaType: string; missing: boolean }
  | { ok: false };

export function parsePublicIngressContentType(value: string | null): ContentTypeResult {
  if (value === null || value.trim() === "")
    return { ok: true, canonicalMediaType: "application/octet-stream", missing: true };
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json")) ||
    mediaType === "text/plain" ||
    mediaType === "application/x-www-form-urlencoded"
  ) {
    return { ok: true, canonicalMediaType: mediaType, missing: false };
  }
  return { ok: false };
}
