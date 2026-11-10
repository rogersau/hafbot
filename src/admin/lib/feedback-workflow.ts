export type FeedbackWorkflow =
  | { kind: "editing"; error: string | null }
  | { kind: "submitting" }
  | { kind: "received"; reference: string };

export type FeedbackEvent =
  | { type: "reset" | "submitted" }
  | { type: "failed"; error: string }
  | { type: "received"; reference: string };

export function transitionFeedback(
  state: FeedbackWorkflow,
  event: FeedbackEvent,
): FeedbackWorkflow {
  switch (event.type) {
    case "reset":
      return { kind: "editing", error: null };
    case "submitted":
      return state.kind === "editing" ? { kind: "submitting" } : state;
    case "failed":
      return state.kind === "received" ? state : { kind: "editing", error: event.error };
    case "received":
      return state.kind === "submitting" ? { kind: "received", reference: event.reference } : state;
  }
}
