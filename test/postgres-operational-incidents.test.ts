import assert from "node:assert/strict";
import test from "node:test";
import { OperationalIncidentService } from "../src/operations/incidents";
import { createPostgresOperationalIncidentStore } from "../src/runtime/postgres/postgres-operational-incident-store";
import { withFreshPostgres } from "./support/postgres";

test(
  "Player Link permission incidents persist and resolve through the current PostgreSQL store",
  { skip: process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withFreshPostgres(async (database) => {
      const service = new OperationalIncidentService(
        createPostgresOperationalIncidentStore(database),
      );
      const key = {
        feature: "platform-link" as const,
        resourceKind: "platform",
        resourceId: "steam",
        condition: "panel-publish-permission-denied",
      };
      const incident = await service.observeFailure({
        guildId: "guild-1",
        key,
        observationId: "permission-failure-1",
        summaryCode: "platform_link_panel_publish_permission_denied",
        safeArgs: { platform: "steam", panelChannelId: "panel-channel" },
        remediationCode: "operator_intervention_required",
        observedAtMs: 100,
      });

      const reconstructed = new OperationalIncidentService(
        createPostgresOperationalIncidentStore(database),
      );
      const [persisted] = await reconstructed.list({ guildId: "guild-1" });
      assert.equal(persisted?.id, incident.id);
      assert.equal(persisted?.feature, "platform-link");
      assert.equal(persisted?.summaryCode, "platform_link_panel_publish_permission_denied");
      assert.deepEqual(persisted?.safeArgs, { platform: "steam", panelChannelId: "panel-channel" });
      assert.deepEqual(await reconstructed.list({ guildId: "guild-2" }), []);

      const resolved = await reconstructed.observeHealthy({
        guildId: "guild-1",
        key,
        observationId: "permission-restored-1",
        observedAtMs: 200,
      });
      assert.equal(resolved?.status, "resolved");
      assert.deepEqual(await reconstructed.list({ guildId: "guild-1" }), []);
      assert.deepEqual(
        (await reconstructed.listEvents("guild-1", incident.id)).map((event) => event.eventType),
        ["resolved", "opened"],
      );
    });
  },
);
