import { fetchStart } from "../../src/node/start-web";
import { ALL_FEATURES_ENABLED } from "../../src/runtime/features";
import { createPublicRuntimeResponses } from "../../src/web/public-runtime-endpoints";
import type { WebRequestContext } from "../../src/web/request-context";

type PublicWebOptions = Pick<
  WebRequestContext,
  "landingPriceCatalog" | "productAnalytics" | "selfHostedSite"
> & {
  discordApplicationId?: string;
};

export function createPublicWeb(options: PublicWebOptions = {}) {
  const endpoints = createPublicRuntimeResponses({ ...options, features: ALL_FEATURES_ENABLED });
  return (request: Request) =>
    fetchStart(request, {
      ...options,
      nonce: "landingtest",
      admin: {
        authenticated: false,
        userProfile: null,
        playstationLinkEnabled: false,
        workerVersion: "",
      },
      haf: endpoints as WebRequestContext["haf"],
    });
}
