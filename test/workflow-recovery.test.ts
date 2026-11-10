import assert from "node:assert/strict";
import test from "node:test";
import {
  managedObjectFailureAction,
  transitionManagedObject,
} from "../src/runtime/managed-object-workflow";
import {
  checkoutFailureRecovery,
  transitionCheckout,
  type CheckoutWorkflow,
} from "../src/commerce/checkout-workflow";
import { readFinancialActionWorkflow } from "../src/commerce/financial-action-workflow";
import { initialAdminRequest, transitionAdminRequest } from "../src/admin/lib/request-workflow";
import { transitionRestore, type RestoreWorkflow } from "../src/admin/lib/restore-workflow";
import { transitionAutoSave } from "../src/admin/lib/auto-save-workflow";
import { transitionFeedback } from "../src/admin/lib/feedback-workflow";
import {
  transitionSetupDependency,
  type SetupDependencyWorkflow,
} from "../src/services/setup-dependency-workflow";
import {
  completeTicketCloseStep,
  readTicketCloseWorkflow,
} from "../src/services/tickets/close-workflow";
import type { CloseTicketRecoveryState } from "../src/services/tickets/close-ticket";
import type { SetupResolution } from "../src/feature-setup";
import { readImageReviewWorkflow } from "../src/services/image-rules/review-workflow";
import {
  eventLifecycleTarget,
  dueEventLifecycleAction,
} from "../src/services/event-lifecycle-workflow";
import { decideSuggestionStatusChange } from "../src/services/suggestion-status-workflow";
import {
  nextClanProvisioningStep,
  nextClanCleanupStep,
} from "../src/services/clan-resource-workflow";
import { platformLinkFailure } from "../src/services/platform-link-workflow";
import {
  transitionPublicIngress,
  publicIngressCompletion,
  type PublicIngressWorkflow,
} from "../src/runtime/public-ingress-workflow";
import { transitionResourceCreation } from "../src/admin/lib/resource-creation-workflow";
import type { SetupPreview } from "../src/feature-setup";

test("an expired Image Rules restore claim requires history inspection rather than a new send", () => {
  const item = {
    status: "pending",
    restoreClaimToken: "old-worker",
    restoreClaimExpiresAtMs: 100,
  } as const;
  assert.equal(readImageReviewWorkflow(item, 99).kind, "restore-leased");
  assert.equal(readImageReviewWorkflow(item, 100).kind, "restore-recovery-required");
  assert.equal(readImageReviewWorkflow({ ...item, restoreClaimToken: null }, 100).kind, "pending");
  assert.equal(readImageReviewWorkflow({ ...item, status: "restored" }, 100).kind, "handled");
});

test("missed Event deadlines end the Event without reopening signup", () => {
  const event = { status: "scheduled", startsAtMs: 10, endsAtMs: 20 } as const;
  assert.equal(dueEventLifecycleAction(event, 20), "end");
  assert.equal(dueEventLifecycleAction(event, 10), "start");
  assert.equal(dueEventLifecycleAction({ ...event, status: "cancelled" }, 30), null);
  assert.equal(eventLifecycleTarget("archived", "publish"), null);
  assert.equal(eventLifecycleTarget("live", "archive"), null);
  assert.equal(eventLifecycleTarget("ended", "archive"), "archived");
});

test("Suggestion authors cannot reopen staff outcomes or grant themselves review authority", () => {
  const author = { isModerator: false, isAuthor: true };
  assert.deepEqual(decideSuggestionStatusChange("needs_work", "gathering_feedback", author), {
    kind: "allowed",
    reopening: false,
    requiresOutcome: false,
  });
  assert.equal(
    decideSuggestionStatusChange("rejected", "gathering_feedback", author).kind,
    "forbidden",
  );
  assert.equal(
    decideSuggestionStatusChange("gathering_feedback", "planned", author).kind,
    "forbidden",
  );
  assert.deepEqual(
    decideSuggestionStatusChange("rejected", "under_review", {
      isModerator: true,
      isAuthor: false,
    }),
    { kind: "allowed", reopening: true, requiresOutcome: false },
  );
});

test("Clan recovery skips saved resources and removes channels before the role", () => {
  const resources = { roleId: "role-1", textChannelId: "text-1", voiceChannelId: null };
  assert.equal(nextClanProvisioningStep(resources, "category-1"), "create-voice-channel");
  assert.deepEqual(nextClanCleanupStep(resources), {
    kind: "delete-text-channel",
    resourceId: "text-1",
  });
  assert.deepEqual(nextClanCleanupStep({ ...resources, textChannelId: null }), {
    kind: "delete-role",
    resourceId: "role-1",
  });
  assert.equal(
    nextClanCleanupStep({ roleId: null, textChannelId: null, voiceChannelId: null }).kind,
    "resources-removed",
  );
});

test("committed Platform Links report finalization failure rather than a failed save", () => {
  assert.deepEqual(platformLinkFailure({ kind: "committed" }), { kind: "finalization-failed" });
  assert.deepEqual(platformLinkFailure({ kind: "persisting" }), {
    kind: "save-failed",
    reason: "storage_unavailable",
  });
});

test("public ingress retries a registered body only until downstream handling is accepted", () => {
  let state: PublicIngressWorkflow = { kind: "unreserved" };
  state = transitionPublicIngress(state, { type: "source-reserved", leaseId: "source-lease" });
  assert.equal(publicIngressCompletion(state).retryable, false);
  state = transitionPublicIngress(state, { type: "global-reserved", leaseId: "global-lease" });
  assert.throws(() => transitionPublicIngress(state, { type: "accepted" }));
  state = transitionPublicIngress(state, { type: "body-hashed", sha256: "body-hash" });
  state = transitionPublicIngress(state, { type: "body-registered" });
  assert.deepEqual(publicIngressCompletion(state), {
    outcome: "rejected",
    retryable: true,
    sha256: "body-hash",
  });
  state = transitionPublicIngress(state, { type: "accepted" });
  assert.deepEqual(publicIngressCompletion(state), {
    outcome: "accepted",
    retryable: false,
    sha256: "body-hash",
  });
});

test("resource creation keeps reviewed access choices through a retryable execution failure", () => {
  const preview: SetupPreview = {
    guildId: "guild-1",
    featureKey: "tickets",
    definitionVersion: 1,
    dependencies: [],
  };
  const previewing = transitionResourceCreation(
    { kind: "editing", error: null },
    { type: "preview-started" },
  );
  assert.equal(transitionResourceCreation(previewing, { type: "create-started" }), previewing);
  const reviewed = transitionResourceCreation(previewing, {
    type: "preview-created",
    preview,
    accessRoleIds: ["role-1"],
    accessChannelIds: ["channel-1"],
  });
  const creating = transitionResourceCreation(reviewed, { type: "create-started" });
  assert.equal(transitionResourceCreation(creating, { type: "closed" }), creating);
  const retry = transitionResourceCreation(creating, {
    type: "failed",
    error: "checkpoint failed",
  });
  assert.equal(retry.kind, "reviewed");
  assert.ok("accessRoleIds" in retry);
  assert.deepEqual(retry.accessRoleIds, ["role-1"]);
  assert.equal(retry.preview, preview);
});

test("an ambiguous upload releases quota only after absence is established", () => {
  const reserved = { kind: "reserved" } as const;
  const uncertain = transitionManagedObject(reserved, "upload-started");
  assert.equal(managedObjectFailureAction(reserved), "release-reservation");
  assert.equal(managedObjectFailureAction(uncertain), "retain-for-reconciliation");
  assert.equal(managedObjectFailureAction(uncertain, true), "release-reservation");
  const uploaded = transitionManagedObject(uncertain, "upload-confirmed");
  assert.equal(managedObjectFailureAction(uploaded, true), "retain-for-reconciliation");
  assert.throws(() => transitionManagedObject(reserved, "commit-confirmed"));
  assert.deepEqual(reserved, { kind: "reserved" });
});

test("checkout recovery preserves successful provider creation after a failed local checkpoint", () => {
  let state: CheckoutWorkflow = { kind: "preparing", capacity: "unclaimed" };
  assert.deepEqual(checkoutFailureRecovery(state), {
    releaseCapacity: false,
    providerOutcome: "confirmed_not_sent",
  });
  state = transitionCheckout(state, { type: "capacity-claimed" });
  assert.equal(checkoutFailureRecovery(state).releaseCapacity, true);
  state = transitionCheckout(state, { type: "provider-invoked" });
  assert.equal(checkoutFailureRecovery(state).providerOutcome, "unknown");
  state = transitionCheckout(state, { type: "provider-created", sessionId: "session-1" });
  assert.deepEqual(checkoutFailureRecovery(state), {
    releaseCapacity: false,
    providerOutcome: "unknown",
  });
  assert.throws(() => transitionCheckout(state, { type: "provider-invoked" }));
  assert.deepEqual(transitionCheckout(state, { type: "session-attached" }), {
    kind: "attached",
    sessionId: "session-1",
  });
});

test("a failed financial attempt resumes from the durable provider checkpoint", () => {
  const action = {
    status: "failed",
    providerResultId: "refund-1",
    providerCompletedAtMs: 1,
    reconciliationRequestedAtMs: null,
    quarantinedAtMs: null,
  };
  assert.deepEqual(readFinancialActionWorkflow(action), {
    kind: "reconciliation-pending",
    providerResultId: "refund-1",
  });
  assert.deepEqual(readFinancialActionWorkflow({ ...action, reconciliationRequestedAtMs: 2 }), {
    kind: "completion-pending",
    providerResultId: "refund-1",
  });
  assert.deepEqual(readFinancialActionWorkflow({ ...action, quarantinedAtMs: 3 }), {
    kind: "quarantined",
  });
  assert.throws(() => readFinancialActionWorkflow({ ...action, providerCompletedAtMs: NaN }));
});

test("cancelled and superseded admin requests cannot finish a newer request", () => {
  const first = transitionAdminRequest(initialAdminRequest, { type: "started", requestId: 1 });
  const second = transitionAdminRequest(first, { type: "started", requestId: 2 });
  assert.equal(
    transitionAdminRequest(second, { type: "failed", requestId: 1, error: "old failure" }),
    second,
  );
  const cancelled = transitionAdminRequest(second, { type: "cancelled", requestId: 3 });
  assert.equal(transitionAdminRequest(cancelled, { type: "succeeded", requestId: 2 }), cancelled);
  assert.equal(cancelled.kind, "cancelled");
});

test("committed configuration restore retains its blocker and only permits refresh recovery", () => {
  let state: RestoreWorkflow<string> = { kind: "editing" };
  state = transitionRestore(state, { type: "preview-started" });
  state = transitionRestore(state, { type: "preview-created", preview: "signed-preview" });
  state = transitionRestore(state, { type: "confirmation-started" });
  state = transitionRestore(state, { type: "restore-started" });
  state = transitionRestore(state, { type: "restore-committed" });
  state = transitionRestore(state, { type: "refresh-failed", error: "offline" });
  for (const type of ["reset", "preview-started", "restore-started", "restore-committed"] as const)
    assert.equal(transitionRestore(state, { type }), state);
  state = transitionRestore(state, { type: "refresh-started" });
  assert.deepEqual(transitionRestore(state, { type: "refresh-completed" }), { kind: "editing" });
});

test("an old autosave acknowledgement cannot clear a newer save of the same key", () => {
  const first = transitionAutoSave(
    { kind: "idle", generation: 0 },
    { type: "started", key: "enabled" },
  );
  const saved = transitionAutoSave(first, { type: "succeeded", generation: 1 });
  const second = transitionAutoSave(saved, { type: "started", key: "enabled" });
  assert.equal(
    transitionAutoSave(second, { type: "acknowledgement-expired", generation: 1 }),
    second,
  );
  assert.equal(transitionAutoSave(second, { type: "started", key: "other" }), second);
});

test("a feedback receipt cannot be replaced by late failure or resubmission", () => {
  const submitting = transitionFeedback({ kind: "editing", error: null }, { type: "submitted" });
  const receipt = transitionFeedback(submitting, { type: "received", reference: "receipt-1" });
  assert.equal(transitionFeedback(receipt, { type: "submitted" }), receipt);
  assert.equal(transitionFeedback(receipt, { type: "failed", error: "late" }), receipt);
});

test("setup cannot create another resource after creation intent is recorded", () => {
  const uncertain = transitionSetupDependency({ kind: "unresolved" }, { type: "creation-started" });
  assert.throws(() => transitionSetupDependency(uncertain, { type: "creation-started" }));
  const resolution: SetupResolution = {
    runId: "run-1",
    dependencyKey: "role",
    resource: { id: "role-1", name: "Staff", kind: "role" },
    relationship: "haf_configured",
    templateVersion: 1,
    validationStatus: "valid",
    validationDetail: null,
    appliedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let state: SetupDependencyWorkflow = transitionSetupDependency(uncertain, {
    type: "resource-resolved",
    resolution,
  });
  assert.throws(() => transitionSetupDependency(state, { type: "application-saved", nowMs: 2 }));
  state = transitionSetupDependency(state, { type: "resolution-saved" });
  const completed = transitionSetupDependency(state, { type: "application-saved", nowMs: 2 });
  assert.equal(completed.kind, "completed");
  assert.equal(resolution.appliedAtMs, null);
});

test("ticket cleanup cannot delete the channel before saving closure", () => {
  const recovery = {
    remainingSteps: ["close-persistence", "ticket-channel"],
  } as CloseTicketRecoveryState;
  const state = readTicketCloseWorkflow(recovery);
  assert.throws(() => completeTicketCloseStep(state, "ticket-channel"));
  const deleting = completeTicketCloseStep(state, "close-persistence");
  assert.equal(deleting.kind, "ticket-channel");
  const completed = completeTicketCloseStep(deleting, "ticket-channel");
  assert.equal(completed.kind, "completed");
  assert.throws(() => completeTicketCloseStep(completed, "ticket-channel"));
  assert.deepEqual(recovery.remainingSteps, ["close-persistence", "ticket-channel"]);
});
