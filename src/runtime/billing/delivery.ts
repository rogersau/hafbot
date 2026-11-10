import type { CreateChannelMessageInput, DiscordEmbed } from "../../discord/messages";
import type { BillingAuditGuild, BillingAuditIdentity, BillingLedgerOperation } from "./types";
import { isRecord } from "../../unknown-parse";

export interface BillingDeliveryState {
  operation: BillingLedgerOperation;
  ownerDmStatus: "pending" | "delivered" | "terminal";
  auditStatus: "pending" | "delivered";
  ownerAttemptCount: number;
}

export interface BillingDeliveryStore {
  read(operationId: string): Promise<BillingDeliveryState | null>;
  recordAttempt(input: {
    id: string;
    operationId: string;
    destination: "owner_dm" | "audit";
    outcome: string;
    providerCorrelationId: string | null;
    attemptedAtMs: number;
  }): Promise<void>;
  markOwnerDelivered(operationId: string, messageId: string, nowMs: number): Promise<void>;
  markOwnerTerminal(operationId: string, reason: string, nowMs: number): Promise<void>;
  markAuditDelivered(operationId: string, messageId: string, nowMs: number): Promise<void>;
  listPendingOutbox(limit?: number): Promise<string[]>;
  markOutboxSent(operationId: string, sentAtMs: number): Promise<void>;
  replay(operationId: string, nowMs: number): Promise<void>;
}

export interface BillingDiscordDelivery {
  resolveOwnerDiscordIdentity(ownerId: string): Promise<BillingAuditIdentity | null>;
  sendOwnerDm(discordUserId: string, message: CreateChannelMessageInput): Promise<{ id: string }>;
  sendAudit(message: CreateChannelMessageInput): Promise<{ id: string }>;
}

export class BillingDeliveryError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export async function processBillingDelivery(options: {
  operationId: string;
  store: BillingDeliveryStore;
  discord: BillingDiscordDelivery;
  now?: () => number;
  createId?: () => string;
}): Promise<{ result: "complete" | "retry"; delaySeconds?: number }> {
  const state = await options.store.read(options.operationId);
  if (!state) return { result: "complete" };
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const summary = parseSafeSummary(state.operation.summaryJson);
  const resolvedOwner =
    summary.owner ?? (await options.discord.resolveOwnerDiscordIdentity(state.operation.ownerId));
  let retryDelay: number | null = null;
  if (state.ownerDmStatus === "pending") {
    if (!summary.notifyOwner) {
      await options.store.markOwnerDelivered(state.operation.id, "not_applicable", now());
    } else {
      const attempt = state.ownerAttemptCount + 1;
      try {
        if (!resolvedOwner) throw new BillingDeliveryError("owner_discord_identity_missing", false);
        const message = await options.discord.sendOwnerDm(
          resolvedOwner.discordUserId,
          formatOwnerMessage(state.operation, summary),
        );
        await options.store.recordAttempt({
          id: createId(),
          operationId: state.operation.id,
          destination: "owner_dm",
          outcome: "delivered",
          providerCorrelationId: message.id,
          attemptedAtMs: now(),
        });
        await options.store.markOwnerDelivered(state.operation.id, message.id, now());
      } catch (error) {
        const deliveryError = normalizeDeliveryError(error);
        await options.store.recordAttempt({
          id: createId(),
          operationId: state.operation.id,
          destination: "owner_dm",
          outcome: deliveryError.transient ? "transient_failure" : "permanent_failure",
          providerCorrelationId: null,
          attemptedAtMs: now(),
        });
        if (!deliveryError.transient || attempt >= 3) {
          await options.store.markOwnerTerminal(state.operation.id, deliveryError.message, now());
        } else {
          retryDelay = boundedRetryDelay(attempt, deliveryError.retryAfterMs);
        }
      }
    }
  }
  if (state.auditStatus === "pending") {
    try {
      const message = await options.discord.sendAudit(
        formatAuditMessage(state.operation, summary, resolvedOwner),
      );
      await options.store.recordAttempt({
        id: createId(),
        operationId: state.operation.id,
        destination: "audit",
        outcome: "delivered",
        providerCorrelationId: message.id,
        attemptedAtMs: now(),
      });
      await options.store.markAuditDelivered(state.operation.id, message.id, now());
    } catch {
      await options.store.recordAttempt({
        id: createId(),
        operationId: state.operation.id,
        destination: "audit",
        outcome: "transient_failure",
        providerCorrelationId: null,
        attemptedAtMs: now(),
      });
      retryDelay = Math.min(retryDelay ?? 60, 60);
    }
  }
  return retryDelay === null
    ? { result: "complete" }
    : { result: "retry", delaySeconds: retryDelay };
}

export async function sweepBillingDeliveryOutbox(options: {
  store: BillingDeliveryStore;
  queue: {
    send(message: { operationId: string }, options?: { delaySeconds?: number }): Promise<unknown>;
  };
  now?: () => number;
}): Promise<number> {
  const pending = await options.store.listPendingOutbox();
  for (const operationId of pending) {
    await options.queue.send({ operationId }, { delaySeconds: 60 });
    await options.store.markOutboxSent(operationId, options.now?.() ?? Date.now());
  }
  return pending.length;
}

function boundedRetryDelay(attempt: number, retryAfterMs?: number): number {
  const policy = [60, 300, 1_800][attempt - 1] ?? 1_800;
  return Math.min(1_800, Math.max(policy, Math.ceil((retryAfterMs ?? 0) / 1_000)));
}

function normalizeDeliveryError(error: unknown): BillingDeliveryError {
  return error instanceof BillingDeliveryError
    ? error
    : new BillingDeliveryError(error instanceof Error ? error.message : "delivery_failed", true);
}

function parseSafeSummary(json: string): {
  summary: string;
  resultingAccess: string;
  effectiveAtMs: number;
  requiredAction: string | null;
  billingPath: string;
  notifyOwner: boolean;
  eventType: string | null;
  plan: string | null;
  owner: BillingAuditIdentity | null;
  actor: BillingAuditIdentity | null;
  guild: BillingAuditGuild | null;
  fromGuild: BillingAuditGuild | null;
  toGuild: BillingAuditGuild | null;
  subscriptionStatus: string | null;
} {
  const value = JSON.parse(json) as Record<string, unknown>;
  return {
    summary: typeof value.summary === "string" ? value.summary : "Billing changed",
    resultingAccess: typeof value.resultingAccess === "string" ? value.resultingAccess : "free",
    effectiveAtMs: typeof value.effectiveAtMs === "number" ? value.effectiveAtMs : Date.now(),
    requiredAction: typeof value.requiredAction === "string" ? value.requiredAction : null,
    billingPath: typeof value.billingPath === "string" ? value.billingPath : "/admin/billing",
    notifyOwner: value.notifyOwner !== false,
    eventType: typeof value.eventType === "string" ? value.eventType : null,
    plan: typeof value.plan === "string" ? value.plan : null,
    owner: parseIdentity(value.owner),
    actor: parseIdentity(value.actor),
    guild: parseGuild(value.guild),
    fromGuild: parseGuild(value.fromGuild),
    toGuild: parseGuild(value.toGuild),
    subscriptionStatus:
      typeof value.subscriptionStatus === "string" ? value.subscriptionStatus : null,
  };
}

function parseIdentity(value: unknown): BillingAuditIdentity | null {
  if (!isRecord(value)) return null;
  const record = value;
  return typeof record.discordUserId === "string" && typeof record.displayName === "string"
    ? { discordUserId: record.discordUserId, displayName: record.displayName }
    : null;
}

function parseGuild(value: unknown): BillingAuditGuild | null {
  if (!isRecord(value)) return null;
  const record = value;
  return typeof record.guildId === "string" && typeof record.name === "string"
    ? { guildId: record.guildId, name: record.name }
    : null;
}

function formatOwnerMessage(
  operation: BillingLedgerOperation,
  summary: ReturnType<typeof parseSafeSummary>,
): CreateChannelMessageInput {
  const presentation = ownerPresentation(operation.kind, summary);
  const fields: NonNullable<DiscordEmbed["fields"]> = [];
  if (summary.guild) fields.push({ name: "Guild", value: formatGuild(summary.guild) });
  if (summary.fromGuild) fields.push({ name: "From Guild", value: formatGuild(summary.fromGuild) });
  if (summary.toGuild) fields.push({ name: "To Guild", value: formatGuild(summary.toGuild) });
  fields.push({
    name: "Your access",
    value: presentation.access,
  });
  fields.push({
    name: "What you need to do",
    value: presentation.action,
  });
  if (Math.abs(summary.effectiveAtMs - operation.createdAtMs) > 60_000) {
    fields.push({
      name: "When this takes effect",
      value: `<t:${Math.floor(summary.effectiveAtMs / 1_000)}:F>`,
    });
  }

  const billingUrl = absoluteUrl(summary.billingPath);
  return {
    embeds: [
      {
        title: presentation.title,
        description: presentation.description,
        color: presentation.color,
        fields,
        footer: { text: "HAF Billing" },
        timestamp: new Date(operation.createdAtMs).toISOString(),
      },
    ],
    components: billingUrl
      ? [
          {
            type: 1,
            components: [{ type: 2, style: 5, label: "Open Billing", url: billingUrl }],
          },
        ]
      : undefined,
  };
}

function ownerPresentation(
  kind: string,
  summary: ReturnType<typeof parseSafeSummary>,
): { title: string; description: string; access: string; action: string; color: number } {
  const plan = formatLabel(summary.plan ?? summary.resultingAccess);
  const activeAccess = summary.resultingAccess !== "free";
  if (kind === "subscription_quarantined") {
    return {
      title: "We’re checking a billing issue",
      description: activeAccess
        ? `We couldn’t safely verify part of your Subscription. Your ${plan} access remains active while we review it.`
        : "We couldn’t safely verify this Subscription, so paid access has not been enabled. Our team has been alerted.",
      access: activeAccess ? `${plan} remains active` : "Free access remains available",
      action: activeAccess
        ? "No action is needed right now. Billing changes may be temporarily unavailable."
        : "Open Billing to review the current status. Contact Billing Support if this is unexpected.",
      color: 0xfee75c,
    };
  }
  if (kind === "subscription_recovered") {
    return {
      title: "Billing is back to normal",
      description: `We verified your ${plan} Subscription. Your access and Billing controls are available again.`,
      access: `${plan} is active`,
      action: "Nothing — you’re all set.",
      color: 0x57f287,
    };
  }
  if (kind === "payment_recovery_required") {
    return {
      title: "Your payment needs attention",
      description: "We couldn’t confirm the latest Subscription payment.",
      access: activeAccess
        ? `${plan} remains active during the recovery period`
        : "Paid access is currently unavailable",
      action: summary.requiredAction ?? "Open Billing and update your payment details.",
      color: 0xfee75c,
    };
  }
  if (kind === "subscription_started") {
    return {
      title: `${plan} is active`,
      description: "Your Subscription is ready to use.",
      access: `${plan} is active`,
      action: "Nothing — you can assign your available Guild slots from Billing.",
      color: 0x57f287,
    };
  }
  if (kind === "subscription_cancelled") {
    return {
      title: "Your Subscription has ended",
      description: "Your paid Subscription is no longer active.",
      access: "Your Guilds now use Free access; saved configuration is retained",
      action: "Open Billing if you want to start a new Subscription.",
      color: 0xed4245,
    };
  }
  if (kind === "guild_assignment_assigned") {
    return assignmentPresentation(
      "A Guild was added to your Subscription",
      `${formatGuildName(summary.guild)} now has ${plan} access.`,
      `${formatGuildName(summary.guild)} has ${plan} access`,
    );
  }
  if (kind === "guild_assignment_unassigned") {
    return {
      title: "A Guild was removed from your Subscription",
      description: `${formatGuildName(summary.guild)} is no longer assigned to your Subscription.`,
      access: `${formatGuildName(summary.guild)} now uses Free access; saved configuration is retained`,
      action: "Nothing, unless you didn’t expect this change.",
      color: 0xed4245,
    };
  }
  if (kind === "guild_assignment_moved") {
    return assignmentPresentation(
      "A Guild Assignment was moved",
      `${formatGuildName(summary.fromGuild)} was replaced by ${formatGuildName(summary.toGuild)}.`,
      `${formatGuildName(summary.toGuild)} now has ${plan} access`,
    );
  }
  return {
    title: auditTitle(kind),
    description: formatLabel(summary.summary),
    access: activeAccess ? `${plan} is active` : "Free access is active",
    action: summary.requiredAction ?? "Nothing — this message is for your information.",
    color: auditColor(kind),
  };
}

function assignmentPresentation(title: string, description: string, access: string) {
  return {
    title,
    description,
    access,
    action: "Nothing — this change is already complete.",
    color: 0x5865f2,
  };
}

function formatGuildName(guild: BillingAuditGuild | null): string {
  return guild?.name ?? "The Guild";
}

function absoluteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatAuditMessage(
  operation: BillingLedgerOperation,
  summary: ReturnType<typeof parseSafeSummary>,
  resolvedOwner: BillingAuditIdentity | null,
): CreateChannelMessageInput {
  const owner = summary.owner ?? resolvedOwner;
  const fields: NonNullable<DiscordEmbed["fields"]> = [];
  if (summary.guild)
    fields.push({ name: "Guild", value: formatGuild(summary.guild), inline: false });
  if (summary.fromGuild)
    fields.push({ name: "From Guild", value: formatGuild(summary.fromGuild), inline: true });
  if (summary.toGuild)
    fields.push({ name: "To Guild", value: formatGuild(summary.toGuild), inline: true });
  if (owner) fields.push({ name: "Plan Owner", value: formatIdentity(owner), inline: false });
  if (summary.actor)
    fields.push({ name: "Actor", value: formatIdentity(summary.actor), inline: false });
  fields.push(
    { name: "Plan", value: formatLabel(summary.plan ?? summary.resultingAccess), inline: true },
    {
      name: "Effective",
      value: `<t:${Math.floor(summary.effectiveAtMs / 1_000)}:F>`,
      inline: true,
    },
  );
  if (summary.requiredAction)
    fields.push({ name: "Required Action", value: summary.requiredAction, inline: false });
  fields.push({ name: "Operation ID", value: `\`${operation.id}\``, inline: false });

  return {
    embeds: [
      {
        title: auditTitle(operation.kind),
        description: formatLabel(summary.summary),
        color: auditColor(operation.kind),
        fields,
        footer: { text: "HAF Billing Audit" },
        timestamp: new Date(operation.createdAtMs).toISOString(),
      },
    ],
  };
}

function formatIdentity(identity: BillingAuditIdentity): string {
  return `${identity.displayName}\n<@${identity.discordUserId}>\nID: ${identity.discordUserId}`;
}

function formatGuild(guild: BillingAuditGuild): string {
  return `${guild.name}\nID: ${guild.guildId}`;
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function auditTitle(kind: string): string {
  const titles: Record<string, string> = {
    subscription_started: "Subscription Started",
    subscription_recovered: "Subscription Recovered",
    subscription_cancelled: "Subscription Ended",
    subscription_plan_changed: "Subscription Changed",
    payment_recovery_required: "Payment Attention Required",
    guild_assignment_assigned: "Guild Assigned",
    guild_assignment_unassigned: "Guild Unassigned",
    guild_assignment_moved: "Guild Assignment Moved",
  };
  return titles[kind] ?? formatLabel(kind);
}

function auditColor(kind: string): number {
  if (
    ["subscription_started", "subscription_recovered", "guild_assignment_assigned"].includes(kind)
  )
    return 0x57f287;
  if (["subscription_cancelled", "guild_assignment_unassigned"].includes(kind)) return 0xed4245;
  if (kind === "payment_recovery_required") return 0xfee75c;
  if (kind.startsWith("support_")) return 0x95a5a6;
  return 0x5865f2;
}
