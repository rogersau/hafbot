import type { WardogsService } from "../../wardogs/service";
import { isRecord } from "../../unknown-parse";
import { GameAccessError, steamId } from "./model";

export interface AccessTarget {
  exists?: boolean;
  guildId: string;
  targetId: string;
  generation: number;
  physicalTarget: string;
  origin: string;
  capacity: number;
  ready: boolean;
}
export interface GameAccessProvider {
  readiness(guildId: string, targetId: string): Promise<AccessTarget>;
  capabilities(target: AccessTarget): Promise<boolean>;
  list(target: AccessTarget): Promise<Set<string>>;
  mutate(
    target: AccessTarget,
    subject: string,
    action: "grant" | "remove",
    beforeSend: () => Promise<void>,
  ): Promise<void>;
}
export function decodeReservedSlots(body: unknown): Set<string> {
  if (
    !isRecord(body) ||
    Object.keys(body).some((k) => k !== "reservedSlots") ||
    !Array.isArray(body.reservedSlots) ||
    body.reservedSlots.length > 2000
  )
    throw new GameAccessError("Reserved access could not be verified.");
  const result = new Set<string>();
  for (const id of body.reservedSlots) {
    if (typeof id !== "string" || !steamId(id) || result.has(id))
      throw new GameAccessError("Reserved access could not be verified.");
    result.add(id);
  }
  return result;
}
export function createWardogsAccessProvider(service: WardogsService): GameAccessProvider {
  return {
    async readiness(guildId, targetId) {
      const state = await service.accessReadiness(guildId, targetId);
      return {
        guildId,
        targetId,
        exists: Boolean(state.target),
        generation: state.target?.generation ?? 0,
        ready: state.ready,
        physicalTarget: state.physicalTarget,
        origin: state.origin,
        capacity: state.capacity ?? 0,
      };
    },
    async capabilities(target) {
      const body = await service.accessRequest(target, { kind: "reserved-capabilities" });
      return (
        isRecord(body) &&
        Array.isArray(body.routes) &&
        body.routes.length <= 128 &&
        body.routes.every((r) => typeof r === "string" && r.length <= 200) &&
        [
          "GET /v1/reserved-slots",
          "POST /v1/reserved-slots",
          "DELETE /v1/reserved-slots/{steamId}",
        ].every((r) => (body.routes as unknown[]).includes(r))
      );
    },
    async list(target) {
      return decodeReservedSlots(await service.accessRequest(target, { kind: "reserved-list" }));
    },
    async mutate(target, subject, action, beforeSend) {
      await service.accessRequest(
        target,
        { kind: "reserved-mutation", steamId: subject, action },
        beforeSend,
      );
    },
  };
}
