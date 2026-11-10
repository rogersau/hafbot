/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  configurationRevisionLabel,
  formatRelativeAge,
  mergeConfigurationRevisionPages,
  readConfigurationEditorDirtyState,
  refreshRestoredConfiguration,
} from "../src/admin/components/configuration-history-card";
import { requireAdminRouteRefresh } from "../src/admin/lib/mutation-reconciliation";

test("configuration history explains operations and sources in customer language", () => {
  assert.equal(
    configurationRevisionLabel({ operation: "update", source: "dashboard-save" }),
    "Updated from dashboard",
  );
  assert.equal(
    configurationRevisionLabel({ operation: "restore", source: "restore" }),
    "Restored from an earlier revision",
  );
  assert.equal(
    configurationRevisionLabel({ operation: "update", source: "system-migration" }),
    "Updated by a system migration",
  );
  assert.equal(
    configurationRevisionLabel({ operation: "clone", source: "clone" }),
    "Cloned from another configuration",
  );
});

test("configuration history formats useful relative ages", () => {
  const now = 1_000_000_000;
  assert.equal(formatRelativeAge(now - 10_000, now), "just now");
  assert.equal(formatRelativeAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeAge(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(formatRelativeAge(now - 2 * 86_400_000, now), "2d ago");
});

test("configuration history pagination appends unseen revisions without replacing selection data", () => {
  const first = [
    { id: "revision-3", operation: "update" },
    { id: "revision-2", operation: "update" },
  ];
  const next = [
    { id: "revision-2", operation: "update" },
    { id: "revision-1", operation: "baseline" },
  ];

  assert.deepEqual(mergeConfigurationRevisionPages(first, next), [
    ...first,
    { id: "revision-1", operation: "baseline" },
  ]);
});

test("restore reconciliation distinguishes a committed restore from a failed editor refresh", async () => {
  assert.deepEqual(
    await refreshRestoredConfiguration(async () => {
      throw new Error("route unavailable");
    }),
    {
      ok: false,
      message: "The restore succeeded, but the editor could not refresh. route unavailable",
    },
  );

  assert.deepEqual(await refreshRestoredConfiguration(async () => {}), { ok: true });
});

test("versioned editor remount requires a genuine authoritative refresh", async () => {
  await assert.rejects(() => requireAdminRouteRefresh(), /refresh is unavailable/);
  await assert.rejects(
    () =>
      requireAdminRouteRefresh(async () => {
        throw new Error("route unavailable");
      }),
    /Retry the editor refresh/,
  );
  await assert.doesNotReject(() => requireAdminRouteRefresh(async () => {}));
});

test("configuration history reads the editor's current dirty state when restore starts", () => {
  let dirty = false;
  const readDirty = () => dirty;
  assert.equal(readConfigurationEditorDirtyState(readDirty), false);
  dirty = true;
  assert.equal(readConfigurationEditorDirtyState(readDirty), true);
});
