import type { WardogsService } from "../../wardogs/service";
import type { ObservationProvider } from "./service";
export function createWardogsObservationProvider(service: WardogsService): ObservationProvider {
  return {
    readiness: (guildId, targetId) => service.observationReadiness(guildId, targetId),
    status: (run, guard) =>
      service.read(
        {
          guildId: run.guildId,
          targetId: run.targetId,
          generation: run.generation,
          operation: "status",
        },
        guard,
      ),
    roster: (run, guard) =>
      service.read(
        {
          guildId: run.guildId,
          targetId: run.targetId,
          generation: run.generation,
          operation: "roster",
        },
        guard,
      ),
  };
}
