import type { Cache } from "./runtime/discord-json-cache";
import type { QueueProducer } from "./runtime/queue-types";
import type { DiscordE2eActors } from "./runtime/discord-e2e-actors";
export interface Env {
  [key: string]: unknown;
  DISCORD_BOT_TOKEN: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  BOT_USER_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_OAUTH_CLIENT_ID?: string;
  DISCORD_OAUTH_CLIENT_SECRET?: string;
  DISCORD_INSTALL_PERMISSIONS?: string;
  BETTER_AUTH_SECRET?: string;
  CONFIGURATION_REVISION_SIGNING_SECRET?: string;
  COMPONENT_ID_SIGNING_SECRET?: string;
  COMPONENT_ID_PREVIOUS_SIGNING_SECRET?: string;
  BETTER_AUTH_URL?: string;
  STAGING_MODE?: string;
  // In-process capability supplied only by the separate Node E2E entrypoint.
  // This is not an environment-variable binding.
  readonly discordE2eActors?: DiscordE2eActors;
  HAF_MAINTENANCE_MODE?: string;
  HAF_DEPLOYMENT_MODE?: string;
  SELF_HOSTED_OPERATOR_NAME?: string;
  SELF_HOSTED_SUPPORT_URL?: string;
  SELF_HOSTED_TERMS_URL?: string;
  SELF_HOSTED_PRIVACY_URL?: string;
  releaseVersion?: string;
  EVIDENCE_MEDIA_SIGNING_SECRET?: string;
  WEBHOOK_CREDENTIAL_KEY_V1?: string;
  WEBHOOK_CREDENTIAL_KEY_V2?: string;

  // Private Discord guild/role allowed to run global HAF admin slash commands.
  HAF_ADMIN_GUILD_ID?: string;
  HAF_ADMIN_ROLE_ID?: string;
  GLOBAL_ADMIN_LOG_CHANNEL_ID?: string;
  OPS_FEEDBACK_CHANNEL_ID?: string;

  // Feature toggles: set to "true", "1", or "yes" to disable a feature.
  // All features default to enabled.
  DISABLE_LFG?: string;
  DISABLE_MARKETPLACE?: string;
  DISABLE_EVENTS?: string;
  DISABLE_TICKETS?: string;
  DISABLE_BLOCKLIST?: string;
  DISABLE_TIMED_ROLES?: string;
  DISABLE_REACTION_ROLES?: string;
  DISABLE_WEBHOOK_PROXY?: string;
  DISABLE_ADMIN_UI?: string;
  DISABLE_PLAYER_COUNT?: string;
  DISABLE_STEAM_LINK?: string;
  DISABLE_XBOX_LINK?: string;
  ENABLE_WEBHOOK_PROXY_LOGS?: string;
  DISABLE_BAN_CASES?: string;
  DISABLE_MEMBER_VERIFICATION?: string;
  DISABLE_BOT_DEFENSE?: string;
  DISABLE_MENTION_PROTECTION?: string;
  DISABLE_SERVER_LEVELS?: string;

  BILLING_SYNC_QUEUE?: QueueProducer<unknown>;
  BILLING_DELIVERY_QUEUE?: QueueProducer<unknown>;
  COMMERCE_SYNC_QUEUE?: QueueProducer<unknown>;
  COMMERCE_ROLE_QUEUE?: QueueProducer<unknown>;
  COMMERCE_GAME_QUEUE?: QueueProducer<import("./commerce/game-access/model").GameAccessMessage>;
  // Explicit Commerce production switch.
  COMMERCE_ENABLED?: string;
  COMMERCE_SUPPORT_PAYMENTS_ENABLED?: string;
  COMMERCE_APPROVAL_CHANNEL_ID?: string;
  BILLING_AUDIT_CHANNEL_ID?: string;
  BILLING_SUPPORT_ROLE_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  STRIPE_API_VERSION?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_PREMIUM_PRODUCT_ID?: string;
  STRIPE_PREMIUM_MONTHLY_PRICE_ID?: string;
  STRIPE_PREMIUM_YEARLY_PRICE_ID?: string;
  STRIPE_PREMIUM_PLUS_PRODUCT_ID?: string;
  STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID?: string;
  STRIPE_PREMIUM_PLUS_YEARLY_PRICE_ID?: string;

  // Steam Web API key for direct server queries
  // Get one free at https://steamcommunity.com/dev/apikey
  STEAM_WEB_API_KEY?: string;
  STEAM_BAN_LOOKUP_RECHECK_INTERVAL_MS?: string;
  XBOX_OAUTH_CLIENT_ID?: string;
  XBOX_OAUTH_CLIENT_SECRET?: string;
  R2_QUOTA_QUEUE?: QueueProducer<unknown>;
  GATEWAY_EVENT_QUEUE: QueueProducer<unknown>;
  WEBHOOK_PROXY_DELIVERY_QUEUE?: QueueProducer<unknown>;
  STEAM_BAN_LOOKUP_QUEUE?: QueueProducer<unknown>;
  TICKET_RECOVERY_QUEUE?: QueueProducer<
    import("./services/tickets/ticket-lifecycle").TicketRecoveryEnvelope
  >;
  WARDOGS_PLAYER_COUNT_ENABLED?: string;
  WARDOGS_MUTATIONS_ENABLED?: string;
  WARDOGS_NETWORK_ENABLED?: string;
  WARDOGS_NETWORK_POLICY?: string;
  SERVER_LEVELS_QUEUE?: QueueProducer<import("./server-levels/ingress").ServerLevelIngressMessage>;
  discordCache?: Cache<string>;

  // Sentry DSN for error tracking (optional)
  SENTRY_DSN?: string;

  // Production-only, cookieless product analytics. POSTHOG_HOST is the explicit
  // regional origin; the token and pseudonym key are environment secrets.
  POSTHOG_HOST?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  PRODUCT_ANALYTICS_PSEUDONYM_KEY?: string;

  // Discord support server invite URL for upgrade CTAs (optional)
  DISCORD_SUPPORT_INVITE?: string;

  // HAF-global Turnstile configuration for enhanced Member Verification.
  // TURNSTILE_SITE_KEY is safe to expose to the browser.
  // TURNSTILE_SECRET_KEY must be kept server-side only.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  // HAF-global Image Rules classifier configuration.
  // IMAGE_RULES_API_BASE_URL and IMAGE_RULES_API_KEY are required for the feature to be usable.
  IMAGE_RULES_API_BASE_URL?: string;
  IMAGE_RULES_API_KEY?: string;
  IMAGE_RULES_MODEL?: string;
  IMAGE_RULES_MAX_IMAGE_BYTES?: string;
  IMAGE_RULES_MAX_IMAGE_DIMENSION?: string;
  IMAGE_RULES_TIMEOUT_MS?: string;
  IMAGE_RULES_MAX_RETRIES?: string;

  // HAF-global AI transcript summarizer configuration.
  // Defaults to the Image Rules provider URL/key; TRANSCRIPT_AI_* can override when needed.
  TRANSCRIPT_AI_API_BASE_URL?: string;
  TRANSCRIPT_AI_API_KEY?: string;
  TRANSCRIPT_AI_MODEL?: string;
  TRANSCRIPT_AI_TIMEOUT_MS?: string;
}
