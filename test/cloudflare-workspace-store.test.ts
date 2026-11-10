import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareWorkspaceStore } from "../src/runtime/cloudflare-workspace-store";
import { WorkspaceGuildAlreadyLinkedError } from "../src/runtime/workspace-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

test("Cloudflare workspace store atomically records Guild link and unlink audit events", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO "Organization" ("id", "name", "slug", "createdAt") VALUES
        ('workspace-1', 'Workspace One', 'workspace-one', 1),
        ('workspace-2', 'Workspace Two', 'workspace-two', 1)
    `);
    const store = createCloudflareWorkspaceStore(database.d1);

    await store.linkGuildToWorkspace({
      workspaceId: "workspace-1",
      guildId: "guild-1",
      linkedByUserId: "user-1",
      linkedAtMs: 100,
    });

    assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), true);
    assert.deepEqual(
      (await store.listWorkspaceGuildAuditEvents("workspace-1")).map(
        ({ id: _id, ...event }) => event,
      ),
      [
        {
          workspaceId: "workspace-1",
          guildId: "guild-1",
          action: "linked",
          actorUserId: "user-1",
          occurredAtMs: 100,
          previousWorkspaceId: null,
        },
      ],
    );

    await assert.rejects(
      store.linkGuildToWorkspace({
        workspaceId: "workspace-2",
        guildId: "guild-1",
        linkedByUserId: "user-2",
        linkedAtMs: 200,
      }),
      WorkspaceGuildAlreadyLinkedError,
    );
    assert.deepEqual(await store.listWorkspaceGuildAuditEvents("workspace-2"), []);

    await store.unlinkGuildFromWorkspace({
      workspaceId: "workspace-1",
      guildId: "guild-1",
      unlinkedByUserId: "user-3",
      unlinkedAtMs: 300,
    });

    assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), false);
    assert.deepEqual(
      (await store.listWorkspaceGuildAuditEvents("workspace-1")).map(
        ({ id: _id, ...event }) => event,
      ),
      [
        {
          workspaceId: "workspace-1",
          guildId: "guild-1",
          action: "unlinked",
          actorUserId: "user-3",
          occurredAtMs: 300,
          previousWorkspaceId: "workspace-1",
        },
        {
          workspaceId: "workspace-1",
          guildId: "guild-1",
          action: "linked",
          actorUserId: "user-1",
          occurredAtMs: 100,
          previousWorkspaceId: null,
        },
      ],
    );
  } finally {
    database.close();
  }
});

test("Cloudflare workspace store records only the unlink that removed the Guild", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO "Organization" ("id", "name", "slug", "createdAt")
      VALUES ('workspace-1', 'Workspace One', 'workspace-one', 1)
    `);
    const store = createCloudflareWorkspaceStore(database.d1);
    await store.linkGuildToWorkspace({
      workspaceId: "workspace-1",
      guildId: "guild-1",
      linkedByUserId: "user-1",
      linkedAtMs: 100,
    });

    await Promise.all([
      store.unlinkGuildFromWorkspace({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        unlinkedByUserId: "user-2",
        unlinkedAtMs: 200,
      }),
      store.unlinkGuildFromWorkspace({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        unlinkedByUserId: "user-3",
        unlinkedAtMs: 201,
      }),
    ]);

    const unlinkEvents = (await store.listWorkspaceGuildAuditEvents("workspace-1")).filter(
      (event) => event.action === "unlinked",
    );
    assert.equal(unlinkEvents.length, 1);
    assert.ok(["user-2", "user-3"].includes(unlinkEvents[0]?.actorUserId ?? ""));
  } finally {
    database.close();
  }
});
