import { getSlashCommandDefinitions } from "../discord-commands";
import { syncApplicationCommands, syncGuildApplicationCommands } from "../discord/commands";
import { parseFeatureFlags } from "../runtime/features";

export async function syncDiscordCommands(
  environment: Record<string, string | undefined>,
  transport = { syncApplicationCommands, syncGuildApplicationCommands },
): Promise<void> {
  const applicationId = environment.DISCORD_APPLICATION_ID?.trim();
  const botToken = environment.DISCORD_BOT_TOKEN?.trim();
  if (!applicationId || !/^\d{17,20}$/.test(applicationId)) {
    throw new Error("DISCORD_APPLICATION_ID must be a Discord application ID.");
  }
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN is required.");
  const adminGuildId = environment.HAF_ADMIN_GUILD_ID?.trim();
  const adminRoleId = environment.HAF_ADMIN_ROLE_ID?.trim();
  if (
    (adminGuildId || adminRoleId) &&
    (!adminGuildId ||
      !adminRoleId ||
      !/^\d{17,20}$/.test(adminGuildId) ||
      !/^\d{17,20}$/.test(adminRoleId))
  ) {
    throw new Error("HAF_ADMIN_GUILD_ID and HAF_ADMIN_ROLE_ID must both be Discord IDs.");
  }

  const commands = getSlashCommandDefinitions(parseFeatureFlags(environment));
  await transport.syncApplicationCommands(
    applicationId,
    botToken,
    commands.filter((command) => command.name !== "haf-admin"),
  );
  const adminCommand = commands.find((command) => command.name === "haf-admin");
  if (adminGuildId && adminCommand) {
    await transport.syncGuildApplicationCommands(applicationId, adminGuildId, botToken, [
      adminCommand,
    ]);
  }
}
