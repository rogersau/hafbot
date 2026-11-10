import type { WardogsService } from "../wardogs/service";
import { isRecord } from "../unknown-parse";
import type { Action, Intent } from "./model";

export interface BanProvider {
  readiness(
    guildId: string,
    targetId: string,
    action: Action,
  ): Promise<{
    ready: boolean;
    physicalTarget: string;
    approvalIdentity: string;
    target: { id: string; name: string; generation: number } | null;
  }>;
  capabilities(intent: Intent): Promise<boolean>;
  observe(intent: Intent): Promise<boolean | null>;
  mutate(
    intent: Intent,
    beforeSend: () => Promise<void>,
    assertCurrent?: () => Promise<void>,
  ): Promise<void>;
}
export function createWardogsBanProvider(service: WardogsService): BanProvider {
  const identity = (i: Intent) => ({
    guildId: i.guildId,
    targetId: i.targetId,
    generation: i.generation,
    action: i.action,
  });
  return {
    readiness: (guildId, targetId, action) => service.banReadiness(guildId, targetId, action),
    async capabilities(intent) {
      const body = await service.banRequest(identity(intent), { kind: "ban-capabilities" });
      if (
        !isRecord(body) ||
        !Array.isArray(body.routes) ||
        body.routes.length > 128 ||
        !body.routes.every((r) => typeof r === "string" && r.length <= 200)
      )
        return false;
      return (
        body.routes.includes("GET /v1/bans") &&
        body.routes.includes(
          intent.action === "ban" ? "POST /v1/bans" : "DELETE /v1/bans/{steamId}",
        )
      );
    },
    async observe(intent) {
      return decodeBanPresence(
        await service.banRequest(identity(intent), { kind: "bans" }),
        intent.subject,
      );
    },
    async mutate(intent, beforeSend, assertCurrent) {
      await service.banRequest(
        identity(intent),
        { kind: "mutation", action: intent.action, steamId: intent.subject, reason: intent.reason },
        beforeSend,
        assertCurrent,
      );
    },
  };
}
// Absence is only meaningful with the separately approved complete-list contract.
// Reject pagination/additional envelope fields rather than guessing completeness.
export function decodeBanPresence(body: unknown, subject: string): boolean | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some((k) => k !== "bans") ||
    !Array.isArray(body.bans) ||
    body.bans.length > 2000
  )
    return null;
  const ids = new Set<string>();
  for (const row of body.bans) {
    if (
      !isRecord(row) ||
      typeof row.steamId !== "string" ||
      !/^7656119\d{10}$/.test(row.steamId) ||
      ids.has(row.steamId)
    )
      return null;
    for (const field of ["reason", "bannedAtUtc", "bannedBy"])
      if (
        row[field] !== undefined &&
        (typeof row[field] !== "string" || (row[field] as string).length > 2000)
      )
        return null;
    ids.add(row.steamId);
  }
  return ids.has(subject);
}
