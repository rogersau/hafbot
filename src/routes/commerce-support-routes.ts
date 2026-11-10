import type {
  CommerceSupportPage,
  CommerceSupportPayment,
  CommerceSupportService,
} from "../commerce/support-payments";
import { defaultCommerceBranding, type CommercePublicBranding } from "../commerce/branding";
import { escapeHtml, renderCommercePage } from "./commerce-branding";
import type { CustomerSession } from "../runtime/auth/customer-session";
import type { RouteHandler } from "./public-routes";

const STATE_TTL_MS = 30 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CommerceSupportState {
  version: 1;
  guildId: string;
  discordUserId: string;
  checkoutAttemptId: string;
  expiresAtMs: number;
}

export interface CommerceSupportRoutesOptions {
  service: CommerceSupportService;
  signingSecret: string;
  publicBaseUrl: string;
  readSession(request: Request): Promise<CustomerSession | null>;
  readMember(
    guildId: string,
    discordUserId: string,
  ): Promise<{ present: boolean; bot: boolean; banned: boolean }>;
  readGuildName(guildId: string): Promise<string>;
  readBranding?: (guildId: string) => Promise<CommercePublicBranding | null>;
  now?: () => number;
  createId?: () => string;
}

export function createCommerceSupportRoutes(options: CommerceSupportRoutesOptions): RouteHandler {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const baseUrl = normalizedBaseUrl(options.publicBaseUrl);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const pageMatch = /^\/commerce\/support\/(\d{2,24})$/.exec(url.pathname);
    if (pageMatch && request.method === "GET") {
      const guildId = pageMatch[1] ?? "";
      try {
        const [support, session, guildName] = await Promise.all([
          options.service.page(guildId),
          options.readSession(request),
          options.readGuildName(guildId).catch(() => `Discord server ${guildId}`),
        ]);
        const branding = await resolveBranding(options, guildId, guildName);
        const state = session
          ? await signCommerceSupportState(
              {
                version: 1,
                guildId,
                discordUserId: session.user.discordUserId,
                checkoutAttemptId: createId(),
                expiresAtMs: now() + STATE_TTL_MS,
              },
              options.signingSecret,
            )
          : null;
        return renderSupportPage({
          support,
          guildName,
          state,
          signInUrl: signInUrl(baseUrl, guildId),
          cancelled: url.searchParams.get("checkout") === "cancelled",
          branding,
        });
      } catch (error) {
        return renderError(publicError(error), 404);
      }
    }

    if (url.pathname === "/commerce/support/checkout" && request.method === "POST") {
      if (!sameOrigin(request, baseUrl))
        return renderError("The checkout request was rejected.", 403);
      const session = await options.readSession(request);
      if (!session) return renderError("Sign in with Discord before continuing.", 401);
      const form = await request.formData().catch(() => null);
      const token = formValue(form, "state");
      const state = await verifyCommerceSupportState(token, options.signingSecret, now());
      if (!state || state.discordUserId !== session.user.discordUserId) {
        return renderError(
          "This support link is invalid, expired, or belongs to another account.",
          403,
        );
      }
      try {
        const customAmount = formValue(form, "custom_amount").trim();
        const amountMinor = customAmount
          ? parseCustomAmountMinor(customAmount)
          : parsePresetAmountMinor(formValue(form, "amount").trim());
        const member = await options.readMember(state.guildId, session.user.discordUserId);
        const checkout = await options.service.startCheckout({
          guildId: state.guildId,
          discordUserId: session.user.discordUserId,
          checkoutAttemptId: state.checkoutAttemptId,
          amountMinor,
          successUrl: fixedUrl(baseUrl, "/commerce/support/return", {
            state: token,
          }),
          cancelUrl: fixedUrl(baseUrl, `/commerce/support/${state.guildId}`, {
            checkout: "cancelled",
          }),
          preflight: {
            memberPresent: member.present,
            memberIsBot: member.bot,
            memberBanned: member.banned,
          },
        });
        return Response.redirect(checkout.url, 303);
      } catch (error) {
        return renderError(publicError(error), errorStatus(error));
      }
    }

    if (url.pathname === "/commerce/support/return" && request.method === "GET") {
      const session = await options.readSession(request);
      if (!session) {
        return Response.redirect(signInUrl(baseUrl, "", url.pathname + url.search), 302);
      }
      const state = await verifyCommerceSupportState(
        url.searchParams.get("state") ?? "",
        options.signingSecret,
        now(),
      );
      if (!state || state.discordUserId !== session.user.discordUserId) {
        return renderError("This checkout return is invalid or belongs to another account.", 403);
      }
      try {
        const payment = await options.service.handleBrowserReturn({
          guildId: state.guildId,
          discordUserId: session.user.discordUserId,
          checkoutAttemptId: state.checkoutAttemptId,
        });
        const [guildName, support] = await Promise.all([
          options.readGuildName(state.guildId).catch(() => `Discord server ${state.guildId}`),
          typeof options.service.page === "function"
            ? options.service.page(state.guildId).catch(() => null)
            : Promise.resolve(null),
        ]);
        return renderReturn(
          state.guildId,
          payment,
          await resolveBranding(options, state.guildId, guildName),
          support?.config.supportContact ?? null,
        );
      } catch (error) {
        return renderError(publicError(error), errorStatus(error));
      }
    }

    if (
      url.pathname === "/commerce/support/checkout" ||
      url.pathname === "/commerce/support/return" ||
      pageMatch
    ) {
      return new Response("Method not allowed", { status: 405 });
    }
    return null;
  };
}

export async function signCommerceSupportState(
  state: CommerceSupportState,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error("Commerce support signing is not configured.");
  const payload = base64UrlEncode(JSON.stringify(state));
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyCommerceSupportState(
  token: string,
  secret: string,
  nowMs: number,
): Promise<CommerceSupportState | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !secret) return null;
  if (!constantTimeEqual(signature, await hmac(payload, secret))) return null;
  try {
    const value = JSON.parse(base64UrlDecode(payload)) as Partial<CommerceSupportState>;
    if (
      value.version !== 1 ||
      typeof value.guildId !== "string" ||
      !/^\d{2,24}$/.test(value.guildId) ||
      typeof value.discordUserId !== "string" ||
      !/^\d{2,24}$/.test(value.discordUserId) ||
      typeof value.checkoutAttemptId !== "string" ||
      !UUID.test(value.checkoutAttemptId) ||
      typeof value.expiresAtMs !== "number" ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= nowMs ||
      value.expiresAtMs > nowMs + STATE_TTL_MS
    ) {
      return null;
    }
    return value as CommerceSupportState;
  } catch {
    return null;
  }
}

function renderSupportPage(input: {
  support: CommerceSupportPage;
  guildName: string;
  state: string | null;
  signInUrl: string;
  cancelled: boolean;
  branding: CommercePublicBranding;
}): Response {
  const { config, context } = input.support;
  const available =
    config.enabled &&
    context.account.status === "active" &&
    context.account.chargesEnabled &&
    context.account.payoutsEnabled &&
    context.account.detailsSubmitted &&
    context.seller.lifecycleState === "active" &&
    context.seller.approvalState === "approved" &&
    context.premiumActive &&
    context.termsAccepted &&
    !context.suspended;
  const amounts = config.suggestedAmountsMinor
    .map(
      (amount) =>
        `<label><input type="radio" name="amount" value="${amount}"> ${formatMoney(amount, config.currency)}</label>`,
    )
    .join("");
  const action = !input.state
    ? `<a class="commerce-button" href="${escapeHtml(input.signInUrl)}">Sign in with Discord</a>`
    : available
      ? `<form class="commerce-form" action="/commerce/support/checkout" method="post">
          <input type="hidden" name="state" value="${escapeHtml(input.state)}">
          <fieldset class="commerce-fieldset"><legend>Choose an amount</legend>${amounts}
            <label>Custom amount (${config.currency}) <input name="custom_amount" type="number" inputmode="decimal" min="2" max="500" step="0.20" placeholder="e.g. 10.00" aria-describedby="support-amount-hint"></label>
            <p id="support-amount-hint" class="commerce-muted">Choose ${config.currency} 2.00–500.00 in 0.20 increments, such as 10 or 10.20. A custom amount replaces the selected suggested amount.</p>
          </fieldset>
          <button class="commerce-button" type="submit">Continue to secure Stripe Checkout</button>
        </form>`
      : `<p class="commerce-notice commerce-error">Support payments are temporarily unavailable.</p>`;
  const fx =
    config.currency === "USD"
      ? `<p class="commerce-notice">This payment is denominated in USD. Your bank may charge currency-conversion or international transaction fees.</p>`
      : "";
  return renderCommercePage({
    title: `Support ${input.guildName}`,
    description: config.explanation,
    branding: input.branding,
    content: `<section class="commerce-card"><p class="commerce-eyebrow">Payment to ${escapeHtml(input.guildName)} / its guild owner</p>
     <h1>Support this server</h1>
     <p class="commerce-description">${escapeHtml(config.explanation)}</p>
     ${input.cancelled ? `<p class="commerce-notice">Checkout was cancelled. You have not been charged by this checkout.</p>` : ""}
     <h2>Before you pay</h2>
     <ul class="commerce-terms">
       <li>This is a voluntary, one-time, non-recurring payment for community operations.</li>
       <li>It is not a charitable donation, tax-deductible contribution, fundraiser, or crowdfunding pledge.</li>
       <li>You receive no exclusive Discord role, prize, investment return, guaranteed benefit, or project-delivery promise.</li>
       <li>The guild owner is the seller. Support and refund requests go to ${escapeHtml(config.supportContact)}.</li>
       <li>Nothing here excludes rights that cannot be excluded under applicable consumer law.</li>
       <li>HAF Bot facilitates payment and Discord entitlement delivery but does not provide guild benefits.</li>
       <li>Stripe processes card and Link payment details. HAF Bot does not store full card details.</li>
     </ul>
     ${fx}
     <div class="commerce-actions">${action}</div></section>`,
  });
}

function renderReturn(
  guildId: string,
  payment: CommerceSupportPayment | null,
  branding: CommercePublicBranding,
  supportContact: string | null,
): Response {
  const reconciled = payment?.status === "succeeded";
  const paymentSummary = payment
    ? `${formatMoney(payment.amountMinor, payment.currency)} one-time payment`
    : "one-time payment amount selected at checkout";
  return renderCommercePage({
    title: reconciled ? "Support payment confirmed" : "Payment verification pending",
    branding,
    content: `<section class="commerce-card"><h1>${reconciled ? "Thank you for supporting this server" : "We’re verifying your payment"}</h1>
     <p>${
       reconciled
         ? "Stripe has confirmed the one-time payment. No subscription or Discord entitlement was created."
         : "Returning from Stripe does not mark the payment as received. HAF Bot is waiting for verified Stripe state."
     }</p>
     <p><a class="commerce-button" href="/commerce/support/${encodeURIComponent(guildId)}">Return to support page</a></p></section>
     <section class="commerce-card"><div class="commerce-fixed"><h2>Support payment terms</h2><span class="commerce-fixed-label">Always shown</span></div><ul class="commerce-terms">
       <li>The guild owner is the seller. Refund and support requests go to ${escapeHtml(supportContact ?? "the guild owner")}.</li>
       <li>This is a ${escapeHtml(paymentSummary)}. It is voluntary, non-recurring, and creates no subscription or Discord entitlement.</li>
       <li>Nothing here excludes rights that cannot be excluded under applicable consumer law.</li>
       <li>HAF Bot facilitates payment but does not provide guild benefits. Stripe processes card and Link payment details.</li>
     </ul></section>`,
  });
}

function parseCustomAmountMinor(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("commerce_support_amount_invalid");
  }
  const [whole, fraction = ""] = value.split(".");
  const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor)) throw new Error("commerce_support_amount_invalid");
  return amountMinor;
}

function parsePresetAmountMinor(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("commerce_support_amount_invalid");
  const amountMinor = Number(value);
  if (!Number.isSafeInteger(amountMinor)) throw new Error("commerce_support_amount_invalid");
  return amountMinor;
}

function publicError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    commerce_support_not_found: "This server does not have a support page.",
    commerce_support_disabled: "Support payments are not enabled for this server.",
    commerce_support_seller_unavailable: "This seller cannot currently accept support payments.",
    commerce_support_member_required: "You must be a current member of this Discord server.",
    commerce_support_bot_forbidden: "Bot accounts cannot make support payments.",
    commerce_support_banned: "This account cannot make a support payment.",
    commerce_support_amount_invalid:
      "Choose an amount from 2.00 through 500.00 in the displayed currency, in 0.20 increments. Use digits and an optional decimal point with up to two decimal places.",
    commerce_support_amount_rounding:
      "Choose an amount from 2.00 through 500.00 in the displayed currency, in 0.20 increments, such as 10.00 or 10.20.",
    commerce_support_rate_limited: "Too many checkout attempts. Please wait before trying again.",
    commerce_support_checkout_already_open: "A support checkout is already open for this server.",
    commerce_support_return_scope_mismatch:
      "This checkout return could not be matched to your account.",
  };
  return messages[code] ?? "Support payments are temporarily unavailable. Contact the seller.";
}

function errorStatus(error: unknown): number {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("not_found")) return 404;
  if (code.includes("rate_limited")) return 429;
  if (code.includes("scope_mismatch") || code.includes("forbidden") || code.includes("banned"))
    return 403;
  if (
    code.includes("disabled") ||
    code.includes("unavailable") ||
    code.includes("member_required") ||
    code.includes("already_open") ||
    code.includes("amount")
  )
    return 409;
  return 503;
}

function renderError(message: string, status: number): Response {
  return renderCommercePage({
    title: "Support payment unavailable",
    content: `<section class="commerce-card commerce-error"><h1>We couldn’t continue</h1><p>${escapeHtml(message)}</p></section>`,
    status,
  });
}

async function resolveBranding(
  options: CommerceSupportRoutesOptions,
  guildId: string,
  guildName: string,
): Promise<CommercePublicBranding> {
  const configured = options.readBranding
    ? await options.readBranding(guildId).catch(() => null)
    : null;
  return configured ?? { ...defaultCommerceBranding(guildName), guildName };
}

function sameOrigin(request: Request, baseUrl: URL): boolean {
  return request.headers.get("origin") === baseUrl.origin;
}

function formValue(form: FormData | null, name: string): string {
  const value = form?.get(name);
  return typeof value === "string" ? value : "";
}

function signInUrl(baseUrl: URL, guildId: string, callbackPath?: string): string {
  const callback = callbackPath
    ? fixedUrl(baseUrl, callbackPath)
    : fixedUrl(baseUrl, `/commerce/support/${guildId}`);
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

function formatMoney(amountMinor: number, currency: "AUD" | "USD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amountMinor / 100);
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
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
