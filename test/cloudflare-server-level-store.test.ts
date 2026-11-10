/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createCloudflareServerLevelCredentialStore } from "../src/runtime/cloudflare-server-level-credential-store";
import { createCloudflareServerLevelStore } from "../src/runtime/cloudflare-server-level-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Server Levels persists opt-in configuration and enforces five Configured Game Servers", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 100,
    });

    for (let index = 1; index <= 5; index += 1) {
      await store.createConfiguredGameServer({
        id: `server-${index}`,
        guildId: "guild-1",
        displayName: `DayZ ${index}`,
        providerServerId: `cftools-${index}`,
        maxSlots: 60,
        endpointId: `endpoint-${index}`,
        webhookCredentialId: `credential-${index}`,
        webhookVerifiedAtMs: null,
        subscribedEvents: [],
        capacityProposal: null,
        lastRosterReconciledAtMs: null,
        lastCapacityCheckedAtMs: null,
        createdAtMs: index,
        updatedAtMs: index,
      });
    }

    await assert.rejects(
      store.createConfiguredGameServer({
        id: "server-6",
        guildId: "guild-1",
        displayName: "DayZ 6",
        providerServerId: "cftools-6",
        maxSlots: 60,
        endpointId: "endpoint-6",
        webhookCredentialId: "credential-6",
        webhookVerifiedAtMs: null,
        subscribedEvents: [],
        capacityProposal: null,
        lastRosterReconciledAtMs: null,
        lastCapacityCheckedAtMs: null,
        createdAtMs: 6,
        updatedAtMs: 6,
      }),
      /at most five Configured Game Servers/,
    );
    assert.equal((await store.listConfiguredGameServers("guild-1")).length, 5);
    assert.equal((await store.readConfig("guild-1"))?.enabled, true);
  } finally {
    database.close();
  }
});

test("Server Levels durably deduplicates provider deliveries before acknowledgement", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 100,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: 50,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    const event = {
      inboxId: "inbox-1",
      deliveryId: "delivery-1",
      configuredGameServerId: "server-1",
      guildId: "guild-1",
      eventType: "player.join" as const,
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: 1,
      queueSize: 0,
      receivedAtMs: 1_100,
      bodySha256: "a".repeat(64),
    };
    const duplicateResults = await Promise.all([
      store.acceptProviderEvent(event),
      store.acceptProviderEvent({ ...event, inboxId: "inbox-duplicate" }),
    ]);
    assert.equal(duplicateResults.filter((result) => result.accepted).length, 1);
    assert.deepEqual(
      new Set(duplicateResults.map((result) => result.inboxId)),
      new Set(["inbox-1"]),
    );
    assert.deepEqual(await store.listPendingIngressOutbox(10), [
      { inboxId: "inbox-1", guildId: "guild-1", createdAtMs: 1_100 },
    ]);
    const conflictingReplay = await store.acceptProviderEvent({
      ...event,
      inboxId: "inbox-conflicting-replay",
      bodySha256: "b".repeat(64),
    });
    assert.deepEqual(conflictingReplay, {
      accepted: false,
      inboxId: "inbox-1",
      duplicateBodyMatches: false,
    });
  } finally {
    database.close();
  }
});

test("Server Levels compacts old interval facts without changing lifetime progression", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.appendAward({
      awardId: "interval-old",
      guildId: "guild-1",
      userId: "user-1",
      configuredGameServerId: "server-1",
      sourceInboxId: "inbox-1",
      kind: "interval",
      intervalStartedAtMs: Date.UTC(2025, 0, 2),
      intervalEndedAtMs: Date.UTC(2025, 0, 2, 0, 1),
      qualifyingSeconds: 60,
      multiplier: 4,
      xpUnits: 240,
      scoringPolicyVersion: 1,
      actorUserId: null,
      reason: null,
      createdAtMs: Date.UTC(2025, 0, 2, 0, 1),
    });
    await store.appendAward({
      awardId: "support-preserved",
      guildId: "guild-1",
      userId: "user-1",
      configuredGameServerId: null,
      sourceInboxId: null,
      kind: "support_adjustment",
      intervalStartedAtMs: null,
      intervalEndedAtMs: null,
      qualifyingSeconds: 0,
      multiplier: null,
      xpUnits: 60,
      scoringPolicyVersion: 1,
      actorUserId: "support-1",
      reason: "Verified correction",
      createdAtMs: Date.UTC(2025, 0, 3),
    });

    const compacted = await Promise.all([
      store.compactIntervalAwards(Date.UTC(2025, 1, 1), 100),
      store.compactIntervalAwards(Date.UTC(2025, 1, 1), 100),
    ]);
    assert.equal(compacted[0]! + compacted[1]!, 1);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 300);
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM server_level_awards")[0]
        ?.count,
      1,
    );
    assert.deepEqual(
      database.query<{ xpUnits: number; qualifyingSeconds: number }>(
        "SELECT xp_units AS xpUnits, qualifying_seconds AS qualifyingSeconds FROM server_level_daily_summaries",
      ),
      [{ xpUnits: 240, qualifyingSeconds: 60 }],
    );
  } finally {
    database.close();
  }
});

test("Server Levels processing leases serialize a Configured Game Server and expire safely", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    assert.equal(await store.acquireProcessingLease?.("server-1", "lease-a", 100, 200), true);
    assert.equal(await store.acquireProcessingLease?.("server-1", "lease-b", 150, 250), false);
    await store.releaseProcessingLease?.("server-1", "wrong-lease");
    assert.equal(await store.acquireProcessingLease?.("server-1", "lease-c", 200, 300), true);
    await store.releaseProcessingLease?.("server-1", "lease-c");
    assert.equal(await store.acquireProcessingLease?.("server-1", "lease-d", 201, 301), true);
  } finally {
    database.close();
  }
});

test("Server Levels configured-server pagination has a stable complete ordering", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    for (const [guildId, serverId] of [
      ["guild-1", "server-b"],
      ["guild-1", "server-a"],
      ["guild-2", "server-c"],
    ] as const) {
      await store.createConfiguredGameServer({
        id: serverId,
        guildId,
        displayName: serverId,
        providerServerId: serverId,
        maxSlots: 60,
        endpointId: `endpoint-${serverId}`,
        webhookCredentialId: `credential-${serverId}`,
        webhookVerifiedAtMs: null,
        subscribedEvents: [],
        capacityProposal: null,
        lastRosterReconciledAtMs: null,
        lastCapacityCheckedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    }
    const first = await store.listAllConfiguredGameServers(2);
    const last = first.at(-1)!;
    const second = await store.listAllConfiguredGameServers(2, {
      guildId: last.guildId,
      createdAtMs: last.createdAtMs,
      id: last.id,
    });
    assert.deepEqual(
      [...first, ...second].map((server) => server.id),
      ["server-a", "server-b", "server-c"],
    );
  } finally {
    database.close();
  }
});

test("Server Levels scopes presence deletion to the owning Guild", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: null,
      subscribedEvents: [],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    for (const steamId64 of ["76561198000000001", "76561198000000002"]) {
      await store.upsertCurrentPresence({
        configuredGameServerId: "server-1",
        steamId64,
        lifecycleGeneration: 0,
        joinedAtMs: 1,
        lastConfirmedAtMs: 1,
        updatedAtMs: 1,
      });
    }

    await store.deleteCurrentPresence("guild-2", "server-1", "76561198000000001");
    await store.clearCurrentPresence("guild-2", "server-1");
    assert.equal((await store.listCurrentPresence("server-1")).length, 2);

    await store.deleteCurrentPresence("guild-1", "server-1", "76561198000000001");
    assert.deepEqual(
      (await store.listCurrentPresence("server-1")).map((presence) => presence.steamId64),
      ["76561198000000002"],
    );
    await store.clearCurrentPresence("guild-1", "server-1");
    assert.deepEqual(await store.listCurrentPresence("server-1"), []);
  } finally {
    database.close();
  }
});

test("Server Levels announcement delivery state is idempotent and member erasure is complete", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.appendAward({
      awardId: "award-1",
      guildId: "guild-1",
      userId: "user-1",
      configuredGameServerId: null,
      sourceInboxId: null,
      kind: "support_adjustment",
      intervalStartedAtMs: null,
      intervalEndedAtMs: null,
      qualifyingSeconds: 0,
      multiplier: null,
      xpUnits: 600,
      scoringPolicyVersion: 1,
      actorUserId: "support-1",
      reason: "Correction",
      createdAtMs: 1,
    });
    const announcement = {
      announcementId: "announcement-1",
      guildId: "guild-1",
      userId: "user-1",
      channelId: "channel-1",
      level: 2,
      createdAtMs: 2,
    };
    await store.enqueueLevelAnnouncement(announcement);
    await store.enqueueLevelAnnouncement(announcement);
    assert.deepEqual(await store.listPendingLevelAnnouncements(10), [announcement]);

    await store.upsertCurrentPresence({
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      lifecycleGeneration: 0,
      joinedAtMs: 1,
      lastConfirmedAtMs: 1,
      updatedAtMs: 1,
    });
    await store.upsertEarningSession({
      sessionId: "session-1",
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      userId: "user-1",
      lifecycleGeneration: 0,
      startedAtMs: 1,
      lastConfirmedAtMs: 1,
      checkpointAtMs: 1,
      closedAtMs: null,
      closeReason: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    await store.eraseMemberProgression("guild-1", "user-1");
    assert.equal(await store.readProfile("guild-1", "user-1"), null);
    assert.deepEqual(await store.listPendingLevelAnnouncements(10), []);
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM server_level_awards")[0]
        ?.count,
      0,
    );
    assert.equal(await store.readCurrentPresence("server-1", "76561198000000001"), null);
  } finally {
    database.close();
  }
});

test("Server Levels projects concurrent awards once and floors negative adjustments at zero", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  const award = (awardId: string, xpUnits: number, createdAtMs: number) => ({
    awardId,
    guildId: "guild-1",
    userId: "user-1",
    configuredGameServerId: null,
    sourceInboxId: null,
    kind: "support_adjustment" as const,
    intervalStartedAtMs: null,
    intervalEndedAtMs: null,
    qualifyingSeconds: 0,
    multiplier: null,
    xpUnits,
    scoringPolicyVersion: 1,
    actorUserId: "support-1",
    reason: "Verified correction",
    createdAtMs,
  });
  try {
    await store.appendAward(award("initial", 120, 1));
    const duplicateResults = await Promise.all([
      store.appendAward(award("duplicate", 60, 2)),
      store.appendAward(award("duplicate", 60, 2)),
    ]);
    assert.equal(duplicateResults.filter((result) => result.applied).length, 1);

    await Promise.all([
      store.appendAward(award("concurrent-a", 60, 3)),
      store.appendAward(award("concurrent-b", 60, 4)),
    ]);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 300);

    const floored = await store.appendAward(award("floor", -1_000, 5));
    assert.deepEqual(floored, {
      applied: true,
      previousTotalXpUnits: 300,
      totalXpUnits: 0,
    });
    assert.deepEqual(await store.appendAward(award("floor", -1_000, 5)), {
      applied: false,
      previousTotalXpUnits: 0,
      totalXpUnits: 0,
    });
    assert.deepEqual(
      database.query<{ xpUnits: number; pending: number }>(
        `SELECT SUM(xp_units) AS xpUnits,
          SUM(CASE WHEN projection_applied_at_ms IS NULL THEN 1 ELSE 0 END) AS pending
         FROM server_level_awards`,
      ),
      [{ xpUnits: 0, pending: 0 }],
    );
  } finally {
    database.close();
  }
});

test("Server Levels purges Guild data only after the uninstall retention deadline", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: false,
      announcementChannelId: null,
      removedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    assert.equal(await store.purgeRemovedGuilds(999, 10), 0);
    assert.ok(await store.readConfig("guild-1"));
    assert.equal(await store.purgeRemovedGuilds(1_000, 10), 1);
    assert.equal(await store.readConfig("guild-1"), null);
  } finally {
    database.close();
  }
});

test("Server Levels purge rechecks the removal marker before deleting a restored Guild", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    await store.upsertConfig({
      guildId: "guild-restored",
      enabled: false,
      announcementChannelId: null,
      removedAtMs: 1,
      updatedAtMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-restored",
      guildId: "guild-restored",
      displayName: "Restored server",
      providerServerId: "provider-restored",
      maxSlots: 60,
      endpointId: "endpoint-restored",
      webhookCredentialId: "credential-restored",
      webhookVerifiedAtMs: null,
      subscribedEvents: [],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    const purge = store.purgeRemovedGuilds(100, 25);
    await store.upsertConfig({
      guildId: "guild-restored",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 2,
    });
    assert.equal(await purge, 0);

    assert.equal((await store.readConfig("guild-restored"))?.enabled, true);
    assert.ok(await store.readConfiguredGameServer("guild-restored", "server-restored"));
  } finally {
    database.close();
  }
});

test("configured-server deletion atomically removes every owned credential", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  const credentials = createCloudflareServerLevelCredentialStore(database.d1);
  try {
    await store.createConfiguredGameServer({
      id: "server-delete",
      guildId: "guild-1",
      displayName: "Delete me",
      providerServerId: "provider-delete",
      maxSlots: 60,
      endpointId: "endpoint-delete",
      webhookCredentialId: "webhook-credential",
      webhookVerifiedAtMs: null,
      subscribedEvents: [],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    for (const [credentialId, purpose] of [
      ["webhook-credential", "webhook_secret"],
      ["data-api-credential", "data_api"],
    ] as const) {
      await credentials.upsert({
        credentialId,
        guildId: "guild-1",
        configuredGameServerId: "server-delete",
        purpose,
        envelope: { version: 1, keyVersion: 1, nonce: "nonce", ciphertext: "ciphertext" },
        fingerprint: "fingerprint",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    }

    await store.deleteConfiguredGameServer("guild-1", "server-delete");

    assert.equal(await store.readConfiguredGameServer("guild-1", "server-delete"), null);
    assert.equal(await credentials.readByOwner("server-delete", "webhook_secret"), null);
    assert.equal(await credentials.readByOwner("server-delete", "data_api"), null);
  } finally {
    database.close();
  }
});
