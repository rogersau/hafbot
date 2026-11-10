export type ServerLevelOperationalEvent =
  | {
      category: "ingress";
      outcome: "accepted" | "duplicate" | "rejected" | "failed" | "verification";
      durationMs: number;
      statusCode?: number;
      reasonCode?: string;
    }
  | {
      category: "processing";
      outcome: "processed" | "late" | "rejected" | "failed";
      durationMs: number;
      count: number;
      reasonCode?: string;
    }
  | {
      category: "xp_transaction";
      outcome: "committed" | "projection_drift";
      durationMs: number;
      xpUnits: number;
      scoringPolicyVersion: number;
    }
  | {
      category: "reconciliation";
      outcome: "completed" | "failed" | "skipped";
      durationMs: number;
      count: number;
      reasonCode?: string;
    }
  | {
      category: "discord_delivery";
      outcome: "delivered" | "retry" | "terminal";
      durationMs: number;
      reasonCode?: string;
    };

export type ServerLevelTelemetryEmitter = (event: ServerLevelOperationalEvent) => void;

export function emitServerLevelTelemetry(
  emitter: ServerLevelTelemetryEmitter | undefined,
  event: ServerLevelOperationalEvent,
): void {
  try {
    emitter?.({
      ...event,
      durationMs: Math.max(0, Math.floor(event.durationMs)),
    });
  } catch {
    // Operational telemetry must never alter attendance or progression.
  }
}

export const logServerLevelTelemetry: ServerLevelTelemetryEmitter = (event) => {
  console.info("server_levels", event);
};
