import { createSqliteGatewayClient } from "./sqlite-gateway-client";
import type { GatewayController } from "../../../../src/runtime/contracts";
import type { WhiteLabelBotStore } from "../../../../src/runtime/contracts/white-label-bot-store";

type GatewayNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

export interface GatewayBotControllerOptions {
  enabled: boolean;
  standardBotToken: string;
  gatewayNamespace: GatewayNamespaceLike;
  whiteLabelBots: Pick<WhiteLabelBotStore, "listActiveWhiteLabelBots">;
  resolveToken(secretRef: string): Promise<string>;
}

export function createGatewayBotController(
  options: GatewayBotControllerOptions,
): GatewayController {
  return {
    async start(): Promise<unknown> {
      if (!options.enabled) {
        return { enabled: false };
      }
      const [standard, whiteLabels] = await Promise.allSettled([
        Promise.resolve().then(() =>
          createIdentityController(options, "standard", options.standardBotToken).start(),
        ),
        (async () => {
          const activeWhiteLabelBots = await options.whiteLabelBots.listActiveWhiteLabelBots();
          return Promise.allSettled(
            activeWhiteLabelBots.map(async (bot) =>
              createIdentityController(
                options,
                `white-label:${bot.guildId}`,
                await options.resolveToken(bot.tokenSecretRef),
                bot.botUserId,
              ).start(),
            ),
          );
        })(),
      ]);
      const settled = [
        standard,
        ...(whiteLabels.status === "fulfilled" ? whiteLabels.value : [whiteLabels]),
      ];
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more Gateway identities could not be started.");
      }
      return settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
    },
    async status(): Promise<unknown> {
      if (!options.enabled) return { enabled: false };
      const controllers = await buildControllers(options);
      return Promise.all(controllers.map((controller) => controller.status()));
    },
    async stop(): Promise<unknown> {
      const attempts: Promise<unknown>[] = [createIdentityController(options, "standard").stop()];
      let discoveryFailed = false;
      let discoveryFailure: unknown;
      try {
        const activeWhiteLabelBots = await options.whiteLabelBots.listActiveWhiteLabelBots();
        attempts.push(
          ...activeWhiteLabelBots.map((bot) =>
            createIdentityController(options, `white-label:${bot.guildId}`).stop(),
          ),
        );
      } catch (error) {
        discoveryFailed = true;
        discoveryFailure = error;
      }

      const settled = await Promise.allSettled(attempts);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (discoveryFailed) failures.push(discoveryFailure);
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more Gateway identities could not be stopped.");
      }
      return settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
    },
  };
}

async function buildControllers(
  options: GatewayBotControllerOptions,
): Promise<GatewayController[]> {
  const standard = createIdentityController(options, "standard", options.standardBotToken);
  const activeWhiteLabelBots = await options.whiteLabelBots.listActiveWhiteLabelBots();
  const whiteLabelControllers = await Promise.all(
    activeWhiteLabelBots.map(async (bot) =>
      createIdentityController(
        options,
        `white-label:${bot.guildId}`,
        await options.resolveToken(bot.tokenSecretRef),
        bot.botUserId,
      ),
    ),
  );
  return [standard, ...whiteLabelControllers];
}

function createIdentityController(
  options: GatewayBotControllerOptions,
  identityId: string,
  discordBotToken?: string,
  botUserId?: string,
) {
  const stub = options.gatewayNamespace.get(options.gatewayNamespace.idFromName(identityId));
  return createSqliteGatewayClient(stub, {
    botIdentityId: identityId,
    botUserId,
    discordBotToken,
  });
}
