/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { buildAwardSegments, ServerLevelProcessor } from "../src/server-levels/processor";
import type { ServerLevelAward } from "../src/server-levels/model";
import { createSqlitePlatformLinkStore } from "./support/sqlite/runtime/sqlite-platform-link-store";
import { createSqliteServerLevelStore } from "./support/sqlite/runtime/sqlite-server-level-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("trusted linked attendance awards fixed-point Server XP through the durable processor", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 500,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join",
      deliveryId: "delivery-join",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    await accept(store, {
      inboxId: "leave",
      deliveryId: "delivery-leave",
      eventType: "player.leave",
      occurredAtMs: 16_000,
      steamId64: "76561198000000001",
      population: 0,
    });

    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 2,
      late: 0,
      rejected: 0,
    });
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 60);
  } finally {
    database.close();
  }
});

test("lifecycle boundaries, Free entitlement, and the kill switch fail closed without catch-up", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 100);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: true,
      actionedByUserId: "admin-1",
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join-free",
      deliveryId: "delivery-1",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    await accept(store, {
      inboxId: "restart-free",
      deliveryId: "delivery-2",
      eventType: "server.restart",
      occurredAtMs: 61_000,
      steamId64: null,
      population: 0,
    });
    const free = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "free",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    await free.processAvailableForServer("server-1");
    assert.equal(await store.readProfile("guild-1", "user-1"), null);

    await accept(store, {
      inboxId: "join-killed",
      deliveryId: "delivery-3",
      eventType: "player.join",
      occurredAtMs: 800_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    await accept(store, {
      inboxId: "leave-killed",
      deliveryId: "delivery-4",
      eventType: "player.leave",
      occurredAtMs: 860_000,
      steamId64: "76561198000000001",
      population: 0,
    });
    const killed = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium_plus",
      isCurrentGuildMember: async () => true,
      isKillSwitchEnabled: () => true,
      now: () => 1_500_000,
      createId: ids(),
    });
    await killed.processAvailableForServer("server-1");
    assert.equal(await store.readProfile("guild-1", "user-1"), null);
  } finally {
    database.close();
  }
});

test("periodic checkpoints award only through the ordering watermark", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join",
      deliveryId: "delivery-join",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    await processor.checkpointAvailableForServer("server-1", 1_000_000);

    // The safe watermark is now - 10 minutes: 399 seconds at 4x after the join.
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 1_596);
  } finally {
    database.close();
  }
});

test("linking Steam during trusted current presence starts earning at the link timestamp", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await accept(store, {
      inboxId: "join-unlinked",
      deliveryId: "delivery-unlinked",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    assert.equal(await store.readProfile("guild-1", "user-1"), null);

    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 61_000,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await processor.checkpointAvailableForServer("server-1", 721_000);

    // The checkpoint watermark is 121s, so only the 60s after linking earns at 4x.
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  } finally {
    database.close();
  }
});

test("continuous sessions stop at twelve hours and cannot reopen without a fresh join", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  const joinedAtMs = 1_000;
  const twelveHoursMs = 12 * 60 * 60 * 1_000;
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join",
      deliveryId: "delivery-join",
      eventType: "player.join",
      occurredAtMs: joinedAtMs,
      steamId64: "76561198000000001",
      population: 1,
    });
    let currentTime = 700_001;
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => currentTime,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    currentTime = joinedAtMs + twelveHoursMs + 700_000;
    await processor.checkpointAvailableForServer("server-1", currentTime);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 12 * 60 * 60 * 4);
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);

    currentTime += 60 * 60 * 1_000;
    await processor.checkpointAvailableForServer("server-1", currentTime);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 12 * 60 * 60 * 4);
  } finally {
    database.close();
  }
});

test("the ordering buffer starts at receipt time and late arrivals fail closed", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    let currentTime = 700_001;
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => currentTime,
      createId: ids(),
    });
    await accept(store, {
      inboxId: "restart",
      deliveryId: "delivery-restart",
      eventType: "server.restart",
      occurredAtMs: 100_000,
      steamId64: null,
      population: 0,
    });
    await processor.processAvailableForServer("server-1");
    await processor.checkpointAvailableForServer("server-1", 1_000_000);

    await store.acceptProviderEvent({
      inboxId: "late",
      deliveryId: "delivery-late",
      configuredGameServerId: "server-1",
      guildId: "guild-1",
      eventType: "server.restart",
      occurredAtMs: 400_000,
      steamId64: null,
      population: 0,
      queueSize: 0,
      receivedAtMs: 1_000_001,
    });
    currentTime = 1_100_000;
    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 0,
      late: 0,
      rejected: 0,
    });
    currentTime = 1_700_001;
    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 0,
      late: 1,
      rejected: 0,
    });
  } finally {
    database.close();
  }
});

test("a checkpoint stops before an accepted event whose receipt window is still open", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    let currentTime = 700_002;
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => currentTime,
      createId: ids(),
    });
    await accept(store, {
      inboxId: "initial",
      deliveryId: "delivery-initial",
      eventType: "server.restart",
      occurredAtMs: 100_000,
      steamId64: null,
      population: 0,
    });
    await processor.processAvailableForServer("server-1");
    await store.acceptProviderEvent({
      inboxId: "delayed",
      deliveryId: "delivery-delayed",
      configuredGameServerId: "server-1",
      guildId: "guild-1",
      eventType: "server.restart",
      occurredAtMs: 400_000,
      steamId64: null,
      population: 0,
      queueSize: 0,
      receivedAtMs: 900_000,
    });

    await processor.checkpointAvailableForServer("server-1", 1_000_000);
    currentTime = 1_500_001;
    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 1,
      late: 0,
      rejected: 0,
    });
  } finally {
    database.close();
  }
});

test("an event already older than the ordering window is late even without a cursor", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await store.acceptProviderEvent({
      inboxId: "stale-first",
      deliveryId: "delivery-stale-first",
      configuredGameServerId: "server-1",
      guildId: "guild-1",
      eventType: "server.restart",
      occurredAtMs: 100_000,
      steamId64: null,
      population: 0,
      queueSize: 0,
      receivedAtMs: 800_001,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 1_400_002,
      createId: ids(),
    });

    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 0,
      late: 1,
      rejected: 0,
    });
    assert.equal(await store.readProcessingCursor("server-1"), null);
  } finally {
    database.close();
  }
});

test("cross-server awards serialize by Guild member before overlap and cap decisions", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await seedServer(store, "server-2", "endpoint-2", 100);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    for (const serverId of ["server-1", "server-2"]) {
      await acceptForServer(store, serverId, {
        inboxId: `${serverId}-join`,
        deliveryId: `${serverId}-delivery-join`,
        eventType: "player.join",
        occurredAtMs: 1_000,
        steamId64: "76561198000000001",
        population: 1,
      });
      await acceptForServer(store, serverId, {
        inboxId: `${serverId}-leave`,
        deliveryId: `${serverId}-delivery-leave`,
        eventType: "player.leave",
        occurredAtMs: 61_000,
        steamId64: "76561198000000001",
        population: 0,
      });
    }

    let releaseServerBarrier!: () => void;
    const serverBarrier = new Promise<void>((resolve) => {
      releaseServerBarrier = resolve;
    });
    let serverLeaseCount = 0;
    let releaseFirstMemberAttempt!: () => void;
    const secondMemberAttempt = new Promise<void>((resolve) => {
      releaseFirstMemberAttempt = resolve;
    });
    let memberLeaseAttempts = 0;
    const serializedStore = {
      ...store,
      async acquireProcessingLease(
        key: string,
        leaseId: string,
        nowMs: number,
        expiresAtMs: number,
      ) {
        const acquired = await store.acquireProcessingLease(key, leaseId, nowMs, expiresAtMs);
        if (key.startsWith("member:")) {
          memberLeaseAttempts += 1;
          if (memberLeaseAttempts === 2) releaseFirstMemberAttempt();
          if (acquired && memberLeaseAttempts === 1) await secondMemberAttempt;
          return acquired;
        }
        if (acquired) {
          serverLeaseCount += 1;
          if (serverLeaseCount === 2) releaseServerBarrier();
          await serverBarrier;
        }
        return acquired;
      },
      async releaseProcessingLease(key: string, leaseId: string) {
        await store.releaseProcessingLease(key, leaseId);
      },
    };
    const processors = ["server-1", "server-2"].map(
      () =>
        new ServerLevelProcessor({
          store: serializedStore,
          platformLinks: links,
          readEntitlementTier: async () => "premium",
          isCurrentGuildMember: async () => true,
          now: () => 700_001,
          createId: ids(),
        }),
    );
    const concurrent = await Promise.allSettled([
      processors[0]!.processAvailableForServer("server-1"),
      processors[1]!.processAvailableForServer("server-2"),
    ]);
    assert.equal(memberLeaseAttempts, 2);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);

    await processors[0]!.processAvailableForServer("server-1");
    await processors[1]!.processAvailableForServer("server-2");
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  } finally {
    database.close();
  }
});

test("a held processing lease blocks processing and a failing run releases its own lease", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 500,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join",
      deliveryId: "delivery-join",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    await accept(store, {
      inboxId: "leave",
      deliveryId: "delivery-leave",
      eventType: "player.leave",
      occurredAtMs: 16_000,
      steamId64: "76561198000000001",
      population: 0,
    });

    assert.equal(
      await store.acquireProcessingLease("server-1", "other-worker", 700_000, 1_000_000),
      true,
    );
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    assert.deepEqual(await processor.processAvailableForServer("server-1"), {
      processed: 0,
      late: 0,
      rejected: 0,
    });
    assert.equal(await store.readProfile("guild-1", "user-1"), null);
    await store.releaseProcessingLease("server-1", "other-worker");

    let failNextRead = true;
    const flakyStore = {
      ...store,
      async listAcceptedProviderEvents(configuredGameServerId: string, safeThroughMs: number) {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("injected processing failure");
        }
        return store.listAcceptedProviderEvents(configuredGameServerId, safeThroughMs);
      },
    };
    const flakyProcessor = new ServerLevelProcessor({
      store: flakyStore,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_000,
      createId: ids(),
    });
    await assert.rejects(
      flakyProcessor.processAvailableForServer("server-1"),
      /injected processing failure/,
    );
    assert.deepEqual(await flakyProcessor.processAvailableForServer("server-1"), {
      processed: 2,
      late: 0,
      rejected: 0,
    });
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 60);
  } finally {
    database.close();
  }
});

test("Steam unlink checkpoints accrued XP before closing the earning session", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join-before-unlink",
      deliveryId: "delivery-join-before-unlink",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_001,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    await processor.stopEarningForLinkedIdentity({
      guildId: "guild-1",
      userId: "user-1",
      steamId64: "76561198000000001",
      removedAtMs: 61_000,
    });

    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.equal((await store.listOpenEarningSessions("server-1")).length, 0);
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);
  } finally {
    database.close();
  }
});

test("disabling Server Levels checkpoints accrued XP before closing earning sessions", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join-before-disable",
      deliveryId: "delivery-join-before-disable",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => 700_001,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    await processor.stopEarningForGuild({
      guildId: "guild-1",
      stoppedAtMs: 61_000,
      reason: "feature_disabled",
      sourceId: "disable:guild-1:1",
    });

    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.equal((await store.listOpenEarningSessions("server-1")).length, 0);
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);
  } finally {
    database.close();
  }
});

test("Guild member departure checkpoints accrued XP before closing earning sessions", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "join-before-member-departure",
      deliveryId: "delivery-join-before-member-departure",
      eventType: "player.join",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    let currentMember = true;
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => currentMember,
      now: () => 700_001,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");
    currentMember = false;
    await processor.stopEarningForMember({
      guildId: "guild-1",
      userId: "user-1",
      stoppedAtMs: 61_000,
      sourceId: "member-departure:guild-1:user-1:1",
    });

    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.equal((await store.listOpenEarningSessions("server-1")).length, 0);
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);
  } finally {
    database.close();
  }
});

test("Data API reconciliation establishes a no-backfill roster and proposes capacity", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const links = createSqlitePlatformLinkStore(database.d1);
  let currentTime = 700_001;
  try {
    await seedServer(store, "server-1", "endpoint-1", 4);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await accept(store, {
      inboxId: "restart",
      deliveryId: "delivery-restart",
      eventType: "server.restart",
      occurredAtMs: 1_000,
      steamId64: null,
      population: 0,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: links,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => currentTime,
      createId: ids(),
    });
    await processor.processAvailableForServer("server-1");

    currentTime = 800_000;
    assert.equal(
      await processor.reconcileCurrentRoster({
        configuredGameServerId: "server-1",
        steamIds: ["76561198000000001"],
        population: 1,
        queueSize: 0,
        maxSlots: 6,
        observedAtMs: currentTime,
        checkCapacity: true,
      }),
      "completed",
    );
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 0);
    assert.deepEqual(
      (await store.readConfiguredGameServer("guild-1", "server-1"))?.capacityProposal,
      { maxSlots: 6, observedAtMs: 800_000 },
    );

    await accept(store, {
      inboxId: "leave-after-roster",
      deliveryId: "delivery-leave-after-roster",
      eventType: "player.leave",
      occurredAtMs: 860_000,
      steamId64: "76561198000000001",
      population: 0,
    });
    currentTime = 1_500_001;
    await processor.processAvailableForServer("server-1");
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);

    await accept(store, {
      inboxId: "join-before-empty-roster",
      deliveryId: "delivery-join-before-empty-roster",
      eventType: "player.join",
      occurredAtMs: 2_000_000,
      steamId64: "76561198000000001",
      population: 1,
    });
    currentTime = 2_700_001;
    await processor.processAvailableForServer("server-1");
    currentTime = 2_710_000;
    await processor.reconcileCurrentRoster({
      configuredGameServerId: "server-1",
      steamIds: [],
      population: 0,
      queueSize: 0,
      maxSlots: 6,
      observedAtMs: currentTime,
      checkCapacity: false,
    });
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);
  } finally {
    database.close();
  }
});

test("overlapping servers award only the highest multiplier delta", () => {
  const lowerAward = intervalAward({
    awardId: "lower",
    intervalStartedAtMs: 0,
    intervalEndedAtMs: 60_000,
    qualifyingSeconds: 60,
    multiplier: 2,
  });
  assert.deepEqual(buildAwardSegments(0, 60_000, 1, [lowerAward]), []);
  assert.deepEqual(buildAwardSegments(0, 60_000, 4, [lowerAward]), [
    {
      kind: "overlap_delta",
      startedAtMs: 0,
      endedAtMs: 60_000,
      qualifyingSeconds: 0,
      multiplier: 4,
      xpUnits: 120,
    },
  ]);
});

test("the rolling cap blocks new qualifying seconds after twelve hours in twenty-four", () => {
  const twelveHoursMs = 12 * 60 * 60 * 1_000;
  const existing = intervalAward({
    awardId: "cap",
    intervalStartedAtMs: 0,
    intervalEndedAtMs: twelveHoursMs,
    qualifyingSeconds: 12 * 60 * 60,
    multiplier: 1,
  });
  assert.deepEqual(buildAwardSegments(twelveHoursMs, twelveHoursMs + 60_000, 4, [existing]), []);
});

test("the rolling cap resumes only as earlier qualifying time expires", () => {
  const hourMs = 60 * 60 * 1_000;
  const existing = intervalAward({
    awardId: "first-twelve-hours",
    intervalStartedAtMs: 0,
    intervalEndedAtMs: 12 * hourMs,
    qualifyingSeconds: 12 * 60 * 60,
    multiplier: 1,
  });

  assert.deepEqual(buildAwardSegments(18 * hourMs, 30 * hourMs, 4, [existing]), [
    {
      kind: "interval",
      startedAtMs: 24 * hourMs,
      endedAtMs: 30 * hourMs,
      qualifyingSeconds: 6 * 60 * 60,
      multiplier: 4,
      xpUnits: 24 * 60 * 60,
    },
  ]);
});

async function seedServer(
  store: ReturnType<typeof createSqliteServerLevelStore>,
  id: string,
  endpointId: string,
  maxSlots: number,
) {
  await store.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    announcementChannelId: null,
    removedAtMs: null,
    updatedAtMs: 1,
  });
  await store.createConfiguredGameServer({
    id,
    guildId: "guild-1",
    displayName: "DayZ",
    providerServerId: id,
    maxSlots,
    endpointId,
    webhookCredentialId: `credential-${id}`,
    webhookVerifiedAtMs: 1,
    subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
    capacityProposal: null,
    lastRosterReconciledAtMs: null,
    lastCapacityCheckedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
}

async function accept(
  store: ReturnType<typeof createSqliteServerLevelStore>,
  input: {
    inboxId: string;
    deliveryId: string;
    eventType: "player.join" | "player.leave" | "server.restart" | "server.shutdown";
    occurredAtMs: number;
    steamId64: string | null;
    population: number;
  },
) {
  await store.acceptProviderEvent({
    ...input,
    configuredGameServerId: "server-1",
    guildId: "guild-1",
    queueSize: 0,
    receivedAtMs: input.occurredAtMs + 1,
  });
}

async function acceptForServer(
  store: ReturnType<typeof createSqliteServerLevelStore>,
  configuredGameServerId: string,
  input: {
    inboxId: string;
    deliveryId: string;
    eventType: "player.join" | "player.leave" | "server.restart" | "server.shutdown";
    occurredAtMs: number;
    steamId64: string | null;
    population: number;
  },
) {
  await store.acceptProviderEvent({
    ...input,
    configuredGameServerId,
    guildId: "guild-1",
    queueSize: 0,
    receivedAtMs: input.occurredAtMs + 1,
  });
}

function ids(): () => string {
  let value = 0;
  return () => `generated-${value++}`;
}

function intervalAward(
  input: Pick<
    ServerLevelAward,
    "awardId" | "intervalStartedAtMs" | "intervalEndedAtMs" | "qualifyingSeconds" | "multiplier"
  >,
): ServerLevelAward {
  return {
    ...input,
    guildId: "guild-1",
    userId: "user-1",
    configuredGameServerId: "server-1",
    sourceInboxId: "source-1",
    kind: "interval",
    xpUnits: input.qualifyingSeconds * (input.multiplier ?? 0),
    scoringPolicyVersion: 1,
    actorUserId: null,
    reason: null,
    createdAtMs: input.intervalEndedAtMs ?? 0,
  };
}

for (const validSnapshot of [true, false]) {
  test(`Steam replacement finalizes accrued XP after commit with ${validSnapshot ? "the removed identity" : "an unrelated snapshot rejected"}`, async () => {
    const database = new SqliteD1Database();
    const store = createSqliteServerLevelStore(database.d1);
    const links = createSqlitePlatformLinkStore(database.d1);
    try {
      await seedServer(store, "server-1", "endpoint-1", 4);
      const original = {
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam" as const,
        platformId: "76561198000000001",
        linkedAtMs: 0,
        manual: false,
        actionedByUserId: null,
        metadataJson: null,
        active: true,
      };
      await links.upsertPlatformLink(original);
      await accept(store, {
        inboxId: "join-before-replacement",
        deliveryId: "delivery-join-before-replacement",
        eventType: "player.join",
        occurredAtMs: 1_000,
        steamId64: original.platformId,
        population: 1,
      });
      const processor = new ServerLevelProcessor({
        store,
        platformLinks: links,
        readEntitlementTier: async () => "premium",
        isCurrentGuildMember: async () => true,
        now: () => 700_001,
        createId: ids(),
      });
      await processor.processAvailableForServer("server-1");
      await links.replacePlatformLinks({
        ...original,
        platformId: "76561198000000002",
        linkedAtMs: 61_000,
      });
      assert.equal(
        await links.readPlatformLinkEntry("guild-1", "user-1", "steam", original.platformId),
        null,
      );
      await processor.stopEarningForLinkedIdentity({
        guildId: "guild-1",
        userId: "user-1",
        steamId64: original.platformId,
        removedAtMs: 61_000,
        linkSnapshot: validSnapshot ? original : { ...original, userId: "other-user" },
      });
      assert.equal(
        (await store.readProfile("guild-1", "user-1"))?.totalXpUnits ?? 0,
        validSnapshot ? 240 : 0,
      );
      assert.deepEqual(await store.listOpenEarningSessions("server-1"), []);
      assert.equal(await store.readCurrentPresence("server-1", original.platformId), null);
    } finally {
      database.close();
    }
  });
}
