export type TicketOpenWorkflow = {
  kind: "resources-created" | "record-created" | "ready";
  staffThreadId: string | null;
};

export type TicketOpenEvent =
  | { type: "staff-thread-created"; threadId: string }
  | { type: "record-created" | "ready" };

export function transitionTicketOpen(
  state: TicketOpenWorkflow,
  event: TicketOpenEvent,
): TicketOpenWorkflow {
  if (
    event.type === "staff-thread-created" &&
    state.kind === "resources-created" &&
    state.staffThreadId === null
  )
    return { ...state, staffThreadId: event.threadId };
  if (event.type === "record-created" && state.kind === "resources-created")
    return { ...state, kind: "record-created" };
  if (event.type === "ready" && state.kind === "record-created") return { ...state, kind: "ready" };
  throw new Error(`Cannot apply ${event.type} while ticket opening is ${state.kind}.`);
}

export function ticketOpenNeedsRecordRollback(state: TicketOpenWorkflow): boolean {
  return state.kind === "record-created" || state.kind === "ready";
}
