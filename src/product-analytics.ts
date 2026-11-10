const SCHEMA_VERSION = 1;

export const PRODUCT_FEATURES = [
  "reaction_rules",
  "tickets",
  "lfg",
  "member_verification",
  "player_link",
  "server_levels",
] as const;

export type ProductFeature = (typeof PRODUCT_FEATURES)[number];
export type ProductOutcomeStatus = "success" | "failure";

export type ProductAnalyticsEvent =
  | {
      name: "public_page_viewed";
      insertionId: string;
      path: "/" | "/changelog" | "/privacy" | "/terms";
      referrerDomain?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      deviceClass?: "mobile" | "tablet" | "desktop";
      browserFamily?: "chrome" | "firefox" | "safari" | "edge" | "other";
      country?: string;
    }
  | { name: "install_started"; insertionId: string }
  | { name: "dashboard_signed_in"; insertionId: string }
  | { name: "guild_installed"; insertionId: string; guildId: string; plan?: ProductPlan }
  | {
      name: "dashboard_page_viewed";
      insertionId: string;
      guildId: string;
      page: DashboardPage;
      feature?: ProductFeature;
    }
  | {
      name: "dashboard_milestone";
      insertionId: string;
      guildId: string;
      action: DashboardMilestoneAction;
      feature?: ProductFeature;
      status?: ProductOutcomeStatus;
      reasonCode?: ProductFailureCode;
    }
  | {
      name: "feature_outcome";
      insertionId: string;
      guildId: string;
      feature: ProductFeature;
      action: ProductOutcomeAction;
      status: ProductOutcomeStatus;
      reasonCode?: ProductFailureCode;
      plan?: ProductPlan;
      provider?: "steam" | "xbox" | "playstation" | "other";
    };

export type ProductOutcomeAction =
  | "blocked_reaction_removed"
  | "reaction_limit_enforced"
  | "ticket_opened"
  | "ticket_closed"
  | "transcript_archived"
  | "lfg_published"
  | "lfg_participation_changed"
  | "lfg_group_completed"
  | "verification_role_granted"
  | "player_link_completed";

export type ProductFailureCode =
  | "discord_rejected"
  | "discord_unavailable"
  | "invalid_configuration"
  | "provider_rejected"
  | "provider_unavailable"
  | "storage_unavailable";

export type ProductPlan = "free" | "premium" | "premium_plus";

export type DashboardPage =
  | "overview"
  | "guild_settings"
  | "reaction_rules"
  | "tickets"
  | "lfg"
  | "member_verification"
  | "player_link"
  | "server_levels"
  | "billing"
  | "other";

export type DashboardMilestoneAction =
  | "guild_selected"
  | "onboarding_goal_selected"
  | "resource_setup_started"
  | "resource_setup_completed"
  | "configuration_saved"
  | "feature_enabled"
  | "feature_disabled"
  | "onboarding_verification_completed"
  | "upgrade_viewed"
  | "upgrade_started"
  | "help_opened";

export interface ProductAnalyticsReporter {
  report(event: ProductAnalyticsEvent): Promise<void>;
}

export const NOOP_PRODUCT_ANALYTICS: ProductAnalyticsReporter = {
  async report() {},
};

export function withGuildAnalyticsPreference(
  reporter: ProductAnalyticsReporter,
  readEnabled: (guildId: string) => Promise<boolean>,
): ProductAnalyticsReporter {
  return {
    async report(event) {
      if ("guildId" in event) {
        try {
          if (!(await readEnabled(event.guildId))) return;
        } catch {
          return;
        }
      }
      await reporter.report(event);
    },
  };
}

export function withProductAnalyticsWaitUntil(
  reporter: ProductAnalyticsReporter,
  waitUntil: (promise: Promise<unknown>) => void,
): ProductAnalyticsReporter {
  return {
    async report(event) {
      try {
        waitUntil(reporter.report(event).catch(() => undefined));
      } catch {
        // Scheduling analytics cannot affect the customer operation.
      }
    },
  };
}

export interface PostHogProductAnalyticsOptions {
  host: string;
  projectToken: string;
  pseudonymKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ProductAnalyticsEnvironment {
  STAGING_MODE?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  PRODUCT_ANALYTICS_PSEUDONYM_KEY?: string;
}

export function createEnvironmentProductAnalytics(
  env: ProductAnalyticsEnvironment,
): ProductAnalyticsReporter {
  if (
    env.STAGING_MODE === "true" ||
    !env.POSTHOG_HOST ||
    !env.POSTHOG_PROJECT_TOKEN ||
    !env.PRODUCT_ANALYTICS_PSEUDONYM_KEY
  ) {
    return NOOP_PRODUCT_ANALYTICS;
  }
  try {
    return createPostHogProductAnalytics({
      host: env.POSTHOG_HOST,
      projectToken: env.POSTHOG_PROJECT_TOKEN,
      pseudonymKey: env.PRODUCT_ANALYTICS_PSEUDONYM_KEY,
    });
  } catch {
    return NOOP_PRODUCT_ANALYTICS;
  }
}

export function createPostHogProductAnalytics(
  options: PostHogProductAnalyticsOptions,
): ProductAnalyticsReporter {
  const host = parsePostHogHost(options.host);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  return {
    async report(event) {
      try {
        const guildPseudonym =
          "guildId" in event
            ? await pseudonymizeGuildId(event.guildId, options.pseudonymKey)
            : undefined;
        const properties = buildProperties(event, guildPseudonym, now().toISOString());
        await fetcher(new URL("/i/v0/e/", host), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: options.projectToken,
            event: event.name,
            distinct_id: guildPseudonym ?? event.insertionId,
            properties,
          }),
        });
      } catch {
        // Product analytics is deliberately fail-open and never diagnostic telemetry.
      }
    },
  };
}

export async function pseudonymizeGuildId(guildId: string, secret: string): Promise<string> {
  if (!/^\d{5,30}$/.test(guildId)) throw new Error("Invalid Guild ID");
  if (secret.length < 32) throw new Error("Analytics pseudonym key is too short");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(guildId));
  return base64Url(new Uint8Array(signature));
}

export function browserPrivacySignalEnabled(request: Request): boolean {
  return request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1";
}

export function createInsertionId(): string {
  return crypto.randomUUID();
}

export async function createDeterministicInsertionId(parts: readonly string[]): Promise<string> {
  const operationKey = parts.map((part) => `${part.length}:${part}`).join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationKey));
  return base64Url(new Uint8Array(digest));
}

function buildProperties(
  event: ProductAnalyticsEvent,
  guildPseudonym: string | undefined,
  timestamp: string,
): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {
    $insert_id: event.insertionId,
    schema_version: SCHEMA_VERSION,
    environment: "production",
    timestamp,
    $process_person_profile: false,
  };
  if (guildPseudonym) properties.guild = guildPseudonym;
  if (event.name === "public_page_viewed") {
    properties.path = event.path;
    add(properties, "referrer_domain", event.referrerDomain);
    add(properties, "utm_source", event.utmSource);
    add(properties, "utm_medium", event.utmMedium);
    add(properties, "utm_campaign", event.utmCampaign);
    add(properties, "device_class", event.deviceClass);
    add(properties, "browser_family", event.browserFamily);
    add(properties, "country", event.country);
  } else if (event.name === "guild_installed") {
    add(properties, "plan", event.plan);
  } else if (event.name === "dashboard_page_viewed") {
    properties.page = event.page;
    add(properties, "feature", event.feature);
  } else if (event.name === "dashboard_milestone") {
    properties.action = event.action;
    add(properties, "feature", event.feature);
    add(properties, "status", event.status);
    add(properties, "reason_code", event.reasonCode);
  } else if (event.name === "feature_outcome") {
    properties.feature = event.feature;
    properties.action = event.action;
    properties.status = event.status;
    add(properties, "reason_code", event.reasonCode);
    add(properties, "plan", event.plan);
    add(properties, "provider", event.provider);
  }
  return properties;
}

function add(target: Record<string, string | number | boolean>, key: string, value?: string): void {
  if (value) target[key] = value;
}

function parsePostHogHost(value: string): URL {
  const host = new URL(value);
  if (host.protocol !== "https:" || (host.pathname !== "/" && host.pathname !== "")) {
    throw new Error("PostHog host must be an HTTPS origin");
  }
  return host;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
