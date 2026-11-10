import type { QueueProducer, QueueBatch } from "../queue-types";
import { PaidRoleEntitlementService } from "../../commerce/paid-role-entitlement";
import type { Env } from "../../env";
import { isRecord } from "../../unknown-parse";
import { CloudflarePaidRoleStore, type PaidRoleRepairRecord } from "./cloudflare-paid-role-store";
import { DiscordPaidRoleAdapter } from "./discord-paid-role-adapter";
import { isValidStripeSecretKey, StripeConnectClient } from "./stripe-connect-client";
import { StripePaidRoleSubscriptionOperations } from "./stripe-paid-role-subscriptions";

export const COMMERCE_ROLE_QUEUE_NAME = "haf-bot-commerce-roles";
const MAX_ROLE_ATTEMPTS = 5;
const ROLE_REPAIR_WINDOW_MS = 72 * 60 * 60 * 1_000;

export interface CommerceRoleQueueMessage {
  outboxId: string;
  operationKey: string;
  entitlementId: string;
  memberState?: "left" | "rejoined" | "banned";
}

export function createCloudflarePaidRoleRuntime(env: Env) {
  const expectedStripeKeyMode = env.STAGING_MODE === "true" ? "test" : "live";
  if (
    !env.HAF_DB ||
    !env.COMMERCE_ROLE_QUEUE ||
    !isValidStripeSecretKey(env.STRIPE_SECRET_KEY, expectedStripeKeyMode) ||
    !env.STRIPE_API_VERSION ||
    !env.BOT_USER_ID ||
    !env.DISCORD_BOT_TOKEN
  ) {
    return null;
  }
  const store = new CloudflarePaidRoleStore(env.HAF_DB);
  const discord = new DiscordPaidRoleAdapter(env.BOT_USER_ID, env.DISCORD_BOT_TOKEN);
  const stripe = new StripeConnectClient(env.STRIPE_SECRET_KEY, env.STRIPE_API_VERSION);
  const service = new PaidRoleEntitlementService({
    store,
    discord,
    notifier: store,
    audit: store,
    incidents: store,
  });
  const queue = env.COMMERCE_ROLE_QUEUE as QueueProducer<CommerceRoleQueueMessage>;
  const provider = new StripePaidRoleSubscriptionOperations(stripe);

  return {
    async processMessage(message: CommerceRoleQueueMessage): Promise<void> {
      const initial = await store.buildEntitlementState(message.entitlementId);
      if (!initial) return;
      const memberState =
        message.memberState ??
        (await discord.readMemberState(initial.guildId, initial.discordUserId));
      const state = { ...initial, memberState, updatedAtMs: Date.now() };
      const decision = await service.reconcile({
        operationKey: message.operationKey,
        source: "scheduled",
        nowMs: state.updatedAtMs,
        state,
      });
      if (
        decision.reason === "already_applied" &&
        (await store.readOperationStatus(message.operationKey)) === "processing"
      ) {
        throw new Error("commerce_role_operation_leased");
      }
      if (decision.action === "quarantine") {
        const offeringId = await store.readOfferingIdForEntitlement(state.entitlementId);
        if (!offeringId) throw new Error("commerce_role_repair_offering_missing");
        await store.saveRoleRepair({
          id: `role-repair:${offeringId}:${state.discordRoleId}`,
          offeringId,
          guildId: state.guildId,
          oldRoleId: state.discordRoleId,
          replacementRoleId: null,
          startedAtMs: state.updatedAtMs,
          deadlineAtMs: state.updatedAtMs + ROLE_REPAIR_WINDOW_MS,
          status: "pending",
          repairedCount: 0,
          lastErrorCode: decision.reason,
          createdAtMs: state.updatedAtMs,
          updatedAtMs: state.updatedAtMs,
        });
      }
      await processProviderActions(store, provider, state.updatedAtMs);
    },
    async sweepOutbox(): Promise<number> {
      const nowMs = Date.now();
      const messages = await store.listRoleOutbox(nowMs);
      for (const entry of messages) {
        await queue.send({
          outboxId: entry.id,
          operationKey: entry.operationKey,
          entitlementId: entry.entitlementId,
          memberState: readMemberStateOverride(entry.payloadJson),
        });
        await store.markRoleOutboxSent(entry.id, nowMs);
      }
      return messages.length;
    },
    async scheduleDriftAndRepairs(): Promise<void> {
      const nowMs = Date.now();
      await store.enqueueHourlyDrift(nowMs);
      await processProviderActions(store, provider, nowMs);
      for (const repair of await store.listPendingRoleRepairs()) {
        await processRepair(service, store, repair, nowMs);
      }
    },
    processProviderActions: () => processProviderActions(store, provider, Date.now()),
    store,
  };
}

export async function handleCommerceRoleQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
): Promise<void> {
  const runtime = createCloudflarePaidRoleRuntime(env);
  if (!runtime) throw new Error("Commerce role Queue is not fully configured.");
  for (const message of batch.messages) {
    if (!isCommerceRoleQueueMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      await runtime.processMessage(message.body);
      message.ack();
    } catch {
      await runtime.store.recordRoleOutboxFailure(
        message.body.outboxId,
        message.attempts,
        "commerce_role_delivery_failed",
        message.attempts >= MAX_ROLE_ATTEMPTS,
        Date.now(),
      );
      message.retry();
    }
  }
}

async function processRepair(
  service: PaidRoleEntitlementService,
  store: CloudflarePaidRoleStore,
  repair: PaidRoleRepairRecord,
  nowMs: number,
): Promise<void> {
  if (!repair.replacementRoleId && nowMs <= repair.deadlineAtMs) return;
  const result = await service.repair({
    operationKey: roleRepairOperationKey(repair),
    guildId: repair.guildId,
    offeringId: repair.offeringId,
    oldRoleId: repair.oldRoleId,
    replacementRoleId: repair.replacementRoleId ?? repair.oldRoleId,
    startedAtMs: repair.startedAtMs,
    nowMs,
  });
  await store.saveRoleRepair({
    ...repair,
    status: result.action === "quarantine" ? "quarantined" : repair.status,
    repairedCount: result.action === "repair" ? result.repaired : repair.repairedCount,
    lastErrorCode:
      result.action === "quarantine"
        ? "role_repair_failed"
        : result.action === "retry"
          ? "role_repair_retry"
          : null,
    updatedAtMs: nowMs,
  });
  const committedNoop =
    result.action === "noop" &&
    (await store.readOperationStatus(roleRepairOperationKey(repair))) === "committed";
  if (
    (result.action === "repair" || committedNoop) &&
    !(await store.hasOutstandingRoleRepairAssignments(repair))
  ) {
    await store.completeRoleRepair(
      {
        ...repair,
        repairedCount: result.action === "repair" ? result.repaired : repair.repairedCount,
      },
      nowMs,
    );
  }
}

function roleRepairOperationKey(repair: PaidRoleRepairRecord): string {
  return `role-repair:${repair.id}:${repair.replacementRoleId ?? "expired"}`;
}

async function processProviderActions(
  store: CloudflarePaidRoleStore,
  provider: StripePaidRoleSubscriptionOperations,
  nowMs: number,
): Promise<number> {
  const actions = await store.listDueProviderActions(nowMs);
  let completed = 0;
  for (const action of actions) {
    const claimedAtMs = await store.claimProviderAction(action.id, nowMs);
    if (claimedAtMs === null) continue;
    try {
      const operation =
        action.actionType === "subscription.cancel_immediately"
          ? provider.cancelImmediately.bind(provider)
          : provider.cancelAtPeriodEnd.bind(provider);
      await operation({
        connectedAccountId: action.connectedAccountId,
        subscriptionId: action.subscriptionId,
        idempotencyKey: action.operationKey,
      });
      if (await store.completeProviderAction(action, claimedAtMs, nowMs)) completed += 1;
    } catch (error) {
      await store.failProviderAction(action, claimedAtMs, safeProviderError(error), nowMs);
    }
  }
  return completed;
}

function safeProviderError(error: unknown): string {
  if (!(error instanceof Error)) return "provider_action_failed";
  return /^[a-z0-9_:-]{1,100}$/i.test(error.message)
    ? error.message.toLowerCase()
    : "provider_action_failed";
}

function isCommerceRoleQueueMessage(value: unknown): value is CommerceRoleQueueMessage {
  return (
    isRecord(value) &&
    typeof value.outboxId === "string" &&
    value.outboxId.length > 0 &&
    typeof value.operationKey === "string" &&
    value.operationKey.length > 0 &&
    typeof value.entitlementId === "string" &&
    value.entitlementId.length > 0 &&
    (value.memberState === undefined ||
      value.memberState === "left" ||
      value.memberState === "rejoined" ||
      value.memberState === "banned")
  );
}

function readMemberStateOverride(payloadJson: string): "left" | "rejoined" | "banned" | undefined {
  try {
    const value: unknown = JSON.parse(payloadJson);
    return isRecord(value) &&
      (value.memberState === "left" ||
        value.memberState === "rejoined" ||
        value.memberState === "banned")
      ? value.memberState
      : undefined;
  } catch {
    return undefined;
  }
}
