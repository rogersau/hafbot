import { readDiscordE2eActors } from "../runtime/discord-e2e-actors";
import { reportNodeStartupFailure, startNodeProcess } from "./start";

void (async () => {
  const discordE2eActors = readDiscordE2eActors(process.env);
  await startNodeProcess({ discordE2eActors });
})().catch(reportNodeStartupFailure);
