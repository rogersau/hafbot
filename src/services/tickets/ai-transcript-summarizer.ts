import type { TicketTranscriptMessage } from "../../tickets";
import { isRecord } from "../../unknown-parse";
import type { AiTranscriptSummarizerEnv } from "./ai-transcript-summarizer-env";

export interface AiTranscriptSummary {
  summary: string | null;
  keywords: string[] | null;
}

export interface SummarizeTicketInput {
  ticketTypeLabel: string;
  ticketTypeId: string;
  answers: Array<{ label: string; value: string }>;
  messages: TicketTranscriptMessage[];
  closerDisplayName: string | null;
}

export type SummarizerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const SYSTEM_PROMPT = `You are a support transcript summarizer for a Discord community.

Summarize the closed ticket conversation in one or two neutral, operational sentences describing what the member needed, what staff did or decided, and the apparent outcome when present. Do not invent resolution details that are not in the transcript.

Also provide up to five topic/action keywords or short phrases that make the ticket easier to search. Keywords should describe the subject, not list usernames or Discord IDs unless a specific user is central to the subject.

Respond with ONLY a JSON object in this exact format:
{"summary": string | null, "keywords": string[] | null}

Set a field to null if you cannot produce a valid value for it. Do not include any other text, explanation, or markdown formatting.`;

const MAX_MESSAGES_INCLUDED = 40;
const MAX_KEYWORDS = 5;
const MAX_KEYWORD_LENGTH = 60;

export async function summarizeTicket(
  input: SummarizeTicketInput,
  env: AiTranscriptSummarizerEnv | undefined,
  fetchImpl: SummarizerFetch = globalThis.fetch,
): Promise<AiTranscriptSummary | null> {
  if (!env) {
    return null;
  }

  if (!hasMeaningfulTranscriptContent(input)) {
    console.info("[ai-transcript-summarizer] Skipped: transcript has no meaningful content");
    return null;
  }

  const url = `${env.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: env.model,
    reasoning_effort: "medium",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildTranscriptPrompt(input) },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), env.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(
        `[ai-transcript-summarizer] AI provider returned non-OK response: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = (await response.json()) as unknown;
    const summary = parseSummaryResponse(data);
    if (!summary) {
      console.error("[ai-transcript-summarizer] Failed to parse AI response content");
    }
    return summary;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[ai-transcript-summarizer] AI provider request failed", error);
    return null;
  }
}

function hasMeaningfulTranscriptContent(input: SummarizeTicketInput): boolean {
  for (const message of input.messages) {
    if (message.content.trim().length > 0) {
      return true;
    }
    if (message.attachments && message.attachments.length > 0) {
      return true;
    }
  }
  return false;
}

function buildTranscriptPrompt(input: SummarizeTicketInput): string {
  const lines: string[] = [];
  lines.push(`Ticket Type: ${input.ticketTypeLabel} (${input.ticketTypeId})`);

  const meaningfulAnswers = input.answers.filter((answer) => answer.value.trim().length > 0);
  if (meaningfulAnswers.length > 0) {
    lines.push("");
    lines.push("Opening Answers:");
    for (const answer of meaningfulAnswers) {
      lines.push(`- ${answer.label}: ${answer.value}`);
    }
  }

  const selectedMessages = selectMessagesForPrompt(input.messages);
  if (selectedMessages.omittedCount > 0) {
    lines.push("");
    lines.push(
      `Note: ${selectedMessages.omittedCount} middle messages were omitted to fit context.`,
    );
  }

  lines.push("");
  lines.push("Conversation:");
  for (const message of selectedMessages.messages) {
    lines.push(formatMessageForPrompt(message));
  }

  return lines.join("\n");
}

function selectMessagesForPrompt(messages: TicketTranscriptMessage[]): {
  messages: TicketTranscriptMessage[];
  omittedCount: number;
} {
  const sorted = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs);
  if (sorted.length <= MAX_MESSAGES_INCLUDED) {
    return { messages: sorted, omittedCount: 0 };
  }

  const headCount = Math.ceil(MAX_MESSAGES_INCLUDED / 2);
  const tailCount = Math.floor(MAX_MESSAGES_INCLUDED / 2);
  const head = sorted.slice(0, headCount);
  const tail = sorted.slice(sorted.length - tailCount);
  return {
    messages: [...head, ...tail],
    omittedCount: sorted.length - headCount - tailCount,
  };
}

function formatMessageForPrompt(message: TicketTranscriptMessage): string {
  const parts: string[] = [];
  parts.push(`[${message.authorTag ?? message.authorId}]`);
  if (message.content.trim().length > 0) {
    parts.push(message.content);
  }
  if (message.attachments && message.attachments.length > 0) {
    const attachmentLabels = message.attachments
      .map(
        (attachment) =>
          `${attachment.filename}${attachment.contentType ? ` (${attachment.contentType})` : ""}`,
      )
      .join(", ");
    parts.push(`[attachments: ${attachmentLabels}]`);
  }
  return parts.join(" ");
}

function parseSummaryResponse(data: unknown): AiTranscriptSummary | null {
  if (!isRecord(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return null;
  }

  const message = (firstChoice as Record<string, unknown>).message;
  if (!isRecord(message)) {
    return null;
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(content));
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const summary = normalizeSummary(parsedRecord.summary);
  const keywords = normalizeKeywords(parsedRecord.keywords);

  if (summary === null && keywords === null) {
    return null;
  }

  return { summary, keywords };
}

function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function normalizeSummary(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKeywords(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const keywords = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0 && item.length <= MAX_KEYWORD_LENGTH)
    .slice(0, MAX_KEYWORDS);
  return keywords.length > 0 ? keywords : null;
}
