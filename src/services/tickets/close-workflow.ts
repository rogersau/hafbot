import type { CloseTicketRecoveryState, CloseTicketRecoveryStep } from "./close-ticket";
import type { TicketInstance } from "../../types";

export type TicketCloseWorkflow =
  | { kind: CloseTicketRecoveryStep; recovery: CloseTicketRecoveryState }
  | { kind: "completed" };

export function ticketCloseSteps(ticket: TicketInstance): CloseTicketRecoveryStep[] {
  return [
    "close-persistence",
    ...(ticket.staffThreadId
      ? (["staff-thread", "staff-message-cleanup", "staff-thread-persistence"] as const)
      : []),
    "ticket-channel",
  ];
}

export function readTicketCloseWorkflow(recovery: CloseTicketRecoveryState): TicketCloseWorkflow {
  const step = recovery.remainingSteps[0];
  return step ? { kind: step, recovery } : { kind: "completed" };
}

/** Advance only after the current effect succeeds. Failed effects keep their recovery envelope. */
export function completeTicketCloseStep(
  state: TicketCloseWorkflow,
  step: CloseTicketRecoveryStep,
): TicketCloseWorkflow {
  if (state.kind === "completed" || state.kind !== step)
    throw new Error(`Cannot complete ${step} while ticket cleanup is ${state.kind}.`);
  return readTicketCloseWorkflow({
    ...state.recovery,
    remainingSteps: state.recovery.remainingSteps.slice(1),
  });
}
