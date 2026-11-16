import type {
  BotDefenseConfig,
  GuildAuditLogConfig,
  MemberVerificationConfig,
  MentionProtectionConfig,
  TicketPanelConfig,
  WebhookProxyConfig,
} from "../types";
import { isRecord } from "../unknown-parse";

export type ConfigurationFeatureKey =
  | "tickets"
  | "webhook-proxy"
  | "mention-protection"
  | "bot-defense"
  | "member-verification"
  | "guild-audit-log";
export type ConfigurationRevisionSource =
  | "dashboard-save"
  | "restore"
  | "clone"
  | "system-snapshot";
export type ConfigurationRevisionOperation =
  | "baseline"
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "clone";

export interface ConfigurationActorContext {
  actorUserId: string | null;
  source: ConfigurationRevisionSource;
  operationId: string;
  correlationId: string | null;
}

export interface ConfigurationSnapshotEnvelope<T> {
  envelopeVersion: 1;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  featureSchemaVersion: number;
  exists: boolean;
  value: T | null;
  secretSlots: Record<string, SecretSlotSnapshot>;
}

export type SecretSlotSnapshot =
  | { state: "not-configured" }
  | {
      state: "configured";
      fingerprint: string;
      restorePolicy: "preserve-current" | "replacement-required";
    };

export interface ConfigurationDisplayMetadata {
  featureLabel: string;
  pathLabels: Readonly<Record<string, string>>;
  unorderedArrayPaths: readonly string[];
}

export interface ConfigurationRevisionAdapter<TCurrent, TSnapshot> {
  readonly feature: ConfigurationFeatureKey;
  readonly currentSchemaVersion: number;
  readonly display: ConfigurationDisplayMetadata;
  serialize(
    current: TCurrent | null,
    resourceKey: string,
  ): ConfigurationSnapshotEnvelope<TSnapshot>;
  parseSnapshot(
    snapshot: ConfigurationSnapshotEnvelope<unknown>,
  ): ConfigurationSnapshotEnvelope<TSnapshot>;
}

export class ConfigurationRevisionAdapterRegistry {
  readonly #adapters = new Map<
    ConfigurationFeatureKey,
    ConfigurationRevisionAdapter<unknown, unknown>
  >();

  register<TCurrent, TSnapshot>(adapter: ConfigurationRevisionAdapter<TCurrent, TSnapshot>): this {
    if (this.#adapters.has(adapter.feature)) {
      throw new Error(`Configuration revision adapter already registered: ${adapter.feature}`);
    }
    this.#adapters.set(adapter.feature, adapter as ConfigurationRevisionAdapter<unknown, unknown>);
    return this;
  }

  get(feature: ConfigurationFeatureKey): ConfigurationRevisionAdapter<unknown, unknown> {
    const adapter = this.#adapters.get(feature);
    if (!adapter) throw new Error(`Configuration revision adapter is unavailable: ${feature}`);
    return adapter;
  }

  list(): ConfigurationFeatureKey[] {
    return [...this.#adapters.keys()];
  }
}

export interface ConfigurationRevision {
  id: string;
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  schemaVersion: number;
  operation: ConfigurationRevisionOperation;
  source: ConfigurationRevisionSource;
  actorUserId: string | null;
  operationId: string;
  correlationId: string | null;
  previousRevisionId: string | null;
  restoredFromRevisionId: string | null;
  snapshotJson: string;
  snapshotHash: string;
  createdAtMs: number;
}

export interface ConfigurationRevisionSummary {
  id: string;
  operation: ConfigurationRevisionOperation;
  source: ConfigurationRevisionSource;
  actorUserId: string | null;
  operationId: string;
  correlationId: string | null;
  previousRevisionId: string | null;
  restoredFromRevisionId: string | null;
  snapshotHash: string;
  createdAtMs: number;
}

export interface ConfigurationRevisionPage {
  revisions: ConfigurationRevision[];
  nextCursor: number | null;
}

export interface ConfigurationDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  label?: string;
  before: string | null;
  after: string | null;
  sensitivity?: "normal" | "secret-state";
}

export interface ConfigurationRevisionDetail {
  revision: ConfigurationRevision;
  diff: ConfigurationDiffEntry[];
}

export interface TicketPanelRevisionMutation {
  currentPanel: TicketPanelConfig | null;
  nextPanel: TicketPanelConfig | null;
  baselineRevision: ConfigurationRevision | null;
  revision: ConfigurationRevision;
}

export type VersionedConfigurationMutation =
  | VersionedMutationFor<"tickets", TicketPanelConfig>
  | VersionedMutationFor<"webhook-proxy", WebhookProxyConfig>
  | VersionedMutationFor<"mention-protection", MentionProtectionConfig>
  | VersionedMutationFor<"bot-defense", BotDefenseConfig>
  | VersionedMutationFor<"member-verification", MemberVerificationConfig>
  | VersionedMutationFor<"guild-audit-log", GuildAuditLogConfig>;

export interface VersionedMutationFor<
  TFeature extends ConfigurationFeatureKey,
  TConfiguration,
> extends PreparedConfigurationRevisions {
  feature: TFeature;
  current: TConfiguration | null;
  next: TConfiguration | null;
}

export interface PreparedConfigurationRevisions {
  baselineRevision: ConfigurationRevision | null;
  revision: ConfigurationRevision;
}

export interface ConfigurationRevisionStore {
  readHead(input: {
    guildId: string;
    feature: ConfigurationFeatureKey;
    resourceKey: string;
  }): Promise<ConfigurationRevision | null>;
  commitTicketPanelMutation(input: TicketPanelRevisionMutation): Promise<void>;
  commitVersionedMutation?(input: VersionedConfigurationMutation): Promise<void>;
  list(input: {
    guildId: string;
    feature: ConfigurationFeatureKey;
    resourceKey: string;
    limit: number;
    beforeCreatedAtMs: number | null;
  }): Promise<ConfigurationRevisionPage>;
  readById(input: { guildId: string; revisionId: string }): Promise<ConfigurationRevision | null>;
  listGuild?(input: {
    guildId: string;
    limit: number;
    beforeCreatedAtMs: number | null;
  }): Promise<ConfigurationRevisionPage>;
  purgeExpired?(input: { nowMs: number; retentionMs: number; limit: number }): Promise<number>;
}

export interface TicketPanelSnapshot {
  panelId: string;
  panelName: string;
  panelChannelId: string;
  categoryChannelId: string;
  transcriptChannelId: string;
  panelEmoji: string | null;
  panelTitle: string | null;
  panelDescription: string | null;
  panelFooter: string | null;
  panelColor: number;
  ticketCreationLimit: number | null;
  ticketLimitRejectionMessage: string | null;
  enableTicketClaiming: boolean;
  aiTranscriptSummariesEnabled: boolean;
  ticketTypes: unknown[];
}

export function serializeTicketPanelConfiguration(
  panel: TicketPanelConfig | null,
  resourceKey?: string,
): ConfigurationSnapshotEnvelope<TicketPanelSnapshot> {
  const resolvedKey = resourceKey ?? panel?.panelId ?? "main";
  return {
    envelopeVersion: 1,
    feature: "tickets",
    resourceKey: resolvedKey,
    featureSchemaVersion: 1,
    exists: panel !== null,
    value: panel
      ? {
          panelId: panel.panelId ?? "main",
          panelName: panel.panelName ?? "Main panel",
          panelChannelId: panel.panelChannelId,
          categoryChannelId: panel.categoryChannelId,
          transcriptChannelId: panel.transcriptChannelId,
          panelEmoji: panel.panelEmoji ?? null,
          panelTitle: panel.panelTitle ?? null,
          panelDescription: panel.panelDescription ?? null,
          panelFooter: panel.panelFooter ?? null,
          panelColor: panel.panelColor ?? 0x57f287,
          ticketCreationLimit: panel.ticketCreationLimit ?? null,
          ticketLimitRejectionMessage: panel.ticketLimitRejectionMessage ?? null,
          enableTicketClaiming: panel.enableTicketClaiming ?? false,
          aiTranscriptSummariesEnabled: panel.aiTranscriptSummariesEnabled ?? false,
          ticketTypes: panel.ticketTypes.map((ticketType) => ({
            id: ticketType.id,
            ...(ticketType.enabled === false ? { enabled: false } : {}),
            label: ticketType.label,
            emoji: ticketType.emoji,
            buttonStyle: ticketType.buttonStyle,
            supportRoleId: ticketType.supportRoleId,
            allowedCreatorRoleIds: [...(ticketType.allowedCreatorRoleIds ?? [])].sort(),
            channelNamePrefix: ticketType.channelNamePrefix,
            questions: ticketType.questions.map((question) => ({
              id: question.id,
              label: question.label,
              style: question.style,
              placeholder: question.placeholder,
              required: question.required,
              validation: question.validation ?? "none",
            })),
            defaultTicketLinkPlatform: ticketType.defaultTicketLinkPlatform ?? null,
            responseRules: (ticketType.responseRules ?? []).map((rule) => ({
              id: rule.id,
              conditions: rule.conditions.map((condition) => ({ ...condition })),
              message: rule.message,
            })),
            anonymousSupportEnabled: ticketType.anonymousSupportEnabled ?? false,
            staffDiscussionThreadEnabled: ticketType.staffDiscussionThreadEnabled ?? false,
            ticketHistoryPromptVisibility: ticketType.ticketHistoryPromptVisibility ?? "off",
            participantManagementEnabled: ticketType.participantManagementEnabled ?? false,
            limitExclusion: ticketType.limitExclusion ?? false,
            mentionSupportRole: ticketType.mentionSupportRole ?? false,
          })),
        }
      : null,
    secretSlots: {},
  };
}

export async function prepareTicketPanelRevisionMutation(input: {
  currentPanel: TicketPanelConfig | null;
  nextPanel: TicketPanelConfig | null;
  head: ConfigurationRevision | null;
  actor: ConfigurationActorContext;
  createId?: () => string;
  now?: () => number;
  operation?: ConfigurationRevisionOperation;
  restoredFromRevisionId?: string | null;
}): Promise<TicketPanelRevisionMutation> {
  const panel = input.nextPanel ?? input.currentPanel;
  if (!panel) throw new Error("Ticket Panel revision mutation needs current or next state.");
  const createId = input.createId ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  const resourceKey = panel.panelId ?? "main";
  const createdAtMs = Math.max(now(), (input.head?.createdAtMs ?? -1) + 1);
  const prepared = await prepareConfigurationRevisions({
    guildId: panel.guildId,
    feature: "tickets",
    resourceKey,
    currentSnapshot: serializeTicketPanelConfiguration(input.currentPanel, resourceKey),
    nextSnapshot: serializeTicketPanelConfiguration(input.nextPanel, resourceKey),
    currentExists: input.currentPanel !== null,
    nextExists: input.nextPanel !== null,
    head: input.head,
    actor: input.actor,
    createId,
    now: () => createdAtMs,
    operation: input.operation,
    restoredFromRevisionId: input.restoredFromRevisionId,
  });
  return {
    currentPanel: input.currentPanel,
    nextPanel: input.nextPanel,
    ...prepared,
  };
}

export async function prepareConfigurationRevisions(input: {
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  currentSnapshot: ConfigurationSnapshotEnvelope<unknown>;
  nextSnapshot: ConfigurationSnapshotEnvelope<unknown>;
  currentExists: boolean;
  nextExists: boolean;
  head: ConfigurationRevision | null;
  actor: ConfigurationActorContext;
  createId?: () => string;
  now?: () => number;
  operation?: ConfigurationRevisionOperation;
  restoredFromRevisionId?: string | null;
}): Promise<PreparedConfigurationRevisions> {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  const createdAtMs = Math.max(now(), (input.head?.createdAtMs ?? -1) + 1);
  const baselineRevision =
    input.currentExists && !input.head
      ? await createRevision({
          id: createId(),
          guildId: input.guildId,
          feature: input.feature,
          resourceKey: input.resourceKey,
          operation: "baseline",
          actor: {
            actorUserId: null,
            source: "system-snapshot",
            operationId: "configurationRevision.captureBaseline",
            correlationId: input.actor.correlationId,
          },
          previousRevisionId: null,
          restoredFromRevisionId: null,
          snapshot: input.currentSnapshot,
          createdAtMs,
        })
      : null;
  const operation =
    input.operation ?? (input.nextExists ? (input.currentExists ? "update" : "create") : "delete");
  const revision = await createRevision({
    id: createId(),
    guildId: input.guildId,
    feature: input.feature,
    resourceKey: input.resourceKey,
    operation,
    actor: input.actor,
    previousRevisionId: baselineRevision?.id ?? input.head?.id ?? null,
    restoredFromRevisionId: input.restoredFromRevisionId ?? null,
    snapshot: input.nextSnapshot,
    createdAtMs: createdAtMs + (baselineRevision ? 1 : 0),
  });
  return { baselineRevision, revision };
}

export function summarizeConfigurationRevision(
  revision: ConfigurationRevision,
): ConfigurationRevisionSummary {
  const {
    id,
    operation,
    source,
    actorUserId,
    operationId,
    correlationId,
    previousRevisionId,
    restoredFromRevisionId,
    snapshotHash,
    createdAtMs,
  } = revision;
  return {
    id,
    operation,
    source,
    actorUserId,
    operationId,
    correlationId,
    previousRevisionId,
    restoredFromRevisionId,
    snapshotHash,
    createdAtMs,
  };
}

export function diffConfigurationSnapshots(
  beforeSnapshotJson: string | null,
  afterSnapshotJson: string,
  metadata?: ConfigurationDisplayMetadata,
): ConfigurationDiffEntry[] {
  const before = beforeSnapshotJson === null ? null : JSON.parse(beforeSnapshotJson);
  const after = JSON.parse(afterSnapshotJson);
  const entries: ConfigurationDiffEntry[] = [];
  walkDiff("", before, after, entries, metadata);
  return entries;
}

export function canonicalConfigurationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalConfigurationJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalConfigurationJson(entry)}`)
    .join(",")}}`;
}

async function createRevision(input: {
  id: string;
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  operation: ConfigurationRevisionOperation;
  actor: ConfigurationActorContext;
  previousRevisionId: string | null;
  restoredFromRevisionId: string | null;
  snapshot: ConfigurationSnapshotEnvelope<unknown>;
  createdAtMs: number;
}): Promise<ConfigurationRevision> {
  const snapshotJson = canonicalConfigurationJson(input.snapshot);
  return {
    id: input.id,
    guildId: input.guildId,
    feature: input.feature,
    resourceKey: input.resourceKey,
    schemaVersion: input.snapshot.featureSchemaVersion,
    operation: input.operation,
    source: input.actor.source,
    actorUserId: input.actor.actorUserId,
    operationId: input.actor.operationId,
    correlationId: input.actor.correlationId,
    previousRevisionId: input.previousRevisionId,
    restoredFromRevisionId: input.restoredFromRevisionId,
    snapshotJson,
    snapshotHash: await sha256(snapshotJson),
    createdAtMs: input.createdAtMs,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashConfigurationSnapshot(
  snapshot: ConfigurationSnapshotEnvelope<unknown>,
): Promise<string> {
  return sha256(canonicalConfigurationJson(snapshot));
}

function walkDiff(
  path: string,
  before: unknown,
  after: unknown,
  output: ConfigurationDiffEntry[],
  metadata?: ConfigurationDisplayMetadata,
): void {
  if (canonicalConfigurationJson(before) === canonicalConfigurationJson(after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      walkDiff(path ? `${path}.${key}` : key, before[key], after[key], output, metadata);
    }
    return;
  }
  const resolvedPath = path || "root";
  output.push({
    path: resolvedPath,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    ...(metadata ? { label: labelForPath(resolvedPath, metadata) } : {}),
    before: displayDiffValue(before),
    after: displayDiffValue(after),
    ...(metadata
      ? {
          sensitivity: resolvedPath.startsWith("secretSlots.")
            ? ("secret-state" as const)
            : ("normal" as const),
        }
      : {}),
  });
}

function labelForPath(path: string, metadata: ConfigurationDisplayMetadata): string {
  const direct = metadata.pathLabels[path];
  if (direct) return direct;
  const wildcard = path.replace(/\.\d+(?=\.|$)/g, ".*");
  return metadata.pathLabels[wildcard] ?? path;
}

function displayDiffValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return canonicalConfigurationJson(value);
}
