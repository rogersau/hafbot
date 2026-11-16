import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../types";

interface ConfigRecord {
  guildId: string;
  publicId: string;
  name: string;
  enabled: number;
  destinationsJson: string;
  defaultDestinationIdsJson: string;
  routingRulesJson: string;
  contentReplacementsJson: string;
  banLookupEnabled: number;
  banLookupAppIdsJson: string;
  banLookupCredentialId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
interface LogRecord {
  guildId: string;
  logId: string;
  publicId: string;
  destinationId: string;
  credentialFingerprint: string | null;
  status: number | null;
  ok: number;
  attempt: number;
  error: string | null;
  timestampMs: number;
}
export function configToRow(config: WebhookProxyConfig): ConfigRecord {
  return {
    guildId: config.guildId,
    publicId: config.publicId,
    name: config.name,
    enabled: config.enabled ? 1 : 0,
    destinationsJson: JSON.stringify(config.destinations),
    defaultDestinationIdsJson: JSON.stringify(config.defaultDestinationIds),
    routingRulesJson: JSON.stringify(config.routingRules),
    contentReplacementsJson: JSON.stringify(config.contentReplacements ?? []),
    banLookupEnabled: config.banLookupEnabled ? 1 : 0,
    banLookupAppIdsJson: JSON.stringify(config.banLookupAppIds),
    banLookupCredentialId: config.banLookupCredentialId,
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}
export function rowToConfig(row: ConfigRecord): WebhookProxyConfig {
  return {
    guildId: row.guildId,
    publicId: row.publicId,
    name: row.name,
    enabled: row.enabled === 1,
    destinations: JSON.parse(row.destinationsJson),
    defaultDestinationIds: JSON.parse(row.defaultDestinationIdsJson),
    routingRules: JSON.parse(row.routingRulesJson),
    contentReplacements: JSON.parse(row.contentReplacementsJson),
    banLookupEnabled: row.banLookupEnabled === 1,
    banLookupAppIds: JSON.parse(row.banLookupAppIdsJson),
    banLookupCredentialId: row.banLookupCredentialId,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}
export function logToRow(log: WebhookProxyForwardLog): LogRecord {
  return {
    guildId: log.guildId,
    logId: log.id,
    publicId: log.publicId,
    destinationId: log.destinationId,
    credentialFingerprint: log.credentialFingerprint ?? null,
    status: log.status,
    ok: log.ok ? 1 : 0,
    attempt: log.attempt,
    error: log.error,
    timestampMs: log.timestampMs,
  };
}
export function rowToLog(row: LogRecord): WebhookProxyForwardLog {
  return {
    guildId: row.guildId,
    id: row.logId,
    publicId: row.publicId,
    destinationId: row.destinationId,
    credentialFingerprint: row.credentialFingerprint,
    status: row.status,
    ok: row.ok === 1,
    attempt: row.attempt,
    error: row.error,
    timestampMs: row.timestampMs,
  };
}
