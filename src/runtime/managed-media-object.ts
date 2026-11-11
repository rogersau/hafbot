import { buildManagedMediaStorageKey } from "../managed-media";

export const PUBLIC_MANAGED_MEDIA_METADATA = Object.freeze({
  visibility: "public",
  contentClass: "managed-message-media",
});

interface ManagedMediaObjectClassification {
  key: string;
  metadata: Readonly<Record<string, string>>;
  uploadedAt: Date | null;
}

export function isPublicManagedMediaObject(input: ManagedMediaObjectClassification): boolean {
  if (!isManagedMediaStorageKey(input.key)) return false;
  const visibility = input.metadata.visibility;
  const contentClass = input.metadata.contentClass;
  return (
    visibility === PUBLIC_MANAGED_MEDIA_METADATA.visibility &&
    contentClass === PUBLIC_MANAGED_MEDIA_METADATA.contentClass
  );
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
