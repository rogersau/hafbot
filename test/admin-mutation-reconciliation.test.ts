/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  adminRefreshWarning,
  reconcileAdminMutation,
  retryAdminRefresh,
} from "../src/admin/lib/mutation-reconciliation";

test("a committed mutation remains successful when route refresh fails", async () => {
  let mutationCalls = 0;
  const result = await reconcileAdminMutation(
    async () => {
      mutationCalls += 1;
      return { id: "saved-resource" };
    },
    async () => {
      throw new Error("route unavailable");
    },
  );

  assert.equal(mutationCalls, 1);
  assert.deepEqual(result.data, { id: "saved-resource" });
  assert.match(adminRefreshWarning("Save", result.refreshError), /Save completed/);
  assert.match(adminRefreshWarning("Save", result.refreshError), /route unavailable/);
});

test("refresh retry only invokes the refresh seam", async () => {
  let refreshCalls = 0;
  const result = await retryAdminRefresh(async () => {
    refreshCalls += 1;
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(refreshCalls, 1);
});

test("mutation failures are still thrown and never trigger refresh", async () => {
  let refreshCalls = 0;
  await assert.rejects(
    reconcileAdminMutation(
      async () => {
        throw new Error("save rejected");
      },
      async () => {
        refreshCalls += 1;
      },
    ),
    /save rejected/,
  );
  assert.equal(refreshCalls, 0);
});
