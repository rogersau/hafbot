import {
  browserPrivacySignalEnabled,
  createInsertionId,
  type ProductAnalyticsEvent,
  type ProductAnalyticsReporter,
} from "../product-analytics";

interface PublicAnalyticsOptions {
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const UTM_SOURCES = new Set(["discord", "github", "google", "reddit", "youtube"]);
const UTM_MEDIA = new Set(["community", "email", "organic", "referral", "social"]);
const UTM_CAMPAIGNS = new Set(["launch", "premium", "product_update"]);

export function reportPublicPageView(
  options: PublicAnalyticsOptions,
  request: Request,
  path: Extract<ProductAnalyticsEvent, { name: "public_page_viewed" }>["path"],
): void {
  if (request.method !== "GET" || browserPrivacySignalEnabled(request)) return;
  const userAgent = request.headers.get("user-agent") ?? "";
  if (/bot|crawler|spider|slurp|preview|headless/i.test(userAgent)) return;
  const url = new URL(request.url);
  report(options, {
    name: "public_page_viewed",
    insertionId: createInsertionId(),
    path,
    referrerDomain: readReferrerDomain(request.headers.get("referer")),
    utmSource: readCampaignValue(url.searchParams.get("utm_source"), UTM_SOURCES),
    utmMedium: readCampaignValue(url.searchParams.get("utm_medium"), UTM_MEDIA),
    utmCampaign: readCampaignValue(url.searchParams.get("utm_campaign"), UTM_CAMPAIGNS),
    deviceClass: readDeviceClass(userAgent),
    browserFamily: readBrowserFamily(userAgent),
    country: readCountry(request.headers.get("cf-ipcountry")),
  });
}

export function report(options: PublicAnalyticsOptions, event: ProductAnalyticsEvent): void {
  if (!options.productAnalytics) return;
  try {
    const promise = options.productAnalytics.report(event).catch(() => undefined);
    if (options.waitUntil) options.waitUntil(promise);
  } catch {}
}

function readReferrerDomain(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname.length <= 253 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function readCampaignValue(value: string | null, allowed: ReadonlySet<string>): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && allowed.has(normalized) ? normalized : undefined;
}

function readCountry(value: string | null): string | undefined {
  const normalized = value?.toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function readDeviceClass(userAgent: string): "mobile" | "tablet" | "desktop" {
  if (/ipad|tablet/i.test(userAgent)) return "tablet";
  return /mobile|iphone|android/i.test(userAgent) ? "mobile" : "desktop";
}

function readBrowserFamily(userAgent: string): "chrome" | "firefox" | "safari" | "edge" | "other" {
  if (/edg\//i.test(userAgent)) return "edge";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
}
