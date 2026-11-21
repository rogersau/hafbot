import { fetchStart } from "../../src/node/start-web";
import { createPublicRuntimeResponses } from "../../src/web/public-runtime-endpoints";
import type { WebRequestContext } from "../../src/web/request-context";
import { createPublicEndpoints } from "../../src/routes/public-routes";
import { createCommerceBuyerEndpoints } from "../../src/routes/commerce-buyer-routes";
import { createCommerceSupportEndpoints } from "../../src/routes/commerce-support-routes";
import { createMemberVerificationRoutes as createVerificationEndpoints } from "../../src/routes/member-verification-routes";
import { createPlatformLinkEndpoints } from "../../src/routes/platform-link-routes";
import { createBanAppealPublicEndpoints } from "../../src/moderation-appeals/routes";

type Endpoint = (
  request: Request,
  ...params: string[]
) => Response | null | Promise<Response | null>;

function dispatch(...endpoints: [RegExp, Endpoint][]) {
  return async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url);
    for (const [pattern, endpoint] of endpoints) {
      const match = pattern.exec(pathname);
      if (match) return endpoint(request, ...match.slice(1));
    }
    return null;
  };
}

function get(handler: Endpoint): Endpoint {
  return (request, ...params) => (request.method === "GET" ? handler(request, ...params) : null);
}

export function createPublicWebRoutes(options: Parameters<typeof createPublicEndpoints>[0]) {
  const haf = createPublicRuntimeResponses(options) as WebRequestContext["haf"];
  return (request: Request) =>
    fetchStart(request, {
      haf,
      nonce: "public-endpoint-test",
      admin: {
        authenticated: false,
        userProfile: null,
        playstationLinkEnabled: false,
        workerVersion: "",
      },
    });
}

export function createPublicRoutes(options: Parameters<typeof createPublicEndpoints>[0]) {
  const { transcript, transcriptMedia } = createPublicEndpoints(options);
  return dispatch(
    [
      /^\/transcripts\/([^/]+)\/([^/]+)\/([^/]+)$/,
      (request, guildId, channelId, token) =>
        transcript(request, {
          guildId: decodeURIComponent(guildId),
          channelId: decodeURIComponent(channelId),
          token: decodeURIComponent(token),
        }),
    ],
    [
      /^\/transcripts\/([^/]+)\/([^/]+)\/([^/]+)\/media\/([^/]+)\/(.+)$/,
      (request, guildId, channelId, token, attachmentId, filename) =>
        transcriptMedia(request, {
          guildId: decodeURIComponent(guildId),
          channelId: decodeURIComponent(channelId),
          token: decodeURIComponent(token),
          attachmentId: decodeURIComponent(attachmentId),
          filename: decodeURIComponent(filename),
        }),
    ],
  );
}

export function createCommerceBuyerRoutes(
  options: Parameters<typeof createCommerceBuyerEndpoints>[0],
) {
  const endpoints = createCommerceBuyerEndpoints(options);
  return dispatch(
    [
      /^\/commerce\/stores\/([^/]+)$/,
      get((_, guildId) => endpoints.commerceStore(decodeURIComponent(guildId))),
    ],
    [
      /^\/commerce\/offers\/([^/]+)$/,
      get((request, offeringId) =>
        endpoints.commerceOffering(request, decodeURIComponent(offeringId)),
      ),
    ],
    [
      /^\/commerce\/checkout$/,
      (request) =>
        request.method === "POST"
          ? endpoints.commerceCheckout(request)
          : endpoints.methodNotAllowed(),
    ],
    [
      /^\/commerce\/return$/,
      (request) =>
        request.method === "GET" ? endpoints.commerceReturn(request) : endpoints.methodNotAllowed(),
    ],
    [
      /^\/commerce\/portal$/,
      (request) =>
        request.method === "POST"
          ? endpoints.commercePortal(request)
          : endpoints.methodNotAllowed(),
    ],
  );
}

export function createCommerceSupportRoutes(
  options: Parameters<typeof createCommerceSupportEndpoints>[0],
) {
  const endpoints = createCommerceSupportEndpoints(options);
  return dispatch(
    [
      /^\/commerce\/support\/(\d{2,24})$/,
      (request, guildId) =>
        request.method === "GET"
          ? endpoints.commerceSupportPage(request, guildId)
          : endpoints.methodNotAllowed(),
    ],
    [
      /^\/commerce\/support\/checkout$/,
      (request) =>
        request.method === "POST"
          ? endpoints.commerceSupportCheckout(request)
          : endpoints.methodNotAllowed(),
    ],
    [
      /^\/commerce\/support\/return$/,
      (request) =>
        request.method === "GET"
          ? endpoints.commerceSupportReturn(request)
          : endpoints.methodNotAllowed(),
    ],
  );
}

export function createPlatformLinkRoutes(
  options: Parameters<typeof createPlatformLinkEndpoints>[0],
) {
  const { start, callback } = createPlatformLinkEndpoints(options);
  return dispatch(
    [new RegExp(`^/auth/${options.platformConfig.platformName}/start$`), get(start)],
    [new RegExp(`^/auth/${options.platformConfig.platformName}/callback$`), get(callback)],
  );
}

export function createMemberVerificationRoutes(
  options: Parameters<typeof createVerificationEndpoints>[0],
) {
  const endpoints = createVerificationEndpoints(options);
  return dispatch([
    /^\/verify\/([^/]+)$/,
    (request, rawAttemptId) => {
      const attemptId = decodeURIComponent(rawAttemptId);
      const handler =
        request.method === "GET"
          ? endpoints.get
          : request.method === "POST"
            ? endpoints.post
            : endpoints.methodNotAllowed;
      return handler(request, attemptId);
    },
  ]);
}

export function createBanAppealPublicRoutes(
  options: Parameters<typeof createBanAppealPublicEndpoints>[0],
) {
  const endpoints = createBanAppealPublicEndpoints(options);
  return dispatch(
    [
      /^\/assets\/ban-appeals\.js$/,
      (request) =>
        request.method === "GET"
          ? endpoints.banAppealScript()
          : endpoints.banAppealScriptMethodNotAllowed(),
    ],
    [
      /^\/ban-appeals\/([^/]+)$/,
      (request, guildId) =>
        request.method === "GET"
          ? endpoints.banAppealPage(request, guildId)
          : endpoints.banAppealMethodNotAllowed(request, guildId),
    ],
    [
      /^\/api\/ban-appeals\/([^/]+)$/,
      (request, guildId) =>
        request.method === "POST"
          ? endpoints.banAppealSubmission(request, guildId)
          : endpoints.banAppealMethodNotAllowed(request, guildId),
    ],
  );
}
