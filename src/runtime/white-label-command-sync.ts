import { syncApplicationCommands } from "../discord/commands";
import { getSlashCommandDefinitions } from "../discord-commands";
import type { FeatureFlags } from "./features";

export interface SyncWhiteLabelApplicationCommandsOptions {
  applicationId: string;
  botToken: string;
  features: FeatureFlags;
}

export async function syncWhiteLabelApplicationCommands(
  options: SyncWhiteLabelApplicationCommandsOptions,
): Promise<void> {
  const commands = getSlashCommandDefinitions(options.features);
  const globalCommands = commands.filter((command) => command.name !== "haf-admin");
  await syncApplicationCommands(options.applicationId, options.botToken, globalCommands);
}
