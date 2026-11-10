import {
  contentSecurityPolicy,
  isCanonicalProductionHttps,
  type HtmlPolicyProfile,
} from "./security-header-policy";

export type { HtmlPolicyProfile } from "./security-header-policy";

export interface HtmlResponseOptions {
  profile: HtmlPolicyProfile;
  html: string;
  status?: number;
  requestUrl?: URL;
  headers?: HeadersInit;
  styleNonce?: string;
}

const PROTECTED_HEADERS = new Set([
  "cache-control",
  "content-security-policy",
  "cross-origin-opener-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
]);

const SENSITIVE = new Set<HtmlPolicyProfile>([
  "admin",
  "commerce",
  "platform-link-result",
  "member-verification",
  "transcript",
  "sensitive-media-document",
]);

export function htmlResponse(options: HtmlResponseOptions): Response {
  const additions = new Headers(options.headers);
  for (const name of PROTECTED_HEADERS) {
    if (additions.has(name)) throw new TypeError(`HTML response policy owns the ${name} header.`);
  }

  const headers = new Headers(additions);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    contentSecurityPolicy(options.profile, { styleNonce: options.styleNonce }),
  );
  headers.set("x-content-type-options", "nosniff");
  // Fetch serializes the Origin header as `null` for navigation POSTs under
  // `no-referrer`. Admin logout and commerce forms need an origin-only policy
  // so their CSRF checks can validate the origin without leaking paths or queries.
  headers.set(
    "referrer-policy",
    options.profile === "admin" || options.profile === "commerce" ? "strict-origin" : "no-referrer",
  );
  headers.set(
    "permissions-policy",
    "accelerometer=(), browsing-topics=(), camera=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "cache-control",
    SENSITIVE.has(options.profile)
      ? "private, no-store, max-age=0"
      : options.profile === "landing"
        ? "public, max-age=60, stale-while-revalidate=300"
        : "public, max-age=300",
  );
  if (SENSITIVE.has(options.profile) || options.profile === "admin") {
    headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  }
  if (isCanonicalProductionHttps(options.requestUrl)) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(options.html, { status: options.status ?? 200, headers });
}
