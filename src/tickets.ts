import type { DiscordEmbed } from "./discord";
import { buildAuditEmbed, formatStaffUserReference, formatUserMention } from "./discord";
import { isRecord } from "./unknown-parse";
import {
  DISCORD_MESSAGE_COMPONENT_ROW,
  DISCORD_MODAL_RESPONSE,
  DISCORD_TEXT_INPUT_COMPONENT,
} from "./discord/constants";
import type {
  TicketResponseCondition,
  TicketResponseRule,
  TicketAnswer,
  TicketInstance,
  TicketLinkPlatform,
  TicketPanelConfig,
  TicketParticipantEvent,
  TicketQuestion,
  TicketTypeConfig,
} from "./types";

const TICKET_OPEN_CUSTOM_ID_PREFIX = "ticket:open:";
const TICKET_CLAIM_CUSTOM_ID_PREFIX = "ticket:claim:";
const TICKET_CLOSE_CUSTOM_ID_PREFIX = "ticket:close:";
const TICKET_CLOSE_REQUEST_CUSTOM_ID_PREFIX = "ticket:close-request:";
const TICKET_CLOSE_CONFIRM_CUSTOM_ID_PREFIX = "ticket:close-confirm:";
const TICKET_CLOSE_DECLINE_CUSTOM_ID_PREFIX = "ticket:close-decline:";
const TICKET_HISTORY_OPEN_CUSTOM_ID_PREFIX = "ticket:history-open:";
const TICKET_HISTORY_PAGE_CUSTOM_ID_PREFIX = "ticket:history-page:";
const TICKET_HISTORY_PROMPT_CUSTOM_ID_PREFIX = "ticket:history-prompt:";
const TICKET_TEMPLATE_REPLY_CUSTOM_ID_PREFIX = "ticket:template-reply:";

export interface TicketModalResponse {
  type: typeof DISCORD_MODAL_RESPONSE;
  data: {
    custom_id: string;
    title: string;
    components: Array<{
      type: typeof DISCORD_MESSAGE_COMPONENT_ROW;
      components: Array<{
        type: typeof DISCORD_TEXT_INPUT_COMPONENT;
        custom_id: string;
        label: string;
        style: 1 | 2;
        placeholder?: string;
        required?: boolean;
      }>;
    }>;
  };
}

export interface TicketModalSubmitInteraction {
  data?: {
    components?: Array<{
      components?: Array<{
        custom_id?: string;
        value?: unknown;
      }>;
    }>;
  };
}

export interface TicketTranscriptAttachment {
  id: string;
  filename: string;
  url: string;
  proxyUrl: string | null;
  contentType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
}

export interface TicketTranscriptMessage {
  messageId?: string;
  authorId: string;
  authorTag: string | null;
  authorAvatarUrl?: string | null;
  content: string;
  createdAtMs: number;
  attachments?: TicketTranscriptAttachment[];
  replyToMessageId?: string | null;
  replyTo?: { authorTag: string | null; authorAvatarUrl?: string | null; content: string } | null;
}

export interface TicketTranscriptPresentationOptions {
  guildName?: string | null;
  channelName?: string | null;
  openerDisplayName?: string | null;
  closerDisplayName?: string | null;
}

interface StoredTicketPanelPayload {
  ticketTypes: TicketTypeConfig[];
  panelEmoji?: string | null;
  panelTitle?: string | null;
  panelDescription?: string | null;
  panelFooter?: string | null;
  panelColor?: number;
}

export function buildTicketOpenCustomId(ticketTypeId: string, panelId?: string): string {
  return `${TICKET_OPEN_CUSTOM_ID_PREFIX}${panelId ? `${panelId}:` : ""}${ticketTypeId}`;
}

export function serializeTicketPanelStorage(panel: TicketPanelConfig): string {
  return JSON.stringify({
    ticketTypes: panel.ticketTypes,
    panelEmoji: panel.panelEmoji,
    panelTitle: panel.panelTitle,
    panelDescription: panel.panelDescription,
    panelFooter: panel.panelFooter,
    panelColor: panel.panelColor ?? 0x57f287,
  } satisfies StoredTicketPanelPayload);
}

export function parseTicketPanelStorage(
  payload: string,
): Pick<
  TicketPanelConfig,
  "ticketTypes" | "panelEmoji" | "panelTitle" | "panelDescription" | "panelFooter" | "panelColor"
> {
  const parsed = JSON.parse(payload) as unknown;

  if (Array.isArray(parsed)) {
    return {
      ticketTypes: parsed.map(normalizeStoredTicketType),
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
      panelColor: 0x57f287,
    };
  }

  if (isRecord(parsed) && Array.isArray(parsed.ticketTypes)) {
    return {
      ticketTypes: parsed.ticketTypes.map(normalizeStoredTicketType),
      panelEmoji: asStoredNullableString(parsed.panelEmoji),
      panelTitle: asStoredNullableString(parsed.panelTitle),
      panelDescription: asStoredNullableString(parsed.panelDescription),
      panelFooter: asStoredNullableString(parsed.panelFooter),
      panelColor: asStoredEmbedColor(parsed.panelColor, 0x57f287),
    };
  }

  throw new Error("Invalid stored ticket panel payload");
}

export function buildTicketCloseCustomId(channelId: string): string {
  return `${TICKET_CLOSE_CUSTOM_ID_PREFIX}${channelId}`;
}

export function buildTicketClaimCustomId(channelId: string): string {
  return `${TICKET_CLAIM_CUSTOM_ID_PREFIX}${channelId}`;
}

export function buildTicketCloseRequestCustomId(channelId: string): string {
  return `${TICKET_CLOSE_REQUEST_CUSTOM_ID_PREFIX}${channelId}`;
}

export function buildTicketCloseConfirmCustomId(channelId: string): string {
  return `${TICKET_CLOSE_CONFIRM_CUSTOM_ID_PREFIX}${channelId}`;
}

export function buildTicketCloseDeclineCustomId(channelId: string): string {
  return `${TICKET_CLOSE_DECLINE_CUSTOM_ID_PREFIX}${channelId}`;
}

export function buildTicketHistoryOpenCustomId(
  requesterUserId: string,
  targetUserId: string,
  excludeChannelId: string | null,
): string {
  return `${TICKET_HISTORY_OPEN_CUSTOM_ID_PREFIX}${requesterUserId}:${targetUserId}:${excludeChannelId ?? "~"}`;
}

export function buildTicketHistoryPageCustomId(
  requesterUserId: string,
  targetUserId: string,
  excludeChannelId: string | null,
  beforeOpenedAtMs: number,
): string {
  return `${TICKET_HISTORY_PAGE_CUSTOM_ID_PREFIX}${requesterUserId}:${targetUserId}:${excludeChannelId ?? "~"}:${beforeOpenedAtMs}`;
}

export function buildTicketHistoryPromptCustomId(
  targetUserId: string,
  ticketChannelId: string,
): string {
  return `${TICKET_HISTORY_PROMPT_CUSTOM_ID_PREFIX}${targetUserId}:${ticketChannelId}`;
}

export function buildTicketTemplateReplyCustomId(
  ticketChannelId: string,
  templateId: string,
  templateUpdatedAtMs: number,
): string {
  return `${TICKET_TEMPLATE_REPLY_CUSTOM_ID_PREFIX}${ticketChannelId}:${templateId}:${templateUpdatedAtMs}`;
}

export function parseTicketCustomId(customId: string):
  | { action: "open"; ticketTypeId: string; panelId?: string }
  | { action: "claim"; channelId: string }
  | { action: "close"; channelId: string }
  | { action: "close-request"; channelId: string }
  | { action: "close-confirm"; channelId: string }
  | { action: "close-decline"; channelId: string }
  | {
      action: "history-open";
      requesterUserId: string;
      targetUserId: string;
      excludeChannelId: string | null;
    }
  | {
      action: "history-page";
      requesterUserId: string;
      targetUserId: string;
      excludeChannelId: string | null;
      beforeOpenedAtMs: number;
    }
  | { action: "history-prompt"; targetUserId: string; ticketChannelId: string }
  | {
      action: "template-reply";
      ticketChannelId: string;
      templateId: string;
      templateUpdatedAtMs: number;
    }
  | null {
  if (customId.startsWith(TICKET_OPEN_CUSTOM_ID_PREFIX)) {
    const value = customId.slice(TICKET_OPEN_CUSTOM_ID_PREFIX.length);
    const separatorIndex = value.indexOf(":");
    if (separatorIndex > 0) {
      return {
        action: "open",
        panelId: value.slice(0, separatorIndex),
        ticketTypeId: value.slice(separatorIndex + 1),
      };
    }

    return {
      action: "open",
      ticketTypeId: value,
    };
  }

  if (customId.startsWith(TICKET_CLAIM_CUSTOM_ID_PREFIX)) {
    return {
      action: "claim",
      channelId: customId.slice(TICKET_CLAIM_CUSTOM_ID_PREFIX.length),
    };
  }

  if (customId.startsWith(TICKET_CLOSE_CUSTOM_ID_PREFIX)) {
    return {
      action: "close",
      channelId: customId.slice(TICKET_CLOSE_CUSTOM_ID_PREFIX.length),
    };
  }

  if (customId.startsWith(TICKET_CLOSE_REQUEST_CUSTOM_ID_PREFIX)) {
    return {
      action: "close-request",
      channelId: customId.slice(TICKET_CLOSE_REQUEST_CUSTOM_ID_PREFIX.length),
    };
  }

  if (customId.startsWith(TICKET_CLOSE_CONFIRM_CUSTOM_ID_PREFIX)) {
    return {
      action: "close-confirm",
      channelId: customId.slice(TICKET_CLOSE_CONFIRM_CUSTOM_ID_PREFIX.length),
    };
  }

  if (customId.startsWith(TICKET_CLOSE_DECLINE_CUSTOM_ID_PREFIX)) {
    return {
      action: "close-decline",
      channelId: customId.slice(TICKET_CLOSE_DECLINE_CUSTOM_ID_PREFIX.length),
    };
  }

  if (customId.startsWith(TICKET_HISTORY_OPEN_CUSTOM_ID_PREFIX)) {
    const [requesterUserId, targetUserId, excludeChannelId] = customId
      .slice(TICKET_HISTORY_OPEN_CUSTOM_ID_PREFIX.length)
      .split(":");
    if (requesterUserId && targetUserId && excludeChannelId) {
      return {
        action: "history-open",
        requesterUserId,
        targetUserId,
        excludeChannelId: excludeChannelId === "~" ? null : excludeChannelId,
      };
    }
  }

  if (customId.startsWith(TICKET_TEMPLATE_REPLY_CUSTOM_ID_PREFIX)) {
    const [ticketChannelId, templateId, updatedAt] = customId
      .slice(TICKET_TEMPLATE_REPLY_CUSTOM_ID_PREFIX.length)
      .split(":");
    const templateUpdatedAtMs = Number(updatedAt);
    if (ticketChannelId && templateId && Number.isSafeInteger(templateUpdatedAtMs)) {
      return { action: "template-reply", ticketChannelId, templateId, templateUpdatedAtMs };
    }
  }

  if (customId.startsWith(TICKET_HISTORY_PAGE_CUSTOM_ID_PREFIX)) {
    const [requesterUserId, targetUserId, excludeChannelId, cursor] = customId
      .slice(TICKET_HISTORY_PAGE_CUSTOM_ID_PREFIX.length)
      .split(":");
    const beforeOpenedAtMs = Number(cursor);
    if (
      requesterUserId &&
      targetUserId &&
      excludeChannelId &&
      Number.isSafeInteger(beforeOpenedAtMs) &&
      beforeOpenedAtMs > 0
    ) {
      return {
        action: "history-page",
        requesterUserId,
        targetUserId,
        excludeChannelId: excludeChannelId === "~" ? null : excludeChannelId,
        beforeOpenedAtMs,
      };
    }
  }

  if (customId.startsWith(TICKET_HISTORY_PROMPT_CUSTOM_ID_PREFIX)) {
    const [targetUserId, ticketChannelId] = customId
      .slice(TICKET_HISTORY_PROMPT_CUSTOM_ID_PREFIX.length)
      .split(":");
    if (targetUserId && ticketChannelId) {
      return { action: "history-prompt", targetUserId, ticketChannelId };
    }
  }

  return null;
}

export function buildTicketModalResponse(
  ticketType: TicketTypeConfig,
  panelId?: string,
): TicketModalResponse {
  return {
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id: buildTicketOpenCustomId(ticketType.id, panelId),
      title: ticketType.label,
      components: ticketType.questions.map((question) => ({
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [buildTicketTextInput(question)],
      })),
    },
  };
}

export function formatTicketNumber(ticketNumber: number): string {
  if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
    throw new Error("Ticket number must be a positive integer");
  }

  return String(ticketNumber).padStart(3, "0");
}

export function buildTicketChannelName(prefix: string, ticketNumber: number): string {
  const suffix = `-${formatTicketNumber(ticketNumber)}`;
  const normalizedPrefix = normalizeTicketChannelPrefix(prefix);
  const maxPrefixLength = Math.max(1, 100 - suffix.length);
  const trimmedPrefix = normalizedPrefix.slice(0, maxPrefixLength).replace(/-+$/g, "");
  return `${trimmedPrefix.length > 0 ? trimmedPrefix : "ticket"}${suffix}`;
}

export function generateTicketTranscriptAccessToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export const TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER = "__HAF_TICKET_TRANSCRIPT_ACCESS_TOKEN__";

export function hydrateTicketTranscriptAttachmentUrl(url: string, accessToken: string): string {
  return url.replaceAll(
    `/${TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER}/media/`,
    `/${encodeURIComponent(accessToken)}/media/`,
  );
}

export function hydrateTicketTranscriptHtmlAccessToken(html: string, accessToken: string): string {
  return html.replace(/\b(?:href|src)="[^"]*"/g, (attribute) =>
    hydrateTicketTranscriptAttachmentUrl(attribute, accessToken),
  );
}

export function buildTicketTranscriptStorageKey(
  guildId: string,
  channelId: string,
  accessToken: string,
): string {
  return `${guildId}/${channelId}/${accessToken}.html`;
}

export function buildTicketTranscriptAttachmentStorageKey(
  guildId: string,
  channelId: string,
  accessToken: string,
  attachmentId: string,
  filename: string,
): string {
  return `${guildId}/${channelId}/${accessToken}/attachments/${attachmentId}/${encodeURIComponent(filename)}`;
}

export function buildTicketTranscriptPath(
  guildId: string,
  channelId: string,
  accessToken: string,
): string {
  return `/transcripts/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(accessToken)}`;
}

export function buildTicketTranscriptAttachmentPath(
  guildId: string,
  channelId: string,
  accessToken: string,
  attachmentId: string,
  filename: string,
): string {
  return `${buildTicketTranscriptPath(guildId, channelId, accessToken)}/media/${encodeURIComponent(attachmentId)}/${encodeURIComponent(filename)}`;
}

export function extractTicketAnswersFromModal(
  interaction: TicketModalSubmitInteraction,
  questions: TicketQuestion[],
): Array<{ questionId: string; label: string; value: string }> {
  const valuesByCustomId = new Map<string, string>();

  for (const row of interaction.data?.components ?? []) {
    for (const component of row.components ?? []) {
      if (typeof component.custom_id === "string" && typeof component.value === "string") {
        valuesByCustomId.set(component.custom_id, component.value);
      }
    }
  }

  return questions.map((question) => ({
    questionId: question.id,
    label: question.label,
    value: valuesByCustomId.get(question.id) ?? "",
  }));
}

export function extractSteamId64FromTicketAnswer(value: string): string | null {
  const trimmedValue = value.trim();
  const directMatch = /^(7656119\d{10})$/.exec(trimmedValue);
  if (directMatch) {
    return directMatch[1];
  }

  const profileUrlMatch =
    /\bhttps?:\/\/steamcommunity\.com\/profiles\/(7656119\d{10})(?:[/?#\s]|$)/i.exec(trimmedValue);
  return profileUrlMatch?.[1] ?? null;
}

export function validateTicketAnswers(
  answers: Array<{ questionId: string; label: string; value: string }>,
  questions: TicketQuestion[],
): string | null {
  const answersByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));

  for (const question of questions) {
    if (question.validation !== "steamId") continue;
    const answer = answersByQuestionId.get(question.id);
    if (!answer || extractSteamId64FromTicketAnswer(answer.value) === null) {
      return "Please submit the ticket again with a valid SteamID64 or Steam profile URL.";
    }
  }

  return null;
}

export function renderTicketAutoReply(
  template: string,
  answers: TicketAnswer[],
  openerUserId: string,
  openedAtMs: number,
): string {
  const answerByQuestionId = new Map(answers.map((a) => [a.questionId, a.value]));
  const discordTimestamp = Math.floor(openedAtMs / 1000);

  return template
    .replace(/\{\{answer\.(\w+)\}\}/g, (_match, questionId) => {
      return answerByQuestionId.get(questionId) ?? _match;
    })
    .replace(/\{\{who\}\}/g, formatUserMention(openerUserId))
    .replace(/\{\{when\}\}/g, `<t:${discordTimestamp}:F>`);
}

export function selectMatchingResponseRules(
  rules: TicketResponseRule[],
  memberRoleIds: string[],
  options: {
    defaultTicketLinkPlatform?: TicketLinkPlatform | null;
    platformLinkedRoleIds?: Partial<Record<TicketLinkPlatform, string | null>>;
  } = {},
): TicketResponseRule[] {
  const memberRoleIdSet = new Set(memberRoleIds);
  return rules.filter((rule) =>
    rule.conditions.every((condition) => {
      if (condition.kind === "has-role") {
        return memberRoleIdSet.has(condition.roleId);
      }

      if (condition.kind === "lacks-platform-linked-role") {
        const platform = condition.platform ?? options.defaultTicketLinkPlatform ?? null;
        if (!platform) {
          return false;
        }
        const linkedRoleId = options.platformLinkedRoleIds?.[platform] ?? null;
        return linkedRoleId !== null && !memberRoleIdSet.has(linkedRoleId);
      }

      return !memberRoleIdSet.has(condition.roleId);
    }),
  );
}

export function renderTicketTranscript(
  instance: TicketInstance,
  messages: TicketTranscriptMessage[],
  participantEvents: TicketParticipantEvent[] = [],
): string {
  const lines: string[] = [];
  const sortedMessages = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs);

  lines.push("# Ticket Transcript");
  lines.push(`Guild: ${instance.guildId}`);
  lines.push(`Ticket Type: ${instance.ticketTypeLabel} (${instance.ticketTypeId})`);
  lines.push(`Channel: ${instance.channelId}`);
  lines.push(`Opened by: ${instance.openerUserId}`);
  lines.push(`Support Role: ${instance.supportRoleId ?? "Not configured"}`);
  lines.push(`Status: ${instance.status}`);
  lines.push(`Opened at: ${new Date(instance.openedAtMs).toISOString()}`);
  lines.push(
    `Closed at: ${instance.closedAtMs === null ? "Not closed" : new Date(instance.closedAtMs).toISOString()}`,
  );
  lines.push(`Closed by: ${instance.closedByUserId ?? "Not closed"}`);
  if (instance.answers.length > 0) {
    lines.push("");
    lines.push("## Answers");
    for (const answer of instance.answers) {
      lines.push(`- ${answer.label}: ${answer.value}`);
    }
  }
  if (participantEvents.length > 0) {
    lines.push("");
    lines.push("## Participant Access History");
    for (const event of participantEvents) {
      lines.push(
        `- ${new Date(event.createdAtMs).toISOString()} ${event.action}: ${event.targetUserId} (staff actor: ${event.actorUserId})`,
      );
    }
  }

  lines.push("");
  lines.push("## Messages");

  if (sortedMessages.length === 0) {
    lines.push("_No messages captured._");
  } else {
    for (const message of sortedMessages) {
      const author = message.authorTag ?? message.authorId;
      const content = message.content.length > 0 ? message.content : "[no text content]";
      lines.push(`[${new Date(message.createdAtMs).toISOString()}] ${author}: ${content}`);
      for (const attachment of message.attachments ?? []) {
        lines.push(formatTranscriptAttachmentTextLine(attachment));
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderTicketTranscriptHtml(
  instance: TicketInstance,
  messages: TicketTranscriptMessage[],
  options: TicketTranscriptPresentationOptions = {},
): string {
  const sortedMessages = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs);
  const answerSection =
    instance.answers.length === 0
      ? ""
      : `<section class="answers-section">
    <h2>Answers</h2>
    <ul class="answers">${instance.answers
      .map(
        (answer) =>
          `<li><span class="answer-label">${escapeHtml(answer.label)}</span> <span class="answer-value">${escapeHtml(answer.value)}</span></li>`,
      )
      .join("")}</ul>
  </section>`;
  const messageMarkup =
    sortedMessages.length === 0
      ? '<p class="empty"><em>No messages captured.</em></p>'
      : `<div class="messages">${sortedMessages
          .map((message) => renderTicketTranscriptMessage(message))
          .join("")}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticket Transcript ${escapeHtml(instance.channelId)}</title>
  <style>
    :root {
      color-scheme: dark;
      --discord-bg: #313338;
      --discord-bg-secondary: #2b2d31;
      --discord-bg-tertiary: #1e1f22;
      --discord-text-normal: #dbdee1;
      --discord-text-muted: #949ba4;
      --discord-text-link: #00a8fc;
      --discord-header-primary: #f2f3f5;
      --discord-header-secondary: #949ba4;
      --discord-interactive-normal: #b5bac1;
      --discord-interactive-hover: #dbdee1;
      --discord-channel-text-area-placeholder: #6d6f78;
      --discord-embed-background: #2b2d31;
      --discord-attachment-background: #232428;
      --discord-reply-bar: #4e5058;
      --discord-reply-bar-active: #c4c9ce;
      --discord-mention-background: rgba(88, 101, 242, 0.15);
      --discord-mention-foreground: #c9cdfb;
      --discord-status-online: #23a55a;
      --discord-font: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      --discord-radius: 8px;
      --discord-avatar-size: 40px;
      font-family: var(--discord-font);
      background: var(--discord-bg);
      color: var(--discord-text-normal);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      background: var(--discord-bg);
      color: var(--discord-text-normal);
      line-height: 1.375;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    h1, h2 {
      color: var(--discord-header-primary);
      margin: 0 0 16px;
      font-weight: 700;
    }
    h1 {
      font-size: 1.5rem;
    }
    h2 {
      font-size: 1.1rem;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--discord-header-secondary);
    }
    .meta-section {
      background: var(--discord-bg-secondary);
      border-radius: var(--discord-radius);
      padding: 16px 20px;
      margin-bottom: 24px;
    }
    .meta {
      display: grid;
      grid-template-columns: minmax(140px, 200px) 1fr;
      gap: 10px 16px;
      margin: 0;
    }
    .meta dt {
      font-weight: 600;
      color: var(--discord-header-secondary);
    }
    .meta dd {
      margin: 0;
      word-break: break-word;
      color: var(--discord-text-normal);
    }
    .answers-section {
      margin-bottom: 24px;
    }
    .answers {
      list-style: none;
      margin: 0;
      padding: 0;
      background: var(--discord-bg-secondary);
      border-radius: var(--discord-radius);
      padding: 12px 16px;
    }
    .answers li {
      padding: 8px 0;
      border-bottom: 1px solid var(--discord-bg-tertiary);
    }
    .answers li:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .answer-label {
      display: inline-block;
      font-weight: 600;
      color: var(--discord-header-secondary);
      margin-right: 8px;
    }
    .answer-value {
      color: var(--discord-text-normal);
      word-break: break-word;
    }
    .messages {
      background: var(--discord-bg-secondary);
      border-radius: var(--discord-radius);
      padding: 16px 0;
    }
    .message {
      display: grid;
      grid-template-columns: calc(var(--discord-avatar-size) + 16px) 1fr;
      padding: 2px 16px;
      position: relative;
    }
    .message:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    .message.has-reply {
      padding-top: 4px;
    }
    .message-avatar {
      width: var(--discord-avatar-size);
      height: var(--discord-avatar-size);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 600;
      font-size: 1rem;
      flex-shrink: 0;
      text-transform: uppercase;
      object-fit: cover;
    }
    .message-avatar-column {
      padding-top: 2px;
    }
    .message-author-id {
      color: var(--discord-text-muted);
      font-size: 0.75rem;
      flex-shrink: 0;
    }
    .message-reply-avatar {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      flex-shrink: 0;
      object-fit: cover;
    }
    .message-body {
      min-width: 0;
    }
    .message-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      height: 22px;
      margin-bottom: 2px;
    }
    .message-author {
      font-weight: 500;
      color: var(--discord-header-primary);
      font-size: 1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .message-time {
      color: var(--discord-text-muted);
      font-size: 0.75rem;
      flex-shrink: 0;
    }
    .message-content {
      color: var(--discord-text-normal);
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 1rem;
      line-height: 1.375;
    }
    .message-content:empty {
      display: none;
    }
    .message-reply {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      color: var(--discord-text-muted);
      font-size: 0.875rem;
      height: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .message-reply-bar {
      width: 32px;
      height: 12px;
      border-left: 2px solid var(--discord-reply-bar);
      border-top: 2px solid var(--discord-reply-bar);
      border-top-left-radius: 6px;
      flex-shrink: 0;
      margin-left: 4px;
    }
    .message-reply-author {
      color: var(--discord-text-muted);
      font-weight: 500;
      flex-shrink: 0;
    }
    .message-reply:hover .message-reply-author {
      color: var(--discord-text-normal);
    }
    .message-reply-content {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .empty {
      color: var(--discord-text-muted);
      padding: 0 16px;
      margin: 0;
    }
    .attachments {
      display: grid;
      gap: 4px;
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      max-width: 520px;
    }
    .attachment {
      overflow: hidden;
      border-radius: var(--discord-radius);
      background: var(--discord-attachment-background);
    }
    .attachment-preview {
      display: block;
      color: inherit;
      text-decoration: none;
    }
    .attachment img,
    .attachment video {
      display: block;
      max-width: 100%;
      background: #000;
    }
    .attachment img {
      width: auto;
      max-height: 480px;
    }
    .attachment video {
      width: 100%;
      max-height: 520px;
    }
    .attachment-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 10px;
      padding: 10px 12px;
      color: var(--discord-text-normal);
      font-size: 0.875rem;
    }
    .attachment-filename {
      color: var(--discord-header-primary);
      font-weight: 500;
    }
    .attachment-meta a {
      color: var(--discord-text-link);
      text-decoration: none;
    }
    .attachment-meta a:hover {
      text-decoration: underline;
    }
    @media (max-width: 640px) {
      main {
        padding: 20px 12px 32px;
      }
      .meta {
        grid-template-columns: 1fr;
      }
      .message {
        grid-template-columns: calc(var(--discord-avatar-size) + 12px) 1fr;
        padding: 2px 12px;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Ticket Transcript</h1>
    <section class="meta-section">
      <dl class="meta">
        <dt>Guild</dt><dd>${escapeHtml(formatTranscriptGuildLabel(instance, options))}</dd>
        <dt>Ticket Type</dt><dd>${escapeHtml(instance.ticketTypeLabel)} (${escapeHtml(instance.ticketTypeId)})</dd>
        <dt>Channel</dt><dd>${escapeHtml(formatTranscriptChannelLabel(instance, options))}</dd>
        <dt>Opened by</dt><dd>${escapeHtml(formatTranscriptIdentity(options.openerDisplayName, instance.openerUserId))}</dd>
        <dt>Support Role</dt><dd>${escapeHtml(instance.supportRoleId ?? "Not configured")}</dd>
        <dt>Status</dt><dd>${escapeHtml(instance.status)}</dd>
        <dt>Opened at</dt><dd>${escapeHtml(formatDiscordTranscriptTimestamp(instance.openedAtMs))}</dd>
        <dt>Closed at</dt><dd>${escapeHtml(instance.closedAtMs === null ? "Not closed" : formatDiscordTranscriptTimestamp(instance.closedAtMs))}</dd>
        <dt>Closed by</dt><dd>${escapeHtml(formatTranscriptIdentity(options.closerDisplayName, instance.closedByUserId))}</dd>
      </dl>
    </section>

    ${answerSection}

    <section class="messages-section">
      <h2>Messages</h2>
      ${messageMarkup}
    </section>
  </main>
</body>
</html>
`;
}

function renderTicketTranscriptMessage(message: TicketTranscriptMessage): string {
  const author = message.authorTag ?? message.authorId;
  const avatarMarkup = renderTicketTranscriptAvatar(message.authorAvatarUrl, author);
  const replyMarkup = message.replyTo
    ? renderTicketTranscriptReply(message.replyTo, message.replyToMessageId)
    : "";
  const contentMarkup =
    message.content.length > 0
      ? `<div class="message-content">${escapeHtml(message.content)}</div>`
      : "";
  const attachmentMarkup = renderTranscriptAttachments(message.attachments ?? []);
  const hasReplyClass = message.replyTo ? " has-reply" : "";

  return `<div class="message${hasReplyClass}" id="message-${escapeHtml(message.messageId ?? message.createdAtMs.toString())}">
  <div class="message-avatar-column">
    ${avatarMarkup}
  </div>
  <div class="message-body">
    ${replyMarkup}
    <div class="message-header">
      <span class="message-author">${escapeHtml(author)}</span>
      <span class="message-author-id">${escapeHtml(message.authorId)}</span>
      <time class="message-time" datetime="${new Date(message.createdAtMs).toISOString()}" title="${new Date(message.createdAtMs).toISOString()}">${formatDiscordTranscriptTimestamp(message.createdAtMs)}</time>
    </div>
    ${contentMarkup}
    ${attachmentMarkup}
  </div>
</div>`;
}

function renderTicketTranscriptAvatar(
  avatarUrl: string | null | undefined,
  author: string,
): string {
  if (avatarUrl) {
    const escapedUrl = escapeHtml(avatarUrl);
    const escapedAuthor = escapeHtml(author);
    return `<img class="message-avatar" src="${escapedUrl}" alt="${escapedAuthor}" title="${escapedAuthor}" loading="lazy" />`;
  }

  const avatarStyle = computeTranscriptAvatarStyle(author);
  return `<div class="message-avatar" style="background: ${avatarStyle.background};" title="${escapeHtml(author)}">${escapeHtml(avatarStyle.initials)}</div>`;
}

function renderTicketTranscriptReply(
  replyTo: NonNullable<TicketTranscriptMessage["replyTo"]>,
  replyToMessageId: string | null | undefined,
): string {
  const author = replyTo.authorTag ?? "Unknown User";
  const preview = truncateTranscriptReplyContent(replyTo.content);
  const messageAnchor = replyToMessageId ? ` href="#message-${escapeHtml(replyToMessageId)}"` : "";
  const avatarMarkup = replyTo.authorAvatarUrl
    ? `<img class="message-reply-avatar" src="${escapeHtml(replyTo.authorAvatarUrl)}" alt="" loading="lazy" />`
    : "";

  return `<a class="message-reply"${messageAnchor}>
    <span class="message-reply-bar"></span>
    ${avatarMarkup}
    <span class="message-reply-author">${escapeHtml(author)}</span>
    <span class="message-reply-content">${escapeHtml(preview)}</span>
  </a>`;
}

function truncateTranscriptReplyContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "[no text content]";
  }

  const singleLine = trimmed.replace(/\s+/g, " ");
  if (singleLine.length <= 80) {
    return singleLine;
  }

  return `${singleLine.slice(0, 80).trim()}…`;
}

function formatDiscordTranscriptTimestamp(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const dateDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (dateDayStart.getTime() === startOfToday.getTime()) {
    return `Today at ${time}`;
  }

  if (dateDayStart.getTime() === startOfYesterday.getTime()) {
    return `Yesterday at ${time}`;
  }

  return `${date.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" })} ${time}`;
}

function computeTranscriptAvatarStyle(author: string): { background: string; initials: string } {
  const colors = [
    "#5865f2",
    "#eb459e",
    "#3ba55d",
    "#f7b42c",
    "#ed4245",
    "#57f287",
    "#5865f2",
    "#99aab5",
  ];
  const colorIndex = [...author].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  const initials = author
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .slice(0, 2);

  return { background: colors[colorIndex] ?? colors[0], initials: initials || "?" };
}

export function buildTicketTranscriptSummaryEmbed(
  instance: TicketInstance,
  messages: TicketTranscriptMessage[],
  options: TicketTranscriptPresentationOptions = {},
  aiSummary?: { summary: string | null; keywords: string[] | null } | null,
): DiscordEmbed {
  const sortedMessages = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs);
  const participantLines = summarizeTranscriptParticipants(sortedMessages)
    .map((participant) => `${participant.messageCount} - ${participant.displayName}`)
    .join("\n");
  const attachmentCount = sortedMessages.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0,
  );
  const searchKeys = buildTicketTranscriptSearchKeys(instance);
  const fields = [
    {
      name: "Server",
      value: truncateDiscordFieldValue(formatTranscriptGuildLabel(instance, options)),
      inline: false,
    },
    {
      name: "Channel",
      value: truncateDiscordFieldValue(formatTranscriptChannelLabel(instance, options)),
      inline: false,
    },
    {
      name: "Type",
      value: truncateDiscordFieldValue(`${instance.ticketTypeLabel} (${instance.ticketTypeId})`),
      inline: false,
    },
    {
      name: "Messages",
      value: String(sortedMessages.length),
      inline: false,
    },
    ...(attachmentCount > 0
      ? [
          {
            name: "Attachments",
            value: String(attachmentCount),
            inline: false,
          },
        ]
      : []),
    ...(searchKeys.length > 0
      ? [
          {
            name: "Search keys",
            value: truncateDiscordFieldValue(searchKeys.join(" ")),
            inline: false,
          },
        ]
      : []),
    {
      name: "Ticket Owner",
      value: truncateDiscordFieldValue(formatStaffUserReference(instance.openerUserId)),
      inline: false,
    },
    ...instance.answers
      .filter((answer) => answer.value.trim().length > 0)
      .map((answer) => ({
        name: truncateDiscordFieldName(answer.label),
        value: truncateDiscordFieldValue(answer.value),
        inline: false,
      })),
    ...(participantLines.length > 0
      ? [
          {
            name: "Users in transcript",
            value: truncateDiscordFieldValue(participantLines),
            inline: false,
          },
        ]
      : []),
    ...(aiSummary?.keywords
      ? [
          {
            name: "AI Keywords",
            value: truncateDiscordFieldValue(aiSummary.keywords.join(", ")),
            inline: false,
          },
        ]
      : []),
    {
      name: "Closed by",
      value: truncateDiscordFieldValue(formatStaffTranscriptIdentity(instance.closedByUserId)),
      inline: false,
    },
  ].slice(0, 25);

  return buildAuditEmbed({
    title: "Ticket Transcript",
    description: aiSummary?.summary ?? undefined,
    color: 5_763_719,
    fields,
    timestamp: new Date(instance.closedAtMs ?? instance.openedAtMs).toISOString(),
  });
}

function renderTranscriptAttachments(attachments: TicketTranscriptAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  return `<ul class="attachments">${attachments.map(renderTranscriptAttachment).join("")}</ul>`;
}

function renderTranscriptAttachment(attachment: TicketTranscriptAttachment): string {
  const safeUrl = getSafeAttachmentUrl(attachment);
  const filename = attachment.filename.trim().length > 0 ? attachment.filename : "attachment";
  const escapedFilename = escapeHtml(filename);
  const details = formatTranscriptAttachmentDetails(attachment);
  const detailMarkup = details.length > 0 ? `<span>${escapeHtml(details)}</span>` : "";
  const kind = getTranscriptAttachmentKind(attachment);
  const previewMarkup = safeUrl ? renderTranscriptAttachmentPreview(attachment, safeUrl, kind) : "";
  const linkMarkup = safeUrl
    ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">Open attachment</a>`
    : "<span>Attachment URL unavailable</span>";

  return `<li class="attachment attachment-${kind}">
  ${previewMarkup}
  <div class="attachment-meta">
    <span class="attachment-filename">${escapedFilename}</span>
    <span>${formatTranscriptAttachmentKind(kind)}</span>
    ${detailMarkup}
    ${linkMarkup}
  </div>
</li>`;
}

function renderTranscriptAttachmentPreview(
  attachment: TicketTranscriptAttachment,
  safeUrl: string,
  kind: TranscriptAttachmentKind,
): string {
  const escapedUrl = escapeHtml(safeUrl);
  const escapedFilename = escapeHtml(
    attachment.filename.trim().length > 0 ? attachment.filename : "attachment",
  );

  if (kind === "image") {
    return `<a class="attachment-preview" href="${escapedUrl}" target="_blank" rel="noopener noreferrer"><img src="${escapedUrl}" alt="${escapedFilename}" loading="lazy" /></a>`;
  }

  if (kind === "video") {
    const contentType = attachment.contentType
      ? ` type="${escapeHtml(attachment.contentType)}"`
      : "";
    return `<video controls preload="metadata"><source src="${escapedUrl}"${contentType} /></video>`;
  }

  return "";
}

function formatTranscriptAttachmentTextLine(attachment: TicketTranscriptAttachment): string {
  const kind = getTranscriptAttachmentKind(attachment);
  const filename = attachment.filename.trim().length > 0 ? attachment.filename : "attachment";
  const details = formatTranscriptAttachmentDetails(attachment);
  const safeUrl = getSafeAttachmentUrl(attachment);
  return `  ${formatTranscriptAttachmentKind(kind)}: ${filename}${details ? ` (${details})` : ""}${safeUrl ? ` - ${safeUrl}` : " - URL unavailable"}`;
}

type TranscriptAttachmentKind = "image" | "video" | "file";

function getTranscriptAttachmentKind(
  attachment: TicketTranscriptAttachment,
): TranscriptAttachmentKind {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return "image";
  }

  if (contentType.startsWith("video/")) {
    return "video";
  }

  const filename = attachment.filename.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/.test(filename)) {
    return "image";
  }

  if (/\.(mp4|webm|mov|m4v|ogg|ogv)$/.test(filename)) {
    return "video";
  }

  return "file";
}

function formatTranscriptAttachmentKind(kind: TranscriptAttachmentKind): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "file":
    default:
      return "Attachment";
  }
}

function formatTranscriptAttachmentDetails(attachment: TicketTranscriptAttachment): string {
  return [attachment.contentType, formatBytes(attachment.size)]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(", ");
}

function formatBytes(size: number | null): string | null {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return null;
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      const formatted =
        value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
      return `${formatted} ${unit}`;
    }
    value /= 1024;
  }

  return null;
}

function getSafeAttachmentUrl(attachment: TicketTranscriptAttachment): string | null {
  try {
    const parsedUrl = new URL(attachment.url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function buildTicketTextInput(question: TicketQuestion) {
  return {
    type: DISCORD_TEXT_INPUT_COMPONENT as typeof DISCORD_TEXT_INPUT_COMPONENT,
    custom_id: question.id,
    label: question.label,
    style: question.style === "paragraph" ? (2 as const) : (1 as const),
    placeholder: question.placeholder ?? undefined,
    required: question.required,
  };
}

function formatTranscriptGuildLabel(
  instance: TicketInstance,
  options: TicketTranscriptPresentationOptions,
): string {
  if (options.guildName && options.guildName !== instance.guildId) {
    return `${options.guildName} (${instance.guildId})`;
  }

  return instance.guildId;
}

function formatTranscriptChannelLabel(
  instance: TicketInstance,
  options: TicketTranscriptPresentationOptions,
): string {
  if (options.channelName && options.channelName !== instance.channelId) {
    return `#${options.channelName} (${instance.channelId})`;
  }

  return instance.channelId;
}

function formatTranscriptIdentity(
  displayName: string | null | undefined,
  userId: string | null,
): string {
  if (!userId) {
    return "Not closed";
  }

  if (displayName && displayName !== userId) {
    return `${displayName} (${userId})`;
  }

  return displayName ?? userId;
}

function formatStaffTranscriptIdentity(userId: string | null): string {
  return userId ? formatStaffUserReference(userId) : "Not closed";
}

function summarizeTranscriptParticipants(messages: TicketTranscriptMessage[]): Array<{
  authorId: string;
  displayName: string;
  messageCount: number;
}> {
  const participants = new Map<string, { displayName: string; messageCount: number }>();

  for (const message of messages) {
    const existing = participants.get(message.authorId);
    const displayName = message.authorTag ?? message.authorId;
    if (existing) {
      existing.messageCount += 1;
      continue;
    }

    participants.set(message.authorId, {
      displayName,
      messageCount: 1,
    });
  }

  return [...participants.entries()]
    .map(([authorId, participant]) => ({ authorId, ...participant }))
    .sort(
      (left, right) =>
        right.messageCount - left.messageCount || left.displayName.localeCompare(right.displayName),
    );
}

function buildTicketTranscriptSearchKeys(instance: TicketInstance): string[] {
  const keys = new Set<string>([`discord:${instance.openerUserId}`]);

  for (const answer of instance.answers) {
    const normalizedKey = canonicalizeSearchKey(
      normalizeSearchKey(answer.questionId || answer.label),
    );
    const normalizedValue = answer.value.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }

    if (!/^(discord|steam|steam64|userid|id)$/.test(normalizedKey)) {
      continue;
    }

    if (/\s/.test(normalizedValue)) {
      continue;
    }

    keys.add(`${normalizedKey}:${normalizedValue}`);
  }

  return [...keys];
}

function normalizeSearchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalizeSearchKey(value: string): string {
  if (value.includes("discord")) {
    return "discord";
  }

  if (value.includes("steam64")) {
    return "steam64";
  }

  if (value.includes("steam")) {
    return "steam";
  }

  if (value === "userid64") {
    return "userid";
  }

  return value;
}

function truncateDiscordFieldName(value: string): string {
  return value.length <= 256 ? value : `${value.slice(0, 253)}...`;
}

function truncateDiscordFieldValue(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1021)}...`;
}

function normalizeStoredTicketType(value: unknown): TicketTypeConfig {
  const ticketType = value as TicketTypeConfig & {
    autoReplyEnabled?: unknown;
    responseRules?: unknown;
    anonymousEnabled?: unknown;
    anonymousSupportEnabled?: unknown;
    staffDiscussionThreadEnabled?: unknown;
    ticketHistoryPromptVisibility?: unknown;
    participantManagementEnabled?: unknown;
    limitExclusion?: unknown;
    mentionSupportRole?: unknown;
    allowedCreatorRoleIds?: unknown;
    defaultTicketLinkPlatform?: unknown;
  };
  const autoReplyMessage = asStoredNullableString(ticketType.autoReplyMessage);
  const responseRules =
    normalizeStoredTicketResponseRules(ticketType.responseRules) ??
    synthesizeLegacyResponseRules(ticketType.autoReplyEnabled, autoReplyMessage);

  return {
    ...ticketType,
    allowedCreatorRoleIds: Array.isArray(ticketType.allowedCreatorRoleIds)
      ? ticketType.allowedCreatorRoleIds.filter(
          (roleId): roleId is string => typeof roleId === "string" && roleId.length > 0,
        )
      : [],
    autoReplyEnabled:
      typeof ticketType.autoReplyEnabled === "boolean"
        ? ticketType.autoReplyEnabled
        : autoReplyMessage !== null,
    autoReplyMessage,
    responseRules,
    ...("defaultTicketLinkPlatform" in ticketType
      ? {
          defaultTicketLinkPlatform: isTicketLinkPlatform(ticketType.defaultTicketLinkPlatform)
            ? ticketType.defaultTicketLinkPlatform
            : null,
        }
      : {}),
    anonymousEnabled:
      typeof ticketType.anonymousEnabled === "boolean" ? ticketType.anonymousEnabled : false,
    anonymousSupportEnabled:
      typeof ticketType.anonymousSupportEnabled === "boolean"
        ? ticketType.anonymousSupportEnabled
        : typeof ticketType.anonymousEnabled === "boolean"
          ? ticketType.anonymousEnabled
          : false,
    staffDiscussionThreadEnabled:
      typeof ticketType.staffDiscussionThreadEnabled === "boolean"
        ? ticketType.staffDiscussionThreadEnabled
        : typeof ticketType.anonymousEnabled === "boolean"
          ? ticketType.anonymousEnabled
          : false,
    ticketHistoryPromptVisibility:
      ticketType.ticketHistoryPromptVisibility === "staff-thread" ? "staff-thread" : "off",
    participantManagementEnabled:
      typeof ticketType.participantManagementEnabled === "boolean"
        ? ticketType.participantManagementEnabled
        : false,
    limitExclusion:
      typeof ticketType.limitExclusion === "boolean" ? ticketType.limitExclusion : false,
    mentionSupportRole:
      typeof ticketType.mentionSupportRole === "boolean" ? ticketType.mentionSupportRole : false,
  };
}

function normalizeStoredTicketResponseRules(value: unknown): TicketResponseRule[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const rules: TicketResponseRule[] = [];

  value.forEach((rawRule, index) => {
    if (!isRecord(rawRule)) {
      return;
    }

    const message = asStoredNullableString(rawRule.message);
    if (message === null) {
      return;
    }

    const conditions = Array.isArray(rawRule.conditions)
      ? rawRule.conditions.flatMap((condition) => {
          const normalizedCondition = normalizeStoredTicketResponseCondition(condition);
          return normalizedCondition ? [normalizedCondition] : [];
        })
      : [];

    rules.push({
      id:
        typeof rawRule.id === "string" && rawRule.id.trim().length > 0
          ? rawRule.id
          : `rule-${index + 1}`,
      conditions,
      message,
    });
  });

  return rules;
}

function normalizeStoredTicketResponseCondition(value: unknown): TicketResponseCondition | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === "lacks-platform-linked-role") {
    return {
      kind: "lacks-platform-linked-role",
      ...(isTicketLinkPlatform(value.platform) ? { platform: value.platform } : {}),
    };
  }

  if (typeof value.roleId !== "string" || value.roleId.trim().length === 0) {
    return null;
  }

  if (value.kind !== "has-role" && value.kind !== "lacks-role") {
    return null;
  }

  return {
    kind: value.kind,
    roleId: value.roleId,
  };
}

function isTicketLinkPlatform(value: unknown): value is TicketLinkPlatform {
  return value === "steam" || value === "xbox" || value === "playstation";
}

function synthesizeLegacyResponseRules(
  autoReplyEnabled: unknown,
  autoReplyMessage: string | null,
): TicketResponseRule[] {
  if (autoReplyEnabled === false || autoReplyMessage === null) {
    return [];
  }

  return [
    {
      id: "legacy-auto-reply",
      conditions: [],
      message: autoReplyMessage,
    },
  ];
}

function asStoredNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asStoredEmbedColor(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? value
    : fallback;
}

function normalizeTicketChannelPrefix(prefix: string): string {
  return (
    prefix
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "ticket"
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
