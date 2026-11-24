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
import type { EvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "../runtime/contracts/webhook-ingress-guard";
import {
  handlePublicWebhookIngress,
  type PublicIngressResult,
} from "../runtime/public-webhook-ingress";
import { redactWebhookSecrets } from "../security/webhook-credentials";
import { htmlResponse } from "../http/html-response";
import { sensitiveBinaryResponse } from "../http/sensitive-binary-response";
import { buildManagedMediaStorageKey, isManagedMediaContentType } from "../managed-media";
import type { PublicManagedMediaStore } from "../managed-media";
import {
  browserPrivacySignalEnabled,
  createInsertionId,
  type ProductAnalyticsReporter,
} from "../product-analytics";
import { report, reportPublicPageView } from "./public-analytics";
import { DISCORD_INSTALL_CONTINUATION, renderInstallPage } from "./install-page";

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
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
  serverLevelIngressHandler?: (request: Request) => Promise<Response | null>;
}

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

export function createPublicEndpoints(options: PublicRouteOptions) {
  return {
    serverLevelIngress: async (request: Request): Promise<Response | null> => {
      if (!options.serverLevelIngressHandler) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return options.serverLevelIngressHandler(request);
    },
    health: () => new Response("OK", { status: 200 }),
    terms: (request: Request) => handleLegalPolicy(options, request, "terms"),
    privacy: (request: Request) => handleLegalPolicy(options, request, "privacy"),
    microsoftIdentityAssociation: (): Response => {
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
    },
    install: (request: Request): Response => {
      const permissions = options.discordInstallPermissions?.trim() || "0";
      const installUrl = buildDiscordInstallUrl(options.discordApplicationId, permissions);

      if (!installUrl) {
        return Response.json({ error: "Discord install link is not configured" }, { status: 404 });
      }

      const requestUrl = new URL(request.url);
      if (
        !options.selfHostedSite &&
        requestUrl.searchParams.get("continue") !== DISCORD_INSTALL_CONTINUATION
      ) {
        return htmlResponse({
          profile: "legal",
          html: renderInstallPage(permissions, requestUrl.search),
          requestUrl,
        });
      }

      if (!browserPrivacySignalEnabled(request)) {
        report(options, { name: "install_started", insertionId: createInsertionId() });
      }
      return Response.redirect(installUrl, 302);
    },
    managedMedia: async (
      request: Request,
      { guildId, filename }: { guildId: string; filename: string },
    ): Promise<Response | null> => {
      try {
        buildManagedMediaStorageKey(guildId, filename);
      } catch {
        return null;
      }
      const object = await options.publicManagedMedia?.getImage({ guildId, filename });
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
          "content-disposition": `inline; filename="${filename}"`,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow, noarchive",
        },
      });
    },
    webhookProbe: (product: "webhookProxy" | "banCases", status: 200 | 204 | 405): Response => {
      const service =
        product === "webhookProxy" ? options.webhookProxyService : options.banCaseService;
      if (!options.features[product] || !service) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return status === 405
        ? Response.json(
            { error: "Method not allowed" },
            { status, headers: PUBLIC_WEBHOOK_METHOD_HEADERS },
          )
        : new Response(null, { status, headers: PUBLIC_WEBHOOK_METHOD_HEADERS });
    },
    webhookProxy: async (request: Request, publicId: string): Promise<Response> => {
      if (!options.features.webhookProxy || !options.webhookProxyService) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      try {
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
    },
    banCaseWebhook: async (request: Request, publicId: string): Promise<Response> => {
      if (!options.features.banCases || !options.banCaseService) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      try {
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
    },
    transcriptMedia: async (
      request: Request,
      {
        guildId,
        channelId,
        token: accessToken,
        attachmentId,
        filename,
      }: {
        guildId: string;
        channelId: string;
        token: string;
        attachmentId: string;
        filename: string;
      },
    ): Promise<Response | null> => {
      if (!options.features.tickets) return null;
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
    },
    evidenceImage: async (
      request: Request,
      { recordId, imageId }: { recordId: string; imageId: string },
    ): Promise<Response | null> => {
      if (!options.features.evidenceVault) return null;
      const url = new URL(request.url);
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
    },
    transcript: async (
      request: Request,
      {
        guildId,
        channelId,
        token: accessToken,
      }: { guildId: string; channelId: string; token: string },
    ): Promise<Response | null> => {
      if (!options.features.tickets) return null;
      const url = new URL(request.url);
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
    },
  };
}

function handleLegalPolicy(
  options: PublicRouteOptions,
  request: Request,
  policy: "terms" | "privacy",
): Response {
  const url = new URL(request.url);
  if (options.selfHostedSite) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    const target =
      policy === "terms" ? options.selfHostedSite.termsUrl : options.selfHostedSite.privacyUrl;
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
      html: renderSelfHostedPolicyUnavailable(options.selfHostedSite, policy, url.origin),
      requestUrl: url,
    });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
  const response = htmlResponse({
    profile: "legal",
    html: policy === "terms" ? TERMS_OF_SERVICE_HTML : PRIVACY_POLICY_HTML,
    requestUrl: url,
  });
  reportPublicPageView(options, request, `/${policy}`);
  return response;
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

function buildDiscordInstallUrl(
  discordApplicationId: string | undefined,
  permissions: string,
): string | null {
  const clientId = discordApplicationId?.trim();
  if (!clientId) {
    return null;
  }

  const installUrl = new URL("https://discord.com/oauth2/authorize");
  installUrl.searchParams.set("client_id", clientId);
  installUrl.searchParams.set("scope", "bot applications.commands");
  installUrl.searchParams.set("permissions", permissions);

  return installUrl.toString();
}
