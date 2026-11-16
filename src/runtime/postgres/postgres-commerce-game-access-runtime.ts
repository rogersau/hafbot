import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { QueueJobMetadata } from "../queue-types";
import { commerceEligibility, type CommerceEligibilityState } from "../../commerce/eligibility";
import { isRecord } from "../../unknown-parse";
import type { GameAccessMessage, GameAccessQueue } from "../../commerce/game-access/model";
import type { GameAccessProvider } from "../../commerce/game-access/provider";
import { PostgresCommerceBuyerCheckoutStore } from "./postgres-commerce-buyer-checkout-store";
import type { GameAccessStore } from "../../commerce/game-access/store";
import { CommerceGameAccessService } from "../../commerce/game-access/service";
import { createWardogsAccessProvider } from "../../commerce/game-access/provider";
import { createPlatformLinkIdentityReader } from "../../services/platform-link-identity-reader";
import type { PlatformLinkStore } from "../contracts/platform-link-store";
import type { WardogsService } from "../../wardogs/service";
import type { GameAccessCheckoutHooks } from "../../commerce/buyer-checkout";
import { PostgresPaidRoleStore } from "./postgres-commerce-paid-role-store";
import { DiscordPaidRoleAdapter } from "../commerce/discord-paid-role-adapter";
import { deliverQueueJob, type QueueDeliveryOutcome } from "../queue-delivery";

export function createGameAccessRuntime(input: {
  database: PostgresDatabaseCapability;
  store: GameAccessStore;
  wardogs: WardogsService;
  platformLink: PlatformLinkStore;
  botUserId: string;
  botToken: string;
  queue?: GameAccessQueue;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  provider?: GameAccessProvider;
  memberState?: (guildId: string, userId: string) => Promise<"present" | "left">;
  premium?: { isPremium(guildId: string): Promise<boolean> };
  // Only fixture composition opts in. Both production compositions pass false.
  enabled?: boolean;
  steamEnabled?: boolean;
}) {
  const db = input.database;
  const now = input.now ?? Date.now;
  const storefronts = new PostgresCommerceBuyerCheckoutStore(
    db,
    input.premium ?? { isPremium: async () => false },
  );
  const roleStore = new PostgresPaidRoleStore(db);
  const identities = createPlatformLinkIdentityReader(input.platformLink);
  const discord = new DiscordPaidRoleAdapter(input.botUserId, input.botToken);
  const service = new CommerceGameAccessService({
    store: input.store,
    provider: input.provider ?? createWardogsAccessProvider(input.wardogs),
    now,
    wait: input.wait,
    identities,
    // #725 remains the authoritative-provider activation gate. There is deliberately
    // no production switch for sales/new grants in this disabled preparation.
    salesAllowed: async () => input.enabled === true && input.steamEnabled === true,
    async offering(id) {
      const row = await db
        .query<{ guild_id: string; purchase_type: string; purchased: number }>(
          `SELECT o.guild_id,o.purchase_type,
        EXISTS(SELECT 1 FROM commerce_checkout_attempts c WHERE c.offering_id=o.id) AS purchased
        FROM commerce_offerings o WHERE o.id=$1`,
          [id],
        )
        .then((rows) => rows[0] ?? null);
      return row
        ? {
            guildId: row.guild_id,
            recurring: row.purchase_type === "subscription",
            purchased: Boolean(row.purchased),
          }
        : null;
    },
    async truth(a) {
      const rows = (
        await db.queryResult<{ id: string; offering_id: string }>(
          `SELECT DISTINCT e.id,e.offering_id FROM commerce_entitlements e
        JOIN commerce_subscriptions s ON s.stripe_subscription_id=e.source_id AND s.connected_account_id=e.connected_account_id
        AND s.offering_id=e.offering_id AND s.buyer_id=e.buyer_id
        JOIN commerce_game_selections gs ON gs.checkout_id=s.checkout_attempt_id AND gs.buyer_id=e.buyer_id AND gs.offering_id=e.offering_id
        WHERE gs.assignment_id=$1 AND e.source_type='subscription'`,
          [a.id],
        )
      ).rows;
      const entitlements: CommerceEligibilityState[] = [];
      for (const row of rows) {
        const state = await roleStore.buildEntitlementState(row.id, "present");
        const saved = await roleStore.readState(row.id);
        if (state) entitlements.push({ ...state, adminAction: saved?.adminAction ?? null });
      }
      // Financial revocation and unlink cleanup do not depend on Discord availability.
      // Membership is required only when a financial source and the original identity
      // could justify access. Failure here remains unknown; it never fabricates departure.
      const identity = await identities.readIdentity(a.guildId, a.userId, "steam", a.subject);
      if (
        identity?.active &&
        identity.assurance === "authenticated" &&
        entitlements.some((e) => commerceEligibility(e, now()).action === "assign")
      ) {
        const member = await (input.memberState ?? discord.readMemberState.bind(discord))(
          a.guildId,
          a.userId,
        );
        for (const e of entitlements) e.memberState = member;
      }
      const checkout = (
        await db.queryResult<{
          status: string | null;
          subscribed: number;
          provider_terminal_at_ms: number | null;
          pre_session_failed_at_ms: number | null;
        }>(
          `SELECT c.status,c.provider_terminal_at_ms,c.pre_session_failed_at_ms, EXISTS(SELECT 1 FROM commerce_subscriptions s WHERE s.checkout_attempt_id=gs.checkout_id AND s.buyer_id=gs.buyer_id AND s.offering_id=gs.offering_id) AS subscribed FROM commerce_game_selections gs
        LEFT JOIN commerce_checkout_attempts c ON c.id=gs.checkout_id WHERE gs.assignment_id=$1`,
          [a.id],
        )
      ).rows;
      let grantsAllowed = false;
      if (input.enabled && input.steamEnabled) {
        for (const selected of await input.store.selections(a.id)) {
          const config = await input.store.config(selected.offeringId);
          const sf = await storefronts.readStorefront(selected.offeringId);
          if (
            rows.some(
              (row) =>
                row.offering_id === selected.offeringId &&
                entitlements.some(
                  (e) =>
                    e.entitlementId === row.id && commerceEligibility(e, now()).action === "assign",
                ),
            ) &&
            config?.acceptingSales &&
            sf?.publishContext.premiumActive &&
            sf.publishContext.sellerEligible &&
            sf.publishContext.termsAccepted &&
            sf.offering.state === "published"
          )
            grantsAllowed = true;
        }
      }
      return {
        entitlements,
        grantsAllowed,
        unpaidAllocationsTerminal:
          checkout.length > 0 &&
          checkout.every(
            (c) =>
              c.provider_terminal_at_ms !== null ||
              (c.status === "failed" && c.pre_session_failed_at_ms !== null) ||
              Boolean(c.subscribed),
          ),
      };
    },
    async audit(event) {
      await db.queryResult(
        "INSERT INTO commerce_game_audit(id,guild_id,created_at_ms,data) VALUES($1,$2,$3,$4)",
        [crypto.randomUUID(), event.guildId, now(), JSON.stringify(event)],
      );
      if (event.assignmentId && event.state === "needs-attention") {
        await db.queryResult(
          `INSERT INTO commerce_incidents(id,connected_account_id,guild_id,incident_key,severity,status,summary_code,entity_type,entity_id,safe_args_json,occurrence_count,first_seen_at_ms,last_seen_at_ms,created_at_ms,updated_at_ms)
          SELECT $1,a.id,a.guild_id,$2,'error','open','commerce_reserved_access_needs_attention','game_access',$3,'{}',1,$4,$5,$6,$7
          FROM commerce_connected_accounts a WHERE a.guild_id=$8
          ON CONFLICT(guild_id,incident_key) DO UPDATE SET status='open',last_seen_at_ms=excluded.last_seen_at_ms,updated_at_ms=excluded.updated_at_ms,resolved_at_ms=NULL,occurrence_count=commerce_incidents.occurrence_count+1`,
          [
            crypto.randomUUID(),
            `reserved-access:${event.assignmentId}`,
            event.assignmentId,
            now(),
            now(),
            now(),
            now(),
            event.guildId,
          ],
        );
      } else if (
        event.assignmentId &&
        event.state &&
        ["managed", "removed", "externally-managed", "withheld"].includes(event.state)
      ) {
        await db.queryResult(
          "UPDATE commerce_incidents SET status='resolved',resolved_at_ms=$1,updated_at_ms=$2 WHERE guild_id=$3 AND incident_key=$4 AND status='open'",
          [now(), now(), event.guildId, `reserved-access:${event.assignmentId}`],
        );
      }
    },
  });
  const hooks: GameAccessCheckoutHooks = {
    revalidate: (checkoutId, guildId, userId) =>
      service.revalidateCheckout(checkoutId, guildId, userId),
    async configuration(offeringId) {
      const config = await input.store.config(offeringId);
      return config
        ? { acceptingSales: Boolean(config.acceptingSales && input.enabled && input.steamEnabled) }
        : null;
    },
    choices: (guildId, userId) => service.choices(guildId, userId),
    prepare: (data) => service.checkout(data),
    async status({ offeringId, guildId, buyerId, userId, checkoutId }) {
      const config = await input.store.config(offeringId);
      if (!config || config.guildId !== guildId) return null;
      const selected = checkoutId ? await input.store.selection(checkoutId) : null;
      if (
        selected?.offeringId === offeringId &&
        selected.guildId === guildId &&
        selected.buyerId === buyerId &&
        selected.userId === userId
      ) {
        const a = await input.store.read(selected.assignmentId);
        if (a?.guildId === guildId && a.userId === userId && a.subject === selected.subject)
          return { state: a.state, reason: a.reason };
      }
      return { state: "pending", reason: "provider_validation_required" };
    },
  };
  return {
    sweepOutbox: () => (input.queue ? service.sweepOutbox(input.queue) : Promise.resolve(0)),
    service,
    hooks,
    store: input.store,
    targets: (guildId: string) => input.wardogs.list(guildId),
  };
}

export const COMMERCE_GAME_QUEUE_NAME = "haf-bot-commerce-game-access";
function validMessage(value: unknown): value is GameAccessMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.assignments) &&
    value.assignments.length > 0 &&
    value.assignments.length <= 50 &&
    value.assignments.every(
      (a) =>
        isRecord(a) &&
        Object.keys(a).length === 3 &&
        typeof a.assignmentId === "string" &&
        a.assignmentId.length > 0 &&
        a.assignmentId.length <= 100 &&
        Number.isSafeInteger(a.generation) &&
        Number(a.generation) > 0 &&
        Number.isSafeInteger(a.revision) &&
        Number(a.revision) > 0,
    )
  );
}
export interface CommerceGameAccessDeliveryPort {
  service: Pick<ReturnType<typeof createGameAccessRuntime>["service"], "processMessage">;
}

export async function deliverCommerceGameAccess(
  payload: unknown,
  metadata: QueueJobMetadata,
  runtime: CommerceGameAccessDeliveryPort,
): Promise<QueueDeliveryOutcome> {
  return deliverQueueJob(payload, {
    metadata,
    parse(body) {
      return validMessage(body)
        ? { ok: true, value: body }
        : { ok: false, reasonCode: "invalid_commerce_game_message" };
    },
    async handle(message) {
      try {
        await runtime.service.processMessage(message);
        return { status: "complete" };
      } catch {
        return { status: "retry", reasonCode: "commerce_game_access_delivery_failed" };
      }
    },
  });
}
