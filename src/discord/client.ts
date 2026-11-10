export const DISCORD_API = "https://discord.com/api/v10";

const MAX_DISCORD_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_DISCORD_RATE_LIMIT_RETRIES = 2;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface DiscordRateLimitMetadata {
  retryAfterMs?: number;
  rateLimited?: boolean;
  globalRateLimit?: boolean;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string,
    readonly metadata: DiscordRateLimitMetadata = {},
  ) {
    super(message);
    this.name = "DiscordApiError";
  }

  get retryAfterMs(): number | undefined {
    return this.metadata.retryAfterMs;
  }

  get rateLimited(): boolean | undefined {
    return this.metadata.rateLimited;
  }

  get globalRateLimit(): boolean | undefined {
    return this.metadata.globalRateLimit;
  }
}

export function isDiscordRateLimitError(error: unknown): boolean {
  if (error instanceof DiscordApiError && error.status === 429) return true;
  return error instanceof Error && error.cause !== error && isDiscordRateLimitError(error.cause);
}

export async function discordRequest(
  url: string,
  method: string,
  botToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${botToken}`);

  return fetchDiscordWithRateLimitRetry(url, method, { ...init, headers });
}

export async function discordOAuthRequest(
  url: string,
  method: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return fetchDiscordWithRateLimitRetry(url, method, { ...init, headers });
}

export async function discordRawRequest(
  url: string,
  method: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchDiscordWithRateLimitRetry(url, method, init);
}

async function fetchDiscordWithRateLimitRetry(
  url: string,
  method: string,
  init: RequestInit,
): Promise<Response> {
  let response = await fetchDiscordRaw(url, method, init);
  let remainingRateLimitWaitMs = MAX_DISCORD_RATE_LIMIT_WAIT_MS;
  for (let retry = 0; response.status === 429 && retry < MAX_DISCORD_RATE_LIMIT_RETRIES; retry++) {
    const rateLimitMetadata = parseDiscordRateLimitMetadata(
      await response
        .clone()
        .text()
        .catch(() => "Unknown error"),
    );
    if (
      rateLimitMetadata.retryAfterMs === undefined ||
      rateLimitMetadata.retryAfterMs > remainingRateLimitWaitMs
    ) {
      break;
    }

    if (rateLimitMetadata.retryAfterMs > 0) {
      await sleep(rateLimitMetadata.retryAfterMs);
      remainingRateLimitWaitMs -= rateLimitMetadata.retryAfterMs;
    }
    response = await fetchDiscordRaw(url, method, init);
  }

  return ensureDiscordOk(response);
}

async function fetchDiscordRaw(url: string, method: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    method,
  });
}

async function ensureDiscordOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw await buildDiscordApiError(response);
  }

  return response;
}

async function buildDiscordApiError(response: Response): Promise<DiscordApiError> {
  const details = await response.text().catch(() => "Unknown error");
  const metadata = response.status === 429 ? parseDiscordRateLimitMetadata(details) : {};
  return new DiscordApiError(
    `Discord API error: ${response.status} ${details}`,
    response.status,
    details,
    metadata,
  );
}

function parseDiscordRateLimitMetadata(details: string): DiscordRateLimitMetadata {
  try {
    const body = JSON.parse(details) as { retry_after?: unknown; global?: unknown };
    const retryAfter = typeof body.retry_after === "number" ? body.retry_after : undefined;
    return {
      rateLimited: true,
      retryAfterMs: retryAfter === undefined ? undefined : Math.max(0, retryAfter * 1000),
      globalRateLimit: typeof body.global === "boolean" ? body.global : undefined,
    };
  } catch {
    return { rateLimited: true };
  }
}

export async function parseDiscordJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new DiscordApiError(message, response.status, details);
  }

  return response.json();
}

export async function discordGetJson<T>(url: string, botToken: string): Promise<T> {
  const response = await discordRequest(url, "GET", botToken);
  return parseDiscordJson<T>(response, `Discord request failed: GET ${url}`);
}

export async function discordOAuthGetJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await discordOAuthRequest(url, "GET", accessToken);
  return parseDiscordJson<T>(response, `Discord request failed: GET ${url}`);
}
