import type { SetupResolution, SetupRun } from "../../feature-setup";

export interface FeatureSetupStore {
  readRun(runId: string): Promise<SetupRun | null>;
  readActiveRun(guildId: string, featureKey: string): Promise<SetupRun | null>;
  readLatestRun(guildId: string, featureKey: string): Promise<SetupRun | null>;
  readLatestResolution(
    guildId: string,
    featureKey: string,
    dependencyKey: string,
    resourceId: string,
  ): Promise<SetupResolution | null>;
  createRun(run: SetupRun): Promise<void>;
  updateRun(run: SetupRun): Promise<void>;
  upsertResolution(resolution: SetupResolution): Promise<void>;
}
