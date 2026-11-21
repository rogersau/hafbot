import { isRecord } from "../../unknown-parse";

const ADMIN_NAV_SECTION_LABELS = [
  "Overview",
  "Moderation",
  "Community Management",
  "Access Control",
  "Integrations",
  "Configuration",
] as const;
export type AdminNavSectionLabel = (typeof ADMIN_NAV_SECTION_LABELS)[number];
export type AdminNavSectionPreferences = Record<AdminNavSectionLabel, boolean>;

export const ADMIN_NAV_SECTION_STORAGE_KEY = "discord-automation:admin-nav-sections";
export const DEFAULT_ADMIN_NAV_SECTION_PREFERENCES: AdminNavSectionPreferences = {
  Overview: true,
  Moderation: false,
  "Community Management": false,
  "Access Control": false,
  Integrations: false,
  Configuration: false,
};

export function readAdminNavSectionPreferences(): AdminNavSectionPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ADMIN_NAV_SECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const value = parsed;

    if (Object.keys(value).length !== ADMIN_NAV_SECTION_LABELS.length) return null;
    if (!ADMIN_NAV_SECTION_LABELS.every((label) => typeof value[label] === "boolean")) return null;
    return Object.fromEntries(
      ADMIN_NAV_SECTION_LABELS.map((label) => [label, value[label]]),
    ) as AdminNavSectionPreferences;
  } catch {
    return null;
  }
}

export function writeAdminNavSectionPreferences(preferences: AdminNavSectionPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADMIN_NAV_SECTION_STORAGE_KEY, JSON.stringify(preferences));
  } catch {}
}
