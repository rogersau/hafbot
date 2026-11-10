import { rejectDiscordE2eEnvironment } from "../runtime/discord-e2e-actors";
import { reportNodeStartupFailure, startNodeProcess } from "./start";

void (async () => {
  rejectDiscordE2eEnvironment(process.env);
  await startNodeProcess();
})().catch(reportNodeStartupFailure);
