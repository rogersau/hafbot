import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresWardogsStore } from "../src/runtime/postgres/postgres-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import type { NetworkPolicy } from "../src/wardogs/model";
const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "PostgreSQL WARDOGS schema, encrypted targets, concurrent Guild limits and shared leases",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assert.match(new URL(postgresUrl).pathname, /_test$/);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await initializePostgresSchema(database);
      const store = createPostgresWardogsStore(database);
      const guildId = crypto.randomUUID();
      const service = new WardogsService({
        store,
        keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
        transport: async () => {
          assert.fail("network defaults off");
        },
      });
      const creations = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => service.create(guildId, `Target ${i}`, null)),
      );
      assert.equal(creations.filter((result) => result.status === "fulfilled").length, 5);
      const target = (await service.list(guildId))[0]!;
      const changed = await service.change({
        guildId,
        targetId: target.id,
        generation: target.generation,
        secret: "synthetic-password",
        enabled: true,
      });
      assert.equal(changed.credentialConfigured, true);
      assert.equal(changed.generation, 2);
      assert.equal(
        (await createPostgresWardogsStore(database).read(guildId, target.id))?.generation,
        2,
      );
      assert.equal(await store.read("another-guild", target.id), null);
      await assert.rejects(
        service.read({ guildId, targetId: target.id, generation: 2, operation: "status" }),
        { code: "disabled" },
      );
      const destination = `https://${crypto.randomUUID()}.example.com`;
      const now = Date.now();
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) => store.claim(destination, String(i), now, 6000, 5000)),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const token = String(claims.indexOf(true));
      await store.release(destination, "wrong-fence", now + 90_000);
      assert.equal(await store.claim(destination, "after-expiry", now + 6001, 6000, 5000), true);
      await store.release(destination, token, now + 900_000);
      await store.release(destination, "after-expiry", now + 90_000);
      assert.equal(await store.claim(destination, "cooldown", now + 60_000, 6000, 5000), false);
      assert.equal(await store.claim(destination, "cooldown-end", now + 90_000, 6000, 5000), true);
      const mutations = await Promise.allSettled([
        service.change({ guildId, targetId: target.id, generation: 2, disconnect: true }),
        service.change({ guildId, targetId: target.id, generation: 2, secret: "other-password" }),
      ]);
      assert.equal(mutations.filter((result) => result.status === "fulfilled").length, 1);
      await database.execute("DELETE FROM wardogs_targets WHERE guild_id = $1", [guildId]);
      await database.execute("DELETE FROM wardogs_budgets WHERE origin = $1", [destination]);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL Player Count minute budget is atomic across services and preserves ordinary reads",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assert.match(new URL(postgresUrl).pathname, /_test$/);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    const guildId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const origin = `https://${crypto.randomUUID()}.example.com`;
    try {
      await initializePostgresSchema(database);
      const policy: NetworkPolicy = {
        enabled: true,
        origins: [
          {
            id: "synthetic",
            origin,
            securePathEvidence: "Synthetic recording transport",
          },
        ],
        approvals: [],
      };
      let now = 1_000_000;
      const calls: string[] = [];
      const createService = () =>
        new WardogsService({
          store: createPostgresWardogsStore(database),
          policy,
          keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
          now: () => now,
          transport: async (url) => {
            calls.push(url);
            return Response.json(
              url.endsWith("capabilities")
                ? { routes: ["GET /v1/status"] }
                : { players: { current: 4, max: 60 } },
            );
          },
        });
      const first = createService();
      const created = await first.create(guildId, "Synthetic", "synthetic");
      const target = await first.change({
        guildId,
        targetId: created.id,
        generation: created.generation,
        enabled: true,
        secret: "synthetic-password",
      });
      const input = { guildId, serverId, targetId: target.id, generation: target.generation };
      policy.approvals = [
        { targetId: target.id, generation: target.generation, originRef: "synthetic", origin },
      ];
      await first.readPlayerCountStatus(input);
      const second = createService();
      now += 5000;
      await assert.rejects(second.readPlayerCountStatus(input), { code: "rate_limited" });
      await second.read({ ...input, operation: "capabilities" });
      assert.equal(calls.length, 2);
      now += 55_000;
      const results = await Promise.allSettled([
        first.readPlayerCountStatus(input),
        second.readPlayerCountStatus(input),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(calls.length, 3);
      await database.execute("DELETE FROM wardogs_budgets WHERE origin IN ($1, $2, $3)", [
        origin,
        `target:${target.id}`,
        `player-count:${guildId}:${serverId}`,
      ]);
      await database.execute("DELETE FROM wardogs_targets WHERE guild_id = $1", [guildId]);
    } finally {
      await database.close();
    }
  },
);
