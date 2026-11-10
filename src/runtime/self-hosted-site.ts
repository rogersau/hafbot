import { parseDeploymentMode } from "./deployment-mode";

export interface SelfHostedSite {
  operatorName: string;
  publicUrl?: string;
  supportUrl?: string;
  termsUrl?: string;
  privacyUrl?: string;
}

interface SelfHostedSiteEnvironment {
  HAF_DEPLOYMENT_MODE?: string;
  BETTER_AUTH_URL?: string;
  SELF_HOSTED_OPERATOR_NAME?: string;
  SELF_HOSTED_SUPPORT_URL?: string;
  SELF_HOSTED_TERMS_URL?: string;
  SELF_HOSTED_PRIVACY_URL?: string;
}

export function readSelfHostedSite(env: SelfHostedSiteEnvironment): SelfHostedSite | undefined {
  if (parseDeploymentMode(env.HAF_DEPLOYMENT_MODE) !== "self-hosted") return undefined;
  const operatorName = env.SELF_HOSTED_OPERATOR_NAME?.trim() || "this installation's operator";
  const hasControls = [...operatorName].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (operatorName.length > 120 || hasControls) {
    throw new Error("SELF_HOSTED_OPERATOR_NAME must be at most 120 characters without controls.");
  }
  const publicUrl = readUrl(env.BETTER_AUTH_URL, "BETTER_AUTH_URL", true)?.origin;
  const termsUrl = readUrl(env.SELF_HOSTED_TERMS_URL, "SELF_HOSTED_TERMS_URL");
  const privacyUrl = readUrl(env.SELF_HOSTED_PRIVACY_URL, "SELF_HOSTED_PRIVACY_URL");
  for (const target of [termsUrl, privacyUrl]) {
    if (
      target &&
      publicUrl &&
      target.origin === publicUrl &&
      ["/terms", "/privacy"].includes(target.pathname.replace(/\/+$/, ""))
    ) {
      throw new Error("Self-hosted policy URLs must not redirect to their own policy endpoint.");
    }
  }
  return {
    operatorName,
    publicUrl,
    supportUrl: readUrl(env.SELF_HOSTED_SUPPORT_URL, "SELF_HOSTED_SUPPORT_URL")?.href,
    termsUrl: termsUrl?.href,
    privacyUrl: privacyUrl?.href,
  };
}

function readUrl(
  value: string | undefined,
  name: string,
  localDevelopment = false,
): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    const local = localDevelopment && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password
    ) {
      throw new Error("Invalid URL");
    }
    return url;
  } catch {
    throw new Error(name + " must be an HTTPS URL without credentials.");
  }
}
