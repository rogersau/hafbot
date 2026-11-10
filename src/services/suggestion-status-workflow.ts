import { isTerminalSuggestionStatus, type SuggestionStatus } from "../suggestions";

export type SuggestionStatusDecision =
  | { kind: "allowed"; reopening: boolean; requiresOutcome: boolean }
  | { kind: "forbidden" }
  | { kind: "unchanged" };

export function decideSuggestionStatusChange(
  from: SuggestionStatus,
  to: SuggestionStatus,
  authority: { isModerator: boolean; isAuthor: boolean },
): SuggestionStatusDecision {
  const authorAllowed =
    authority.isAuthor &&
    ((from === "gathering_feedback" && to === "needs_work") ||
      (from === "needs_work" && to === "gathering_feedback"));
  if (!authority.isModerator && !authorAllowed) return { kind: "forbidden" };
  if (from === to) return { kind: "unchanged" };
  return {
    kind: "allowed",
    reopening: isTerminalSuggestionStatus(from) && !isTerminalSuggestionStatus(to),
    requiresOutcome: isTerminalSuggestionStatus(to),
  };
}
