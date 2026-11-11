import type { CreateChannelMessageInput } from "../discord/messages";
import type { CommerceOfferingDashboard, CommerceOfferingStore } from "./offering-service";
import { isCommerceNewPurchaseBlocked, type CommerceSafeguardDashboard } from "./safeguards";
import type { CommerceSupportPage } from "./support-payments";
import type { CommerceSalesPanel } from "./types";
import type { CommerceStore } from "./store";

const MAX_BUTTONS = 25;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_EMBED_FIELDS = 25;
const MAX_FIELD_VALUE = 1_024;
const MAX_FIELD_NAME = 256;
const MAX_BUTTON_LABEL = 80;
const MAX_DESCRIPTION = 4_096;
const MAX_EMBED_TOTAL = 6_000;
const PUBLICATION_LEASE_MS = 60_000;
const SALES_PANEL_FOOTER = "Sold by this Discord server · HAF Bot facilitates payment";

export const DEFAULT_COMMERCE_SALES_PANEL_TITLE = "Support this Discord server";
export const DEFAULT_COMMERCE_SALES_PANEL_DESCRIPTION =
  "Discover paid Discord role access from this server.";

export type CommerceSalesPanelOffering = CommerceOfferingDashboard["offerings"][number];

export interface CommerceSalesPanelDiscordAdapter {
  publish(input: {
    guildId: string;
    channelId: string;
    messageId: string | null;
    message: CreateChannelMessageInput;
    createNonce: string;
  }): Promise<{ messageId: string; created: boolean }>;
  deleteMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
}

export interface CommerceSalesPanelServiceOptions {
  store: Pick<
    CommerceStore,
    | "readConnectedAccountByGuild"
    | "readSalesPanel"
    | "claimSalesPanelPublication"
    | "completeSalesPanelPublication"
    | "failSalesPanelPublication"
    | "deleteSalesPanelProjection"
  >;
  catalog: Pick<CommerceOfferingStore, "readDashboard" | "readPublishContext">;
  discord: CommerceSalesPanelDiscordAdapter;
  support?: Pick<CommerceSupportServiceLike, "page">;
  safeguards?: Pick<CommerceSafeguardsServiceLike, "readDashboard">;
  publicBaseUrl: string;
  now?: () => number;
  createLeaseToken?: () => string;
  createNonce?: () => string;
}

interface CommerceSupportServiceLike {
  page(guildId: string): Promise<CommerceSupportPage>;
}

interface CommerceSafeguardsServiceLike {
  readDashboard(guildId: string): Promise<CommerceSafeguardDashboard | null>;
}

export class CommerceSalesPanelService {
  private readonly now: () => number;
  private readonly createLeaseToken: () => string;
  private readonly createNonce: () => string;

  constructor(private readonly options: CommerceSalesPanelServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createLeaseToken = options.createLeaseToken ?? (() => crypto.randomUUID());
    this.createNonce =
      options.createNonce ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 25));
    if (!options.publicBaseUrl.trim()) throw new Error("commerce_sales_panel_base_url_missing");
  }

  read(connectedAccountId: string): Promise<CommerceSalesPanel | null> {
    return this.options.store.readSalesPanel(connectedAccountId);
  }

  async publish(input: {
    connectedAccountId: string;
    guildId: string;
    channelId: string;
    title?: string;
    description?: string;
  }): Promise<CommerceSalesPanel> {
    const account = await this.options.store.readConnectedAccountByGuild(input.guildId);
    if (!account || account.id !== input.connectedAccountId) {
      throw new Error("commerce_sales_panel_seller_scope_mismatch");
    }
    const copy = normalizeCommerceSalesPanelCopy({
      title: input.title ?? DEFAULT_COMMERCE_SALES_PANEL_TITLE,
      description: input.description ?? DEFAULT_COMMERCE_SALES_PANEL_DESCRIPTION,
    });
    const leaseToken = this.createLeaseToken();
    const claim = await this.options.store.claimSalesPanelPublication({
      connectedAccountId: input.connectedAccountId,
      guildId: input.guildId,
      targetChannelId: input.channelId,
      title: copy.title,
      description: copy.description,
      leaseToken,
      createNonce: this.createNonce(),
      nowMs: this.now(),
      leaseMs: PUBLICATION_LEASE_MS,
    });
    if (!claim) throw new Error("commerce_sales_panel_publication_in_progress");
    const existing = claim.panel;

    let published: { messageId: string; created: boolean };
    try {
      const message = await this.buildMessage(
        input.connectedAccountId,
        input.guildId,
        claim.title,
        claim.description,
      );
      if (existing.messageId && existing.channelId !== claim.targetChannelId) {
        await this.options.discord.deleteMessage(
          input.guildId,
          existing.channelId,
          existing.messageId,
        );
      }
      published = await this.options.discord.publish({
        guildId: input.guildId,
        channelId: claim.targetChannelId,
        messageId:
          existing.channelId === claim.targetChannelId ? (existing.messageId ?? null) : null,
        message,
        createNonce: claim.createNonce,
      });
    } catch (error) {
      await this.failPublication(input.connectedAccountId, leaseToken, true);
      throw error;
    }

    const nowMs = this.now();
    const panel: CommerceSalesPanel = {
      connectedAccountId: input.connectedAccountId,
      guildId: input.guildId,
      channelId: claim.targetChannelId,
      title: claim.title,
      description: claim.description,
      messageId: published.messageId,
      lastErrorCode: null,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: nowMs,
    };
    if (!(await this.completePublication(panel, leaseToken))) {
      let compensated = !published.created;
      if (published.created) {
        try {
          await this.options.discord.deleteMessage(
            input.guildId,
            claim.targetChannelId,
            published.messageId,
          );
          compensated = true;
        } catch {
          compensated = false;
        }
      }
      await this.failPublication(input.connectedAccountId, leaseToken, !compensated);
      throw new Error(
        compensated
          ? "commerce_sales_panel_persistence_failed"
          : "commerce_sales_panel_partial_success",
      );
    }
    return panel;
  }

  async refreshForGuild(guildId: string): Promise<CommerceSalesPanel | null> {
    const account = await this.options.store.readConnectedAccountByGuild(guildId);
    if (!account) return null;
    const existing = await this.options.store.readSalesPanel(account.id);
    if (!existing) return null;
    try {
      return await this.publish({
        connectedAccountId: account.id,
        guildId,
        channelId: existing.channelId,
        title: existing.title,
        description: existing.description,
      });
    } catch {
      // publish() records the safe refresh error against the existing projection.
      throw new Error("commerce_sales_panel_refresh_failed");
    }
  }

  async unpublish(input: {
    connectedAccountId: string;
    guildId: string;
  }): Promise<CommerceSalesPanel | null> {
    return this.remove(input, false);
  }

  async removeForOffboarding(input: {
    connectedAccountId: string;
    guildId: string;
  }): Promise<CommerceSalesPanel | null> {
    return this.remove(input, true);
  }

  private async remove(
    input: { connectedAccountId: string; guildId: string },
    deleteProjection: boolean,
  ): Promise<CommerceSalesPanel | null> {
    const existing = await this.options.store.readSalesPanel(input.connectedAccountId);
    if (!existing) return null;
    if (existing.guildId !== input.guildId) {
      throw new Error("commerce_sales_panel_guild_scope_mismatch");
    }
    const account = await this.options.store.readConnectedAccountByGuild(input.guildId);
    if (account && account.id !== input.connectedAccountId) {
      throw new Error("commerce_sales_panel_seller_scope_mismatch");
    }
    const leaseToken = this.createLeaseToken();
    const claim = await this.options.store.claimSalesPanelPublication({
      connectedAccountId: input.connectedAccountId,
      guildId: input.guildId,
      targetChannelId: existing.channelId,
      title: existing.title,
      description: existing.description,
      leaseToken,
      createNonce: this.createNonce(),
      nowMs: this.now(),
      leaseMs: PUBLICATION_LEASE_MS,
    });
    if (!claim) throw new Error("commerce_sales_panel_publication_in_progress");

    let preservePending = claim.recovering;
    try {
      if (claim.recovering) {
        const message = await this.buildMessage(
          input.connectedAccountId,
          input.guildId,
          claim.title,
          claim.description,
        );
        if (claim.panel.messageId && claim.panel.channelId !== claim.targetChannelId) {
          await this.options.discord.deleteMessage(
            input.guildId,
            claim.panel.channelId,
            claim.panel.messageId,
          );
        }
        const reconciled = await this.options.discord.publish({
          guildId: input.guildId,
          channelId: claim.targetChannelId,
          messageId:
            claim.panel.channelId === claim.targetChannelId
              ? (claim.panel.messageId ?? null)
              : null,
          message,
          createNonce: claim.createNonce,
        });
        await this.options.discord.deleteMessage(
          input.guildId,
          claim.targetChannelId,
          reconciled.messageId,
        );
        preservePending = false;
      } else if (claim.panel.messageId) {
        await this.options.discord.deleteMessage(
          input.guildId,
          claim.panel.channelId,
          claim.panel.messageId,
        );
      }
    } catch (error) {
      await this.failPublication(input.connectedAccountId, leaseToken, preservePending);
      throw new Error("commerce_sales_panel_delete_failed", { cause: error });
    }

    if (deleteProjection) {
      if (!(await this.deleteProjection(input.connectedAccountId, leaseToken))) {
        await this.failPublication(input.connectedAccountId, leaseToken, false);
        throw new Error("commerce_sales_panel_partial_success");
      }
      return {
        ...claim.panel,
        channelId: claim.targetChannelId,
        messageId: null,
        lastErrorCode: null,
        updatedAtMs: this.now(),
      };
    }
    const unpublished: CommerceSalesPanel = {
      ...claim.panel,
      channelId: claim.targetChannelId,
      messageId: null,
      lastErrorCode: null,
      updatedAtMs: this.now(),
    };
    if (!(await this.completePublication(unpublished, leaseToken))) {
      await this.failPublication(input.connectedAccountId, leaseToken, false);
      throw new Error("commerce_sales_panel_partial_success");
    }
    return unpublished;
  }

  private async buildMessage(
    connectedAccountId: string,
    guildId: string,
    title: string,
    description: string,
  ): Promise<CreateChannelMessageInput> {
    const dashboard = await this.options.catalog.readDashboard(connectedAccountId);
    const safeguard = await this.options.safeguards?.readDashboard(guildId);
    const offerings = (
      await Promise.all(
        dashboard.offerings
          .filter((row) => row.offering.state === "published")
          .map(async (row) => {
            if (isCommerceNewPurchaseBlocked(safeguard, row.offering.id)) return null;
            if (row.offering.purchaseType !== "subscription") return null;
            if (
              !row.activePrices.some(
                (price) =>
                  price.status === "active" &&
                  price.priceType === "recurring" &&
                  price.recurringInterval !== null,
              )
            ) {
              return null;
            }
            const context = await this.options.catalog.readPublishContext(
              connectedAccountId,
              guildId,
              row.offering.id,
            );
            return context.premiumActive &&
              context.sellerEligible &&
              context.termsAccepted &&
              context.roleManageable
              ? row
              : null;
          }),
      )
    ).filter((row): row is CommerceSalesPanelOffering => row !== null);
    const supportEnabled = await this.readSupportEnabled(guildId);
    return buildCommerceSalesPanelMessage({
      guildId,
      publicBaseUrl: this.options.publicBaseUrl,
      offerings,
      supportEnabled,
      title,
      description,
    });
  }

  private async readSupportEnabled(guildId: string): Promise<boolean> {
    if (!this.options.support) return false;
    try {
      const page = await this.options.support.page(guildId);
      const { account, seller } = page.context;
      return (
        page.config.enabled &&
        account.status === "active" &&
        account.chargesEnabled &&
        account.payoutsEnabled &&
        account.detailsSubmitted &&
        seller.lifecycleState === "active" &&
        seller.approvalState === "approved" &&
        page.context.termsAccepted &&
        page.context.premiumActive &&
        !page.context.suspended
      );
    } catch {
      return false;
    }
  }

  private async failPublication(
    connectedAccountId: string,
    leaseToken: string,
    preservePending: boolean,
  ): Promise<void> {
    try {
      await this.options.store.failSalesPanelPublication({
        connectedAccountId,
        leaseToken,
        errorCode: "commerce_sales_panel_refresh_failed",
        nowMs: this.now(),
        preservePending,
      });
    } catch {
      // The original provider error remains the actionable result. A later retry reconciles it.
    }
  }

  private async completePublication(
    panel: CommerceSalesPanel,
    leaseToken: string,
  ): Promise<boolean> {
    try {
      return await this.options.store.completeSalesPanelPublication({ panel, leaseToken });
    } catch {
      return false;
    }
  }

  private async deleteProjection(connectedAccountId: string, leaseToken: string): Promise<boolean> {
    try {
      return await this.options.store.deleteSalesPanelProjection({
        connectedAccountId,
        leaseToken,
      });
    } catch {
      return false;
    }
  }
}

export function buildCommerceSalesPanelMessage(input: {
  guildId: string;
  publicBaseUrl: string;
  offerings: CommerceSalesPanelOffering[];
  supportEnabled: boolean;
  title?: string;
  description?: string;
}): CreateChannelMessageInput {
  const copy = normalizeCommerceSalesPanelCopy({
    title: input.title ?? DEFAULT_COMMERCE_SALES_PANEL_TITLE,
    description: input.description ?? DEFAULT_COMMERCE_SALES_PANEL_DESCRIPTION,
  });
  const buttonCount = input.offerings.length + (input.supportEnabled ? 1 : 0);
  if (buttonCount > MAX_BUTTONS) throw new Error("commerce_sales_panel_button_limit");
  if (input.offerings.length > MAX_EMBED_FIELDS) {
    throw new Error("commerce_sales_panel_offering_limit");
  }

  const fields = input.offerings.map((row) => {
    const price = row.activePrices.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.priceType === "recurring" &&
        candidate.recurringInterval !== null,
    );
    const priceText = price
      ? `${formatMoney(price.unitAmountMinor, price.currency)} / ${price.recurringInterval ?? "period"}`
      : "Price unavailable";
    const description = row.offering.description?.trim();
    const benefits = row.offering.includedBenefits
      .slice(0, 4)
      .map((benefit) => `• ${benefit.trim()}`);
    if (row.offering.includedBenefits.length > benefits.length) {
      benefits.push(
        `• and ${row.offering.includedBenefits.length - benefits.length} more benefit(s)`,
      );
    }
    return {
      name: truncate(row.offering.name, MAX_FIELD_NAME),
      value: truncate(
        [priceText, description, benefits.join("\n")].filter(Boolean).join("\n"),
        MAX_FIELD_VALUE,
      ),
      inline: false,
    };
  });
  if (fields.length === 0) {
    fields.push({
      name: "No offerings are currently available",
      value: "The seller has not published a purchase-eligible offering yet.",
      inline: false,
    });
  }

  const components = [] as Array<{
    type: 1;
    components: Array<{ type: 2; style: 5; label: string; url: string }>;
  }>;
  const buttons = [
    ...input.offerings.map((row) => ({
      type: 2 as const,
      style: 5 as const,
      label: truncate(`Get ${row.offering.name}`, MAX_BUTTON_LABEL),
      url: fixedPublicUrl(input.publicBaseUrl, `/commerce/offers/${row.offering.id}`),
    })),
    ...(input.supportEnabled
      ? [
          {
            type: 2 as const,
            style: 5 as const,
            label: "Support this server",
            url: fixedPublicUrl(input.publicBaseUrl, `/commerce/support/${input.guildId}`),
          },
        ]
      : []),
  ];
  for (let index = 0; index < buttons.length; index += MAX_BUTTONS_PER_ROW) {
    components.push({ type: 1, components: buttons.slice(index, index + MAX_BUTTONS_PER_ROW) });
  }

  const footer = SALES_PANEL_FOOTER;
  const fixedEmbedBudget = MAX_EMBED_TOTAL - copy.title.length - footer.length;
  const fittedFields = fitCommerceSalesPanelFields(fields, fixedEmbedBudget);
  const fieldSize = fittedFields.reduce(
    (total, field) => total + field.name.length + field.value.length,
    0,
  );
  const descriptionBudget = Math.max(0, fixedEmbedBudget - fieldSize);
  const fittedDescription =
    descriptionBudget > 0
      ? truncate(copy.description, Math.min(MAX_DESCRIPTION, descriptionBudget))
      : "";

  const embed: {
    title: string;
    description?: string;
    color: number;
    fields: typeof fittedFields;
    footer: { text: string };
  } = {
    title: copy.title,
    ...(fittedDescription ? { description: fittedDescription } : {}),
    color: 0x5865f2,
    fields: fittedFields,
    footer: { text: footer },
  };
  const embedSize = [
    embed.title,
    embed.description,
    embed.footer.text,
    ...fittedFields.flatMap((field) => [field.name, field.value]),
  ]
    .filter((value): value is string => typeof value === "string")
    .reduce((total, value) => total + value.length, 0);
  if (embedSize > MAX_EMBED_TOTAL) throw new Error("commerce_sales_panel_embed_limit");
  return {
    embeds: [embed],
    components,
    allowed_mentions: { parse: [] },
  };
}

function fitCommerceSalesPanelFields(
  fields: Array<{ name: string; value: string; inline: boolean }>,
  budget: number,
): Array<{ name: string; value: string; inline: boolean }> {
  const fitted = fields.map((field) => ({ ...field }));
  let excess =
    fitted.reduce((total, field) => total + field.name.length + field.value.length, 0) - budget;
  if (excess <= 0) return fitted;

  for (const field of [...fitted].reverse()) {
    if (excess <= 0) break;
    const reducible = Math.max(0, field.value.length - 1);
    const amount = Math.min(excess, reducible);
    if (amount > 0) {
      field.value = truncate(field.value, field.value.length - amount);
      excess -= amount;
    }
  }
  for (const field of [...fitted].reverse()) {
    if (excess <= 0) break;
    const reducible = Math.max(0, field.name.length - 1);
    const amount = Math.min(excess, reducible);
    if (amount > 0) {
      field.name = truncate(field.name, field.name.length - amount);
      excess -= amount;
    }
  }
  return fitted;
}

export function normalizeCommerceSalesPanelCopy(input: { title: string; description: string }): {
  title: string;
  description: string;
} {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title || title.length > MAX_FIELD_NAME) {
    throw new Error("commerce_sales_panel_title_invalid");
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new Error("commerce_sales_panel_description_invalid");
  }
  return { title, description };
}

function fixedPublicUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error("commerce_sales_panel_redirect_scope_invalid");
  return url.toString();
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatMoney(amountMinor: number, currency: "AUD" | "USD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amountMinor / 100);
}
