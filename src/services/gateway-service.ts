import type { GatewayController } from "../runtime/contracts";

export interface GatewayBootstrapOptions {
  discordApplicationId?: string;
  syncApplicationCommands?: (applicationId: string) => Promise<void>;
}

export class GatewayService {
  constructor(
    private readonly gateway: GatewayController,
    private readonly bootstrapOptions?: GatewayBootstrapOptions,
  ) {}

  async bootstrap(): Promise<unknown> {
    if (
      this.bootstrapOptions?.discordApplicationId &&
      this.bootstrapOptions.syncApplicationCommands
    ) {
      try {
        await this.bootstrapOptions.syncApplicationCommands(
          this.bootstrapOptions.discordApplicationId,
        );
      } catch (error) {
        console.error("Failed to sync slash commands during bootstrap", error);
      }
    }
    return this.gateway.start();
  }

  async getStatus(): Promise<unknown> {
    return this.gateway.status();
  }
}
