import type { Env } from "../../env";

type AiTranscriptSummarizerEnvInput = Pick<
  Env,
  | "IMAGE_RULES_API_BASE_URL"
  | "IMAGE_RULES_API_KEY"
  | "TRANSCRIPT_AI_API_BASE_URL"
  | "TRANSCRIPT_AI_API_KEY"
  | "TRANSCRIPT_AI_MODEL"
  | "TRANSCRIPT_AI_TIMEOUT_MS"
>;

export interface AiTranscriptSummarizerEnv {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 10_000;

export function parseAiTranscriptSummarizerEnv(
  env: AiTranscriptSummarizerEnvInput,
): AiTranscriptSummarizerEnv | undefined {
  const apiBaseUrl =
    normalizeOptionalString(env.TRANSCRIPT_AI_API_BASE_URL) ??
    normalizeOptionalString(env.IMAGE_RULES_API_BASE_URL);
  const apiKey =
    normalizeOptionalString(env.TRANSCRIPT_AI_API_KEY) ??
    normalizeOptionalString(env.IMAGE_RULES_API_KEY);
  if (!apiBaseUrl || !apiKey) {
    return undefined;
  }

  return {
    apiBaseUrl,
    apiKey,
    model: normalizeOptionalString(env.TRANSCRIPT_AI_MODEL) ?? DEFAULT_MODEL,
    timeoutMs: parsePositiveNumber(env.TRANSCRIPT_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parsePositiveNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
  }
  if (typeof value !== "string") {
    return defaultValue;
  }

  const normalized = value.trim();
  if (!normalized) {
    return defaultValue;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
