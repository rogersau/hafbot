import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import { createCloudflareOperationalIncidentStore } from "../src/runtime/cloudflare-operational-incident-store";
import { OperationalIncidentService } from "../src/operations/incidents";
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresBanEnforcementStore } from "../src/runtime/postgres/postgres-wardogs-store";
import type { Operation } from "../src/ban-case-enforcement/model";
const url = process.env.TEST_POSTGRES_URL;
test(
  "native PostgreSQL persists operation/outbox atomically, suppresses concurrent duplicates and fences stale claims",
  { skip: !url },
  async () => {
    assert.ok(url);
    assert.match(new URL(url).pathname, /_test$/);
    const db = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: url,
      NODE_ENV: "test",
    });
    try {
      await applyPostgresMigrations(
        db,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const store = createPostgresBanEnforcementStore(db);
      const incidents = new OperationalIncidentService(
        createCloudflareOperationalIncidentStore(
          createPostgresD1CompatibilityDatabase(db),
          "ban-cases",
        ),
      );
      const key = {
        feature: "ban-cases" as const,
        resourceKind: "server-action",
        resourceId: crypto.randomUUID(),
        condition: "enforcement-uncertain",
      };
      const incident = await incidents.observeFailure({
        guildId: key.resourceId,
        key,
        summaryCode: "ban_case_enforcement_uncertain",
        safeArgs: { operationId: key.resourceId },
        remediationCode: "operator_intervention_required",
      });
      await incidents.observeHealthy({ guildId: key.resourceId, key });
      assert.equal((await incidents.get(key.resourceId, incident.id))?.status, "resolved");
      assert.equal((await incidents.listEvents(key.resourceId, incident.id)).length, 2);
      const id = crypto.randomUUID();
      const op: Operation = {
        id,
        guildId: id,
        actorId: "staff",
        caseId: "case",
        targetId: "target",
        generation: 1,
        targetLabel: "Synthetic",
        physicalTarget: id,
        approvalIdentity: "synthetic-contract",
        subject: "76561198000000001",
        action: "ban",
        reason: "Staff reason",
        createdAtMs: 1,
        expiresAtMs: 900001,
        state: "pending",
        revision: 1,
        attempts: 0,
        nextAtMs: 1,
        confirmedAtMs: 1,
        attemptAtMs: null,
        completedAtMs: null,
        transmittedAtMs: null,
        acknowledgedAtMs: null,
        outcome: "requested",
        before: null,
        after: null,
      };
      await store.prepare(op);
      const duplicates = await Promise.all(Array.from({ length: 6 }, () => store.confirm(op)));
      assert.equal(new Set(duplicates.map((o) => o.id)).size, 1);
      const saved = duplicates[0]!;
      assert.equal((await store.list(id)).length, 1);
      assert.ok((await store.due(1)).some((o) => o.id === saved.id));
      const claims = await Promise.all(
        Array.from({ length: 6 }, () =>
          store.save({ ...saved, state: "executing", transmittedAtMs: 2 }, 1),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await store.save({ ...saved, state: "succeeded" }, 1), null);
      assert.equal(
        (await createPostgresBanEnforcementStore(db).read(saved.id))?.transmittedAtMs,
        2,
      );
      const opposite = { ...op, id: crypto.randomUUID(), action: "unban" as const };
      await store.prepare(opposite);
      await assert.rejects(store.confirm(opposite), /Unresolved work/);
    } finally {
      await db.close();
    }
  },
);

test(
  "PostgreSQL restart retains transmission uncertainty and permits only readback",
  { skip: !url },
  async () => {
    assert.ok(url);
    assert.match(new URL(url).pathname, /_test$/);
    const { BanCaseEnforcement } = await import("../src/ban-case-enforcement/service");
    const { createCloudflareBanCaseStore } =
      await import("../src/runtime/cloudflare-ban-case-store");
    const { WardogsError } = await import("../src/wardogs/model");
    const db = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: url,
      NODE_ENV: "test",
    });
    try {
      await applyPostgresMigrations(
        db,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const store = createPostgresBanEnforcementStore(db);
      const cases = createCloudflareBanCaseStore(createPostgresD1CompatibilityDatabase(db));
      const id = crypto.randomUUID();
      await cases.createBanCase({
        guildId: id,
        caseId: id,
        sourceId: id,
        publicId: id,
        subject: { platform: "steam", id: "76561198000000001" },
        username: "Synthetic report",
        status: "completed",
        threadChannelId: "thread",
        threadMessageId: "message",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      let now = 1000,
        mutations = 0;
      let banned = false;
      const options = {
        store,
        cases,
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
        authorize: async () => true,
        available: async () => true,
        provider: {
          readiness: async () => ({
            ready: true,
            physicalTarget: id,
            approvalIdentity: id,
            target: { id, name: "Synthetic only", generation: 1 },
          }),
          capabilities: async () => true,
          observe: async () => banned,
          mutate: async (
            _intent: unknown,
            beforeSend: () => Promise<void>,
            current?: () => Promise<void>,
          ) => {
            await beforeSend();
            await current?.();
            mutations++;
            throw new WardogsError("unreachable");
          },
        },
      };
      let service = new BanCaseEnforcement(options);
      const input = {
        guildId: id,
        actorId: "staff",
        caseId: id,
        targetId: id,
        action: "ban" as const,
        reason: "Staff decision",
      };
      const intents = await Promise.all(Array.from({ length: 6 }, () => service.prepare(input)));
      const confirmed = await Promise.all(
        intents.map((intent) => service.confirm(intent.id, id, "staff")),
      );
      const op = confirmed[0]!;
      assert.equal(new Set(confirmed.map((entry) => entry.id)).size, 1);
      for (let i = 0; i < 4; i++) {
        now += 60000;
        await service.process(op.id);
      }
      assert.equal((await store.read(op.id))!.state, "needs-attention");
      const opposite = await service.prepare({ ...input, action: "unban" });
      await assert.rejects(service.confirm(opposite.id, id, "staff"), /Unresolved work/);
      now += 20 * 60000;
      service = new BanCaseEnforcement({
        ...options,
        store: createPostgresBanEnforcementStore(db),
      });
      await service.process(op.id);
      assert.equal(mutations, 1);
      banned = true;
      now += 60000;
      await service.process(op.id);
      assert.equal((await store.read(op.id))!.state, "needs-attention");
      assert.equal((await store.read(op.id))!.after, true);
      assert.match((await store.read(op.id))!.outcome, /verified desired state/);
      assert.equal(mutations, 1);
      // Persisted receipts survive settlement, independently of confirmation expiry.
      for (const intent of intents)
        assert.equal((await store.confirm({ ...op, id: intent.id })).id, op.id);
      assert.equal((await store.list(id)).length, 1);
    } finally {
      await db.close();
    }
  },
);
