import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type {
  CommerceCapability,
  CommerceConnectedAccount,
  CommerceCurrency,
  CommerceOffering,
  CommercePrice,
  CommerceSellerControl,
  CommerceSellerProfile,
  CommerceSellerReviewRequest,
  CommerceSalesPanel,
  CommerceStore,
  CommerceSubscription,
} from "../commerce";
import {
  commerceBuyers,
  commerceAuthorityGrants,
  commerceConnectedAccounts,
  commerceCustomers,
  commerceDeliveryOutbox,
  commerceDisputes,
  commerceEntitlements,
  commerceIncidents,
  commerceOfferings,
  commerceOperationsLedger,
  commercePayments,
  commercePrices,
  commerceRefunds,
  commerceRoleAssignments,
  commerceSellerAcceptances,
  commerceSellerControls,
  commerceSellerProfiles,
  commerceSellerReviewRequests,
  commerceSalesPanels,
  commerceSubscriptions,
  commerceSyncState,
  commerceWebhookEvents,
} from "../db/commerce-schema";
import { createD1DrizzleDatabase } from "./drizzle-db";

const storeCache = new WeakMap<D1Database, CommerceStore>();

export function createCloudflareCommerceStore(database: D1Database): CommerceStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  const store: CommerceStore = {
    async readConnectedAccountByGuild(guildId) {
      const row =
        (
          await db
            .select()
            .from(commerceConnectedAccounts)
            .where(eq(commerceConnectedAccounts.guildId, guildId))
            .orderBy(asc(commerceConnectedAccounts.createdAtMs))
            .all()
        ).find((account) => account.status !== "archived") ?? null;
      return row ? connectedAccountFromRow(row) : null;
    },

    async saveConnectedAccount(account) {
      await db
        .insert(commerceConnectedAccounts)
        .values(account)
        .onConflictDoUpdate({
          target: commerceConnectedAccounts.id,
          set: {
            stripeAccountId: account.stripeAccountId,
            status: account.status,
            country: account.country,
            defaultCurrency: account.defaultCurrency,
            chargesEnabled: account.chargesEnabled,
            payoutsEnabled: account.payoutsEnabled,
            detailsSubmitted: account.detailsSubmitted,
            providerCreatedAtMs: account.providerCreatedAtMs,
            archivedAtMs: account.archivedAtMs,
            updatedAtMs: account.updatedAtMs,
          },
        })
        .run();
    },

    async appendSellerAcceptance(acceptance) {
      return Boolean(
        await db
          .insert(commerceSellerAcceptances)
          .values(acceptance)
          .onConflictDoNothing()
          .returning({ id: commerceSellerAcceptances.id })
          .get(),
      );
    },

    async readSellerAcceptance(connectedAccountId, termsVersion) {
      return (
        (await db
          .select()
          .from(commerceSellerAcceptances)
          .where(
            and(
              eq(commerceSellerAcceptances.connectedAccountId, connectedAccountId),
              eq(commerceSellerAcceptances.termsVersion, termsVersion),
            ),
          )
          .limit(1)
          .get()) ?? null
      );
    },

    async readSellerProfile(connectedAccountId) {
      const row = await db
        .select()
        .from(commerceSellerProfiles)
        .where(eq(commerceSellerProfiles.connectedAccountId, connectedAccountId))
        .limit(1)
        .get();
      return row ? sellerProfileFromRow(row) : null;
    },

    async listSellerProfiles(approvalState) {
      const rows = approvalState
        ? await db
            .select()
            .from(commerceSellerProfiles)
            .where(eq(commerceSellerProfiles.approvalState, approvalState))
            .orderBy(asc(commerceSellerProfiles.createdAtMs))
            .all()
        : await db
            .select()
            .from(commerceSellerProfiles)
            .orderBy(asc(commerceSellerProfiles.createdAtMs))
            .all();
      return rows.map(sellerProfileFromRow);
    },

    async saveSellerProfile(profile) {
      await db
        .insert(commerceSellerProfiles)
        .values(profile)
        .onConflictDoUpdate({
          target: commerceSellerProfiles.connectedAccountId,
          set: {
            sellerOwnerUserId: profile.sellerOwnerUserId,
            lifecycleState: profile.lifecycleState,
            approvalState: profile.approvalState,
            supportContact: profile.supportContact,
            adultAttestedAtMs: profile.adultAttestedAtMs,
            twoFactorEvidence: profile.twoFactorEvidence,
            guildCreatedAtMs: profile.guildCreatedAtMs,
            ownershipTransferredAtMs: profile.ownershipTransferredAtMs,
            guildGoodStanding: profile.guildGoodStanding,
            sellerGoodStanding: profile.sellerGoodStanding,
            requirementsCurrentlyDueJson: profile.requirementsCurrentlyDueJson,
            requirementsEventuallyDueJson: profile.requirementsEventuallyDueJson,
            requirementsPendingVerificationJson: profile.requirementsPendingVerificationJson,
            disabledReason: profile.disabledReason,
            reviewedByUserId: profile.reviewedByUserId,
            reviewedAtMs: profile.reviewedAtMs,
            capabilitiesUpdatedAtMs: profile.capabilitiesUpdatedAtMs,
            updatedAtMs: profile.updatedAtMs,
          },
        })
        .run();
    },

    async readSellerReviewRequest(connectedAccountId) {
      const row = await db
        .select()
        .from(commerceSellerReviewRequests)
        .where(eq(commerceSellerReviewRequests.connectedAccountId, connectedAccountId))
        .limit(1)
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async ensureSellerReviewRequest(input) {
      if (!input.stripeDetailsSubmitted) return null;
      await db
        .insert(commerceSellerReviewRequests)
        .values({
          id: input.id,
          connectedAccountId: input.connectedAccountId,
          guildId: input.guildId,
          sellerOwnerUserId: input.sellerOwnerUserId,
          guildCreatedAtMs: input.guildCreatedAtMs,
          state: "pending",
          stripeDetailsSubmitted: input.stripeDetailsSubmitted,
          stripeChargesEnabled: input.stripeChargesEnabled,
          stripePayoutsEnabled: input.stripePayoutsEnabled,
          createdAtMs: input.nowMs,
          updatedAtMs: input.nowMs,
        })
        .onConflictDoUpdate({
          target: commerceSellerReviewRequests.connectedAccountId,
          set: {
            stripeDetailsSubmitted: input.stripeDetailsSubmitted,
            stripeChargesEnabled: input.stripeChargesEnabled,
            stripePayoutsEnabled: input.stripePayoutsEnabled,
            guildCreatedAtMs: input.guildCreatedAtMs,
            updatedAtMs: input.nowMs,
          },
        })
        .run();
      const row = await db
        .select()
        .from(commerceSellerReviewRequests)
        .where(eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId))
        .limit(1)
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async claimSellerReviewNotification(input) {
      const expiresAtMs = input.nowMs + input.leaseMs;
      const claimed = await db
        .update(commerceSellerReviewRequests)
        .set({
          notificationLeaseToken: input.leaseToken,
          notificationLeaseExpiresAtMs: expiresAtMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.state, "pending"),
            isNull(commerceSellerReviewRequests.reviewMessageId),
            or(
              isNull(commerceSellerReviewRequests.notificationLeaseExpiresAtMs),
              sql`${commerceSellerReviewRequests.notificationLeaseExpiresAtMs} < ${input.nowMs}`,
            ),
          ),
        )
        .returning()
        .get();
      return claimed ? sellerReviewRequestFromRow(claimed) : null;
    },

    async completeSellerReviewNotification(input) {
      const result = await db
        .update(commerceSellerReviewRequests)
        .set({
          reviewChannelId: input.channelId,
          reviewMessageId: input.messageId,
          notificationLeaseToken: null,
          notificationLeaseExpiresAtMs: null,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.notificationLeaseToken, input.leaseToken),
            eq(commerceSellerReviewRequests.state, "pending"),
          ),
        )
        .returning({ id: commerceSellerReviewRequests.id })
        .get();
      return Boolean(result);
    },

    async claimSellerReviewDecision(input) {
      const row = await db
        .update(commerceSellerReviewRequests)
        .set({
          state: "processing",
          notificationLeaseToken: input.leaseToken,
          notificationLeaseExpiresAtMs: input.nowMs + input.leaseMs,
          decisionActorUserId: input.actorUserId,
          decisionState: input.state,
          decisionReason: input.reason,
          decidedAtMs: null,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.state, "pending"),
          ),
        )
        .returning()
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async reclaimExpiredSellerReviewDecision(input) {
      const row = await db
        .update(commerceSellerReviewRequests)
        .set({
          notificationLeaseToken: input.leaseToken,
          notificationLeaseExpiresAtMs: input.nowMs + input.leaseMs,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.state, "processing"),
            sql`${commerceSellerReviewRequests.notificationLeaseExpiresAtMs} < ${input.nowMs}`,
          ),
        )
        .returning()
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async completeSellerReviewDecision(input) {
      const row = await db
        .update(commerceSellerReviewRequests)
        .set({
          state: input.state,
          decisionState: null,
          decidedAtMs: input.nowMs,
          notificationLeaseToken: null,
          notificationLeaseExpiresAtMs: null,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.state, "processing"),
            eq(commerceSellerReviewRequests.decisionState, input.state),
            eq(commerceSellerReviewRequests.notificationLeaseToken, input.leaseToken),
          ),
        )
        .returning()
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async listPendingSellerReviewNotifications(limit = 50) {
      const rows = await db
        .select()
        .from(commerceSellerReviewRequests)
        .where(
          and(
            eq(commerceSellerReviewRequests.state, "pending"),
            isNull(commerceSellerReviewRequests.reviewMessageId),
          ),
        )
        .orderBy(asc(commerceSellerReviewRequests.createdAtMs))
        .limit(limit)
        .all();
      return rows.map(sellerReviewRequestFromRow);
    },

    async listExpiredSellerReviewDecisions(nowMs, limit = 50) {
      const rows = await db
        .select()
        .from(commerceSellerReviewRequests)
        .where(
          and(
            eq(commerceSellerReviewRequests.state, "processing"),
            sql`${commerceSellerReviewRequests.notificationLeaseExpiresAtMs} < ${nowMs}`,
          ),
        )
        .orderBy(asc(commerceSellerReviewRequests.updatedAtMs))
        .limit(limit)
        .all();
      return rows.map(sellerReviewRequestFromRow);
    },

    async claimSellerReviewDecisionNotification(input) {
      const row = await db
        .update(commerceSellerReviewRequests)
        .set({
          notificationLeaseToken: input.leaseToken,
          notificationLeaseExpiresAtMs: input.nowMs + input.leaseMs,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            or(
              eq(commerceSellerReviewRequests.state, "approved"),
              eq(commerceSellerReviewRequests.state, "rejected"),
            ),
            isNull(commerceSellerReviewRequests.decisionNotifiedAtMs),
            or(
              isNull(commerceSellerReviewRequests.notificationLeaseExpiresAtMs),
              sql`${commerceSellerReviewRequests.notificationLeaseExpiresAtMs} < ${input.nowMs}`,
            ),
          ),
        )
        .returning()
        .get();
      return row ? sellerReviewRequestFromRow(row) : null;
    },

    async completeSellerReviewDecisionNotification(input) {
      const result = await db
        .update(commerceSellerReviewRequests)
        .set({
          decisionNotifiedAtMs: input.nowMs,
          notificationLeaseToken: null,
          notificationLeaseExpiresAtMs: null,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(commerceSellerReviewRequests.connectedAccountId, input.connectedAccountId),
            eq(commerceSellerReviewRequests.notificationLeaseToken, input.leaseToken),
            isNull(commerceSellerReviewRequests.decisionNotifiedAtMs),
          ),
        )
        .returning({ id: commerceSellerReviewRequests.id })
        .get();
      return Boolean(result);
    },

    async listUnnotifiedSellerReviewDecisions(limit = 50) {
      const rows = await db
        .select()
        .from(commerceSellerReviewRequests)
        .where(
          and(
            or(
              eq(commerceSellerReviewRequests.state, "approved"),
              eq(commerceSellerReviewRequests.state, "rejected"),
            ),
            isNull(commerceSellerReviewRequests.decisionNotifiedAtMs),
          ),
        )
        .orderBy(asc(commerceSellerReviewRequests.updatedAtMs))
        .limit(limit)
        .all();
      return rows.map(sellerReviewRequestFromRow);
    },

    async readSellerCapabilities(connectedAccountId, discordUserId) {
      const rows = await db
        .select({ capability: commerceAuthorityGrants.capability })
        .from(commerceAuthorityGrants)
        .where(
          and(
            eq(commerceAuthorityGrants.connectedAccountId, connectedAccountId),
            eq(commerceAuthorityGrants.discordUserId, discordUserId),
            isNull(commerceAuthorityGrants.revokedAtMs),
          ),
        )
        .all();
      return rows.map(({ capability }) => capability as CommerceCapability);
    },

    async saveAuthorityGrant(grant) {
      await db
        .insert(commerceAuthorityGrants)
        .values(grant)
        .onConflictDoUpdate({
          target: [
            commerceAuthorityGrants.connectedAccountId,
            commerceAuthorityGrants.discordUserId,
            commerceAuthorityGrants.capability,
          ],
          set: {
            grantedByUserId: grant.grantedByUserId,
            grantedAtMs: grant.grantedAtMs,
            revokedAtMs: grant.revokedAtMs,
          },
        })
        .run();
    },

    async readSellerControl(scopeType, scopeId) {
      const row = await db
        .select()
        .from(commerceSellerControls)
        .where(
          and(
            eq(commerceSellerControls.scopeType, scopeType),
            eq(commerceSellerControls.scopeId, scopeId),
          ),
        )
        .limit(1)
        .get();
      return row ? sellerControlFromRow(row) : null;
    },

    async saveSellerControl(control) {
      await db
        .insert(commerceSellerControls)
        .values(control)
        .onConflictDoUpdate({
          target: [commerceSellerControls.scopeType, commerceSellerControls.scopeId],
          set: {
            suspended: control.suspended,
            reasonCode: control.reasonCode,
            actorUserId: control.actorUserId,
            updatedAtMs: control.updatedAtMs,
          },
        })
        .run();
    },

    async readSalesPanel(connectedAccountId) {
      const row = await db
        .select()
        .from(commerceSalesPanels)
        .where(eq(commerceSalesPanels.connectedAccountId, connectedAccountId))
        .limit(1)
        .get();
      return row ? salesPanelFromRow(row) : null;
    },

    async saveSalesPanel(panel) {
      await db
        .insert(commerceSalesPanels)
        .values(panel)
        .onConflictDoUpdate({
          target: commerceSalesPanels.connectedAccountId,
          set: {
            guildId: panel.guildId,
            channelId: panel.channelId,
            title: panel.title,
            description: panel.description,
            messageId: panel.messageId,
            lastErrorCode: panel.lastErrorCode,
            updatedAtMs: panel.updatedAtMs,
          },
        })
        .run();
    },

    async claimSalesPanelPublication(input) {
      const leaseExpiresAtMs = input.nowMs + input.leaseMs;
      const inserted = await database
        .prepare(
          `INSERT OR IGNORE INTO commerce_sales_panels (
             connected_account_id, guild_id, channel_id, title, description,
             message_id, last_error_code, pending_channel_id, pending_title,
             pending_description, publication_nonce, publication_lease_token,
             publication_lease_expires_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.connectedAccountId,
          input.guildId,
          input.targetChannelId,
          input.title,
          input.description,
          input.targetChannelId,
          input.title,
          input.description,
          input.createNonce,
          input.leaseToken,
          leaseExpiresAtMs,
          input.nowMs,
          input.nowMs,
        )
        .run();

      if (Number(inserted.meta.changes ?? 0) === 0) {
        const existing = await database
          .prepare(
            `SELECT guild_id FROM commerce_sales_panels WHERE connected_account_id = ? LIMIT 1`,
          )
          .bind(input.connectedAccountId)
          .first<{ guild_id: string }>();
        if (!existing) {
          const guildRow = await database
            .prepare(`SELECT connected_account_id FROM commerce_sales_panels WHERE guild_id = ?`)
            .bind(input.guildId)
            .first<{ connected_account_id: string }>();
          if (guildRow) throw new Error("commerce_sales_panel_guild_scope_mismatch");
          return null;
        }
        if (existing.guild_id !== input.guildId) {
          throw new Error("commerce_sales_panel_guild_scope_mismatch");
        }
        const claimed = await database
          .prepare(
            `UPDATE commerce_sales_panels
                SET pending_channel_id = COALESCE(pending_channel_id, ?),
                    pending_title = COALESCE(pending_title, ?),
                    pending_description = COALESCE(pending_description, ?),
                    publication_nonce = COALESCE(publication_nonce, ?),
                    publication_lease_token = ?, publication_lease_expires_at_ms = ?,
                    updated_at_ms = ?
              WHERE connected_account_id = ? AND guild_id = ?
                AND (publication_lease_token IS NULL
                  OR publication_lease_expires_at_ms IS NULL
                  OR publication_lease_expires_at_ms <= ?)`,
          )
          .bind(
            input.targetChannelId,
            input.title,
            input.description,
            input.createNonce,
            input.leaseToken,
            leaseExpiresAtMs,
            input.nowMs,
            input.connectedAccountId,
            input.guildId,
            input.nowMs,
          )
          .run();
        if (Number(claimed.meta.changes ?? 0) === 0) return null;
      }

      const row = await database
        .prepare(
          `SELECT connected_account_id, guild_id, channel_id, title, description,
                  message_id, last_error_code, pending_channel_id, pending_title,
                  pending_description, publication_nonce, created_at_ms, updated_at_ms
             FROM commerce_sales_panels
            WHERE connected_account_id = ? AND publication_lease_token = ? LIMIT 1`,
        )
        .bind(input.connectedAccountId, input.leaseToken)
        .first<SalesPanelPublicationRow>();
      if (
        !row ||
        !row.pending_channel_id ||
        row.pending_title === null ||
        row.pending_description === null ||
        !row.publication_nonce
      )
        return null;
      return {
        panel: salesPanelFromPublicationRow(row),
        targetChannelId: row.pending_channel_id,
        title: row.pending_title,
        description: row.pending_description,
        createNonce: row.publication_nonce,
        recovering: row.publication_nonce !== input.createNonce,
      };
    },

    async completeSalesPanelPublication(input) {
      const result = await database
        .prepare(
          `UPDATE commerce_sales_panels
              SET channel_id = ?, title = ?, description = ?, message_id = ?, last_error_code = ?,
                  pending_channel_id = NULL, pending_title = NULL, pending_description = NULL,
                  publication_nonce = NULL,
                  publication_lease_token = NULL, publication_lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE connected_account_id = ? AND publication_lease_token = ?`,
        )
        .bind(
          input.panel.channelId,
          input.panel.title,
          input.panel.description,
          input.panel.messageId,
          input.panel.lastErrorCode,
          input.panel.updatedAtMs,
          input.panel.connectedAccountId,
          input.leaseToken,
        )
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },

    async failSalesPanelPublication(input) {
      const result = await database
        .prepare(
          `UPDATE commerce_sales_panels
              SET last_error_code = ?,
                  pending_channel_id = CASE WHEN ? = 1 THEN pending_channel_id ELSE NULL END,
                  pending_title = CASE WHEN ? = 1 THEN pending_title ELSE NULL END,
                  pending_description = CASE WHEN ? = 1 THEN pending_description ELSE NULL END,
                  publication_nonce = CASE WHEN ? = 1 THEN publication_nonce ELSE NULL END,
                  publication_lease_token = NULL, publication_lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE connected_account_id = ? AND publication_lease_token = ?`,
        )
        .bind(
          input.errorCode,
          input.preservePending ? 1 : 0,
          input.preservePending ? 1 : 0,
          input.preservePending ? 1 : 0,
          input.preservePending ? 1 : 0,
          input.nowMs,
          input.connectedAccountId,
          input.leaseToken,
        )
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },

    async deleteSalesPanelProjection(input) {
      const result = await database
        .prepare(
          `DELETE FROM commerce_sales_panels
            WHERE connected_account_id = ? AND publication_lease_token = ?`,
        )
        .bind(input.connectedAccountId, input.leaseToken)
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },

    async saveOffering(offering) {
      await db
        .insert(commerceOfferings)
        .values(offering)
        .onConflictDoUpdate({
          target: commerceOfferings.id,
          set: {
            discordRoleId: offering.discordRoleId,
            name: offering.name,
            description: offering.description,
            purchaseType: offering.purchaseType,
            status: offering.status,
            archivedAtMs: offering.archivedAtMs,
            updatedAtMs: offering.updatedAtMs,
          },
        })
        .run();
    },

    async createPrice(price) {
      return Boolean(
        await db
          .insert(commercePrices)
          .values(price)
          .onConflictDoNothing()
          .returning({ id: commercePrices.id })
          .get(),
      );
    },

    async listOfferings(connectedAccountId) {
      const rows = await db
        .select()
        .from(commerceOfferings)
        .where(eq(commerceOfferings.connectedAccountId, connectedAccountId))
        .orderBy(asc(commerceOfferings.createdAtMs))
        .all();
      return rows.map(offeringFromRow);
    },

    async listPrices(offeringId) {
      const rows = await db
        .select()
        .from(commercePrices)
        .where(eq(commercePrices.offeringId, offeringId))
        .orderBy(asc(commercePrices.createdAtMs))
        .all();
      return rows.map(priceFromRow);
    },

    async saveBuyer(buyer) {
      await db
        .insert(commerceBuyers)
        .values(buyer)
        .onConflictDoUpdate({
          target: commerceBuyers.id,
          set: {
            discordUserId: buyer.discordUserId,
            updatedAtMs: buyer.updatedAtMs,
          },
        })
        .run();
    },

    async saveCustomer(customer) {
      await db
        .insert(commerceCustomers)
        .values(customer)
        .onConflictDoUpdate({
          target: commerceCustomers.id,
          set: {
            stripeCustomerId: customer.stripeCustomerId,
            updatedAtMs: customer.updatedAtMs,
          },
        })
        .run();
    },

    async saveSubscription(subscription) {
      await db
        .insert(commerceSubscriptions)
        .values(subscription)
        .onConflictDoUpdate({
          target: commerceSubscriptions.id,
          set: {
            checkoutAttemptId: subscription.checkoutAttemptId,
            customerId: subscription.customerId,
            buyerId: subscription.buyerId,
            offeringId: subscription.offeringId,
            priceId: subscription.priceId,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            currentPeriodStartMs: subscription.currentPeriodStartMs,
            currentPeriodEndMs: subscription.currentPeriodEndMs,
            canceledAtMs: subscription.canceledAtMs,
            endedAtMs: subscription.endedAtMs,
            providerUpdatedAtMs: subscription.providerUpdatedAtMs,
            latestInvoiceId: subscription.latestInvoiceId,
            latestInvoiceStatus: subscription.latestInvoiceStatus,
            latestPaymentIntentId: subscription.latestPaymentIntentId,
            latestPaymentStatus: subscription.latestPaymentStatus,
            graceStartedAtMs: subscription.graceStartedAtMs,
            graceEndsAtMs: subscription.graceEndsAtMs,
            updatedAtMs: subscription.updatedAtMs,
          },
        })
        .run();
    },

    async saveEntitlement(entitlement) {
      await db
        .insert(commerceEntitlements)
        .values(entitlement)
        .onConflictDoUpdate({
          target: commerceEntitlements.id,
          set: {
            status: entitlement.status,
            effectiveAtMs: entitlement.effectiveAtMs,
            expiresAtMs: entitlement.expiresAtMs,
            revokedAtMs: entitlement.revokedAtMs,
            updatedAtMs: entitlement.updatedAtMs,
          },
        })
        .run();
    },

    async saveRoleAssignment(assignment) {
      await db
        .insert(commerceRoleAssignments)
        .values(assignment)
        .onConflictDoUpdate({
          target: commerceRoleAssignments.id,
          set: {
            status: assignment.status,
            attemptCount: assignment.attemptCount,
            lastErrorCode: assignment.lastErrorCode,
            nextAttemptAtMs: assignment.nextAttemptAtMs,
            assignedAtMs: assignment.assignedAtMs,
            removedAtMs: assignment.removedAtMs,
            updatedAtMs: assignment.updatedAtMs,
          },
        })
        .run();
    },

    async listSubscriptions(buyerId) {
      const rows = await db
        .select()
        .from(commerceSubscriptions)
        .where(eq(commerceSubscriptions.buyerId, buyerId))
        .orderBy(asc(commerceSubscriptions.createdAtMs))
        .all();
      return rows.map(subscriptionFromRow);
    },

    async savePayment(payment) {
      await db
        .insert(commercePayments)
        .values(payment)
        .onConflictDoUpdate({
          target: commercePayments.id,
          set: {
            stripeChargeId: payment.stripeChargeId,
            stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
            amountReceivedMinor: payment.amountReceivedMinor,
            amountRefundedMinor: payment.amountRefundedMinor,
            applicationFeeMinor: payment.applicationFeeMinor,
            stripeFeeMinor: payment.stripeFeeMinor,
            status: payment.status,
            paidAtMs: payment.paidAtMs,
            updatedAtMs: payment.updatedAtMs,
          },
        })
        .run();
    },

    async saveRefund(refund) {
      await db
        .insert(commerceRefunds)
        .values(refund)
        .onConflictDoUpdate({
          target: commerceRefunds.id,
          set: {
            status: refund.status,
            reason: refund.reason,
            updatedAtMs: refund.updatedAtMs,
          },
        })
        .run();
    },

    async saveDispute(dispute) {
      await db
        .insert(commerceDisputes)
        .values(dispute)
        .onConflictDoUpdate({
          target: commerceDisputes.id,
          set: {
            status: dispute.status,
            reason: dispute.reason,
            closedAtMs: dispute.closedAtMs,
            updatedAtMs: dispute.updatedAtMs,
          },
        })
        .run();
    },

    async acceptWebhookEvent(event) {
      return Boolean(
        await db
          .insert(commerceWebhookEvents)
          .values(event)
          .onConflictDoNothing()
          .returning({ id: commerceWebhookEvents.id })
          .get(),
      );
    },

    async saveWebhookEvent(event) {
      await db
        .insert(commerceWebhookEvents)
        .values(event)
        .onConflictDoUpdate({
          target: commerceWebhookEvents.id,
          set: {
            status: event.status,
            attemptCount: event.attemptCount,
            lastErrorCode: event.lastErrorCode,
            processedAtMs: event.processedAtMs,
            updatedAtMs: event.updatedAtMs,
          },
        })
        .run();
    },

    async saveSyncState(state) {
      await db
        .insert(commerceSyncState)
        .values(state)
        .onConflictDoUpdate({
          target: commerceSyncState.id,
          set: {
            status: state.status,
            providerUpdatedAtMs: state.providerUpdatedAtMs,
            providerEventId: state.providerEventId,
            lastSyncedAtMs: state.lastSyncedAtMs,
            lastErrorCode: state.lastErrorCode,
            generation: state.generation,
            appliedGeneration: state.appliedGeneration,
            leaseToken: state.leaseToken,
            leaseExpiresAtMs: state.leaseExpiresAtMs,
            updatedAtMs: state.updatedAtMs,
          },
        })
        .run();
    },

    async appendOperation(operation) {
      return Boolean(
        await db
          .insert(commerceOperationsLedger)
          .values(operation)
          .onConflictDoNothing()
          .returning({ id: commerceOperationsLedger.id })
          .get(),
      );
    },

    async enqueueDelivery(delivery) {
      return Boolean(
        await db
          .insert(commerceDeliveryOutbox)
          .values(delivery)
          .onConflictDoNothing()
          .returning({ id: commerceDeliveryOutbox.id })
          .get(),
      );
    },

    async saveDelivery(delivery) {
      await db
        .insert(commerceDeliveryOutbox)
        .values(delivery)
        .onConflictDoUpdate({
          target: commerceDeliveryOutbox.id,
          set: {
            status: delivery.status,
            attemptCount: delivery.attemptCount,
            availableAtMs: delivery.availableAtMs,
            lastErrorCode: delivery.lastErrorCode,
            deliveredAtMs: delivery.deliveredAtMs,
            updatedAtMs: delivery.updatedAtMs,
          },
        })
        .run();
    },

    async saveIncident(incident) {
      await db
        .insert(commerceIncidents)
        .values(incident)
        .onConflictDoUpdate({
          target: commerceIncidents.id,
          set: {
            severity: incident.severity,
            status: incident.status,
            summaryCode: incident.summaryCode,
            entityType: incident.entityType,
            entityId: incident.entityId,
            safeArgsJson: incident.safeArgsJson,
            occurrenceCount: incident.occurrenceCount,
            lastSeenAtMs: incident.lastSeenAtMs,
            resolvedAtMs: incident.resolvedAtMs,
            updatedAtMs: incident.updatedAtMs,
          },
        })
        .run();
    },
  };

  storeCache.set(database, store);
  return store;
}

function connectedAccountFromRow(
  row: typeof commerceConnectedAccounts.$inferSelect,
): CommerceConnectedAccount {
  if (
    row.status !== "pending" &&
    row.status !== "active" &&
    row.status !== "restricted" &&
    row.status !== "disconnected" &&
    row.status !== "archived"
  ) {
    throw new Error(`Invalid commerce connected account status in storage: ${row.status}`);
  }
  return { ...row, status: row.status, defaultCurrency: currencyOrNull(row.defaultCurrency) };
}

function sellerProfileFromRow(
  row: typeof commerceSellerProfiles.$inferSelect,
): CommerceSellerProfile {
  if (
    row.lifecycleState !== "onboarding_incomplete" &&
    row.lifecycleState !== "pending_review" &&
    row.lifecycleState !== "active" &&
    row.lifecycleState !== "restricted" &&
    row.lifecycleState !== "repair_required" &&
    row.lifecycleState !== "offboarding" &&
    row.lifecycleState !== "disconnected" &&
    row.lifecycleState !== "suspended"
  ) {
    throw new Error(`Invalid commerce seller lifecycle state in storage: ${row.lifecycleState}`);
  }
  if (
    row.approvalState !== "pending" &&
    row.approvalState !== "approved" &&
    row.approvalState !== "rejected"
  ) {
    throw new Error(`Invalid commerce seller approval state in storage: ${row.approvalState}`);
  }
  if (row.twoFactorEvidence !== "discord_verified" && row.twoFactorEvidence !== "seller_attested") {
    throw new Error(
      `Invalid commerce seller two-factor evidence in storage: ${row.twoFactorEvidence}`,
    );
  }
  return {
    ...row,
    lifecycleState: row.lifecycleState,
    approvalState: row.approvalState,
    twoFactorEvidence: row.twoFactorEvidence,
  };
}

function sellerReviewRequestFromRow(
  row: typeof commerceSellerReviewRequests.$inferSelect,
): CommerceSellerReviewRequest {
  if (
    row.state !== "pending" &&
    row.state !== "processing" &&
    row.state !== "approved" &&
    row.state !== "rejected"
  ) {
    throw new Error(`Invalid commerce seller review state in storage: ${row.state}`);
  }
  if (
    row.decisionState !== null &&
    row.decisionState !== "approved" &&
    row.decisionState !== "rejected"
  ) {
    throw new Error(
      `Invalid commerce seller review decision state in storage: ${row.decisionState}`,
    );
  }
  return { ...row, state: row.state, decisionState: row.decisionState };
}

function sellerControlFromRow(
  row: typeof commerceSellerControls.$inferSelect,
): CommerceSellerControl {
  if (row.scopeType !== "global" && row.scopeType !== "guild") {
    throw new Error(`Invalid commerce seller control scope in storage: ${row.scopeType}`);
  }
  return { ...row, scopeType: row.scopeType };
}

function salesPanelFromRow(row: typeof commerceSalesPanels.$inferSelect): CommerceSalesPanel {
  return {
    connectedAccountId: row.connectedAccountId,
    guildId: row.guildId,
    channelId: row.channelId,
    title: row.title,
    description: row.description,
    messageId: row.messageId,
    lastErrorCode: row.lastErrorCode,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

interface SalesPanelPublicationRow {
  connected_account_id: string;
  guild_id: string;
  channel_id: string;
  title: string;
  description: string;
  message_id: string | null;
  last_error_code: string | null;
  pending_channel_id: string | null;
  pending_title: string | null;
  pending_description: string | null;
  publication_nonce: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function salesPanelFromPublicationRow(row: SalesPanelPublicationRow): CommerceSalesPanel {
  return {
    connectedAccountId: row.connected_account_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description,
    messageId: row.message_id,
    lastErrorCode: row.last_error_code,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function offeringFromRow(row: typeof commerceOfferings.$inferSelect): CommerceOffering {
  if (row.purchaseType !== "subscription" && row.purchaseType !== "one_time") {
    throw new Error(`Invalid commerce offering purchase type in storage: ${row.purchaseType}`);
  }
  if (row.status !== "draft" && row.status !== "active" && row.status !== "archived") {
    throw new Error(`Invalid commerce offering status in storage: ${row.status}`);
  }
  return { ...row, purchaseType: row.purchaseType, status: row.status };
}

function priceFromRow(row: typeof commercePrices.$inferSelect): CommercePrice {
  const currency = requiredCurrency(row.currency);
  if (row.priceType !== "recurring" && row.priceType !== "one_time") {
    throw new Error(`Invalid commerce price type in storage: ${row.priceType}`);
  }
  if (
    row.recurringInterval !== null &&
    row.recurringInterval !== "month" &&
    row.recurringInterval !== "year"
  ) {
    throw new Error(`Invalid commerce recurring interval in storage: ${row.recurringInterval}`);
  }
  if (row.status !== "active" && row.status !== "retired") {
    throw new Error(`Invalid commerce price status in storage: ${row.status}`);
  }
  return {
    ...row,
    currency,
    priceType: row.priceType,
    recurringInterval: row.recurringInterval,
    status: row.status,
  };
}

function subscriptionFromRow(row: typeof commerceSubscriptions.$inferSelect): CommerceSubscription {
  if (
    row.status !== "incomplete" &&
    row.status !== "trialing" &&
    row.status !== "active" &&
    row.status !== "past_due" &&
    row.status !== "paused" &&
    row.status !== "unpaid" &&
    row.status !== "canceled" &&
    row.status !== "ended"
  ) {
    throw new Error(`Invalid commerce subscription status in storage: ${row.status}`);
  }
  const latestInvoiceStatus = row.latestInvoiceStatus;
  if (
    latestInvoiceStatus !== null &&
    latestInvoiceStatus !== "draft" &&
    latestInvoiceStatus !== "open" &&
    latestInvoiceStatus !== "paid" &&
    latestInvoiceStatus !== "uncollectible" &&
    latestInvoiceStatus !== "void"
  ) {
    throw new Error(`Invalid commerce invoice status in storage: ${latestInvoiceStatus}`);
  }
  const latestPaymentStatus = row.latestPaymentStatus;
  if (
    latestPaymentStatus !== null &&
    latestPaymentStatus !== "requires_action" &&
    latestPaymentStatus !== "processing" &&
    latestPaymentStatus !== "succeeded" &&
    latestPaymentStatus !== "failed" &&
    latestPaymentStatus !== "canceled"
  ) {
    throw new Error(`Invalid commerce payment status in storage: ${latestPaymentStatus}`);
  }
  return { ...row, status: row.status, latestInvoiceStatus, latestPaymentStatus };
}

function requiredCurrency(value: string): CommerceCurrency {
  if (value !== "AUD" && value !== "USD") {
    throw new Error(`Invalid commerce currency in storage: ${value}`);
  }
  return value;
}

function currencyOrNull(value: string | null): CommerceCurrency | null {
  return value === null ? null : requiredCurrency(value);
}
