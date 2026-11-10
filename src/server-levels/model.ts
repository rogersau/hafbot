export const SERVER_LEVEL_PROVIDER_EVENT_TYPES = [
  "player.join",
  "player.leave",
  "server.restart",
  "server.shutdown",
] as const;

export type ServerLevelProviderEventType = (typeof SERVER_LEVEL_PROVIDER_EVENT_TYPES)[number];

export const SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS = [
  "user.join",
  "user.leave",
  "server.restart",
  "server.shutdown",
] as const;

export type ServerLevelWebhookEventType = (typeof SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS)[number];

export interface ServerLevelConfig {
  guildId: string;
  enabled: boolean;
  announcementChannelId: string | null;
  removedAtMs: number | null;
  updatedAtMs: number;
}

export interface ServerLevelCapacityProposal {
  maxSlots: number;
  observedAtMs: number;
}

export interface ConfiguredGameServer {
  id: string;
  guildId: string;
  displayName: string;
  providerServerId: string;
  maxSlots: number;
  endpointId: string;
  webhookCredentialId: string;
  webhookVerifiedAtMs: number | null;
  subscribedEvents: ServerLevelWebhookEventType[];
  capacityProposal: ServerLevelCapacityProposal | null;
  lastRosterReconciledAtMs: number | null;
  lastCapacityCheckedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ServerLevelProviderEvent {
  inboxId: string;
  deliveryId: string;
  configuredGameServerId: string;
  guildId: string;
  eventType: ServerLevelProviderEventType;
  occurredAtMs: number;
  steamId64: string | null;
  population: number | null;
  queueSize: number | null;
  receivedAtMs: number;
  /** Digest of the exact bounded request body, when the event came through webhook ingress. */
  bodySha256?: string;
}

export interface ServerLevelIngressOutboxRecord {
  inboxId: string;
  guildId: string;
  createdAtMs: number;
}

export interface ServerLevelProfile {
  guildId: string;
  userId: string;
  totalXpUnits: number;
  updatedAtMs: number;
}

export interface ServerLevelProcessingCursor {
  configuredGameServerId: string;
  latestSeenAtMs: number;
  watermarkAtMs: number;
  lastDeliveryId: string;
  population: number | null;
  queueSize: number | null;
  lifecycleGeneration: number;
  updatedAtMs: number;
}

export interface ServerLevelPresence {
  configuredGameServerId: string;
  steamId64: string;
  lifecycleGeneration: number;
  joinedAtMs: number;
  lastConfirmedAtMs: number;
  updatedAtMs: number;
}

export interface ServerLevelEarningSession {
  sessionId: string;
  guildId: string;
  configuredGameServerId: string;
  steamId64: string;
  userId: string;
  lifecycleGeneration: number;
  startedAtMs: number;
  lastConfirmedAtMs: number;
  checkpointAtMs: number;
  closedAtMs: number | null;
  closeReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type ServerLevelAwardKind = "interval" | "overlap_delta" | "support_adjustment";

export interface ServerLevelAward {
  awardId: string;
  guildId: string;
  userId: string;
  configuredGameServerId: string | null;
  sourceInboxId: string | null;
  kind: ServerLevelAwardKind;
  intervalStartedAtMs: number | null;
  intervalEndedAtMs: number | null;
  qualifyingSeconds: number;
  multiplier: number | null;
  xpUnits: number;
  scoringPolicyVersion: number;
  actorUserId: string | null;
  reason: string | null;
  createdAtMs: number;
}

export interface ServerLevelAnnouncement {
  announcementId: string;
  guildId: string;
  userId: string;
  channelId: string;
  level: number;
  createdAtMs: number;
}

export function isServerLevelProviderEventType(
  value: string,
): value is ServerLevelProviderEventType {
  return (SERVER_LEVEL_PROVIDER_EVENT_TYPES as readonly string[]).includes(value);
}

export function isServerLevelWebhookEventType(value: string): value is ServerLevelWebhookEventType {
  return (SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export function normalizeServerLevelWebhookEvent(
  value: ServerLevelWebhookEventType,
): ServerLevelProviderEventType {
  if (value === "user.join") return "player.join";
  if (value === "user.leave") return "player.leave";
  return value;
}
