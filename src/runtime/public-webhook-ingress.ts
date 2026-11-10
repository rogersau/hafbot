import {
  transitionPublicIngress,
  publicIngressCompletion,
  type PublicIngressWorkflow,
} from "./public-ingress-workflow";
import { readBoundedUtf8Body, trustedContentLength } from "./bounded-request-body";
import type { WebhookIngressGuardNamespace } from "./contracts/webhook-ingress-guard";
import {
  PUBLIC_INGRESS_POLICIES,
  parsePublicIngressContentType,
  type PublicIngressProduct,
} from "./public-ingress-policy";

export type PublicIngressResult =
  | { ok: true; duplicate: boolean }
  | {
      ok: false;
      reason:
        | "invalid_source"
        | "unsupported_type"
        | "too_large"
        | "invalid_utf8"
        | "limited"
        | "unavailable";
      retryAfterSeconds?: number;
    };

export async function handlePublicWebhookIngress(input: {
  request: Request;
  product: PublicIngressProduct;
  publicId: string;
  guard: WebhookIngressGuardNamespace;
  readCachedSourceExists(): Promise<boolean | null>;
  sourceExists(): Promise<boolean>;
  handle(text: string, contentType: string | null): Promise<void>;
  now?: () => number;
}): Promise<PublicIngressResult> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.publicId))
    return { ok: false, reason: "invalid_source" };
  const policy = PUBLIC_INGRESS_POLICIES[input.product];
  const mediaType = parsePublicIngressContentType(input.request.headers.get("content-type"));
  if (!mediaType.ok) return { ok: false, reason: "unsupported_type" };
  const length = trustedContentLength(input.request);
  if (length !== null && length > policy.maxBytes) return { ok: false, reason: "too_large" };
  const nowMs = (input.now ?? Date.now)();
  let cachedSourceExists: boolean | null;
  try {
    cachedSourceExists = await input.readCachedSourceExists();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (cachedSourceExists !== true) {
    const invalidReservation = await reserveInvalidSourceAdmission(input, policy, nowMs);
    if (!invalidReservation.ok) return invalidReservation.result;
    const invalidAdmission = invalidReservation.admission;
    let sourceExists = cachedSourceExists === false ? false : undefined;
    if (sourceExists === undefined) {
      try {
        sourceExists = await input.sourceExists();
      } catch {
        await invalidAdmission.complete("lookup_unavailable");
        return { ok: false, reason: "unavailable" };
      }
    }
    if (!sourceExists) {
      return handleInvalidSourceProbe(
        input,
        policy,
        mediaType.canonicalMediaType,
        invalidAdmission,
      );
    }
    await invalidAdmission.complete("known_source");
  }
  const source = input.guard.getByName(`source:v1:${input.product}:${input.publicId}`);
  const global = input.guard.getByName(`global:v2:${input.product}`);
  const sourcePolicy = {
    requestsPerMinute: policy.sourceRequestsPerMinute,
    burst: policy.sourceBurst,
    concurrency: policy.sourceConcurrency,
    leaseTimeoutMs: policy.leaseTimeoutMs,
    duplicateWindowMs: policy.duplicateWindowMs,
  };
  const globalPolicy = {
    requestsPerMinute: policy.globalRequestsPerMinute,
    burst: policy.globalBurst,
    concurrency: policy.globalConcurrency,
    leaseTimeoutMs: policy.leaseTimeoutMs,
    duplicateWindowMs: policy.duplicateWindowMs,
  };
  let workflow: PublicIngressWorkflow = { kind: "unreserved" };
  try {
    const sourceReservation = await source.reserve({ nowMs, policy: sourcePolicy });
    if (!sourceReservation.ok)
      return {
        ok: false,
        reason: "limited",
        retryAfterSeconds: sourceReservation.retryAfterSeconds,
      };
    const sourceLease = sourceReservation.leaseId;
    workflow = transitionPublicIngress(workflow, { type: "source-reserved", leaseId: sourceLease });
    const globalReservation = await global.reserve({ nowMs, policy: globalPolicy });
    if (!globalReservation.ok)
      return {
        ok: false,
        reason: "limited",
        retryAfterSeconds: globalReservation.retryAfterSeconds,
      };
    workflow = transitionPublicIngress(workflow, {
      type: "global-reserved",
      leaseId: globalReservation.leaseId,
    });
    const body = await readBoundedUtf8Body(input.request, {
      maxBytes: policy.maxBytes,
      canonicalMediaType: mediaType.canonicalMediaType,
    });
    if (!body.ok) return { ok: false, reason: body.reason };
    const sha256 = `${input.product}|${input.publicId}|${mediaType.canonicalMediaType}|${body.sha256}`;
    workflow = transitionPublicIngress(workflow, { type: "body-hashed", sha256 });
    const registered = await source.registerBody({
      leaseId: sourceLease,
      sha256,
      nowMs,
      duplicateWindowMs: policy.duplicateWindowMs,
    });
    if (!registered.ok)
      return registered.reason === "duplicate"
        ? { ok: true, duplicate: true }
        : { ok: false, reason: "unavailable" };
    workflow = transitionPublicIngress(workflow, { type: "body-registered" });
    await input.handle(body.text, input.request.headers.get("content-type"));
    workflow = transitionPublicIngress(workflow, { type: "accepted" });
    return { ok: true, duplicate: false };
  } catch (error) {
    if (workflow.kind === "body-registered") throw error;
    return { ok: false, reason: "unavailable" };
  } finally {
    const completedAtMs = (input.now ?? Date.now)();
    const { outcome, retryable, sha256 } = publicIngressCompletion(workflow);
    const sourceLease = "sourceLease" in workflow ? workflow.sourceLease : undefined;
    const globalLease = "globalLease" in workflow ? workflow.globalLease : undefined;
    if (sourceLease)
      await source
        .complete({ leaseId: sourceLease, outcome, nowMs: completedAtMs, sha256, retryable })
        .catch(() => undefined);
    if (globalLease)
      await global
        .complete({ leaseId: globalLease, outcome, nowMs: completedAtMs })
        .catch(() => undefined);
  }
}

interface InvalidSourceAdmission {
  complete(outcome: string): Promise<void>;
}

type InvalidSourceAdmissionResult =
  | { ok: true; admission: InvalidSourceAdmission }
  | {
      ok: false;
      result: Extract<PublicIngressResult, { ok: false }>;
    };

async function reserveInvalidSourceAdmission(
  input: {
    request: Request;
    product: PublicIngressProduct;
    guard: WebhookIngressGuardNamespace;
    now?: () => number;
  },
  policy: (typeof PUBLIC_INGRESS_POLICIES)[PublicIngressProduct],
  nowMs: number,
): Promise<InvalidSourceAdmissionResult> {
  let clientKey: string;
  try {
    clientKey = await invalidSourceClientKey(input.request);
  } catch {
    return { ok: false, result: { ok: false, reason: "unavailable" } };
  }
  const client = input.guard.getByName(`invalid-source:v1:${input.product}:client:${clientKey}`);
  const global = input.guard.getByName(`invalid-source:v1:${input.product}:global`);
  const clientPolicy = {
    requestsPerMinute: policy.invalidSourceRequestsPerMinute,
    burst: policy.invalidSourceBurst,
    concurrency: policy.invalidSourceConcurrency,
    leaseTimeoutMs: policy.leaseTimeoutMs,
    duplicateWindowMs: 0,
  };
  const globalPolicy = {
    requestsPerMinute: policy.invalidSourceGlobalRequestsPerMinute,
    burst: policy.invalidSourceGlobalBurst,
    concurrency: policy.invalidSourceGlobalConcurrency,
    leaseTimeoutMs: policy.leaseTimeoutMs,
    duplicateWindowMs: 0,
  };
  let clientLease: string | undefined;
  let globalLease: string | undefined;
  let completed = false;
  const complete = async (outcome: string): Promise<void> => {
    if (completed) return;
    completed = true;
    const completedAtMs = (input.now ?? Date.now)();
    if (clientLease)
      await client
        .complete({ leaseId: clientLease, outcome, nowMs: completedAtMs })
        .catch(() => undefined);
    if (globalLease)
      await global
        .complete({ leaseId: globalLease, outcome, nowMs: completedAtMs })
        .catch(() => undefined);
  };
  try {
    const clientReservation = await client.reserve({ nowMs, policy: clientPolicy });
    if (!clientReservation.ok)
      return {
        ok: false,
        result: {
          ok: false,
          reason: "limited",
          retryAfterSeconds: clientReservation.retryAfterSeconds,
        },
      };
    clientLease = clientReservation.leaseId;
    const globalReservation = await global.reserve({ nowMs, policy: globalPolicy });
    if (!globalReservation.ok) {
      await complete("rejected");
      return {
        ok: false,
        result: {
          ok: false,
          reason: "limited",
          retryAfterSeconds: globalReservation.retryAfterSeconds,
        },
      };
    }
    globalLease = globalReservation.leaseId;
    return { ok: true, admission: { complete } };
  } catch {
    await complete("unavailable");
    return { ok: false, result: { ok: false, reason: "unavailable" } };
  }
}

async function handleInvalidSourceProbe(
  input: {
    request: Request;
  },
  policy: (typeof PUBLIC_INGRESS_POLICIES)[PublicIngressProduct],
  canonicalMediaType: string,
  admission: InvalidSourceAdmission,
): Promise<PublicIngressResult> {
  try {
    const body = await readBoundedUtf8Body(input.request, {
      maxBytes: policy.maxBytes,
      canonicalMediaType,
    });
    if (!body.ok) return { ok: false, reason: body.reason };
    return { ok: false, reason: "invalid_source" };
  } catch {
    return { ok: false, reason: "invalid_source" };
  } finally {
    await admission.complete("invalid_source");
  }
}

async function invalidSourceClientKey(request: Request): Promise<string> {
  const identity = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
