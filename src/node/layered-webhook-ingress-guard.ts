import type {
  WebhookIngressGuardNamespace,
  WebhookIngressGuardScope,
} from "../runtime/contracts/webhook-ingress-guard";

export function createLayeredWebhookIngressGuard(input: {
  process: WebhookIngressGuardNamespace;
  durable: WebhookIngressGuardNamespace;
}): WebhookIngressGuardNamespace {
  return {
    getByName(name) {
      return createLayeredScope(input.process.getByName(name), input.durable.getByName(name));
    },
  };
}

function createLayeredScope(
  process: WebhookIngressGuardScope,
  durable: WebhookIngressGuardScope,
): WebhookIngressGuardScope {
  return {
    async reserve(input) {
      const processReservation = await process.reserve(input);
      if (!processReservation.ok) return processReservation;
      try {
        const durableReservation = await durable.reserve(input);
        if (!durableReservation.ok) {
          await process.complete({
            leaseId: processReservation.leaseId,
            outcome: "durable_rejected",
            nowMs: input.nowMs,
          });
          return durableReservation;
        }
        return {
          ok: true,
          leaseId: encodeLease(processReservation.leaseId, durableReservation.leaseId),
          expiresAtMs: Math.min(processReservation.expiresAtMs, durableReservation.expiresAtMs),
        };
      } catch (error) {
        await process
          .complete({
            leaseId: processReservation.leaseId,
            outcome: "durable_unavailable",
            nowMs: input.nowMs,
          })
          .catch(() => undefined);
        throw error;
      }
    },

    async registerBody(input) {
      const lease = decodeLease(input.leaseId);
      if (!lease) return { ok: false, reason: "lease_expired" };
      const processResult = await process.registerBody({ ...input, leaseId: lease.process });
      if (!processResult.ok) return processResult;
      return durable.registerBody({ ...input, leaseId: lease.durable });
    },

    async complete(input) {
      const lease = decodeLease(input.leaseId);
      if (!lease) return;
      const results = await Promise.allSettled([
        process.complete({ ...input, leaseId: lease.process }),
        durable.complete({ ...input, leaseId: lease.durable }),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    },

    snapshot(nowMs) {
      return durable.snapshot(nowMs);
    },
  };
}

function encodeLease(processLease: string, durableLease: string): string {
  return Buffer.from(JSON.stringify([processLease, durableLease]), "utf8").toString("base64url");
}

function decodeLease(value: string): { process: string; durable: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    ) {
      return null;
    }
    return { process: decoded[0], durable: decoded[1] };
  } catch {
    return null;
  }
}
