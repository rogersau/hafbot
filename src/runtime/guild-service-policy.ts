import type { GuildServiceSuspensionStore } from "./contracts";
import { isRecord } from "../unknown-parse";

export const GUILD_SERVICE_UNAVAILABLE_MESSAGE = "Service unavailable for this server.";

export class GuildServicePolicy {
  constructor(private readonly store?: GuildServiceSuspensionStore) {}

  async isGuildSuspended(guildId: string | null | undefined): Promise<boolean> {
    if (!guildId || !this.store) return false;
    return (await this.store.readActiveSuspension(guildId)) !== null;
  }

  async listSuspendedGuildIds(): Promise<string[]> {
    if (!this.store) return [];
    return (await this.store.listSuspensions({ activeOnly: true })).map((entry) => entry.guildId);
  }

  static buildUnavailableResponse(): {
    status: 503;
    body: { error: string };
  } {
    return { status: 503, body: { error: GUILD_SERVICE_UNAVAILABLE_MESSAGE } };
  }

  static buildHttpUnavailableResponse(): Response {
    const response = GuildServicePolicy.buildUnavailableResponse();
    return Response.json(response.body, { status: response.status });
  }
}

export function findGuildIdInValue(value: unknown, depth = 0): string | null {
  if (depth > 6 || !isRecord(value)) return null;
  const record = value;
  const direct = record.guildId ?? record.guild_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (
    (record.type === "GUILD_CREATE" || record.type === "GUILD_DELETE") &&
    isRecord(record.data) &&
    typeof record.data.id === "string" &&
    record.data.id.length > 0
  ) {
    return record.data.id;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findGuildIdInValue(item, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findGuildIdInValue(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function isGatewayGuildLifecycleEvent(value: unknown): boolean {
  if (!isRecord(value) || (value.type !== "GUILD_CREATE" && value.type !== "GUILD_DELETE")) {
    return false;
  }
  return isRecord(value.data) && typeof value.data.id === "string" && value.data.id.length > 0;
}
