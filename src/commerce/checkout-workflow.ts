type Capacity = "unclaimed" | "claimed";

/** Local execution progress; the checkout attempt and provider idempotency key remain durable. */
export type CheckoutWorkflow =
  | { kind: "preparing"; capacity: Capacity }
  | { kind: "provider-outcome-unknown"; capacity: Capacity }
  | { kind: "provider-created"; sessionId: string }
  | { kind: "attached"; sessionId: string };

export type CheckoutEvent =
  | { type: "capacity-claimed" }
  | { type: "provider-invoked" }
  | { type: "provider-created"; sessionId: string }
  | { type: "session-attached" };

export function transitionCheckout(
  state: CheckoutWorkflow,
  event: CheckoutEvent,
): CheckoutWorkflow {
  switch (event.type) {
    case "capacity-claimed":
      if (state.kind === "preparing" && state.capacity === "unclaimed")
        return { ...state, capacity: "claimed" };
      break;
    case "provider-invoked":
      if (state.kind === "preparing") return { ...state, kind: "provider-outcome-unknown" };
      break;
    case "provider-created":
      if (state.kind === "provider-outcome-unknown")
        return { kind: "provider-created", sessionId: event.sessionId };
      break;
    case "session-attached":
      if (state.kind === "provider-created") return { ...state, kind: "attached" };
      break;
  }
  throw new Error(`Cannot apply ${event.type} while checkout is ${state.kind}.`);
}

export function checkoutFailureRecovery(state: CheckoutWorkflow): {
  releaseCapacity: boolean;
  providerOutcome: "unknown" | "confirmed_not_sent";
} {
  return {
    // Preserve the existing capacity policy for an unconfirmed provider response.
    releaseCapacity:
      (state.kind === "preparing" || state.kind === "provider-outcome-unknown") &&
      state.capacity === "claimed",
    providerOutcome: state.kind === "preparing" ? "confirmed_not_sent" : "unknown",
  };
}
