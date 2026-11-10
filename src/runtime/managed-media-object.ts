import { buildManagedMediaStorageKey } from "../managed-media";

export const PUBLIC_MANAGED_MEDIA_METADATA = Object.freeze({
  visibility: "public",
  contentClass: "managed-message-media",
});

// Frozen at the commit that introduced explicit Managed Media classification so
// newly written metadata-free objects can never become public via compatibility.
const LEGACY_PUBLIC_MEDIA_CREATED_BEFORE_MS = Date.parse("2026-08-15T00:00:00Z");

interface ManagedMediaObjectClassification {
  key: string;
  metadata: Readonly<Record<string, string>>;
  uploadedAt: Date | null;
}

export function isPublicManagedMediaObject(input: ManagedMediaObjectClassification): boolean {
  if (!isManagedMediaStorageKey(input.key)) return false;
  const visibility = input.metadata.visibility;
  const contentClass = input.metadata.contentClass;
  if (visibility === undefined && contentClass === undefined) {
    return isLegacyPublicManagedMediaObject(input);
  }
  return (
    visibility === PUBLIC_MANAGED_MEDIA_METADATA.visibility &&
    contentClass === PUBLIC_MANAGED_MEDIA_METADATA.contentClass
  );
}

export function normalizeLegacyPublicManagedMediaMetadata(
  input: ManagedMediaObjectClassification,
): Record<string, string> {
  if (!isLegacyPublicManagedMediaObject(input)) return { ...input.metadata };
  return { ...input.metadata, ...PUBLIC_MANAGED_MEDIA_METADATA };
}

function isLegacyPublicManagedMediaObject(input: ManagedMediaObjectClassification): boolean {
  const uploadedAtMs = input.uploadedAt?.getTime();
  if (
    input.metadata.visibility !== undefined ||
    input.metadata.contentClass !== undefined ||
    uploadedAtMs === undefined ||
    !Number.isFinite(uploadedAtMs) ||
    uploadedAtMs >= LEGACY_PUBLIC_MEDIA_CREATED_BEFORE_MS ||
    !isManagedMediaStorageKey(input.key)
  ) {
    return false;
  }
  return true;
}

function isManagedMediaStorageKey(key: string): boolean {
  const segments = key.split("/");
  if (segments.length !== 3 || segments[1] !== "managed-media") return false;
  try {
    return buildManagedMediaStorageKey(segments[0] ?? "", segments[2] ?? "") === key;
  } catch {
    return false;
  }
}
