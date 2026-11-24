export interface MessageClassificationEnv {
  provider: "jev" | "openai";
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
}

export function parseMessageClassificationEnv(
  env: Record<string, string | undefined>,
): MessageClassificationEnv | undefined {
  const provider = env.MESSAGE_CLASSIFICATION_PROVIDER?.trim().toLowerCase();
  const apiKey = env.MESSAGE_CLASSIFICATION_API_KEY?.trim();
  if ((provider !== "jev" && provider !== "openai") || !apiKey) return undefined;

  const model =
    env.MESSAGE_CLASSIFICATION_MODEL?.trim() || (provider === "jev" ? "jev-latest" : "gpt-6-luna");
  const baseUrl = env.MESSAGE_CLASSIFICATION_API_BASE_URL?.trim();
  if (!baseUrl) return { provider, apiKey, model };

  const url = URL.parse(baseUrl);
  if (
    provider !== "openai" ||
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return {
    provider,
    apiKey,
    model,
    apiBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
  };
}
