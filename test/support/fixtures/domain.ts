import type { DiscordInteraction } from "../../../src/runtime/app-types";
import type { CustomerSession } from "../../../src/runtime/auth/customer-session";
import type { WorkspaceSummary } from "../../../src/runtime/workspace-types";
import type { GuildEntitlement, TicketInstance, WebhookProxyConfig } from "../../../src/types";
import { IdSequence } from "../id-sequence";
import { TestClock } from "../test-clock";

export interface FixtureContext {
  ids?: IdSequence;
  clock?: TestClock;
}

function context(input: FixtureContext = {}) {
  return { ids: input.ids ?? new IdSequence(), clock: input.clock ?? new TestClock() };
}

export function guildFixture(
  overrides: Partial<{ id: string; name: string }> = {},
  input?: FixtureContext,
) {
  const { ids } = context(input);
  return { id: overrides.id ?? ids.next("guild"), name: overrides.name ?? "Test Guild" };
}

export function customerSessionFixture(
  overrides: Partial<CustomerSession> = {},
  input?: FixtureContext,
): CustomerSession {
  const { ids, clock } = context(input);
  return {
    session: {
      id: ids.next("session"),
      expiresAt: new Date(clock.now() + 3_600_000),
      token: ids.next("token"),
      createdAt: new Date(clock.now()),
      updatedAt: new Date(clock.now()),
      userId: ids.next("user"),
    },
    user: {
      id: ids.next("user"),
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      discordUserId: ids.next("discord"),
      createdAt: new Date(clock.now()),
      updatedAt: new Date(clock.now()),
    },
    ...overrides,
  };
}

export function workspaceFixture(
  overrides: Partial<WorkspaceSummary> = {},
  input?: FixtureContext,
): WorkspaceSummary {
  const { ids } = context(input);
  return { id: ids.next("workspace"), name: "Test Workspace", role: "owner", ...overrides };
}

export function entitlementFixture(
  overrides: Partial<GuildEntitlement> = {},
  input?: FixtureContext,
): GuildEntitlement {
  const { ids, clock } = context(input);
  return {
    guildId: ids.next("guild"),
    tier: "premium",
    expiresAtMs: null,
    updatedAtMs: clock.now(),
    ...overrides,
  };
}

export function discordInteractionFixture(
  overrides: Partial<DiscordInteraction> = {},
  input?: FixtureContext,
): DiscordInteraction {
  const { ids } = context(input);
  return {
    id: ids.next("interaction"),
    type: 2,
    token: ids.next("token"),
    application_id: ids.next("app"),
    guild_id: ids.next("guild"),
    member: { user: { id: ids.next("user") } },
    data: { name: "test" },
    ...overrides,
  } as DiscordInteraction;
}

export function discordMessageFixture(
  overrides: Record<string, unknown> = {},
  input?: FixtureContext,
) {
  const { ids, clock } = context(input);
  return {
    id: ids.next("message"),
    guild_id: ids.next("guild"),
    channel_id: ids.next("channel"),
    author: { id: ids.next("user"), bot: false },
    content: "test message",
    timestamp: new Date(clock.now()).toISOString(),
    ...overrides,
  };
}

export function ticketFixture(
  overrides: Partial<TicketInstance> = {},
  input?: FixtureContext,
): TicketInstance {
  const { ids, clock } = context(input);
  return {
    guildId: ids.next("guild"),
    channelId: ids.next("channel"),
    openerId: ids.next("user"),
    typeId: "support",
    openedAtMs: clock.now(),
    closedAtMs: null,
    closedBy: null,
    closeReason: null,
    transcriptKey: null,
    ...overrides,
  };
}

export function webhookProxyFixture(
  overrides: Partial<WebhookProxyConfig> = {},
  input?: FixtureContext,
): WebhookProxyConfig {
  const { ids, clock } = context(input);
  return {
    guildId: ids.next("guild"),
    publicId: ids.next("webhook"),
    name: "Test webhook",
    enabled: true,
    destinations: [],
    routingRules: [],
    contentReplacements: [],
    createdAtMs: clock.now(),
    updatedAtMs: clock.now(),
    ...overrides,
  };
}

export function queueMessageFixture<T>(body: T, input?: FixtureContext) {
  const { ids, clock } = context(input);
  return { id: ids.next("queue"), timestamp: new Date(clock.now()), body };
}
