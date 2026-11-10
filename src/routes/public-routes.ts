import {
  buildTicketTranscriptAttachmentStorageKey,
  buildTicketTranscriptStorageKey,
  hydrateTicketTranscriptHtmlAccessToken,
} from "../tickets";
import type {
  TicketTranscriptBlobStore,
  TicketTranscriptCapabilityAccess,
} from "../runtime/contracts";
import type { EvidenceVaultBlobStore, RuntimeStores } from "../runtime/app-types";
import type { FeatureFlags } from "../runtime/features";
import {
  CHANGELOG_HTML,
  CHANGELOG_FEED,
  LANDING_ASSETS,
  LLMS_TXT,
} from "../runtime/landing-bundle";
import {
  WebhookProxyNotFoundError,
  WebhookProxyServiceUnavailableError,
  type WebhookProxyService,
} from "../services/webhook-proxy-service";
import type { BanCaseService } from "../services/ban-case-service";
import {
  PRIVACY_POLICY_HTML,
  TERMS_OF_SERVICE_HTML,
  renderSelfHostedPolicyUnavailable,
} from "./legal-pages";
import type { SelfHostedSite } from "../runtime/self-hosted-site";
import type { LandingPriceCatalog } from "../runtime/billing/landing-catalog";
import { renderLandingPage } from "../runtime/landing-page";
import type { EvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "../runtime/contracts/webhook-ingress-guard";
import {
  handlePublicWebhookIngress,
  type PublicIngressResult,
} from "../runtime/public-webhook-ingress";
import { redactWebhookSecrets } from "../security/webhook-credentials";
import { htmlResponse } from "../http/html-response";
import { sensitiveBinaryResponse } from "../http/sensitive-binary-response";
import { isManagedMediaContentType, parseManagedMediaPath } from "../managed-media";
import type { PublicManagedMediaStore } from "../managed-media";
import {
  browserPrivacySignalEnabled,
  createInsertionId,
  type ProductAnalyticsEvent,
  type ProductAnalyticsReporter,
} from "../product-analytics";

export interface RouteHandler {
  (request: Request): Promise<Response | null>;
}

export interface PublicRouteOptions {
  selfHostedSite?: SelfHostedSite;
  microsoftApplicationId?: string;
  discordApplicationId?: string;
  discordInstallPermissions?: string;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  ticketTranscriptAccessGuard?: WebhookIngressGuardNamespace;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  publicManagedMedia?: PublicManagedMediaStore;
  evidenceVaultStore?: RuntimeStores["evidenceVault"];
  evidenceMediaCapability?: EvidenceMediaCapability;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  features: FeatureFlags;
  webhookProxyService?: WebhookProxyService;
  banCaseService?: BanCaseService;
  landingPriceCatalog?: LandingPriceCatalog;
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
  serverLevelIngressHandler?: (request: Request) => Promise<Response | null>;
}

const UTM_SOURCES = new Set(["discord", "github", "google", "reddit", "youtube"]);
const UTM_MEDIA = new Set(["community", "email", "organic", "referral", "social"]);
const UTM_CAMPAIGNS = new Set(["launch", "premium", "product_update"]);

const PUBLIC_WEBHOOK_METHOD_HEADERS = {
  allow: "GET, HEAD, POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers":
    "Authorization, Content-Type, X-Signature, X-Hub-Signature, X-Hub-Signature-256, X-Slack-Signature, X-Slack-Request-Timestamp, Stripe-Signature",
};

function acceptedWebhookResponse(): Response {
  return new Response(null, { status: 204, headers: PUBLIC_WEBHOOK_METHOD_HEADERS });
}

function webhookIngressFailureResponse(
  failure: Extract<PublicIngressResult, { ok: false }>,
): Response {
  if (failure.reason === "invalid_source") return acceptedWebhookResponse();
  const status =
    failure.reason === "unsupported_type"
      ? 415
      : failure.reason === "too_large"
        ? 413
        : failure.reason === "invalid_utf8"
          ? 400
          : failure.reason === "limited"
            ? 429
            : 503;
  const headers = new Headers(PUBLIC_WEBHOOK_METHOD_HEADERS);
  if (failure.reason === "limited") headers.set("retry-after", "60");
  if (failure.reason === "unavailable") headers.set("retry-after", "5");
  return new Response(null, { status, headers });
}

export function createPublicRoutes(options: PublicRouteOptions): RouteHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/webhooks/server-levels/cftools/")) {
      if (!options.serverLevelIngressHandler) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return options.serverLevelIngressHandler(request);
    }

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    if (options.selfHostedSite) {
      const site = options.selfHostedSite;
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
        return new Response(null, {
          status: 302,
          headers: {
            location: new URL("/admin", site.publicUrl ?? url.origin).href,
            "cache-control": "no-store",
          },
        });
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname === "/changelog"
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://github.com/rogersau/hafbot/releases",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname === "/terms" || url.pathname === "/privacy") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        const policy = url.pathname === "/terms" ? "terms" : "privacy";
        const target = policy === "terms" ? site.termsUrl : site.privacyUrl;
        const targetUrl = target ? new URL(target) : undefined;
        const loopsToPolicy =
          targetUrl?.origin === url.origin &&
          ["/terms", "/privacy"].includes(targetUrl.pathname.replace(/\/+$/, ""));
        if (target && !loopsToPolicy) {
          return new Response(null, {
            status: 302,
            headers: { location: target, "cache-control": "no-store" },
          });
        }
        const response = htmlResponse({
          profile: "legal",
          status: 503,
          html: renderSelfHostedPolicyUnavailable(site, policy, url.origin),
          requestUrl: url,
        });
        return request.method === "HEAD"
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      }
    }

    if (url.pathname === "/.well-known/microsoft-identity-association.json") {
      const applicationId = options.selfHostedSite
        ? options.microsoftApplicationId
        : "b8574ee2-584c-48d7-893f-9ffe940b2f97";
      if (!applicationId) return new Response("Not found", { status: 404 });
      return new Response(
        JSON.stringify({
          associatedApplications: [{ applicationId }],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    if (url.pathname === "/terms") {
      const response = htmlResponse({
        profile: "legal",
        html: TERMS_OF_SERVICE_HTML,
        requestUrl: url,
      });
      reportPublicPageView(options, request, "/terms");
      return response;
    }

    if (url.pathname === "/privacy") {
      const response = htmlResponse({
        profile: "legal",
        html: PRIVACY_POLICY_HTML,
        requestUrl: url,
      });
      reportPublicPageView(options, request, "/privacy");
      return response;
    }

    if (request.method === "GET" && url.pathname === "/install") {
      const installUrl = buildDiscordInstallUrl({
        discordApplicationId: options.discordApplicationId,
        discordInstallPermissions: options.discordInstallPermissions,
      });

      if (!installUrl) {
        return Response.json({ error: "Discord install link is not configured" }, { status: 404 });
      }

      if (!browserPrivacySignalEnabled(request)) {
        report(options, { name: "install_started", insertionId: createInsertionId() });
      }
      return Response.redirect(installUrl, 302);
    }

    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nSitemap: https://hafbot.xyz/sitemap.xml\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/sitemap.xml") {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://hafbot.xyz/</loc></url><url><loc>https://hafbot.xyz/changelog</loc></url><url><loc>https://hafbot.xyz/terms</loc></url><url><loc>https://hafbot.xyz/privacy</loc></url></urlset>\n',
        { headers: { "content-type": "application/xml; charset=utf-8" } },
      );
    }

    if (request.method === "GET" && url.pathname === "/llms.txt") {
      return new Response(LLMS_TXT, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/changelog.xml"
    ) {
      return new Response(request.method === "HEAD" ? null : CHANGELOG_FEED, {
        headers: {
          "content-type": "application/atom+xml; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/changelog")) {
      const response = htmlResponse({
        profile: "landing",
        html:
          url.pathname === "/"
            ? await renderLandingPage(options.landingPriceCatalog)
            : CHANGELOG_HTML,
        requestUrl: url,
      });
      reportPublicPageView(options, request, url.pathname);
      return response;
    }

    if (request.method === "GET" && url.pathname.startsWith("/landing/assets/")) {
      const filename = url.pathname.slice("/landing/assets/".length);
      const asset = LANDING_ASSETS[filename];
      if (!asset) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(asset.content, {
        status: 200,
        headers: { "content-type": asset.contentType },
      });
    }

    const managedMedia = parseManagedMediaPath(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && managedMedia) {
      const object = options.publicManagedMedia
        ? await options.publicManagedMedia.getImage({
            guildId: managedMedia.guildId,
            filename: managedMedia.filename,
          })
        : null;
      if (!object?.contentType || !isManagedMediaContentType(object.contentType)) {
        if (object?.body instanceof ReadableStream)
          await object.body.cancel().catch(() => undefined);
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "HEAD" && object.body instanceof ReadableStream) {
        await object.body.cancel().catch(() => undefined);
      }
      return new Response(request.method === "HEAD" ? null : object.body, {
        status: 200,
        headers: {
          "content-type": object.contentType,
          "content-disposition": `inline; filename="${managedMedia.filename}"`,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow, noarchive",
        },
      });
    }

    const webhookMatch = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (webhookMatch) {
      if (!options.features.webhookProxy || !options.webhookProxyService) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      // Provider verification / reachability probes (e.g. CFTools, Discord)
      // send GET/HEAD/OPTIONS before enabling a webhook. Return a constant 200/204
      // regardless of whether the publicId is valid so the endpoint cannot be
      // used to confirm whether a given webhook URL is live.
      if (request.method === "OPTIONS") {
        return acceptedWebhookResponse();
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return new Response(null, { status: 200, headers: PUBLIC_WEBHOOK_METHOD_HEADERS });
      }
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: PUBLIC_WEBHOOK_METHOD_HEADERS },
        );
      }

      try {
        const publicId = decodeURIComponent(webhookMatch[1] ?? "");
        if (options.webhookIngressGuard) {
          const admission = await handlePublicWebhookIngress({
            request,
            product: "webhook-proxy",
            publicId,
            guard: options.webhookIngressGuard,
            readCachedSourceExists: () =>
              options.webhookProxyService!.readCachedInboundWebhookSource(publicId),
            sourceExists: () => options.webhookProxyService!.hasInboundWebhookSource(publicId),
            handle: async (text, contentType) => {
              await options.webhookProxyService!.handleInboundWebhook(publicId, text, contentType);
            },
          });
          if (!admission.ok) return webhookIngressFailureResponse(admission);
        } else {
          await options.webhookProxyService.handleInboundWebhook(
            publicId,
            await request.text(),
            request.headers.get("content-type"),
          );
        }
        return acceptedWebhookResponse();
      } catch (error) {
        if (error instanceof WebhookProxyNotFoundError) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (error instanceof WebhookProxyServiceUnavailableError) {
          return Response.json({ error: "Service unavailable for this server." }, { status: 503 });
        }
        console.error("Webhook proxy request failed", redactWebhookSecrets(error));
        return Response.json({ error: "Internal Server Error" }, { status: 500 });
      }
    }

    const banCaseMatch = /^\/ban-cases\/([^/]+)$/.exec(url.pathname);
    if (banCaseMatch) {
      if (!options.features.banCases || !options.banCaseService) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      // Provider verification / reachability probes (e.g. game-server ban
      // webhooks) send GET/HEAD/OPTIONS before enabling delivery. Return a constant
      // 200/204 regardless of whether the source id is valid so the endpoint
      // cannot be used to confirm whether a given webhook URL is live.
      if (request.method === "OPTIONS") {
        return acceptedWebhookResponse();
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return new Response(null, { status: 200, headers: PUBLIC_WEBHOOK_METHOD_HEADERS });
      }
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: PUBLIC_WEBHOOK_METHOD_HEADERS },
        );
      }

      try {
        const publicId = decodeURIComponent(banCaseMatch[1] ?? "");
        if (options.webhookIngressGuard) {
          await handlePublicWebhookIngress({
            request,
            product: "ban-case",
            publicId,
            guard: options.webhookIngressGuard,
            readCachedSourceExists: () =>
              options.banCaseService!.readCachedInboundBanCaseSource(publicId),
            sourceExists: () => options.banCaseService!.hasInboundBanCaseSource(publicId),
            handle: async (text) => {
              await options.banCaseService!.handleInboundBanWebhook(publicId, text);
            },
          });
        } else {
          await options.banCaseService.handleInboundBanWebhook(publicId, await request.text());
        }
        // Always accepted: extraction failure, dormancy, and missing config are all
        // logged internally and must not trigger game-server retries.
        return acceptedWebhookResponse();
      } catch (error) {
        console.error("Ban Case webhook request failed", redactWebhookSecrets(error));
        return acceptedWebhookResponse();
      }
    }

    const transcriptMediaMatch =
      options.features.tickets &&
      /^\/transcripts\/([^/]+)\/([^/]+)\/([^/]+)\/media\/([^/]+)\/(.+)$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && transcriptMediaMatch) {
      const guildId = decodeURIComponent(transcriptMediaMatch[1] ?? "");
      const channelId = decodeURIComponent(transcriptMediaMatch[2] ?? "");
      const accessToken = decodeURIComponent(transcriptMediaMatch[3] ?? "");
      const attachmentId = decodeURIComponent(transcriptMediaMatch[4] ?? "");
      const filename = decodeURIComponent(transcriptMediaMatch[5] ?? "");
      const capability = await authorizeTicketTranscriptRequest(options, request, {
        guildId,
        channelId,
        accessToken,
      });
      if (!capability) return sensitiveNotFound();
      const attachment = options.ticketTranscriptBlobs
        ? await options.ticketTranscriptBlobs.getAttachment(
            buildTicketTranscriptAttachmentStorageKey(
              guildId,
              channelId,
              capability.objectId,
              attachmentId,
              filename,
            ),
          )
        : null;

      if (!attachment) return sensitiveNotFound();

      if (request.method === "HEAD" && attachment.body instanceof ReadableStream) {
        await attachment.body.cancel().catch(() => undefined);
      }
      return sensitiveBinaryResponse(request.method === "HEAD" ? null : attachment.body, {
        contentType: attachment.contentType ?? "application/octet-stream",
      });
    }

    const evidenceImageMatch =
      options.features.evidenceVault &&
      /^\/evidence-vault\/images\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && evidenceImageMatch) {
      const recordId = decodeURIComponent(evidenceImageMatch[1] ?? "");
      const imageId = decodeURIComponent(evidenceImageMatch[2] ?? "");
      const accessValues = url.searchParams.getAll("access");
      const record = options.evidenceVaultStore
        ? await options.evidenceVaultStore.readRecord(recordId)
        : null;
      const recordImage = record?.images.find((image) => image.id === imageId);
      if (
        accessValues.length !== 1 ||
        !record ||
        record.status !== "active" ||
        !recordImage ||
        !options.evidenceMediaCapability ||
        !(
          await options.evidenceMediaCapability.verify(accessValues[0], {
            guildId: record.guildId,
            recordId,
            imageId,
          })
        ).ok
      ) {
        return sensitiveNotFound();
      }
      const object = options.evidenceVaultBlobs
        ? await options.evidenceVaultBlobs.getImage(recordImage.r2Key)
        : null;
      if (!object) return sensitiveNotFound();
      if (request.method === "HEAD" && object.body instanceof ReadableStream) {
        await object.body.cancel().catch(() => undefined);
      }
      return sensitiveBinaryResponse(request.method === "HEAD" ? null : object.body, {
        contentType: object.contentType ?? recordImage.contentType,
        headers: {
          "content-disposition": `inline; filename="${sanitizeFilename(recordImage.filename)}"`,
        },
      });
    }

    const transcriptMatch =
      options.features.tickets && /^\/transcripts\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && transcriptMatch) {
      const guildId = decodeURIComponent(transcriptMatch[1] ?? "");
      const channelId = decodeURIComponent(transcriptMatch[2] ?? "");
      const accessToken = decodeURIComponent(transcriptMatch[3] ?? "");
      const capability = await authorizeTicketTranscriptRequest(options, request, {
        guildId,
        channelId,
        accessToken,
      });
      if (!capability) return sensitiveNotFound();
      const html = options.ticketTranscriptBlobs
        ? await options.ticketTranscriptBlobs.getHtml(
            buildTicketTranscriptStorageKey(guildId, channelId, capability.objectId),
          )
        : null;

      if (!html) return sensitiveNotFound();

      return htmlResponse({
        profile: "transcript",
        html:
          request.method === "HEAD"
            ? ""
            : hydrateTicketTranscriptHtmlAccessToken(html, accessToken),
        requestUrl: url,
      });
    }

    return null;
  };
}

function reportPublicPageView(
  options: PublicRouteOptions,
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

function report(options: PublicRouteOptions, event: ProductAnalyticsEvent): void {
  if (!options.productAnalytics) return;
  try {
    const promise = options.productAnalytics.report(event).catch(() => undefined);
    if (options.waitUntil) options.waitUntil(promise);
  } catch {
    // An injected reporter cannot affect a public response.
  }
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

function sensitiveBlobHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store, max-age=0",
    pragma: "no-cache",
    expires: "0",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
}

function sensitiveNotFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404, headers: sensitiveBlobHeaders() });
}

async function authorizeTicketTranscriptRequest(
  options: PublicRouteOptions,
  request: Request,
  capability: { guildId: string; channelId: string; accessToken: string },
): Promise<{ objectId: string } | null> {
  if (!options.ticketTranscriptCapabilities) return null;
  const admission = await reserveTicketTranscriptAccess(
    request,
    options.ticketTranscriptAccessGuard,
  );
  if (!admission) return null;
  let outcome = "not_found";
  try {
    const authorized = await options.ticketTranscriptCapabilities.authorize({
      ...capability,
      nowMs: Date.now(),
    });
    if (authorized) outcome = "authorized";
    return authorized;
  } finally {
    await admission.complete(outcome);
  }
}

interface TicketTranscriptAdmission {
  complete(outcome: string): Promise<void>;
}

async function reserveTicketTranscriptAccess(
  request: Request,
  guard?: WebhookIngressGuardNamespace,
): Promise<TicketTranscriptAdmission | null> {
  if (!guard) return { complete: async () => {} };
  let clientKey: string;
  try {
    const identity = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    clientKey = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return null;
  }
  const client = guard.getByName(`transcript-access:v1:client:${clientKey}`);
  const global = guard.getByName("transcript-access:v1:global");
  const nowMs = Date.now();
  const clientPolicy = {
    requestsPerMinute: 30,
    burst: 10,
    concurrency: 5,
    leaseTimeoutMs: 10_000,
    duplicateWindowMs: 0,
  };
  const globalPolicy = {
    requestsPerMinute: 10_000,
    burst: 2_000,
    concurrency: 1_000,
    leaseTimeoutMs: 10_000,
    duplicateWindowMs: 0,
  };
  let clientLeaseId: string | undefined;
  let globalLeaseId: string | undefined;
  let completed = false;
  const complete = async (outcome: string): Promise<void> => {
    if (completed) return;
    completed = true;
    const completedAtMs = Date.now();
    if (clientLeaseId) {
      await client
        .complete({ leaseId: clientLeaseId, outcome, nowMs: completedAtMs })
        .catch(() => undefined);
    }
    if (globalLeaseId) {
      await global
        .complete({ leaseId: globalLeaseId, outcome, nowMs: completedAtMs })
        .catch(() => undefined);
    }
  };
  try {
    const clientReservation = await client.reserve({ nowMs, policy: clientPolicy });
    if (!clientReservation.ok) return null;
    clientLeaseId = clientReservation.leaseId;
    const globalReservation = await global.reserve({ nowMs, policy: globalPolicy });
    if (!globalReservation.ok) {
      await complete("limited");
      return null;
    }
    globalLeaseId = globalReservation.leaseId;
    return { complete };
  } catch {
    await complete("unavailable");
    return null;
  }
}

function sanitizeFilename(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return character === '"' || character === "\\" || code <= 31 || code === 127 ? "_" : character;
  }).join("");
  return sanitized.slice(0, 180) || "evidence";
}

function buildDiscordInstallUrl(options: {
  discordApplicationId?: string;
  discordInstallPermissions?: string;
}): string | null {
  const clientId = options.discordApplicationId?.trim();
  if (!clientId) {
    return null;
  }

  const installUrl = new URL("https://discord.com/oauth2/authorize");
  installUrl.searchParams.set("client_id", clientId);
  installUrl.searchParams.set("scope", "bot applications.commands");
  installUrl.searchParams.set("permissions", options.discordInstallPermissions?.trim() || "0");

  return installUrl.toString();
}
