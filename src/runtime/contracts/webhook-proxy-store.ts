import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../../types";

export interface WebhookProxyStore {
  readWebhookProxyConfig(publicId: string): Promise<WebhookProxyConfig | null>;
  listWebhookProxyConfigs(guildId: string): Promise<WebhookProxyConfig[]>;
  upsertWebhookProxyConfig(config: WebhookProxyConfig): Promise<void>;
  deleteWebhookProxyConfig(body: { guildId: string; publicId: string }): Promise<void>;
  createWebhookProxyForwardLog(log: WebhookProxyForwardLog): Promise<void>;
  listWebhookProxyForwardLogs(
    guildId: string,
    publicId: string,
    limit?: number,
  ): Promise<WebhookProxyForwardLog[]>;
}
