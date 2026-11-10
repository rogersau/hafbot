export type AdminRequestState = {
  kind: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  requestId: number;
  error: string | null;
};

export type AdminRequestEvent =
  | { type: "started" | "succeeded" | "cancelled"; requestId: number }
  | { type: "failed"; requestId: number; error: string | null }
  | { type: "error-set"; error: string | null };

export const initialAdminRequest: AdminRequestState = { kind: "idle", requestId: 0, error: null };

/** Only the current request may finish; cancellation revokes ownership immediately. */
export function transitionAdminRequest(
  state: AdminRequestState,
  event: AdminRequestEvent,
): AdminRequestState {
  if (event.type === "error-set") return { ...state, error: event.error };
  if (event.type === "started" || event.type === "cancelled") {
    if (event.requestId <= state.requestId) return state;
    return {
      kind: event.type === "started" ? "running" : "cancelled",
      requestId: event.requestId,
      error: null,
    };
  }
  if (state.kind !== "running" || event.requestId !== state.requestId) return state;
  return {
    ...state,
    kind: event.type,
    error: event.type === "failed" ? event.error : state.error,
  };
}
