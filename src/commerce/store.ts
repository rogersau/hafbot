import type {
  CommerceBuyer,
  CommerceAuthorityGrant,
  CommerceCapability,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceDelivery,
  CommerceDispute,
  CommerceEntitlement,
  CommerceIncident,
  CommerceOffering,
  CommerceOperation,
  CommercePayment,
  CommercePrice,
  CommerceRefund,
  CommerceRoleAssignment,
  CommerceSellerAcceptance,
  CommerceSellerControl,
  CommerceSellerProfile,
  CommerceSellerReviewRequest,
  CommerceSalesPanel,
  CommerceSubscription,
  CommerceSyncState,
  CommerceWebhookEvent,
} from "./types";

export interface CommerceSellerStore {
  readConnectedAccountByGuild(guildId: string): Promise<CommerceConnectedAccount | null>;
  saveConnectedAccount(account: CommerceConnectedAccount): Promise<void>;
  appendSellerAcceptance(acceptance: CommerceSellerAcceptance): Promise<boolean>;
  readSellerAcceptance(
    connectedAccountId: string,
    termsVersion: string,
  ): Promise<CommerceSellerAcceptance | null>;
  readSellerProfile(connectedAccountId: string): Promise<CommerceSellerProfile | null>;
  listSellerProfiles(
    approvalState?: CommerceSellerProfile["approvalState"],
  ): Promise<CommerceSellerProfile[]>;
  saveSellerProfile(profile: CommerceSellerProfile): Promise<void>;
  readSellerReviewRequest(connectedAccountId: string): Promise<CommerceSellerReviewRequest | null>;
  ensureSellerReviewRequest(input: {
    id: string;
    connectedAccountId: string;
    guildId: string;
    sellerOwnerUserId: string;
    guildCreatedAtMs: number;
    stripeDetailsSubmitted: boolean;
    stripeChargesEnabled: boolean;
    stripePayoutsEnabled: boolean;
    nowMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  claimSellerReviewNotification(input: {
    connectedAccountId: string;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  completeSellerReviewNotification(input: {
    connectedAccountId: string;
    leaseToken: string;
    channelId: string;
    messageId: string;
    nowMs: number;
  }): Promise<boolean>;
  claimSellerReviewDecision(input: {
    connectedAccountId: string;
    state: "approved" | "rejected";
    actorUserId: string;
    reason: string;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  reclaimExpiredSellerReviewDecision(input: {
    connectedAccountId: string;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  completeSellerReviewDecision(input: {
    connectedAccountId: string;
    state: "approved" | "rejected";
    leaseToken: string;
    nowMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  listPendingSellerReviewNotifications(limit?: number): Promise<CommerceSellerReviewRequest[]>;
  listExpiredSellerReviewDecisions(
    nowMs: number,
    limit?: number,
  ): Promise<CommerceSellerReviewRequest[]>;
  claimSellerReviewDecisionNotification(input: {
    connectedAccountId: string;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<CommerceSellerReviewRequest | null>;
  completeSellerReviewDecisionNotification(input: {
    connectedAccountId: string;
    leaseToken: string;
    nowMs: number;
  }): Promise<boolean>;
  listUnnotifiedSellerReviewDecisions(limit?: number): Promise<CommerceSellerReviewRequest[]>;
  readSellerCapabilities(
    connectedAccountId: string,
    discordUserId: string,
  ): Promise<CommerceCapability[]>;
  saveAuthorityGrant(grant: CommerceAuthorityGrant): Promise<void>;
  readSellerControl(
    scopeType: CommerceSellerControl["scopeType"],
    scopeId: string,
  ): Promise<CommerceSellerControl | null>;
  saveSellerControl(control: CommerceSellerControl): Promise<void>;
}

export interface CommerceSalesPanelStore {
  readSalesPanel(connectedAccountId: string): Promise<CommerceSalesPanel | null>;
  saveSalesPanel(panel: CommerceSalesPanel): Promise<void>;
  claimSalesPanelPublication(input: {
    connectedAccountId: string;
    guildId: string;
    targetChannelId: string;
    title: string;
    description: string;
    leaseToken: string;
    createNonce: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<{
    panel: CommerceSalesPanel;
    targetChannelId: string;
    title: string;
    description: string;
    createNonce: string;
    recovering: boolean;
  } | null>;
  completeSalesPanelPublication(input: {
    panel: CommerceSalesPanel;
    leaseToken: string;
  }): Promise<boolean>;
  failSalesPanelPublication(input: {
    connectedAccountId: string;
    leaseToken: string;
    errorCode: string;
    nowMs: number;
    preservePending: boolean;
  }): Promise<boolean>;
  deleteSalesPanelProjection(input: {
    connectedAccountId: string;
    leaseToken: string;
  }): Promise<boolean>;
}

export interface CommerceCatalogStore {
  saveOffering(offering: CommerceOffering): Promise<void>;
  createPrice(price: CommercePrice): Promise<boolean>;
  listOfferings(connectedAccountId: string): Promise<CommerceOffering[]>;
  listPrices(offeringId: string): Promise<CommercePrice[]>;
}

export interface CommerceBuyerStore {
  saveBuyer(buyer: CommerceBuyer): Promise<void>;
  saveCustomer(customer: CommerceCustomer): Promise<void>;
  saveSubscription(subscription: CommerceSubscription): Promise<void>;
  saveEntitlement(entitlement: CommerceEntitlement): Promise<void>;
  saveRoleAssignment(assignment: CommerceRoleAssignment): Promise<void>;
  listSubscriptions(buyerId: string): Promise<CommerceSubscription[]>;
}

export interface CommerceProviderProjectionStore {
  savePayment(payment: CommercePayment): Promise<void>;
  saveRefund(refund: CommerceRefund): Promise<void>;
  saveDispute(dispute: CommerceDispute): Promise<void>;
  acceptWebhookEvent(event: CommerceWebhookEvent): Promise<boolean>;
  saveWebhookEvent(event: CommerceWebhookEvent): Promise<void>;
  saveSyncState(state: CommerceSyncState): Promise<void>;
}

export interface CommerceOperationsStore {
  appendOperation(operation: CommerceOperation): Promise<boolean>;
  enqueueDelivery(delivery: CommerceDelivery): Promise<boolean>;
  saveDelivery(delivery: CommerceDelivery): Promise<void>;
  saveIncident(incident: CommerceIncident): Promise<void>;
}

export interface CommerceStore
  extends
    CommerceSellerStore,
    CommerceSalesPanelStore,
    CommerceCatalogStore,
    CommerceBuyerStore,
    CommerceProviderProjectionStore,
    CommerceOperationsStore {}
