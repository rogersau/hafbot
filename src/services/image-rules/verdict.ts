import { isRecord } from "../../unknown-parse";

const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export type ImageRulesVerdict = "on-topic" | "off-topic" | "uncertain";

export interface ClassifiableImage {
  id: string;
  url: string;
  proxyUrl?: string;
  contentType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}

export function verdictFromConfidences(
  confidences: { off_topic_confidence: number; on_topic_confidence: number },
  thresholds: { autoDeleteThreshold: number; modReviewThreshold: number },
): ImageRulesVerdict {
  if (confidences.off_topic_confidence >= thresholds.autoDeleteThreshold) {
    return "off-topic";
  }
  if (confidences.off_topic_confidence >= thresholds.modReviewThreshold) {
    return "uncertain";
  }
  return "on-topic";
}

export function worstVerdictOf(verdicts: ImageRulesVerdict[]): ImageRulesVerdict {
  if (verdicts.length === 0) {
    return "on-topic";
  }
  if (verdicts.some((verdict) => verdict === "off-topic")) {
    return "off-topic";
  }
  if (verdicts.some((verdict) => verdict === "uncertain")) {
    return "uncertain";
  }
  return "on-topic";
}

export function selectImagesForClassification(
  attachments: unknown[],
  constraints: { maxBytes: number; maxDimension: number },
): ClassifiableImage[] {
  const selected: ClassifiableImage[] = [];

  for (const attachment of attachments) {
    const image = asClassifiableImage(attachment);
    if (!image) continue;
    if (image.sizeBytes > constraints.maxBytes) continue;
    if (image.width !== undefined && image.width > constraints.maxDimension) continue;
    if (image.height !== undefined && image.height > constraints.maxDimension) continue;
    selected.push(image);
  }

  return selected;
}

function asClassifiableImage(attachment: unknown): ClassifiableImage | null {
  if (!isRecord(attachment)) {
    return null;
  }

  const record = attachment as Record<string, unknown>;

  const id = normalizeString(record.id);
  const url = normalizeString(record.url);
  const contentType = normalizeString(record.content_type ?? record.contentType);
  const sizeBytes = normalizeNumber(record.size ?? record.sizeBytes);

  if (!id || !url || !contentType || sizeBytes === undefined) {
    return null;
  }

  if (!contentType.startsWith("image/") || !SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType)) {
    return null;
  }

  const proxyUrl = normalizeOptionalString(record.proxy_url ?? record.proxyUrl);
  const width = normalizeOptionalNumber(record.width);
  const height = normalizeOptionalNumber(record.height);

  return {
    id,
    url,
    ...(proxyUrl !== undefined && { proxyUrl }),
    contentType,
    sizeBytes,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeNumber(value);
}
