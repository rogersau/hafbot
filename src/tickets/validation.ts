import {
  DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_MODAL_LABEL_MAX_LENGTH,
  DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH,
} from "../discord/constants";
import { buildTicketOpenCustomId } from "../tickets";
import type { TicketPanelConfig } from "../types";

export type TicketModalFieldValidationKind =
  | "ticket-type-label"
  | "ticket-type-open-custom-id"
  | "question-label"
  | "question-id"
  | "question-placeholder";

export interface TicketModalFieldValidationIssue {
  kind: TicketModalFieldValidationKind;
  ticketTypeIndex: number;
  questionIndex?: number;
  message: string;
}

/**
 * Validate values that are copied into Discord modal/component fields.
 *
 * Applied at mutation boundaries and by the dashboard before submit.
 */
export function listTicketModalFieldValidationIssues(
  panel: Pick<TicketPanelConfig, "panelId" | "ticketTypes">,
): TicketModalFieldValidationIssue[] {
  const issues: TicketModalFieldValidationIssue[] = [];
  const panelId = panel.panelId ?? "main";

  for (const [ticketTypeIndex, ticketType] of panel.ticketTypes.entries()) {
    const ticketTypeName = ticketType.label || ticketType.id || String(ticketTypeIndex + 1);
    if (ticketType.label.length > DISCORD_MODAL_LABEL_MAX_LENGTH) {
      issues.push({
        kind: "ticket-type-label",
        ticketTypeIndex,
        message: `Ticket Type "${ticketTypeName}": Ticket Type label must be ${DISCORD_MODAL_LABEL_MAX_LENGTH} characters or fewer.`,
      });
    }

    const openCustomId = buildTicketOpenCustomId(ticketType.id, panelId);
    if (openCustomId.length > DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH) {
      issues.push({
        kind: "ticket-type-open-custom-id",
        ticketTypeIndex,
        message: `Ticket Type "${ticketTypeName}": Ticket Type open custom ID must be ${DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH} characters or fewer (currently ${openCustomId.length}).`,
      });
    }

    for (const [questionIndex, question] of ticketType.questions.entries()) {
      if (question.label.length > DISCORD_MODAL_LABEL_MAX_LENGTH) {
        issues.push({
          kind: "question-label",
          ticketTypeIndex,
          questionIndex,
          message: `Ticket Type "${ticketTypeName}", question ${questionIndex + 1} ("${question.label}"): Question label must be ${DISCORD_MODAL_LABEL_MAX_LENGTH} characters or fewer.`,
        });
      }
      if (question.id.length > DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH) {
        issues.push({
          kind: "question-id",
          ticketTypeIndex,
          questionIndex,
          message: `Ticket Type "${ticketTypeName}", question ${questionIndex + 1} ("${question.label}"): Question ID must be ${DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH} characters or fewer.`,
        });
      }
      if ((question.placeholder?.length ?? 0) > DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH) {
        issues.push({
          kind: "question-placeholder",
          ticketTypeIndex,
          questionIndex,
          message: `Ticket Type "${ticketTypeName}", question ${questionIndex + 1} ("${question.label}"): Placeholder must be ${DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH} characters or fewer.`,
        });
      }
    }
  }

  return issues;
}

export function firstTicketModalFieldValidationIssue(
  panel: Pick<TicketPanelConfig, "panelId" | "ticketTypes">,
): TicketModalFieldValidationIssue | null {
  return listTicketModalFieldValidationIssues(panel)[0] ?? null;
}

export function ticketTypeOpenCustomIdMaxLength(panelId: string | undefined): number {
  return Math.max(
    1,
    DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH - buildTicketOpenCustomId("", panelId ?? "main").length,
  );
}
