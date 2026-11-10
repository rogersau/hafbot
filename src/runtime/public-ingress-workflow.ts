type Leases = { sourceLease: string; globalLease: string };
export type PublicIngressWorkflow =
  | { kind: "unreserved" }
  | { kind: "source-reserved"; sourceLease: string }
  | ({ kind: "admitted" } & Leases)
  | ({ kind: "body-hashed" | "body-registered" | "accepted"; sha256: string } & Leases);

export type PublicIngressEvent =
  | { type: "source-reserved"; leaseId: string }
  | { type: "global-reserved"; leaseId: string }
  | { type: "body-hashed"; sha256: string }
  | { type: "body-registered" | "accepted" };

export function transitionPublicIngress(
  state: PublicIngressWorkflow,
  event: PublicIngressEvent,
): PublicIngressWorkflow {
  switch (event.type) {
    case "source-reserved":
      if (state.kind === "unreserved")
        return { kind: "source-reserved", sourceLease: event.leaseId };
      break;
    case "global-reserved":
      if (state.kind === "source-reserved")
        return { ...state, kind: "admitted", globalLease: event.leaseId };
      break;
    case "body-hashed":
      if (state.kind === "admitted") return { ...state, kind: "body-hashed", sha256: event.sha256 };
      break;
    case "body-registered":
      if (state.kind === "body-hashed") return { ...state, kind: "body-registered" };
      break;
    case "accepted":
      if (state.kind === "body-registered") return { ...state, kind: "accepted" };
      break;
  }
  throw new Error(`Cannot apply ${event.type} while public ingress is ${state.kind}.`);
}

export function publicIngressCompletion(state: PublicIngressWorkflow): {
  outcome: "accepted" | "rejected";
  retryable: boolean;
  sha256?: string;
} {
  return {
    outcome: state.kind === "accepted" ? "accepted" : "rejected",
    retryable: state.kind === "body-registered",
    sha256: "sha256" in state ? state.sha256 : undefined,
  };
}
