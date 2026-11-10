import type { MemberVerificationConfigSnapshot } from "../components/admin-member-verification-page";

const RETURN_PATH_MARKER = "/member-verification";
const DRAFT_STORAGE_PREFIX = "haf:member-verification-draft:";
const ADMIN_ORIGIN = "https://admin.hafbot.invalid";

export type MemberVerificationPrerequisiteOutcome = "complete" | "cancel";

export interface MemberVerificationPrerequisiteReturn {
  outcome: MemberVerificationPrerequisiteOutcome;
  draft: MemberVerificationConfigSnapshot;
}

function storageKey(key: string): string {
  return `${DRAFT_STORAGE_PREFIX}${key}`;
}

export function createMemberVerificationDraftKey(guildId: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${guildId}:${suffix}`;
}

export function persistMemberVerificationDraft(
  key: string,
  guildId: string,
  workspaceId: string,
  draft: MemberVerificationConfigSnapshot,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify({ guildId, workspaceId, draft }));
  } catch {
    // Storage can be disabled by privacy settings; the setup page still works,
    // but cannot restore the draft after a full navigation.
  }
}

export function buildMemberVerificationReturnTo(
  guildId: string,
  workspaceId: string,
  draftKey: string,
): string {
  const params = new URLSearchParams();
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  params.set("mvDraftKey", draftKey);
  return `/admin/${encodeURIComponent(guildId)}${RETURN_PATH_MARKER}?${params.toString()}`;
}

/**
 * Parse the Player Link detour return value. Only same-Guild internal member
 * verification destinations are accepted; external URLs and other Guilds are
 * discarded before they can be navigated to.
 */
export function parseSafeMemberVerificationReturnTo(
  value: string | null | undefined,
  guildId: string,
  workspaceId?: string,
): { href: string; draftKey: string } | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, ADMIN_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ADMIN_ORIGIN || url.protocol !== "https:") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "admin" || segments[2] !== "member-verification") {
    return null;
  }
  try {
    if (decodeURIComponent(segments[1] ?? "") !== guildId) return null;
  } catch {
    return null;
  }
  const draftKey = url.searchParams.get("mvDraftKey")?.trim() ?? "";
  const returnWorkspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  if (!draftKey) return null;
  if (workspaceId !== undefined && returnWorkspaceId !== workspaceId.trim()) return null;
  return { href: `${url.pathname}${url.search}`, draftKey };
}

export function consumeMemberVerificationPrerequisiteReturn(
  guildId: string,
  search: string,
  workspaceId?: string,
): MemberVerificationPrerequisiteReturn | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(search);
  const outcome = params.get("mvOutcome");
  if (outcome !== "complete" && outcome !== "cancel") return null;
  const draftKey = params.get("mvDraftKey")?.trim() ?? "";
  if (!draftKey) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(draftKey));
    window.sessionStorage.removeItem(storageKey(draftKey));
    if (!raw) return null;
    const saved = JSON.parse(raw) as {
      guildId?: string;
      workspaceId?: string;
      draft?: MemberVerificationConfigSnapshot;
    };
    if (
      saved.guildId !== guildId ||
      (workspaceId !== undefined && saved.workspaceId !== workspaceId.trim()) ||
      !saved.draft
    )
      return null;
    return { outcome, draft: saved.draft };
  } catch {
    return null;
  }
}
