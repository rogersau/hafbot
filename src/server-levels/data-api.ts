import type { ServerLevelCredentialService } from "./credentials";
import type { ConfiguredGameServer } from "./model";
import { isRecord } from "../unknown-parse";

const CFTOOLS_DATA_API_ORIGIN = "https://data.cftools.cloud";
const MAX_RESPONSE_BYTES = 1_048_576;
const TOKEN_LIFETIME_MS = 23 * 60 * 60 * 1_000;

export interface ServerLevelRosterObservation {
  steamIds: string[];
  population: number;
  queueSize: number;
  maxSlots: number;
  observedAtMs: number;
}

export interface CftoolsDataApiClientOptions {
  credentials: ServerLevelCredentialService;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ApiSession {
  guildId: string;
  configuredGameServerId: string;
  applicationId: string;
  secret: string;
  accessToken: string;
}

export class CftoolsDataApiClient {
  constructor(private readonly options: CftoolsDataApiClientOptions) {}

  async observeCurrentRoster(server: ConfiguredGameServer): Promise<ServerLevelRosterObservation> {
    const credentials = await this.options.credentials.readDataApiCredentials({
      guildId: server.guildId,
      configuredGameServerId: server.id,
    });
    if (!credentials) throw new Error("CFTools Data API credentials are not configured.");
    const now = this.options.now?.() ?? Date.now();
    const session: ApiSession = {
      guildId: server.guildId,
      configuredGameServerId: server.id,
      applicationId: credentials.applicationId,
      secret: credentials.secret,
      accessToken:
        credentials.accessToken &&
        credentials.accessTokenExpiresAtMs !== null &&
        credentials.accessTokenExpiresAtMs > now + 60_000
          ? credentials.accessToken
          : await this.authenticate(server, credentials.applicationId, credentials.secret, now),
    };

    const info = await this.authorizedGet(session, `/v1/server/${server.providerServerId}/info`);
    const publicGameServerId = parseDayzServerInfo(info);
    const roster = await this.authorizedGet(
      session,
      `/v1/server/${server.providerServerId}/GSM/list`,
    );
    const status = await this.authorizedGet(session, `/v1/gameserver/${publicGameServerId}`);
    const steamIds = parseRoster(roster);
    const capacity = parsePublicStatus(status);
    if (steamIds.length !== capacity.population) {
      throw new Error(
        "CFTools roster and public population did not describe one trusted snapshot.",
      );
    }
    return { steamIds, ...capacity, observedAtMs: this.options.now?.() ?? Date.now() };
  }

  private async authorizedGet(session: ApiSession, path: string): Promise<unknown> {
    assertAllowedReadPath(path);
    let response = await this.request(path, {
      method: "GET",
      headers: this.headers(session.applicationId, session.accessToken),
    });
    if (response.status === 403) {
      session.accessToken = await this.authenticate(
        {
          guildId: session.guildId,
          id: session.configuredGameServerId,
        },
        session.applicationId,
        session.secret,
        this.options.now?.() ?? Date.now(),
      );
      response = await this.request(path, {
        method: "GET",
        headers: this.headers(session.applicationId, session.accessToken),
      });
    }
    return readJson(response);
  }

  private async authenticate(
    server: Pick<ConfiguredGameServer, "guildId" | "id">,
    applicationId: string,
    secret: string,
    now: number,
  ): Promise<string> {
    const response = await this.request("/v1/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": applicationId,
      },
      body: JSON.stringify({ application_id: applicationId, secret }),
    });
    const body = await readJson(response);
    const token = record(body)?.token;
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,4000}$/.test(token)) {
      throw new Error("CFTools authentication returned an invalid token.");
    }
    await this.options.credentials.storeDataApiAccessToken({
      guildId: server.guildId,
      configuredGameServerId: server.id,
      accessToken: token,
      accessTokenExpiresAtMs: now + TOKEN_LIFETIME_MS,
      nowMs: now,
    });
    return token;
  }

  private headers(applicationId: string, token: string): HeadersInit {
    return { Authorization: `Bearer ${token}`, "User-Agent": applicationId };
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    // `cache: "no-store"` is supported by the Node fetch client, but the
    // repository's Workers type package predates that runtime addition.
    const noStoreInit = {
      ...init,
      redirect: "error",
      cache: "no-store",
    } as RequestInit;
    return (this.options.fetch ?? fetch)(`${CFTOOLS_DATA_API_ORIGIN}${path}`, noStoreInit);
  }
}

function assertAllowedReadPath(path: string): void {
  if (
    !/^\/v1\/server\/[A-Za-z0-9._:-]{1,200}\/(?:info|GSM\/list)$/.test(path) &&
    !/^\/v1\/gameserver\/[A-Za-z0-9._:-]{1,200}$/.test(path)
  ) {
    throw new Error("CFTools Data API route is not allowlisted.");
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("CFTools Data API response exceeded the size limit.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("CFTools Data API response exceeded the size limit.");
  }
  if (!response.ok) throw new Error(`CFTools Data API request failed with ${response.status}.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("CFTools Data API returned invalid JSON.");
  }
}

function parseDayzServerInfo(value: unknown): string {
  const root = record(value);
  const server = record(root?.server);
  const gameServer = record(server?.gameserver);
  if (gameServer?.game !== 1) throw new Error("CFTools server is not a DayZ server.");
  const id = server?.gameserver_id ?? root?.gameserver_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
    throw new Error("CFTools server info did not include a valid public server identity.");
  }
  return id;
}

function parseRoster(value: unknown): string[] {
  const sessions = record(value)?.sessions;
  if (!Array.isArray(sessions) || sessions.length > 10_000) {
    throw new Error("CFTools roster response is invalid.");
  }
  const ids = sessions.map((session) => record(record(session)?.gamedata)?.steam64);
  if (!ids.every((id): id is string => typeof id === "string" && /^\d{17}$/.test(id))) {
    throw new Error("CFTools roster included an invalid SteamID64.");
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error("CFTools roster included duplicate players.");
  return unique.sort();
}

function parsePublicStatus(value: unknown): {
  population: number;
  queueSize: number;
  maxSlots: number;
} {
  const status = findStatusRecord(value, 0);
  const population = status?.players;
  const queueSize = record(status?.queue)?.size;
  const maxSlots = status?.slots;
  if (
    !Number.isSafeInteger(population) ||
    (population as number) < 0 ||
    !Number.isSafeInteger(queueSize) ||
    (queueSize as number) < 0 ||
    !Number.isSafeInteger(maxSlots) ||
    (maxSlots as number) < 1 ||
    (maxSlots as number) > 10_000
  ) {
    throw new Error("CFTools public server status is invalid.");
  }
  return {
    population: population as number,
    queueSize: queueSize as number,
    maxSlots: maxSlots as number,
  };
}

function findStatusRecord(value: unknown, depth: number): Record<string, unknown> | null {
  const current = record(value);
  if (!current || depth > 4) return null;
  const status = record(current.status);
  if (status && "players" in status && "slots" in status) return status;
  for (const child of Object.values(current)) {
    const found = findStatusRecord(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
