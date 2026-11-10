import { READ_ROUTES, WardogsError } from "./model";
import type { WardogsService } from "./service";
export async function validateWardogsContract(
  service: WardogsService,
  input: {
    guildId: string;
    targetId: string;
    generation: number;
    roster: boolean;
    operatorConfirmation: "APPROVE_READ_ONLY_VALIDATION";
    provider: string;
    serverBuild: string | null;
    sourceRevision: string;
  },
) {
  if (input.operatorConfirmation !== "APPROVE_READ_ONLY_VALIDATION")
    throw new WardogsError("disabled");
  const target = await service.verify(input);
  return {
    observedAt: new Date(target.verifiedAtMs!).toISOString(),
    provider: safeLabel(input.provider),
    serverBuild: input.serverBuild === null ? null : safeLabel(input.serverBuild),
    sourceRevision: safeLabel(input.sourceRevision),
    originRef: target.originRef,
    targetId: target.id,
    generation: target.generation,
    testedRoutes: [
      READ_ROUTES.capabilities,
      READ_ROUTES.status,
      ...(input.roster ? [READ_ROUTES.roster] : []),
    ],
    responseShapeChecks: "passed",
    operatorConfirmation: true,
    provenance: "runtime-read-validation",
    unknowns: [
      "Provider support and polling guarantees require separate confirmation",
      "SteamID64 namespace is provisional",
      "Queue information is unknown",
      "Read validation grants no mutation, sales or XP approval",
    ],
  };
}
function safeLabel(value: string): string {
  return /^[A-Za-z0-9 ._/-]{1,100}$/.test(value) ? value : "unrecorded";
}
