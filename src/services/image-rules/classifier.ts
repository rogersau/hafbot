import type { ImageRulesClassifierEnv } from "./env";
import { isRecord } from "../../unknown-parse";

export type ClassifierFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ClassifyImageError =
  | { error: "timeout" }
  | { error: "5xx" }
  | { error: "rate_limited" }
  | { error: "parse_error" };

export interface ImageRulesConfidences {
  image_description: string;
  classification_reason: string;
  off_topic_confidence: number;
  on_topic_confidence: number;
}

const IMAGE_RULES_SYSTEM_PROMPT = `You are an image content classifier for a Discord community.

Determine whether the provided image is on-topic or off-topic for this community.

Topic description: {topicDescription}

Be conservative about deleting content. The off_topic_confidence is the probability that
the image is clearly outside the topic, not the inverse of a perfect match.

Guidelines:
- If the image could reasonably match the topic, give it the benefit of the doubt.
- Only use off_topic_confidence >= 0.85 when there is no reasonable interpretation where the image matches the topic.
- If the topic mentions screenshots, treat screen captures as potentially on-topic even when they include desktop UI, taskbars, icons, application windows, wallpaper, or other surrounding screen context.
- If the topic is broad or ambiguous, prefer uncertain/lower off-topic confidence over high-confidence deletion.

Respond with ONLY a JSON object in this exact format:
{"image_description": string, "classification_reason": string, "off_topic_confidence": number, "on_topic_confidence": number}

The two numbers must be non-negative and sum to exactly 1.0.
image_description should briefly state what is visible in the image.
classification_reason should briefly explain why it matches or does not match the topic.
Do not include any other text, explanation, or markdown formatting.`;

function buildClassifierPrompt(topicDescription: string): string {
  return IMAGE_RULES_SYSTEM_PROMPT.replace("{topicDescription}", topicDescription);
}

export async function classifyImage(
  options: { imageUrl: string; topicDescription: string; env: ImageRulesClassifierEnv },
  fetchImpl: ClassifierFetch = globalThis.fetch,
): Promise<ImageRulesConfidences | ClassifyImageError> {
  const { imageUrl, topicDescription, env } = options;
  const url = `${env.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: env.model,
    reasoning_effort: "medium",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildClassifierPrompt(topicDescription) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  let lastError: ClassifyImageError | undefined;
  const maxAttempts = env.maxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      if (response.status === 429) {
        return { error: "rate_limited" };
      }

      if (response.status >= 500) {
        lastError = { error: "5xx" };
        continue;
      }

      if (!response.ok) {
        return { error: "parse_error" };
      }

      const data = (await response.json()) as unknown;
      const confidences = parseConfidences(data);
      if (!confidences) {
        return { error: "parse_error" };
      }

      return confidences;
    } catch (error) {
      clearTimeout(timeoutId);
      if (isAbortError(error)) {
        lastError = { error: "timeout" };
        continue;
      }
      return { error: "parse_error" };
    }
  }

  return lastError ?? { error: "parse_error" };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError";
  }
  return false;
}

function parseConfidences(data: unknown): ImageRulesConfidences | null {
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

  const stripped = stripMarkdownFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const imageDescription = normalizeText(parsedRecord.image_description);
  const classificationReason = normalizeText(parsedRecord.classification_reason);
  const offTopic = normalizeConfidence(parsedRecord.off_topic_confidence);
  const onTopic = normalizeConfidence(parsedRecord.on_topic_confidence);

  if (
    !imageDescription ||
    !classificationReason ||
    offTopic === undefined ||
    onTopic === undefined
  ) {
    return null;
  }

  const sum = offTopic + onTopic;
  if (sum < 0.99 || sum > 1.01) {
    return null;
  }

  return {
    image_description: imageDescription,
    classification_reason: classificationReason,
    off_topic_confidence: offTopic,
    on_topic_confidence: onTopic,
  };
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}
