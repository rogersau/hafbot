/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createGatewayBotController } from "./support/sqlite/runtime/gateway-bot-orchestration";
import type { WhiteLabelBot, WhiteLabelBotStatus } from "../src/types";

type GatewayRequest = {
  name: string;
  action: "start" | "status" | "stop";
  token: string | null;
  identity: string | null;
};

test("createGatewayBotController starts standard and active White-Label Bot gateway sessions", async () => {
  const requests: GatewayRequest[] = [];
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [whiteLabelBot("guild-1", "ACTIVE_TOKEN")],
    },
    resolveToken: async (secretRef) => `${secretRef}-resolved`,
  });

  await controller.start();

  assert.deepEqual(requests, [
    { name: "standard", action: "start", token: "standard-token", identity: "standard" },
    {
      name: "white-label:guild-1",
      action: "start",
      token: "ACTIVE_TOKEN-resolved",
      identity: "white-label:guild-1",
    },
  ]);
});

test("createGatewayBotController keeps the single standard-bot case when no White-Label Bots are active", async () => {
  const requests: GatewayRequest[] = [];
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [],
    },
    resolveToken: async () => {
      throw new Error("No White-Label Bot token should be resolved");
    },
  });

  await controller.start();

  assert.deepEqual(requests, [
    { name: "standard", action: "start", token: "standard-token", identity: "standard" },
  ]);
});

test("createGatewayBotController starts standard Gateway when discovery fails and recovers on the next start", async () => {
  const requests: GatewayRequest[] = [];
  const discoveryFailure = new Error("identity store unavailable");
  let discoveryFails = true;
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      async listActiveWhiteLabelBots() {
        if (discoveryFails) throw discoveryFailure;
        return [whiteLabelBot("guild-1", "ACTIVE_TOKEN")];
      },
    },
    resolveToken: async (secretRef) => `${secretRef}-resolved`,
  });

  await assert.rejects(controller.start(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [discoveryFailure]);
    return true;
  });
  assert.deepEqual(requests, [
    { name: "standard", action: "start", token: "standard-token", identity: "standard" },
  ]);

  discoveryFails = false;
  requests.length = 0;
  const results = await controller.start();

  assert.deepEqual(results, [{ status: "connecting" }, { status: "connecting" }]);
  assert.deepEqual(requests, [
    { name: "standard", action: "start", token: "standard-token", identity: "standard" },
    {
      name: "white-label:guild-1",
      action: "start",
      token: "ACTIVE_TOKEN-resolved",
      identity: "white-label:guild-1",
    },
  ]);
});

test("createGatewayBotController starts healthy identities when another White-Label credential fails", async () => {
  const requests: GatewayRequest[] = [];
  const credentialFailure = new Error("credential unavailable");
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [
        whiteLabelBot("broken", "MISSING_TOKEN"),
        whiteLabelBot("healthy", "ACTIVE_TOKEN"),
      ],
    },
    async resolveToken(secretRef) {
      if (secretRef === "MISSING_TOKEN") throw credentialFailure;
      return `${secretRef}-resolved`;
    },
  });

  await assert.rejects(controller.start(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [credentialFailure]);
    return true;
  });
  assert.deepEqual(requests, [
    { name: "standard", action: "start", token: "standard-token", identity: "standard" },
    {
      name: "white-label:healthy",
      action: "start",
      token: "ACTIVE_TOKEN-resolved",
      identity: "white-label:healthy",
    },
  ]);
});

test("createGatewayBotController waits for every startup and returns results in identity order", async () => {
  const completed: string[] = [];
  let finishStandard: () => void = () => {};
  const standardReady = new Promise<void>((resolve) => {
    finishStandard = resolve;
  });
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        async fetch() {
          if (name === "standard") await standardReady;
          completed.push(name);
          if (name === "white-label:guild-2") finishStandard();
          return Response.json({ identity: name });
        },
      }),
    },
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [
        whiteLabelBot("guild-1", "FIRST_TOKEN"),
        whiteLabelBot("guild-2", "SECOND_TOKEN"),
      ],
    },
    resolveToken: async (secretRef) => `${secretRef}-resolved`,
  });

  const results = await controller.start();

  assert.deepEqual(completed, ["white-label:guild-1", "white-label:guild-2", "standard"]);
  assert.deepEqual(results, [
    { identity: "standard" },
    { identity: "white-label:guild-1" },
    { identity: "white-label:guild-2" },
  ]);
});

test("createGatewayBotController reports every failed identity after healthy startups finish", async () => {
  const started: string[] = [];
  const credentialFailure = new Error("credential unavailable");
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "standard-token",
    gatewayNamespace: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        async fetch() {
          if (name === "standard") return new Response(null, { status: 503 });
          started.push(name);
          return Response.json({ status: "connecting" });
        },
      }),
    },
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [
        whiteLabelBot("broken", "MISSING_TOKEN"),
        whiteLabelBot("healthy", "ACTIVE_TOKEN"),
      ],
    },
    async resolveToken(secretRef) {
      if (secretRef === "MISSING_TOKEN") throw credentialFailure;
      return `${secretRef}-resolved`;
    },
  });

  await assert.rejects(controller.start(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0]?.message, "Cloudflare gateway request failed: 503");
    assert.equal(error.errors[1], credentialFailure);
    assert.deepEqual(started, ["white-label:healthy"]);
    return true;
  });
});

test("createGatewayBotController does not access gateway identities when startup is disabled", async () => {
  const requests: GatewayRequest[] = [];
  const controller = createGatewayBotController({
    enabled: false,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => {
        throw new Error("Disabled gateways must not list identities");
      },
    },
    resolveToken: async () => {
      throw new Error("Disabled gateways must not resolve bot tokens");
    },
  });

  await controller.start();

  assert.deepEqual(requests, []);
});

test("createGatewayBotController stops every identity without resolving credentials", async () => {
  const requests: GatewayRequest[] = [];
  const controller = createGatewayBotController({
    enabled: false,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => [whiteLabelBot("guild-1", "MISSING_TOKEN")],
    },
    resolveToken: async () => {
      throw new Error("Stopping a Gateway must not require its credential");
    },
  });

  assert.ok(controller.stop);
  await controller.stop();

  assert.deepEqual(requests, [
    { name: "standard", action: "stop", token: null, identity: null },
    { name: "white-label:guild-1", action: "stop", token: null, identity: null },
  ]);
});

test("createGatewayBotController still stops standard Gateway when identity discovery fails", async () => {
  const requests: GatewayRequest[] = [];
  const controller = createGatewayBotController({
    enabled: false,
    standardBotToken: "standard-token",
    gatewayNamespace: fakeGatewayNamespace(requests),
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => {
        throw new Error("identity store unavailable");
      },
    },
    resolveToken: async () => "unused",
  });

  assert.ok(controller.stop);
  await assert.rejects(async () => {
    await controller.stop!();
  }, /Gateway identities could not be stopped/);
  assert.deepEqual(requests, [{ name: "standard", action: "stop", token: null, identity: null }]);
});

function whiteLabelBot(
  guildId: string,
  tokenSecretRef: string,
  status: WhiteLabelBotStatus = "active",
): WhiteLabelBot {
  return {
    guildId,
    applicationId: `app-${guildId}`,
    botUserId: `bot-${guildId}`,
    displayName: `Bot ${guildId}`,
    brandFooterText: null,
    status,
    tokenSecretRef,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function fakeGatewayNamespace(requests: GatewayRequest[]) {
  return {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const headers = new Headers(init?.headers);
          const action = new URL(String(input)).pathname.slice(1) as GatewayRequest["action"];
          requests.push({
            name: id.name,
            action,
            token: headers.get("X-Discord-Bot-Token"),
            identity: headers.get("X-Gateway-Bot-Identity"),
          });
          return Response.json({ status: "connecting" });
        },
      };
    },
  };
}
