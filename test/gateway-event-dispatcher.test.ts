/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  dispatchGatewayEventHandlers,
  type GatewayEventHandler,
} from "../src/runtime/gateway-events/dispatcher";
import type {
  GatewayEventCapabilities,
  GatewayEventEnvelope,
} from "../src/runtime/gateway-events/contracts";
import { defineGatewayEventHandler } from "../src/runtime/gateway-events/define-handler";
import { gatewayEventHandlers } from "../src/runtime/gateway-events/registry";
import { ALL_FEATURES_ENABLED, type FeatureFlags } from "../src/runtime/features";

interface Envelope {
  type: string;
}

interface Capabilities {
  enabled: boolean;
  calls: string[];
}

function handler(
  key: string,
  order: number,
  options: {
    eventTypes?: string[];
    enabled?: (capabilities: Capabilities) => boolean;
    outcome?: "continue" | "stop";
    error?: Error;
  } = {},
): GatewayEventHandler<Envelope, Capabilities> {
  return {
    key,
    order,
    eventTypes: options.eventTypes ?? ["MESSAGE_CREATE"],
    isEnabled: options.enabled,
    async handle(capabilities) {
      capabilities.calls.push(key);
      if (options.error) throw options.error;
      return options.outcome;
    },
  };
}

test("Gateway handler dispatch filters by event and feature gate, then preserves declared order", async () => {
  const capabilities: Capabilities = { enabled: false, calls: [] };
  const results = await dispatchGatewayEventHandlers(
    [
      handler("late", 30),
      handler("other-event", 5, { eventTypes: ["MESSAGE_DELETE"] }),
      handler("disabled", 10, { enabled: (value) => value.enabled }),
      handler("early", 20),
    ],
    capabilities,
    { type: "MESSAGE_CREATE" },
  );

  assert.deepEqual(capabilities.calls, ["early", "late"]);
  assert.deepEqual(results, [
    { handlerKey: "early", outcome: "continue" },
    { handlerKey: "late", outcome: "continue" },
  ]);
});

test("Gateway handler dispatch preserves managed-message style short circuits", async () => {
  const capabilities: Capabilities = { enabled: true, calls: [] };
  await dispatchGatewayEventHandlers(
    [
      handler("tickets", 10),
      handler("managed-message", 20, { outcome: "stop" }),
      handler("audit", 30),
    ],
    capabilities,
    { type: "MESSAGE_CREATE" },
  );

  assert.deepEqual(capabilities.calls, ["tickets", "managed-message"]);
});

test("Gateway handler dispatch stops on partial failure and exposes prior outcomes", async () => {
  const capabilities: Capabilities = { enabled: true, calls: [] };
  const observed: string[] = [];

  await assert.rejects(
    dispatchGatewayEventHandlers(
      [
        handler("first", 10),
        handler("failed", 20, { error: new Error("provider failed") }),
        handler("last", 30),
      ],
      capabilities,
      { type: "MESSAGE_CREATE" },
      (result) => observed.push(result.handlerKey),
    ),
    /provider failed/,
  );
  assert.deepEqual(capabilities.calls, ["first", "failed"]);
  assert.deepEqual(observed, ["first"]);
});

const EXPECTED_HANDLER_CALLS: Readonly<Record<string, readonly string[]>> = {
  MESSAGE_REACTION_ADD: ["reaction-blocklist", "reaction-limits", "reaction-roles", "suggestions"],
  MESSAGE_REACTION_REMOVE: ["reaction-roles", "suggestions"],
  MESSAGE_CREATE: [
    "community-tools",
    "mention-protection",
    "message-blocklist",
    "image-rules",
    "bot-defense",
    "tickets",
    "suggestions",
  ],
  MESSAGE_UPDATE: ["mention-protection", "tickets", "message-audit"],
  MESSAGE_DELETE: ["tickets", "managed-message-delete", "message-audit"],
  GUILD_MEMBER_ADD: [
    "server-level-membership",
    "community-tools",
    "platform-link-restore",
    "timed-roles",
    "commerce-paid-role-membership",
    "member-verification",
    "member-audit",
  ],
  GUILD_MEMBER_UPDATE: ["timed-roles", "member-audit"],
  GUILD_MEMBER_REMOVE: [
    "server-level-membership",
    "platform-link-deactivate",
    "community-tools",
    "clan-reconciliation",
    "commerce-paid-role-membership",
    "member-audit",
    "suggestions",
  ],
  GUILD_BAN_ADD: ["commerce-paid-role-membership", "ban-audit"],
  GUILD_BAN_REMOVE: ["ban-audit"],
  INVITE_CREATE: ["structure-audit"],
  CHANNEL_CREATE: ["structure-audit"],
  CHANNEL_UPDATE: ["structure-audit"],
  CHANNEL_DELETE: ["clan-reconciliation", "structure-audit"],
  GUILD_ROLE_DELETE: ["clan-reconciliation"],
  GUILD_CREATE: ["guild-lifecycle"],
  GUILD_DELETE: ["guild-lifecycle", "commerce-paid-role-membership"],
  VOICE_STATE_UPDATE: ["lfg-voice-cleanup"],
  UNSUPPORTED: [],
};

test("production Gateway registry preserves the expected call order for every event type", () => {
  const capabilities = registryCapabilities(ALL_FEATURES_ENABLED);
  for (const [eventType, expectedCalls] of Object.entries(EXPECTED_HANDLER_CALLS)) {
    assert.deepEqual(eligibleProductionHandlers(eventType, capabilities), expectedCalls, eventType);
  }
});

test("production Gateway feature gates remove only their characterized handlers", () => {
  const handlerKeysByFeature: Partial<Record<keyof FeatureFlags, readonly string[]>> = {
    blocklist: ["reaction-blocklist", "message-blocklist"],
    mentionProtection: ["mention-protection"],
    imageRules: ["image-rules"],
    botDefense: ["bot-defense"],
    tickets: ["tickets"],
    timedRoles: ["timed-roles"],
    memberVerification: ["member-verification"],
    lfg: ["lfg-voice-cleanup"],
    clans: ["clan-reconciliation"],
    suggestions: ["suggestions"],
    serverLevels: ["server-level-membership"],
    reactionRoles: ["reaction-roles"],
  };
  for (const [feature, removedKeys] of Object.entries(handlerKeysByFeature) as Array<
    [keyof FeatureFlags, readonly string[]]
  >) {
    const capabilities = registryCapabilities({ ...ALL_FEATURES_ENABLED, [feature]: false });
    for (const [eventType, expectedCalls] of Object.entries(EXPECTED_HANDLER_CALLS)) {
      assert.deepEqual(
        eligibleProductionHandlers(eventType, capabilities),
        expectedCalls.filter((key) => !removedKeys.includes(key)),
        `${feature}:${eventType}`,
      );
    }
  }
});

test("production handler registration exposes only declared capabilities and stores", async () => {
  let received: object | undefined;
  const registered = defineGatewayEventHandler(["features"], ["lfg"], {
    key: "scoped",
    eventTypes: ["VOICE_STATE_UPDATE"],
    order: 10,
    async handle(capabilities) {
      received = capabilities;
    },
  });
  const capabilities = {
    features: ALL_FEATURES_ENABLED,
    env: { secret: true },
    stores: { lfg: { expected: true }, audit: { hidden: true } },
  } as unknown as GatewayEventCapabilities;

  await registered.handle(capabilities, gatewayEnvelope("VOICE_STATE_UPDATE"));

  assert.deepEqual(Object.keys(received!).sort(), ["features", "stores"]);
  assert.deepEqual(Object.keys((received as { stores: object }).stores), ["lfg"]);
});

test("every production handler declares its least-capability scope", () => {
  const scopes = Object.fromEntries(
    gatewayEventHandlers.map((handler) => [handler.key, handler.scope]),
  );
  assert.deepEqual(scopes, {
    "community-tools": scope(["operations"], ["communityTools", "reputationServiceForGuild"]),
    "reaction-roles": scope(["env", "features", "discord", "operations"], ["reactionRole"]),
    "reaction-blocklist": scope(
      ["botEnv", "features", "operations", "productAnalytics"],
      ["blocklist"],
    ),
    "mention-protection": scope(["env", "features", "mentionProtection", "operations"]),
    "message-blocklist": scope(
      ["botEnv", "features", "operations", "discord", "resolveBotDisplayName"],
      ["blocklist"],
    ),
    "image-rules": scope(
      ["env", "botEnv", "features", "operations", "discord", "resolveBotDisplayName"],
      ["audit", "imageRules"],
    ),
    "bot-defense": scope(
      ["env", "botEnv", "features", "operations", "resolveBotDisplayName"],
      ["audit", "botDefense", "entitlement"],
    ),
    "reaction-limits": scope(
      ["operations", "discord", "productAnalytics"],
      ["reactionLimit", "reactionMutations", "timedRole", "blocklist", "entitlement"],
    ),
    tickets: scope(["env", "features", "discord", "operations"], ["guildRbac", "ticket"]),
    "platform-link-deactivate": scope(["env", "botEnv", "operations"], ["platformLink"]),
    "platform-link-restore": scope(["env", "botEnv", "operations", "discord"], ["platformLink"]),
    "server-level-membership": scope(
      ["env", "features", "operations"],
      ["entitlement", "platformLink", "serverLevel"],
    ),
    "timed-roles": scope(
      ["env", "botEnv", "features", "operations", "discord"],
      ["blocklist", "timedRole"],
    ),
    "commerce-paid-role-membership": scope(["commerceLifecycle", "operations"]),
    "member-verification": scope(["env", "features", "operations", "memberVerificationService"]),
    "managed-message-delete": scope(["env", "botEnv"], ["audit", "managedMessage"]),
    "message-audit": scope(["env", "botEnv", "operations"], ["audit"]),
    "member-audit": scope(["env", "botEnv", "operations"], ["audit"]),
    "ban-audit": scope(["env", "botEnv", "operations"], ["audit"]),
    "structure-audit": scope(["env", "botEnv", "operations"], ["audit"]),
    "guild-lifecycle": scope(
      ["env", "operations", "discord", "standardDiscord", "productAnalytics"],
      ["knownGuild", "guildServiceSuspensions", "serverLevel", "observations"],
    ),
    "clan-reconciliation": scope(["env", "features", "operations", "clanService"], []),
    "lfg-voice-cleanup": scope(["env", "features", "discord", "operations"], ["lfg"]),
    suggestions: scope(
      ["botEnv", "features", "discord", "operations"],
      ["suggestion", "audit", "webhookCredential"],
    ),
  });
});

function eligibleProductionHandlers(
  eventType: string,
  capabilities: GatewayEventCapabilities,
): string[] {
  const envelope = gatewayEnvelope(eventType);
  return gatewayEventHandlers
    .filter(
      (handler) =>
        handler.eventTypes.includes(eventType) &&
        (handler.isEnabled?.(capabilities, envelope) ?? true),
    )
    .sort((left, right) => left.order - right.order)
    .map((handler) => handler.key);
}

function registryCapabilities(features: FeatureFlags): GatewayEventCapabilities {
  return {
    env: {},
    features,
    stores: {},
    commerceLifecycle: {},
    clanService: {},
    memberVerificationService: {},
  } as unknown as GatewayEventCapabilities;
}

function gatewayEnvelope(type: string): GatewayEventEnvelope {
  return {
    version: 2,
    eventKey: `test:${type}`,
    sessionId: null,
    sequence: null,
    type,
    data: {},
    emptiedVoiceChannelId: type === "VOICE_STATE_UPDATE" ? "channel-1" : null,
  };
}

function scope(capabilityKeys: string[], storeKeys: string[] = []) {
  return { capabilityKeys, storeKeys };
}
