/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import type { WorkspaceStore } from "../src/runtime/workspace-store";
import { createMemoryWorkspaceStore } from "./helpers/memory-workspace-store";

test("workspace store links guilds to one workspace", async () => {
  const store = createMemoryWorkspaceStore();

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });

  assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), true);
  assert.equal(await store.isGuildLinkedToWorkspace("workspace-2", "guild-1"), false);
  await assert.rejects(
    () =>
      store.linkGuildToWorkspace({
        workspaceId: "workspace-2",
        guildId: "guild-1",
        linkedByUserId: "user-2",
        linkedAtMs: 200,
      }),
    { name: "WorkspaceGuildAlreadyLinkedError" },
  );
});

test("workspace store uses manual free plan defaults", async () => {
  const store: WorkspaceStore = createMemoryWorkspaceStore();

  assert.deepEqual(await store.readEntitlement("workspace-1"), {
    workspaceId: "workspace-1",
    plan: "free",
    status: "manual",
    enabledFlags: [],
    updatedAtMs: 0,
  });
});

test("workspace store unlink is idempotent and only unlinks owned guilds", async () => {
  const store = createMemoryWorkspaceStore();

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });

  await store.unlinkGuildFromWorkspace({
    workspaceId: "workspace-2",
    guildId: "guild-1",
    unlinkedByUserId: "user-2",
    unlinkedAtMs: 200,
  });
  assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), true);

  await store.unlinkGuildFromWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    unlinkedByUserId: "user-1",
    unlinkedAtMs: 300,
  });
  assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), false);

  await store.unlinkGuildFromWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    unlinkedByUserId: "user-1",
    unlinkedAtMs: 400,
  });
  assert.equal(await store.isGuildLinkedToWorkspace("workspace-1", "guild-1"), false);
});

test("workspace store records link and unlink audit events", async () => {
  const store = createMemoryWorkspaceStore();

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-2",
    linkedAtMs: 200,
  });
  await store.unlinkGuildFromWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    unlinkedByUserId: "user-3",
    unlinkedAtMs: 300,
  });

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
        actorUserId: "user-2",
        occurredAtMs: 200,
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
});

test("workspace store lists guilds for a workspace ordered by linked time", async () => {
  const store = createMemoryWorkspaceStore();

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-late",
    linkedByUserId: "user-1",
    linkedAtMs: 300,
  });
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-2",
    guildId: "guild-other",
    linkedByUserId: "user-2",
    linkedAtMs: 100,
  });
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-early",
    linkedByUserId: "user-3",
    linkedAtMs: 100,
  });
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-middle",
    linkedByUserId: "user-4",
    linkedAtMs: 200,
  });

  assert.deepEqual(
    (await store.listGuildsForWorkspace("workspace-1")).map((link) => link.guildId),
    ["guild-early", "guild-middle", "guild-late"],
  );
});

test("workspace store persists entitlement updates", async () => {
  const store = createMemoryWorkspaceStore();

  await store.upsertEntitlement({
    workspaceId: "workspace-1",
    plan: "paid",
    status: "active",
    enabledFlags: ["feature-a", "feature-b"],
    updatedAtMs: 500,
  });

  assert.deepEqual(await store.readEntitlement("workspace-1"), {
    workspaceId: "workspace-1",
    plan: "paid",
    status: "active",
    enabledFlags: ["feature-a", "feature-b"],
    updatedAtMs: 500,
  });
});

test("workspace store relinks same guild to same workspace and updates metadata", async () => {
  const store = createMemoryWorkspaceStore();

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-2",
    linkedAtMs: 200,
  });

  assert.deepEqual(await store.listGuildsForWorkspace("workspace-1"), [
    {
      workspaceId: "workspace-1",
      guildId: "guild-1",
      linkedByUserId: "user-2",
      linkedAtMs: 200,
    },
  ]);
});

test("workspace store resolves workspace id for a linked guild", async () => {
  const store = createMemoryWorkspaceStore();

  assert.equal(await store.readWorkspaceIdForGuild("guild-1"), null);

  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-1",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });

  assert.equal(await store.readWorkspaceIdForGuild("guild-1"), "workspace-1");
  assert.equal(await store.readWorkspaceIdForGuild("guild-2"), null);
});
