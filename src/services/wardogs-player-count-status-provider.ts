import type { WardogsService } from "../wardogs/service";
import { WardogsError } from "../wardogs/model";
import type { PlayerCountStatusProvider } from "./player-count-status-provider";

export function createWardogsPlayerCountStatusProvider(options: {
  wardogs?: WardogsService;
  enabled: boolean;
}): PlayerCountStatusProvider {
  return {
    async readiness(server) {
      if (!options.wardogs)
        return {
          ready: false,
          targetExists: false,
          error: "WARDOGS Player Count is disabled by the HAF operator.",
        };
      const state = await options.wardogs.statusReadiness(server.guildId, server.providerServerId);
      return {
        ready: options.enabled && state.ready,
        error: options.enabled
          ? state.error
          : "WARDOGS Player Count is disabled by the HAF operator.",
        sourceUpdatedAtMs: state.target
          ? Math.max(state.target.updatedAtMs, state.target.verifiedAtMs ?? 0)
          : undefined,
        targetExists: state.target !== null,
      };
    },
    async query(server) {
      if (!options.enabled || !options.wardogs)
        return {
          ok: false,
          dormant: true,
          error: "WARDOGS Player Count is disabled by the HAF operator.",
        };
      const state = await options.wardogs.statusReadiness(server.guildId, server.providerServerId);
      if (!state.ready || !state.target)
        return { ok: false, dormant: true, error: state.error ?? "WARDOGS target is unavailable." };
      try {
        const status = await options.wardogs.readPlayerCountStatus({
          guildId: server.guildId,
          targetId: state.target.id,
          generation: state.target.generation,
          serverId: server.id,
        });
        return {
          ok: true,
          snapshot: {
            count: status.players.current,
            maxSlots: status.players.max,
            queue: null,
            ...(status.serverName !== undefined ? { serverName: status.serverName } : {}),
            ...(status.map !== undefined ? { map: status.map } : {}),
          },
        };
      } catch (error) {
        const safe =
          error instanceof WardogsError ? error : new WardogsError("provider_unavailable");
        return {
          ok: false,
          error: safe.message,
          dormant: ["disabled", "unapproved_target", "rate_limited"].includes(safe.code),
        };
      }
    },
  };
}
