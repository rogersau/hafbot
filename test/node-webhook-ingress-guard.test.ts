import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryWebhookIngressGuard } from "../src/node/in-memory-webhook-ingress-guard";
import { createLayeredWebhookIngressGuard } from "../src/node/layered-webhook-ingress-guard";
import type {
  GuardPolicyInput,
  WebhookIngressGuardNamespace,
} from "../src/runtime/contracts/webhook-ingress-guard";

const policy: GuardPolicyInput = {
  requestsPerMinute: 60,
  burst: 1,
  concurrency: 1,
  leaseTimeoutMs: 1_000,
  duplicateWindowMs: 60_000,
};

test("in-memory webhook guard bounds scope growth and rejects before durable work", async () => {
  let id = 0;
  const process = createInMemoryWebhookIngressGuard({
    maxScopes: 1,
    randomId: () => `memory-${++id}`,
  });
  const calls = { reserve: 0, register: 0, complete: 0 };
  const durable = createFakeDurableGuard(calls);
  const layered = createLayeredWebhookIngressGuard({ process, durable });
  const scope = layered.getByName("known-source");
  const first = await scope.reserve({ nowMs: 1_000, policy });
  assert.ok(first.ok);
  assert.equal(calls.reserve, 1);

  const processRejected = await scope.reserve({ nowMs: 1_000, policy });
  assert.equal(processRejected.ok, false);
  assert.equal(calls.reserve, 1);

  assert.deepEqual(
    await scope.registerBody({
      leaseId: first.leaseId,
      sha256: "sha",
      nowMs: 1_000,
      duplicateWindowMs: 60_000,
    }),
    { ok: true },
  );
  await scope.complete({ leaseId: first.leaseId, outcome: "accepted", nowMs: 1_000 });
  assert.deepEqual(calls, { reserve: 1, register: 1, complete: 1 });

  const overflowOne = layered.getByName("attacker-source-1");
  const overflowTwo = layered.getByName("attacker-source-2");
  const acceptedOverflow = await overflowOne.reserve({ nowMs: 2_000, policy });
  assert.equal(acceptedOverflow.ok, true);
  const boundedOverflow = await overflowTwo.reserve({ nowMs: 2_000, policy });
  assert.equal(boundedOverflow.ok, false);
});

test("layered webhook leases fail closed when their opaque token is invalid", async () => {
  const process = createInMemoryWebhookIngressGuard();
  const durable = createFakeDurableGuard({ reserve: 0, register: 0, complete: 0 });
  const scope = createLayeredWebhookIngressGuard({ process, durable }).getByName("source");
  assert.deepEqual(
    await scope.registerBody({
      leaseId: "not-a-layered-lease",
      sha256: "sha",
      nowMs: 1_000,
      duplicateWindowMs: 60_000,
    }),
    { ok: false, reason: "lease_expired" },
  );
});

function createFakeDurableGuard(calls: {
  reserve: number;
  register: number;
  complete: number;
}): WebhookIngressGuardNamespace {
  return {
    getByName() {
      return {
        async reserve({ nowMs, policy: inputPolicy }) {
          calls.reserve += 1;
          return {
            ok: true,
            leaseId: `durable-${calls.reserve}`,
            expiresAtMs: nowMs + inputPolicy.leaseTimeoutMs,
          };
        },
        async registerBody() {
          calls.register += 1;
          return { ok: true };
        },
        async complete() {
          calls.complete += 1;
        },
        async snapshot(nowMs = Date.now()) {
          return {
            activeLeases: 0,
            tokens: null,
            updatedAtMs: null,
            outcomes: {},
            sampledAtMs: nowMs,
          };
        },
      };
    },
  };
}
