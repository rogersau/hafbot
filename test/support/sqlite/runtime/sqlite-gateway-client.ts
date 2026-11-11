import { SafeDiagnosticError } from "../../../../src/observability/safe-diagnostic-error";
import type { GatewaySnapshot } from "../../../../src/runtime/contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SqliteGatewayClientOptions {
  botIdentityId?: string;
  botUserId?: string;
  discordBotToken?: string;
}

export function createSqliteGatewayClient(
  gatewayStub: { fetch: FetchLike },
  options: SqliteGatewayClientOptions = {},
) {
  return {
    async start(): Promise<GatewaySnapshot> {
      return readJson<GatewaySnapshot>(
        gatewayStub.fetch("https://gateway-session/start", {
          method: "POST",
          headers: buildGatewayHeaders(options),
        }),
      );
    },
    async status(): Promise<GatewaySnapshot> {
      return readJson<GatewaySnapshot>(gatewayStub.fetch("https://gateway-session/status"));
    },
    async stop(): Promise<GatewaySnapshot> {
      return readJson<GatewaySnapshot>(
        gatewayStub.fetch("https://gateway-session/stop", { method: "POST" }),
      );
    },
  };
}

function buildGatewayHeaders(options: SqliteGatewayClientOptions): HeadersInit | undefined {
  if (!options.botIdentityId && !options.discordBotToken) return undefined;
  const headers = new Headers();
  if (options.botIdentityId) headers.set("X-Gateway-Bot-Identity", options.botIdentityId);
  if (options.botUserId) headers.set("X-Gateway-Bot-User-Id", options.botUserId);
  if (options.discordBotToken) headers.set("X-Discord-Bot-Token", options.discordBotToken);
  return headers;
}

async function validateResponse(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeDiagnosticError(`Cloudflare gateway request failed: ${response.status}`);
  }
  return response;
}

async function readJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await validateResponse(responsePromise);
  try {
    return await response.json();
  } catch {
    throw new SafeDiagnosticError("Cloudflare gateway returned an invalid JSON response.");
  }
}
