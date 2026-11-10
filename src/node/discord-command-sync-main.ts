import { syncDiscordCommands } from "./discord-command-sync";

void syncDiscordCommands(process.env).then(
  () => console.info("Discord application commands registered."),
  () => {
    // Provider errors can contain response payloads; do not print credentials or raw errors.
    console.error(
      "Discord command registration failed. Check application credentials, operator IDs and Discord availability.",
    );
    process.exitCode = 1;
  },
);
