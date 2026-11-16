import { GameAccessError } from "../commerce/game-access/model";
import type {
  CommerceBuyerCheckoutService,
  CommerceBuyerStatus,
  CommerceStorefront,
} from "../commerce/buyer-checkout";
import { defaultCommerceBranding, type CommercePublicBranding } from "../commerce/branding";
import { escapeHtml, renderCommercePage } from "./commerce-branding";
import type { CustomerSession } from "../runtime/auth/customer-session";
import type { RouteHandler } from "./public-routes";

const OFFERING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURCHASE_STATE_TTL_MS = 30 * 60 * 1_000;
// Stripe Checkout remains open for 31 minutes. Keep its account-scoped return
// token valid long enough for the full Checkout window and browser redirect.
const CHECKOUT_RETURN_STATE_TTL_MS = 45 * 60 * 1_000;

export interface CommercePurchaseState {
  version: 1;
  offeringId: string;
  guildId: string;
  discordUserId: string;
  checkoutAttemptId: string;
  expiresAtMs: number;
}

export interface CommerceBuyerRoutesOptions {
  service: CommerceBuyerCheckoutService;
  signingSecret: string;
  publicBaseUrl: string;
  readSession(request: Request): Promise<CustomerSession | null>;
  readMember(
    guildId: string,
    discordUserId: string,
  ): Promise<{ present: boolean; bot: boolean; banned: boolean }>;
  roleManageable(guildId: string, discordRoleId: string, discordUserId: string): Promise<boolean>;
  readPresentation(
    guildId: string,
    discordRoleId: string,
  ): Promise<{ guildName: string; roleName: string }>;
  readBranding?: (guildId: string) => Promise<CommercePublicBranding | null>;
  readSupportEnabled?: (guildId: string) => Promise<boolean>;
  now?: () => number;
  createId?: () => string;
}

export function createCommerceBuyerRoutes(options: CommerceBuyerRoutesOptions): RouteHandler {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const baseUrl = normalizedBaseUrl(options.publicBaseUrl);

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const storeMatch = /^\/commerce\/stores\/([^/]+)$/.exec(url.pathname);
    if (storeMatch && request.method === "GET") {
      const guildId = decodeURIComponent(storeMatch[1] ?? "");
      if (!validGuildId(guildId)) return renderError("This storefront link is invalid.", 404);
      try {
        const [storefronts, guildPresentation] = await Promise.all([
          options.service.storefrontsForGuild(guildId),
          options.readPresentation(guildId, "").catch(() => ({
            guildName: `Discord server ${guildId}`,
            roleName: "",
          })),
        ]);
        const branding = await resolveBranding(options, guildId, guildPresentation.guildName);
        const offerings = await Promise.all(
          storefronts.map(async (storefront) => ({
            storefront,
            presentation: await options
              .readPresentation(guildId, storefront.offering.discordRoleId)
              .catch(() => ({
                guildName: branding.guildName,
                roleName: `Role ${storefront.offering.discordRoleId}`,
              })),
          })),
        );
        const supportEnabled = options.readSupportEnabled
          ? await options.readSupportEnabled(guildId).catch(() => false)
          : false;
        return renderCatalog({
          branding,
          offerings,
          supportEnabled: Boolean(supportEnabled),
          guildId,
          baseUrl,
        });
      } catch (error) {
        return renderError(publicError(error), 404);
      }
    }
    const offerMatch = /^\/commerce\/offers\/([^/]+)$/.exec(url.pathname);
    if (offerMatch && request.method === "GET") {
      const offeringId = decodeURIComponent(offerMatch[1] ?? "");
      if (!OFFERING_ID.test(offeringId)) return renderError("This offering link is invalid.", 404);
      try {
        const storefront = await options.service.storefront(offeringId);
        const session = await options.readSession(request);
        const presentation = await options
          .readPresentation(storefront.offering.guildId, storefront.offering.discordRoleId)
          .catch(() => ({
            guildName: `Discord server ${storefront.offering.guildId}`,
            roleName: `Role ${storefront.offering.discordRoleId}`,
          }));
        const branding = await resolveBranding(
          options,
          storefront.offering.guildId,
          presentation.guildName,
        );
        const status = session
          ? await options.service
              .buyerStatus(offeringId, session.user.discordUserId)
              .catch(() => emptyStatus())
          : emptyStatus();
        const state = session
          ? await signCommercePurchaseState(
              {
                version: 1,
                offeringId,
                guildId: storefront.offering.guildId,
                discordUserId: session.user.discordUserId,
                checkoutAttemptId: createId(),
                expiresAtMs: now() + PURCHASE_STATE_TTL_MS,
              },
              options.signingSecret,
            )
          : null;
        return renderStorefront({
          storefront,
          presentation,
          status,
          state,
          signInUrl: signInUrl(baseUrl, offeringId),
          cancelled: url.searchParams.get("checkout") === "cancelled",
          steamChoices:
            storefront.reservedAccess && session
              ? await options.service.gameIdentityChoices(
                  storefront.offering.guildId,
                  session.user.discordUserId,
                )
              : [],
          branding,
        });
      } catch (error) {
        return renderError(publicError(error), 404);
      }
    }

    if (url.pathname === "/commerce/checkout" && request.method === "POST") {
      if (!sameOrigin(request, baseUrl))
        return renderError("The checkout request was rejected.", 403);
      const session = await options.readSession(request);
      if (!session) return renderError("Sign in with Discord before checking out.", 401);
      const form = await request.formData().catch(() => null);
      const token = formValue(form, "state");
      const state = await verifyCommercePurchaseState(token, options.signingSecret, now());
      if (!state || state.discordUserId !== session.user.discordUserId) {
        return renderError(
          "This purchase link is invalid, expired, or belongs to another account.",
          403,
        );
      }
      try {
        const storefront = await options.service.storefront(state.offeringId);
        if (storefront.offering.guildId !== state.guildId) {
          return renderError("This purchase link does not match the seller.", 403);
        }
        const [member, roleManageable] = await Promise.all([
          options.readMember(state.guildId, session.user.discordUserId),
          options.roleManageable(
            state.guildId,
            storefront.offering.discordRoleId,
            session.user.discordUserId,
          ),
        ]);
        const returnToken = await signCommercePurchaseState(
          {
            ...state,
            expiresAtMs: now() + CHECKOUT_RETURN_STATE_TTL_MS,
          },
          options.signingSecret,
        );
        const checkout = await options.service.startSubscriptionCheckout({
          offeringId: state.offeringId,
          discordUserId: session.user.discordUserId,
          checkoutAttemptId: state.checkoutAttemptId,
          subject:
            typeof form?.get("steamId") === "string" ? String(form?.get("steamId")) : undefined,
          successUrl: fixedUrl(baseUrl, "/commerce/return", { state: returnToken }),
          cancelUrl: fixedUrl(baseUrl, `/commerce/offers/${state.offeringId}`, {
            checkout: "cancelled",
          }),
          preflight: {
            memberPresent: member.present,
            memberIsBot: member.bot,
            memberBanned: member.banned,
            roleManageable,
          },
        });
        return Response.redirect(checkout.url, 303);
      } catch (error) {
        return renderError(publicError(error), errorStatus(error));
      }
    }

    if (url.pathname === "/commerce/return" && request.method === "GET") {
      const session = await options.readSession(request);
      if (!session)
        return Response.redirect(signInUrl(baseUrl, null, url.pathname + url.search), 302);
      const token = url.searchParams.get("state") ?? "";
      const state = await verifyCommerceCheckoutReturnState(token, options.signingSecret, now());
      if (!state || state.discordUserId !== session.user.discordUserId) {
        return renderError(
          "This checkout return is invalid, expired, or belongs to another account.",
          403,
        );
      }
      try {
        const storefront = await options.service.storefront(state.offeringId);
        if (storefront.offering.guildId !== state.guildId) {
          return renderError("This checkout return does not match the seller.", 403);
        }
        const status = await options.service.handleBrowserReturn({
          offeringId: state.offeringId,
          discordUserId: session.user.discordUserId,
          checkoutAttemptId: state.checkoutAttemptId,
        });
        const presentation = await options
          .readPresentation(storefront.offering.guildId, storefront.offering.discordRoleId)
          .catch(() => ({
            guildName: `Discord server ${storefront.offering.guildId}`,
            roleName: `Role ${storefront.offering.discordRoleId}`,
          }));
        const branding = await resolveBranding(
          options,
          storefront.offering.guildId,
          presentation.guildName,
        );
        return renderReturn(storefront, status, branding);
      } catch (error) {
        return renderError(publicError(error), errorStatus(error));
      }
    }

    if (url.pathname === "/commerce/portal" && request.method === "POST") {
      if (!sameOrigin(request, baseUrl))
        return renderError("The portal request was rejected.", 403);
      const session = await options.readSession(request);
      if (!session) return renderError("Sign in with Discord to manage billing.", 401);
      const form = await request.formData().catch(() => null);
      const token = formValue(form, "state");
      const state = await verifyCommercePurchaseState(token, options.signingSecret, now());
      if (!state || state.discordUserId !== session.user.discordUserId) {
        return renderError(
          "This portal link is invalid, expired, or belongs to another account.",
          403,
        );
      }
      try {
        const storefront = await options.service.storefront(state.offeringId);
        if (storefront.offering.guildId !== state.guildId) {
          return renderError("This portal link does not match the seller.", 403);
        }
        const portal = await options.service.createCustomerPortal({
          offeringId: state.offeringId,
          discordUserId: session.user.discordUserId,
          returnUrl: fixedUrl(baseUrl, `/commerce/offers/${state.offeringId}`),
          intentId: createId(),
        });
        return Response.redirect(portal.url, 303);
      } catch (error) {
        return renderError(publicError(error), errorStatus(error));
      }
    }

    if (
      url.pathname === "/commerce/checkout" ||
      url.pathname === "/commerce/return" ||
      url.pathname === "/commerce/portal"
    ) {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    return null;
  };
}

export async function signCommercePurchaseState(
  state: CommercePurchaseState,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error("Commerce purchase signing is not configured.");
  const payload = base64UrlEncode(JSON.stringify(state));
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyCommercePurchaseState(
  token: string,
  secret: string,
  nowMs: number,
): Promise<CommercePurchaseState | null> {
  return verifyCommerceState(token, secret, nowMs, PURCHASE_STATE_TTL_MS);
}

async function verifyCommerceCheckoutReturnState(
  token: string,
  secret: string,
  nowMs: number,
): Promise<CommercePurchaseState | null> {
  return verifyCommerceState(token, secret, nowMs, CHECKOUT_RETURN_STATE_TTL_MS);
}

async function verifyCommerceState(
  token: string,
  secret: string,
  nowMs: number,
  maximumTtlMs: number,
): Promise<CommercePurchaseState | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !secret) return null;
  const expected = await hmac(payload, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const value = JSON.parse(base64UrlDecode(payload)) as Partial<CommercePurchaseState>;
    if (
      value.version !== 1 ||
      typeof value.offeringId !== "string" ||
      !OFFERING_ID.test(value.offeringId) ||
      typeof value.guildId !== "string" ||
      !/^\d{2,24}$/.test(value.guildId) ||
      typeof value.discordUserId !== "string" ||
      !/^\d{2,24}$/.test(value.discordUserId) ||
      typeof value.checkoutAttemptId !== "string" ||
      !OFFERING_ID.test(value.checkoutAttemptId) ||
      typeof value.expiresAtMs !== "number" ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= nowMs ||
      value.expiresAtMs > nowMs + maximumTtlMs
    ) {
      return null;
    }
    return value as CommercePurchaseState;
  } catch {
    return null;
  }
}

function renderStorefront(input: {
  storefront: CommerceStorefront;
  presentation: { guildName: string; roleName: string };
  status: CommerceBuyerStatus;
  state: string | null;
  signInUrl: string;
  cancelled: boolean;
  steamChoices?: string[];
  branding: CommercePublicBranding;
}): Response {
  const { storefront, presentation, status } = input;
  const available =
    (!storefront.reservedAccess || storefront.reservedAccess.acceptingSales) &&
    storefront.offering.purchaseType === "subscription" &&
    storefront.offering.state === "published" &&
    storefront.price.status === "active" &&
    storefront.price.priceType === "recurring" &&
    storefront.publishContext.premiumActive &&
    storefront.publishContext.sellerEligible &&
    storefront.publishContext.termsAccepted &&
    storefront.offering.roleManageable;
  const action = !input.state
    ? `<a class="commerce-button" href="${escapeHtml(input.signInUrl)}">Sign in with Discord</a>`
    : status.subscriptionStatus && !["canceled", "ended"].includes(status.subscriptionStatus)
      ? `<p class="commerce-notice">You already have a ${escapeHtml(status.subscriptionStatus)} subscription for this offering.</p>`
      : available && storefront.reservedAccess && !input.steamChoices?.length
        ? `<p class="commerce-notice">Link and authenticate Steam using this Discord server's Platform Link panel, then reload this page.</p>`
        : available
          ? `<form class="commerce-form" action="/commerce/checkout" method="post"><input type="hidden" name="state" value="${escapeHtml(input.state)}">${storefront.reservedAccess ? `<label>Linked Steam account<select name="steamId" required>${(input.steamChoices?.length ?? 0) > 1 ? `<option value="">Choose an account</option>` : ""}${(input.steamChoices ?? []).map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")}</select></label>` : ""}<button class="commerce-button" type="submit">Continue to secure Stripe Checkout</button></form>`
          : `<p class="commerce-notice commerce-error">New purchases are temporarily unavailable.</p>`;
  const portal =
    input.state && status.customerExists
      ? `<form class="commerce-form" action="/commerce/portal" method="post"><input type="hidden" name="state" value="${escapeHtml(input.state)}"><button class="commerce-button-secondary" type="submit">Manage billing in Stripe</button></form>`
      : "";
  const benefits = storefront.offering.includedBenefits
    .map((benefit) => `<li>${escapeHtml(benefit)}</li>`)
    .join("");
  const fxText =
    storefront.price.currency === "USD"
      ? "This purchase is denominated in USD. Your bank may charge currency-conversion or international transaction fees."
      : "";
  const statusCopy = renderStatus(status);
  return renderCommercePage({
    title: `${storefront.offering.name} — ${presentation.guildName}`,
    description: storefront.offering.description ?? input.branding.tagline,
    branding: input.branding,
    content: `<div class="commerce-grid"><section class="commerce-card">
     <p class="commerce-eyebrow">Sold by ${escapeHtml(presentation.guildName)} / its guild owner</p>
     <h1>${escapeHtml(storefront.offering.name)}</h1>
     <p class="commerce-description">${escapeHtml(storefront.offering.description ?? "Paid Discord role access")}</p>
     ${input.cancelled ? `<p class="commerce-notice">Checkout was cancelled. You have not been charged by this checkout.</p>` : ""}
     <div class="commerce-role"><span class="commerce-role-dot"></span>Discord role: ${escapeHtml(presentation.roleName)}</div>
     <h3>What you receive</h3><ul class="commerce-benefits">${benefits}</ul></section>
     <aside class="commerce-card"><div class="commerce-price">${formatMoney(storefront.price.unitAmountMinor, storefront.price.currency)} <span>per ${escapeHtml(storefront.price.recurringInterval ?? "period")}</span></div>
     <p class="commerce-muted">Renews automatically until cancelled.</p>
     <div class="commerce-actions">${action}${portal}</div>${statusCopy}
     </aside></div>
     <section class="commerce-card"><div class="commerce-fixed"><h3>Before you subscribe</h3><span class="commerce-fixed-label">Always shown</span></div><ul class="commerce-terms">
       <li>The subscription renews automatically every ${escapeHtml(storefront.price.recurringInterval ?? "billing period")} until cancelled.</li>
       <li>Cancellation normally takes effect at the end of the current paid period.</li>
       <li>Refund requests are handled by the seller at ${escapeHtml(storefront.offering.supportContact ?? storefront.seller.supportContact)}. Nothing here excludes rights that cannot be excluded under Australian Consumer Law or other applicable consumer law.</li>
       <li>HAF Bot facilitates payment and Discord entitlement delivery. The guild owner is the seller; HAF Bot does not provide the listed guild benefits.</li>
       <li>Stripe processes card and Link payment details. HAF Bot does not receive or store full card details.</li>
     </ul>${fxText ? `<p class="commerce-notice">${escapeHtml(fxText)}</p>` : ""}</section>`,
  });
}

function renderReturn(
  storefront: CommerceStorefront,
  status: CommerceBuyerStatus,
  branding: CommercePublicBranding,
): Response {
  const active = status.entitlementStatus === "active";
  return renderCommercePage({
    title: active ? "Subscription active" : "Payment verification pending",
    description: `${storefront.offering.name} — ${branding.guildName}`,
    branding,
    content: `<section class="commerce-card"><p class="commerce-eyebrow">${escapeHtml(storefront.offering.name)}</p>
     <h1>${active ? "Your subscription is active" : "We’re verifying your payment"}</h1>
     <p>${
       active
         ? "Your subscription is active. Your Discord role may take a moment to appear."
         : "We’re checking your payment. Check your status again in a moment; your Discord role will be added once your payment is confirmed."
     }</p>
     ${renderStatus(status)}
     <p><a class="commerce-button" href="/commerce/offers/${encodeURIComponent(storefront.offering.id)}">Check latest status</a></p>
     <p><a class="commerce-button-secondary" href="https://discord.com/channels/${encodeURIComponent(storefront.offering.guildId)}">Return to Discord</a></p></section>
     <section class="commerce-card"><div class="commerce-fixed"><h2>Purchase terms</h2><span class="commerce-fixed-label">Always shown</span></div><ul class="commerce-terms">
       <li>The seller is ${escapeHtml(branding.guildName)} / its guild owner. Refund and support requests go to ${escapeHtml(storefront.offering.supportContact ?? storefront.seller.supportContact)}.</li>
       <li>This offering is ${escapeHtml(formatMoney(storefront.price.unitAmountMinor, storefront.price.currency))} per ${escapeHtml(storefront.price.recurringInterval ?? "billing period")} and renews automatically until cancelled.</li>
       <li>Cancellation normally takes effect at the end of the current paid period. Nothing here excludes rights that cannot be excluded under applicable consumer law.</li>
       <li>HAF Bot facilitates payment and Discord entitlement delivery but does not provide the guild benefits.</li>
       <li>Stripe processes card and Link payment details. HAF Bot does not receive or store full card details.</li>
     </ul></section>`,
  });
}

function renderStatus(status: CommerceBuyerStatus): string {
  if (!status.subscriptionStatus && !status.entitlementStatus && !status.gameAccess) return "";
  const grace = status.graceEndsAtMs
    ? `<p>Update your payment method before ${renderBillingDate(status.graceEndsAtMs)} to avoid losing access.</p>`
    : "";
  const period = status.currentPeriodEndMs
    ? `<p>${status.cancelAtPeriodEnd ? "Cancellation takes effect" : "Current paid period ends"} ${renderBillingDate(status.currentPeriodEndMs)}.</p>`
    : status.cancelAtPeriodEnd
      ? "<p>Cancellation is scheduled for the end of the paid period.</p>"
      : "";
  return `<section class="commerce-status"><h2>Your current status</h2>
    <p>Subscription: <strong>${escapeHtml(status.subscriptionStatus ?? "pending")}</strong><br>
    Access eligibility: <strong>${escapeHtml(status.entitlementStatus ?? "pending")}</strong><br>
    Discord role delivery: <strong>${escapeHtml(status.roleDeliveryStatus ?? "pending")}</strong></p>
    ${period}
    ${status.gameAccess ? `<p>Reserved access: <strong>${escapeHtml(status.gameAccess.state)}</strong>. ${escapeHtml(status.gameAccess.reason.replaceAll("_", " "))}. Server list membership does not guarantee admission.</p>` : ""}
    ${grace}</section>`;
}

function renderBillingDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  const label = new Intl.DateTimeFormat("en-AU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `<time datetime="${date.toISOString()}">${escapeHtml(label)} UTC</time>`;
}

function renderError(message: string, status: number): Response {
  return renderCommercePage({
    title: "Commerce unavailable",
    content: `<section class="commerce-card commerce-error"><h1>We couldn’t continue</h1><p>${escapeHtml(message)}</p></section>`,
    status,
  });
}

function renderCatalog(input: {
  branding: CommercePublicBranding;
  offerings: Array<{
    storefront: CommerceStorefront;
    presentation: { guildName: string; roleName: string };
  }>;
  supportEnabled: boolean;
  guildId: string;
  baseUrl: URL;
}): Response {
  const cards = input.offerings
    .map(({ storefront, presentation }) => {
      const description = storefront.offering.description ?? "Paid Discord role access";
      const benefits = storefront.offering.includedBenefits.slice(0, 3);
      return `<article class="commerce-card"><p class="commerce-eyebrow">${escapeHtml(presentation.roleName)}</p><h2>${escapeHtml(storefront.offering.name)}</h2><p class="commerce-description">${escapeHtml(description)}</p><ul class="commerce-benefits">${benefits.map((benefit) => `<li>${escapeHtml(benefit)}</li>`).join("")}</ul><p class="commerce-price">${formatMoney(storefront.price.unitAmountMinor, storefront.price.currency)} <span>per ${escapeHtml(storefront.price.recurringInterval ?? "period")}</span></p><a class="commerce-button" href="${escapeHtml(fixedUrl(input.baseUrl, `/commerce/offers/${storefront.offering.id}`))}">View and join</a></article>`;
    })
    .join("");
  const empty = `<section class="commerce-card commerce-locked"><h2>No offerings are available right now</h2><p class="commerce-muted">This guild has not published a purchase-eligible offering yet.</p></section>`;
  const sellerContact = input.offerings[0]
    ? (input.offerings[0].storefront.offering.supportContact ??
      input.offerings[0].storefront.seller.supportContact)
    : "the guild's published support contact";
  return renderCommercePage({
    title: `${input.branding.guildName} Store`,
    description: input.branding.tagline,
    branding: input.branding,
    content: `<section><p class="commerce-eyebrow">${escapeHtml(input.branding.guildName)} community store</p><h1>Choose your membership</h1><p class="commerce-description">Support the server and choose the benefits that fit you.</p></section><div class="commerce-grid-wide">${cards || empty}</div>${input.supportEnabled ? `<p><a class="commerce-button-secondary" href="${escapeHtml(fixedUrl(input.baseUrl, `/commerce/support/${input.guildId}`))}">Support this server</a></p>` : ""}<section class="commerce-card"><div class="commerce-fixed"><h2>Before you pay</h2><span class="commerce-fixed-label">Always shown</span></div><ul class="commerce-terms"><li>The guild owner is the seller. Refund and support requests go to ${escapeHtml(sellerContact)}.</li><li>Each offering shows its exact price, currency, and renewal cadence before checkout. Cancellation normally takes effect at the end of the paid period.</li><li>Nothing here excludes rights that cannot be excluded under applicable consumer law.</li><li>HAF Bot facilitates payment and Discord entitlement delivery but does not provide the guild benefits.</li><li>Stripe processes card and Link payment details. HAF Bot does not receive or store full card details.</li></ul></section>`,
  });
}

async function resolveBranding(
  options: CommerceBuyerRoutesOptions,
  guildId: string,
  guildName: string,
): Promise<CommercePublicBranding> {
  const configured = options.readBranding
    ? await options.readBranding(guildId).catch(() => null)
    : null;
  return configured ?? { ...defaultCommerceBranding(guildName), guildName };
}

function validGuildId(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_-]+$/.test(value);
}

function publicError(error: unknown): string {
  if (error instanceof GameAccessError) return error.message;
  if (error instanceof Error && error.message === "commerce_reserved_access_unavailable")
    return "Reserved-access sales await provider validation. Existing billing and delivery states are separate.";
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    commerce_offering_not_found: "This offering was not found.",
    commerce_offering_not_purchasable: "This offering is no longer available for new purchases.",
    commerce_seller_not_purchasable: "The seller is not currently able to accept new purchases.",
    commerce_role_unmanageable: "HAF Bot cannot currently manage the offered Discord role.",
    commerce_buyer_not_guild_member: "You must be a current member of this Discord server.",
    commerce_buyer_bot_forbidden: "Bot accounts cannot purchase subscriptions.",
    commerce_buyer_banned: "Banned members cannot purchase subscriptions.",
    commerce_duplicate_subscription: "You already have an active subscription for this offering.",
    commerce_checkout_already_open: "A checkout is already open for this offering.",
    commerce_checkout_rate_limited: "Too many checkout attempts. Please wait before trying again.",
    commerce_checkout_return_scope_mismatch:
      "This checkout return could not be matched to your account.",
    commerce_customer_not_found: "No Stripe billing profile exists for this seller.",
  };
  return messages[code] ?? "Commerce is temporarily unavailable. Please contact the seller.";
}

function errorStatus(error: unknown): number {
  if (error instanceof GameAccessError) return 409;
  const code = error instanceof Error ? error.message : "";
  if (code.includes("not_found")) return 404;
  if (code.includes("rate_limited")) return 429;
  if (code.includes("scope_mismatch") || code.includes("bot_forbidden") || code.includes("banned"))
    return 403;
  if (
    code.includes("not_purchasable") ||
    code.includes("duplicate") ||
    code.includes("already_open") ||
    code.includes("not_guild_member") ||
    code.includes("unmanageable") ||
    code.includes("customer_not_found")
  ) {
    return 409;
  }
  return 503;
}

function emptyStatus(): CommerceBuyerStatus {
  return {
    customerExists: false,
    entitlementStatus: null,
    subscriptionStatus: null,
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: null,
    graceEndsAtMs: null,
  };
}

function sameOrigin(request: Request, baseUrl: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === baseUrl.origin;
}

function formValue(form: FormData | null, name: string): string {
  const value = form?.get(name);
  return typeof value === "string" ? value : "";
}

function signInUrl(baseUrl: URL, offeringId: string | null, callbackPath?: string): string {
  const callback = callbackPath
    ? fixedUrl(baseUrl, callbackPath)
    : fixedUrl(baseUrl, `/commerce/offers/${offeringId}`);
  return fixedUrl(baseUrl, "/api/auth/sign-in/social", {
    provider: "discord",
    callbackURL: callback,
  });
}

function fixedUrl(baseUrl: URL, path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new Error("Commerce redirect scope is invalid.");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function hmac(value: string, secret: string): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.encode(value))));
}

function base64UrlEncode(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function formatMoney(amountMinor: number, currency: "AUD" | "USD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amountMinor / 100);
}
