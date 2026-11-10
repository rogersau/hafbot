import type { Env } from "../../env";

type ImageRulesEnvInput = Pick<
  Env,
  | "IMAGE_RULES_API_BASE_URL"
  | "IMAGE_RULES_API_KEY"
  | "IMAGE_RULES_MODEL"
  | "IMAGE_RULES_MAX_IMAGE_BYTES"
  | "IMAGE_RULES_MAX_IMAGE_DIMENSION"
  | "IMAGE_RULES_TIMEOUT_MS"
  | "IMAGE_RULES_MAX_RETRIES"
>;

export interface ImageRulesClassifierEnv {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxImageBytes: number;
  maxImageDimension: number;
  timeoutMs: number;
  maxRetries: number;
}

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_IMAGE_BYTES = 20_971_520;
const DEFAULT_MAX_IMAGE_DIMENSION = 4096;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 1;

export function parseImageRulesEnv(env: ImageRulesEnvInput): ImageRulesClassifierEnv | undefined {
  const apiBaseUrl = normalizeOptionalString(env.IMAGE_RULES_API_BASE_URL);
  const apiKey = normalizeOptionalString(env.IMAGE_RULES_API_KEY);
  if (!apiBaseUrl || !apiKey) {
    return undefined;
  }

  return {
    apiBaseUrl,
    apiKey,
    model: normalizeOptionalString(env.IMAGE_RULES_MODEL) ?? DEFAULT_MODEL,
    maxImageBytes: parsePositiveNumber(env.IMAGE_RULES_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
    maxImageDimension: parsePositiveNumber(
      env.IMAGE_RULES_MAX_IMAGE_DIMENSION,
      DEFAULT_MAX_IMAGE_DIMENSION,
    ),
    timeoutMs: parsePositiveNumber(env.IMAGE_RULES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: parseNonNegativeInteger(env.IMAGE_RULES_MAX_RETRIES, DEFAULT_MAX_RETRIES),
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

function parseNonNegativeInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : defaultValue;
  }
  if (typeof value !== "string") {
    return defaultValue;
  }

  const normalized = value.trim();
  if (!normalized) {
    return defaultValue;
  }

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}
