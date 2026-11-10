import assert from "node:assert/strict";
import test from "node:test";

import {
  readTimedRoleWorkflow,
  timedRoleWorkflowSchema,
  transitionTimedRoleWorkflow,
} from "../src/services/timed-roles/workflow";

test("legacy timed roles normalize their suspension snapshot without losing restoration work", () => {
  const state = readTimedRoleWorkflow({
    suspendedRoleIds: [" access-a ", "", "access-a", "access-b"],
    removedRoleIds: ["access-a"],
  });
  assert.equal(state.kind, "active");
  assert.deepEqual(state.suspendedRoleIds, ["access-a", "access-b"]);
  assert.deepEqual(state.pendingRestorationRoleIds, ["access-a"]);

  const restored = readTimedRoleWorkflow({
    removedRoleIds: ["access-a"],
    pendingRestorationRoleIds: [],
    restorationStartedAtMs: 10,
    targetRoleRemovalCompletedAtMs: 11,
  });
  assert.equal(restored.kind, "ready-to-delete");
  assert.deepEqual(restored.pendingRestorationRoleIds, []);
});

test("the workflow schema rejects contradictory progress before it can drive recovery", () => {
  const state = readTimedRoleWorkflow({});
  assert.equal(timedRoleWorkflowSchema.safeParse({ ...state, kind: "suspending" }).success, false);
  assert.equal(
    timedRoleWorkflowSchema.safeParse({ ...state, kind: "restoring-roles" }).success,
    false,
  );
  assert.throws(() => readTimedRoleWorkflow({ targetRoleRemovalCompletedAtMs: 10 }));
  assert.throws(() => readTimedRoleWorkflow({ restorationStartedAtMs: Number.NaN }));
  assert.throws(() => readTimedRoleWorkflow({ removedRoleIds: "access-a" }));
});

test("confirming suspension records the restoration obligation and leaves its input unchanged", () => {
  const state = readTimedRoleWorkflow({ pendingSuspensionRoleIds: ["access-a", "access-b"] });
  const before = structuredClone(state);
  const transition = transitionTimedRoleWorkflow(state, {
    type: "suspension-confirmed",
    roleId: "access-a",
  });
  assert.deepEqual(state, before);
  assert.equal(transition.state.kind, "suspending");
  assert.deepEqual(transition.effects, [
    {
      type: "persist-suspension",
      progress: {
        pendingSuspensionRoleIds: ["access-b"],
        removedRoleIds: ["access-a"],
        pendingRestorationRoleIds: ["access-a"],
      },
    },
  ]);
  assert.ok("pendingRestorationRoleIds" in transition.state);
  assert.deepEqual(transition.state.pendingRestorationRoleIds, ["access-a"]);
  assert.deepEqual(transition.state.pendingSuspensionRoleIds, ["access-b"]);
});

test("an interrupted suspension restores a possibly removed role before deleting the assignment", () => {
  // The Discord DELETE succeeded, but its completion checkpoint did not.
  const captured = readTimedRoleWorkflow({
    pendingSuspensionRoleIds: ["access-b"],
    removedRoleIds: ["access-a"],
    pendingRestorationRoleIds: ["access-a"],
  });
  const requested = transitionTimedRoleWorkflow(captured, {
    type: "restoration-requested",
    nowMs: 100,
  });
  assert.equal(requested.state.kind, "removing-target");
  assert.deepEqual(
    requested.effects.map((effect) => effect.type),
    ["persist-restoration", "persist-suspension"],
  );
  assert.ok("pendingRestorationRoleIds" in requested.state);
  assert.deepEqual(requested.state.pendingRestorationRoleIds, ["access-a", "access-b"]);

  // Restart after only the first of those two writes committed.
  const interrupted = readTimedRoleWorkflow({
    ...captured,
    restorationStartedAtMs: 100,
    pendingRestorationRoleIds: ["access-a", "access-b"],
  });
  const resumed = transitionTimedRoleWorkflow(interrupted, {
    type: "restoration-requested",
    nowMs: 200,
  });
  assert.deepEqual(resumed.state, requested.state);
  assert.deepEqual(
    resumed.effects.map((effect) => effect.type),
    ["persist-suspension"],
  );

  const confirmed = transitionTimedRoleWorkflow(resumed.state, {
    type: "target-removal-confirmed",
    nowMs: 201,
  });
  assert.equal(confirmed.state.kind, "restoring-roles");
  assert.deepEqual(
    confirmed.effects.map((effect) => effect.type),
    ["persist-restoration"],
  );
  assert.throws(() =>
    transitionTimedRoleWorkflow(requested.state, {
      type: "restoration-attempted",
      remainingRoleIds: [],
    }),
  );
});

test("partial restoration checkpoints only remaining obligations and resumes after restart", () => {
  const state = readTimedRoleWorkflow({
    removedRoleIds: ["access-a", "access-b"],
    pendingRestorationRoleIds: ["access-a", "access-b"],
    restorationStartedAtMs: 100,
    targetRoleRemovalCompletedAtMs: 101,
  });
  const attempted = transitionTimedRoleWorkflow(state, {
    type: "restoration-attempted",
    remainingRoleIds: ["access-b"],
  });
  assert.equal(attempted.state.kind, "restoring-roles");
  const effect = attempted.effects[0];
  assert.equal(effect.type, "persist-restoration");
  if (effect.type !== "persist-restoration") throw new Error("Expected restoration checkpoint.");
  assert.deepEqual(effect.progress, {
    pendingRestorationRoleIds: ["access-b"],
    restorationStartedAtMs: 100,
    targetRoleRemovalCompletedAtMs: 101,
  });
  const resumed = readTimedRoleWorkflow(
    JSON.parse(JSON.stringify({ ...state, ...effect.progress })),
  );
  assert.deepEqual(resumed, attempted.state);
  const finished = transitionTimedRoleWorkflow(resumed, {
    type: "restoration-attempted",
    remainingRoleIds: [],
  });
  assert.deepEqual(finished, {
    state: { kind: "completed" },
    effects: [{ type: "delete-assignment" }],
  });
});

test("failed or deferred restoration retains its obligation without a redundant checkpoint", () => {
  const state = readTimedRoleWorkflow({
    pendingRestorationRoleIds: ["access-a"],
    restorationStartedAtMs: 100,
    targetRoleRemovalCompletedAtMs: 101,
  });
  const transition = transitionTimedRoleWorkflow(state, {
    type: "restoration-attempted",
    remainingRoleIds: ["access-a"],
  });
  assert.deepEqual(transition.state, state);
  assert.deepEqual(transition.effects, []);
  assert.throws(() =>
    transitionTimedRoleWorkflow(state, {
      type: "restoration-attempted",
      remainingRoleIds: ["unrelated-role"],
    }),
  );
});

test("compensation restores only confirmed removals and retains unsuccessful recovery work", () => {
  const captured = readTimedRoleWorkflow({ pendingSuspensionRoleIds: ["access-a", "access-b"] });
  const suspended = transitionTimedRoleWorkflow(captured, {
    type: "suspension-confirmed",
    roleId: "access-a",
  }).state;
  const compensating = transitionTimedRoleWorkflow(suspended, {
    type: "compensation-requested",
    targetRoleRemovalRequired: true,
  }).state;
  assert.equal(compensating.kind, "compensating");
  assert.ok("pendingRestorationRoleIds" in compensating);
  assert.deepEqual(compensating.pendingRestorationRoleIds, ["access-a"]);
  assert.deepEqual(compensating.pendingSuspensionRoleIds, []);
  assert.throws(() =>
    transitionTimedRoleWorkflow(compensating, {
      type: "compensation-finished",
      snapshotPersisted: true,
    }),
  );
  const restored = transitionTimedRoleWorkflow(compensating, {
    type: "compensation-role-restored",
    roleId: "access-a",
  }).state;
  assert.ok("pendingRestorationRoleIds" in restored);
  assert.deepEqual(restored.pendingRestorationRoleIds, []);
  assert.deepEqual(compensating.pendingRestorationRoleIds, ["access-a"]);
  const targetRemoved = transitionTimedRoleWorkflow(restored, {
    type: "compensation-target-removed",
  }).state;
  assert.deepEqual(
    transitionTimedRoleWorkflow(targetRemoved, {
      type: "compensation-finished",
      snapshotPersisted: true,
    }),
    { state: { kind: "completed" }, effects: [{ type: "delete-assignment" }] },
  );
  assert.deepEqual(
    transitionTimedRoleWorkflow(targetRemoved, {
      type: "compensation-finished",
      snapshotPersisted: false,
    }).effects,
    [],
  );
});

test("deletion cannot skip pending suspension intent even when the target was removed", () => {
  const ready = readTimedRoleWorkflow({
    restorationStartedAtMs: 100,
    targetRoleRemovalCompletedAtMs: 101,
    pendingRestorationRoleIds: [],
  });
  assert.equal(ready.kind, "ready-to-delete");
  assert.equal(
    timedRoleWorkflowSchema.safeParse({ ...ready, pendingSuspensionRoleIds: ["access-a"] }).success,
    false,
  );
  const interrupted = readTimedRoleWorkflow({
    restorationStartedAtMs: 100,
    targetRoleRemovalCompletedAtMs: 101,
    pendingSuspensionRoleIds: ["access-a"],
    pendingRestorationRoleIds: [],
  });
  assert.throws(() =>
    transitionTimedRoleWorkflow(interrupted, {
      type: "restoration-attempted",
      remainingRoleIds: [],
    }),
  );
  const resumed = transitionTimedRoleWorkflow(interrupted, {
    type: "restoration-requested",
    nowMs: 200,
  });
  assert.equal(resumed.state.kind, "restoring-roles");
  assert.ok("pendingRestorationRoleIds" in resumed.state);
  assert.deepEqual(resumed.state.pendingRestorationRoleIds, ["access-a"]);
});

test("completed workflows reject further role mutation events", () => {
  assert.throws(() =>
    transitionTimedRoleWorkflow(
      { kind: "completed" },
      {
        type: "restoration-requested",
        nowMs: 100,
      },
    ),
  );
});

test("compensation retains only the uncertain attempted removal alongside confirmed work", () => {
  const state = readTimedRoleWorkflow({
    removedRoleIds: ["confirmed"],
    pendingRestorationRoleIds: ["confirmed"],
    pendingSuspensionRoleIds: ["uncertain", "unattempted"],
  });
  const result = transitionTimedRoleWorkflow(state, {
    type: "compensation-requested",
    targetRoleRemovalRequired: true,
    uncertainRemovalRoleId: "uncertain",
  }).state;
  assert.equal(result.kind, "compensating");
  assert.ok("pendingRestorationRoleIds" in result);
  assert.deepEqual(result.pendingRestorationRoleIds, ["confirmed", "uncertain"]);
  assert.deepEqual(readTimedRoleWorkflow(result).pendingRestorationRoleIds, [
    "confirmed",
    "uncertain",
  ]);
  assert.throws(() =>
    transitionTimedRoleWorkflow(state, {
      type: "compensation-requested",
      targetRoleRemovalRequired: true,
      uncertainRemovalRoleId: "foreign-role",
    }),
  );
});
