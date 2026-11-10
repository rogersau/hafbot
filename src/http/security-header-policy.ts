export type HtmlPolicyProfile =
  | "admin"
  | "commerce"
  | "platform-link-result"
  | "member-verification"
  | "transcript"
  | "sensitive-media-document"
  | "landing"
  | "legal";

type Directives = Record<string, readonly string[]>;

export interface ContentSecurityPolicyOptions {
  styleNonce?: string;
}

const COMMON: Directives = {
  "base-uri": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
};

const PROFILES: Record<HtmlPolicyProfile, Directives> = {
  admin: {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "style-src-attr": ["'unsafe-inline'"],
    "font-src": ["'self'"],
    "img-src": [
      "'self'",
      "data:",
      "https://cdn.discordapp.com",
      "https://cdn.jsdelivr.net",
      "https://media.discordapp.net",
    ],
    "connect-src": ["'self'"],
    "form-action": ["'self'"],
    "worker-src": ["'none'"],
    "frame-src": ["'none'"],
    "media-src": ["'self'", "https://cdn.discordapp.com", "https://media.discordapp.net"],
  },
  commerce: {
    "default-src": ["'none'"],
    "style-src": ["'unsafe-inline'"],
    // Guild icons are constructed from trusted Discord metadata and further
    // constrained to the deterministic CDN guild-icon path by the renderer.
    "img-src": ["'self'", "data:", "https://cdn.discordapp.com"],
    // Forms post to HAF Bot, then 303 navigation continues to the specific
    // Stripe-hosted Checkout or Billing Portal surface.
    // CSP evaluates the full form-submission redirect chain.
    "form-action": ["'self'", "https://checkout.stripe.com", "https://billing.stripe.com"],
    "connect-src": ["'none'"],
    "script-src": ["'none'"],
    "frame-src": ["'none'"],
  },
  "platform-link-result": {
    "default-src": ["'none'"],
    "style-src": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:", "https://cdn.cloudflare.steamstatic.com"],
    "form-action": ["'none'"],
    "connect-src": ["'none'"],
    "script-src": ["'none'"],
    "frame-src": ["'none'"],
  },
  "member-verification": {
    "default-src": ["'none'"],
    "script-src": ["https://challenges.cloudflare.com"],
    "frame-src": ["https://challenges.cloudflare.com"],
    "connect-src": ["https://challenges.cloudflare.com"],
    "style-src": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "form-action": ["'self'"],
  },
  transcript: {
    "default-src": ["'none'"],
    "img-src": ["'self'", "data:", "https://cdn.discordapp.com", "https://media.discordapp.net"],
    "media-src": ["'self'", "https://cdn.discordapp.com", "https://media.discordapp.net"],
    "style-src": ["'unsafe-inline'"],
    "form-action": ["'none'"],
    "connect-src": ["'none'"],
    "script-src": ["'none'"],
    "frame-src": ["'none'"],
  },
  "sensitive-media-document": {
    "default-src": ["'none'"],
    "img-src": ["'self'", "data:", "https://cdn.discordapp.com", "https://media.discordapp.net"],
    "media-src": ["'self'", "https://cdn.discordapp.com", "https://media.discordapp.net"],
    "style-src": ["'unsafe-inline'"],
    "form-action": ["'none'"],
    "connect-src": ["'none'"],
    "script-src": ["'none'"],
    "frame-src": ["'none'"],
  },
  landing: {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'"],
    "img-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "form-action": ["'self'"],
    "frame-src": ["'none'"],
    "worker-src": ["'none'"],
  },
  legal: {
    "default-src": ["'none'"],
    "style-src": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "form-action": ["'none'"],
    "connect-src": ["'none'"],
    "script-src": ["'none'"],
    "frame-src": ["'none'"],
  },
};

export function contentSecurityPolicy(
  profile: HtmlPolicyProfile,
  options: ContentSecurityPolicyOptions = {},
): string {
  const directives: Directives = { ...COMMON, ...PROFILES[profile] };
  if (options.styleNonce) {
    directives["style-src"] = [...(directives["style-src"] ?? []), `'nonce-${options.styleNonce}'`];
  }
  return Object.entries(directives)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => `${name} ${[...values].sort().join(" ")}`)
    .join("; ");
}

export function isCanonicalProductionHttps(url?: URL): boolean {
  return url?.protocol === "https:" && url.hostname === "hafbot.xyz";
}
