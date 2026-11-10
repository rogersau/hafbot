import type { TicketPanelConfig, TicketTypeConfig } from "../../types";

export interface TicketPanelEditorUiState {
  ticketTypeKeys: string[];
  questionKeys: string[][];
  openTicketTypes: Set<string>;
  openQuestions: Set<string>;
}

export function moveArrayItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (index < 0 || index >= items.length || nextIndex < 0 || nextIndex >= items.length) {
    return [...items];
  }

  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item!);
  return next;
}

export function createEmptyTicketType(index: number): TicketTypeConfig {
  return {
    id: `ticket-type-${index + 1}`,
    label: "",
    emoji: null,
    buttonStyle: "primary",
    supportRoleId: "",
    allowedCreatorRoleIds: [],
    channelNamePrefix: "",
    questions: [],
    autoReplyEnabled: true,
    autoReplyMessage: null,
    responseRules: [],
    defaultTicketLinkPlatform: null,
    anonymousEnabled: false,
    anonymousSupportEnabled: false,
    staffDiscussionThreadEnabled: false,
    ticketHistoryPromptVisibility: "off",
    participantManagementEnabled: false,
    limitExclusion: false,
    mentionSupportRole: false,
  };
}

export function buildInitialTicketPanelUiState(
  value: TicketPanelConfig,
  createUiKey: (prefix: string) => string,
): TicketPanelEditorUiState {
  const ticketTypeKeys = value.ticketTypes.map(() => createUiKey("ticket-type"));
  const questionKeys = value.ticketTypes.map((ticketType) =>
    ticketType.questions.map(() => createUiKey("ticket-question")),
  );
  return {
    ticketTypeKeys,
    questionKeys,
    openTicketTypes: new Set(ticketTypeKeys.slice(0, 1)),
    openQuestions: new Set(),
  };
}
