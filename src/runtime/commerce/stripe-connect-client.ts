import { isRecord } from "../../unknown-parse";

const STRIPE_BASE_URL = "https://api.stripe.com";
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;
const STRIPE_SECRET_KEY_PATTERN = /^sk_(?:test|live)_[A-Za-z0-9_-]{16,}$/;
const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{16,}$/;

export type StripeSecretKeyMode = "test" | "live";

export function isValidStripeSecretKey(
  value: unknown,
  expectedMode?: StripeSecretKeyMode,
): value is string {
  if (typeof value !== "string" || !STRIPE_SECRET_KEY_PATTERN.test(value)) return false;
  return expectedMode === undefined || value.startsWith(`sk_${expectedMode}_`);
}

export function isValidStripeWebhookSecret(value: unknown): value is string {
  return typeof value === "string" && STRIPE_WEBHOOK_SECRET_PATTERN.test(value);
}

export interface StripeConnectClientOptions {
  secretKey: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

export interface StripeConnectAccount {
  id: string;
  country: string;
  defaultCurrency: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  currentlyDue: string[];
  eventuallyDue: string[];
  pendingVerification: string[];
  providerCreatedAtMs: number | null;
  state: StripeConnectAccountState;
}

export type CreateConnectedAccountInput = {
  guildId: string;
  idempotencyKey: string;
  environment?: string;
  sellerEmail?: string;
  businessProfileUrl?: string;
} & ({ sellerUserId: string; sellerId?: string } | { sellerId: string; sellerUserId?: string });

export type AccountLinkInput = {
  idempotencyKey: string;
} & (
  | { connectedAccountId: string; accountId?: string }
  | { accountId: string; connectedAccountId?: string }
);

export interface StripeConnectAccountState {
  capabilities: Record<string, StripeCapabilityState>;
  requirements: StripeRequirementsState;
}

export type StripeCapabilityState =
  | "active"
  | "inactive"
  | "pending"
  | "restricted"
  | "unrequested"
  | "unknown";

export interface StripeRequirementsState {
  currentlyDue: string[];
  eventuallyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  errors: Array<{ code: string | null; reason: string | null; requirement: string | null }>;
  disabledReason: string | null;
  currentDeadlineMs: number | null;
}

export interface StripeConnectLink {
  url: string;
  expiresAtMs: number | null;
}

export interface ConnectedAccountRequest {
  accountId: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: URLSearchParams;
  idempotencyKey?: string;
}

/**
 * Small, account-bound Stripe client for Commerce. Premium billing deliberately
 * uses a separate client; no method here silently falls back to platform scope.
 */
export class StripeConnectClient {
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(secretKey: string, apiVersion: string, fetchImpl?: typeof fetch);
  constructor(options: StripeConnectClientOptions);
  constructor(
    secretOrOptions: string | StripeConnectClientOptions,
    apiVersion?: string,
    fetchImpl?: typeof fetch,
  ) {
    if (typeof secretOrOptions === "string") {
      this.secretKey = secretOrOptions;
      this.apiVersion = apiVersion ?? "";
      this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    } else {
      this.secretKey = secretOrOptions.secretKey;
      this.apiVersion = secretOrOptions.apiVersion;
      this.fetchImpl = secretOrOptions.fetchImpl ?? ((input, init) => fetch(input, init));
    }
    if (!isValidStripeSecretKey(this.secretKey) || !this.apiVersion)
      throw new Error("Stripe Connect configuration is invalid.");
  }

  /** Create a seller account in platform scope (never Stripe-Account scoped). */
  async createConnectedAccount(input: CreateConnectedAccountInput): Promise<StripeConnectAccount> {
    opaqueId(input.guildId, "guild ID");
    const sellerUserId = input.sellerUserId ?? input.sellerId;
    opaqueId(sellerUserId, "seller ID");
    if (!sellerUserId) throw new Error("seller ID must be an opaque identifier.");
    requiredIdempotencyKey(input.idempotencyKey);
    const body = new URLSearchParams({
      country: "AU",
      "controller[fees][payer]": "account",
      "controller[losses][payments]": "stripe",
      "controller[requirement_collection]": "stripe",
      "controller[stripe_dashboard][type]": "full",
      "capabilities[card_payments][requested]": "true",
      "capabilities[transfers][requested]": "true",
      "metadata[haf_guild_id]": input.guildId,
      "metadata[haf_seller_id]": sellerUserId,
    });
    if (input.environment) opaqueId(input.environment, "environment");
    if (input.environment) body.set("metadata[haf_environment]", input.environment);
    if (input.sellerEmail) body.set("email", normalizedEmail(input.sellerEmail));
    if (input.businessProfileUrl) {
      body.set("business_profile[url]", normalizedHttpsUrl(input.businessProfileUrl));
    }
    const value = await this.platformRequest("/v1/accounts", "POST", body, input.idempotencyKey);
    return parseConnectedAccount(value);
  }

  /** Short alias for callers modelling the Stripe Account resource directly. */
  async createAccount(input: CreateConnectedAccountInput): Promise<StripeConnectAccount> {
    return this.createConnectedAccount(input);
  }

  /** Read an Account from platform scope (never Stripe-Account scoped). */
  async readConnectedAccount(accountId: string): Promise<StripeConnectAccount> {
    requireAccountId(accountId);
    const value = await this.platformRequest(
      `/v1/accounts/${encodeURIComponent(accountId)}`,
      "GET",
    );
    return parseConnectedAccount(value);
  }

  async readAccount(accountId: string): Promise<StripeConnectAccount> {
    return this.readConnectedAccount(accountId);
  }

  async readAccountState(accountId: string): Promise<StripeConnectAccountState> {
    return (await this.readConnectedAccount(accountId)).state;
  }

  async readConnectedAccountState(accountId: string): Promise<StripeConnectAccountState> {
    return this.readAccountState(accountId);
  }

  async createOnboardingLink(
    input: AccountLinkInput & {
      returnUrl: string;
      refreshUrl: string;
    },
  ): Promise<StripeConnectLink> {
    const accountId = input.connectedAccountId ?? input.accountId;
    requireAccountId(accountId);
    requiredIdempotencyKey(input.idempotencyKey);
    const value = await this.platformRequest(
      "/v1/account_links",
      "POST",
      new URLSearchParams({
        account: accountId,
        type: "account_onboarding",
        return_url: input.returnUrl,
        refresh_url: input.refreshUrl,
        "collection_options[fields]": "currently_due",
        "collection_options[future_requirements]": "omit",
      }),
      input.idempotencyKey,
    );
    return parseLink(value, "onboarding");
  }

  async createAccountLink(
    input: AccountLinkInput & { returnUrl: string; refreshUrl: string },
  ): Promise<StripeConnectLink> {
    return this.createOnboardingLink(input);
  }

  async createAccountManagementLink(input: AccountLinkInput): Promise<StripeConnectLink> {
    const accountId = input.connectedAccountId ?? input.accountId;
    requireAccountId(accountId);
    requiredIdempotencyKey(input.idempotencyKey);
    // Full-Dashboard connected accounts sign in through Stripe directly. The
    // login-links endpoint is only compatible with Express accounts.
    return { url: "https://dashboard.stripe.com/", expiresAtMs: null };
  }

  async createLoginLink(input: AccountLinkInput): Promise<StripeConnectLink> {
    return this.createAccountManagementLink(input);
  }

  /** Permanently disconnect a Standard connected account from the platform. */
  async deleteConnectedAccount(accountId: string, idempotencyKey: string): Promise<void> {
    requireAccountId(accountId);
    requiredIdempotencyKey(idempotencyKey);
    await this.platformRequest(
      `/v1/accounts/${encodeURIComponent(accountId)}`,
      "DELETE",
      undefined,
      idempotencyKey,
    );
  }

  /** Execute a request against a connected seller. Account ID is mandatory. */
  async requestConnectedAccount(input: ConnectedAccountRequest): Promise<unknown>;
  async requestConnectedAccount(
    accountId: string,
    path: string,
    options?: Omit<ConnectedAccountRequest, "accountId" | "path">,
  ): Promise<unknown>;
  async requestConnectedAccount(
    inputOrAccountId: ConnectedAccountRequest | string,
    path?: string,
    options: Omit<ConnectedAccountRequest, "accountId" | "path"> = {},
  ): Promise<unknown> {
    const input: ConnectedAccountRequest =
      typeof inputOrAccountId === "string"
        ? { accountId: inputOrAccountId, path: path ?? "", ...options }
        : inputOrAccountId;
    requireAccountId(input.accountId);
    return this.request(input.path, {
      accountId: input.accountId,
      method: input.method ?? "GET",
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Alias kept explicit at call sites so account scope cannot be accidental. */
  async requestForConnectedAccount(
    accountId: string,
    path: string,
    options: Omit<ConnectedAccountRequest, "accountId" | "path"> = {},
  ): Promise<unknown> {
    return this.requestConnectedAccount({ accountId, path, ...options });
  }

  private async platformRequest(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.request(path, { method, body, idempotencyKey });
  }

  private async request(
    path: string,
    options: {
      accountId?: string;
      method: "GET" | "POST" | "DELETE";
      body?: URLSearchParams;
      idempotencyKey?: string;
    },
  ): Promise<unknown> {
    if (!path.startsWith("/v1/")) throw new Error("Stripe Connect path is invalid.");
    if (options.accountId) requireAccountId(options.accountId);
    if (options.idempotencyKey) requiredIdempotencyKey(options.idempotencyKey);
    if (options.method === "POST" && !options.idempotencyKey) requiredIdempotencyKey("");
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      "stripe-version": this.apiVersion,
    };
    if (options.accountId) headers["stripe-account"] = options.accountId;
    if (options.body) headers["content-type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    try {
      const response = await this.fetchImpl(`${STRIPE_BASE_URL}${path}`, {
        method: options.method,
        headers,
        ...(options.body ? { body: options.body } : {}),
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("invalid response");
      }
      if (!response.ok) throw new Error("request failed");
      return value;
    } catch {
      // Deliberately omit provider response text and request details: Stripe's
      // secret key and seller PII must never leak through an application error.
      throw new Error("Stripe Connect request failed.");
    }
  }
}

export function parseConnectedAccountState(value: unknown): StripeConnectAccountState {
  const account = isRecord(value) ? value : null;
  const capabilities: Record<string, StripeCapabilityState> = {};
  if (account && isRecord(account.capabilities)) {
    for (const [name, status] of Object.entries(account.capabilities)) {
      if (typeof status === "string") capabilities[name] = normalizeCapability(status);
    }
  }
  const requirements = account && isRecord(account.requirements) ? account.requirements : null;
  return {
    capabilities,
    requirements: {
      currentlyDue: stringArray(requirements?.currently_due),
      eventuallyDue: stringArray(requirements?.eventually_due),
      pastDue: stringArray(requirements?.past_due),
      pendingVerification: stringArray(requirements?.pending_verification),
      errors: requirements ? parseRequirementErrors(requirements.errors) : [],
      disabledReason:
        requirements && typeof requirements.disabled_reason === "string"
          ? requirements.disabled_reason
          : null,
      currentDeadlineMs:
        requirements && typeof requirements.current_deadline === "number"
          ? requirements.current_deadline * 1_000
          : null,
    },
  };
}

function parseConnectedAccount(value: unknown): StripeConnectAccount {
  if (!isRecord(value) || typeof value.id !== "string" || !ACCOUNT_ID_PATTERN.test(value.id)) {
    throw new Error("Stripe returned an invalid connected Account.");
  }
  if (typeof value.country !== "string") {
    throw new Error("Stripe returned an invalid connected Account.");
  }
  const state = parseConnectedAccountState(value);
  return {
    id: value.id,
    country: value.country,
    defaultCurrency: typeof value.default_currency === "string" ? value.default_currency : null,
    chargesEnabled: value.charges_enabled === true,
    payoutsEnabled: value.payouts_enabled === true,
    detailsSubmitted: value.details_submitted === true,
    disabledReason: state.requirements.disabledReason,
    currentlyDue: state.requirements.currentlyDue,
    eventuallyDue: state.requirements.eventuallyDue,
    pendingVerification: state.requirements.pendingVerification,
    providerCreatedAtMs: typeof value.created === "number" ? value.created * 1_000 : null,
    state,
  };
}

function parseLink(value: unknown, label: string): StripeConnectLink {
  if (!isRecord(value) || typeof value.url !== "string" || !value.url.startsWith("https://")) {
    throw new Error(`Stripe returned an invalid ${label} link.`);
  }
  return {
    url: value.url,
    expiresAtMs: typeof value.expires_at === "number" ? value.expires_at * 1_000 : null,
  };
}

function parseRequirementErrors(value: unknown): StripeRequirementsState["errors"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    code: typeof item.code === "string" ? item.code : null,
    reason: typeof item.reason === "string" ? item.reason : null,
    requirement: typeof item.requirement === "string" ? item.requirement : null,
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeCapability(value: string): StripeCapabilityState {
  return value === "active" ||
    value === "inactive" ||
    value === "pending" ||
    value === "restricted" ||
    value === "unrequested"
    ? value
    : "unknown";
}

function requireAccountId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error("A connected Stripe Account ID is required.");
  }
}

function opaqueId(value: unknown, label: string): void {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be an opaque identifier.`);
  }
}

function requiredIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new Error("A Stripe idempotency key is required.");
  }
}

function normalizedEmail(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
    normalized.toLowerCase().endsWith("@discord.local")
  ) {
    throw new Error("Seller email is invalid.");
  }
  return normalized;
}

function normalizedHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Seller business profile URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Seller business profile URL is invalid.");
  }
  return url.toString();
}
