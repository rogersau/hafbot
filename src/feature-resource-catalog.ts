import type { ResourceRelationship, SetupResourceKind } from "./feature-setup";

export interface FeatureResourceCatalogEntry {
  surfaceKey: string;
  dependencyKey: string;
  label: string;
  kind: SetupResourceKind;
  recommendedName: string;
  relationship: Exclude<ResourceRelationship, "referenced">;
  private: boolean;
  pairedAccess: boolean;
  permissionSummary: string;
}

const entries: FeatureResourceCatalogEntry[] = [
  channel("tickets", "panel_channel", "Ticket panel channel", "support-tickets"),
  category("tickets", "ticket_category", "Ticket category", "Support Tickets", true),
  channel("tickets", "transcript_channel", "Ticket transcript channel", "ticket-transcripts", true),
  role("tickets", "support_role", "Ticket support role", "Ticket Support"),
  channel("lfg", "notice_channel", "LFG noticeboard channel", "looking-for-group"),
  role("lfg", "notification_role", "LFG notification role", "LFG Notifications"),
  voice("lfg", "counter_voice_channel", "LFG counter voice channel", "LFG (0)"),
  channel("lfg", "approval_audit_channel", "LFG approval audit channel", "lfg-approvals", true),
  category("lfg", "approval_voice_category", "LFG voice category", "LFG Voice", true),
  channel("marketplace", "notice_channel", "Marketplace noticeboard channel", "marketplace"),
  channel("marketplace", "log_channel", "Marketplace log channel", "marketplace-log", true),
  channel(
    "evidence_vault",
    "audit_channel",
    "Evidence Vault audit channel",
    "evidence-vault",
    true,
  ),
  role("evidence_vault", "access_role", "Evidence Vault access role", "Evidence Vault Access"),
  channel("image_rules", "mod_queue_channel", "Image Rules Mod Queue", "image-rules-queue", true),
  role("image_rules", "mod_role", "Image Rules mod role", "Image Rules Moderator"),
  channel("bot_defense", "mod_queue_channel", "Bot Defense Mod Queue", "bot-defense-queue", true),
  role("bot_defense", "mod_role", "Bot Defense mod role", "Bot Defense Moderator"),
  channel(
    "member_verification",
    "welcome_channel",
    "Member Verification welcome channel",
    "verification",
  ),
  role("member_verification", "verified_role", "Verified role", "Verified"),
  forum("ban_cases", "forum_channel", "Ban Cases forum", "ban-cases", true),
  role("ban_cases", "mod_role", "Ban Cases mod role", "Ban Case Moderator"),
  channel("guild_audit_log", "audit_channel", "Guild Audit Log channel", "guild-audit-log", true),
  channel("player_link", "panel_channel", "Player Link panel channel", "link-account"),
  channel("player_link", "log_channel", "Player Link log channel", "player-link-log", true),
  role("player_link", "linked_role", "Linked player role", "Linked Player"),
  voice("player_count", "status_voice_channel", "Player Count voice channel", "Players (0)"),
  channel("player_count", "alert_channel", "Player Count alert channel", "server-alerts", true),
  forum("suggestions", "forum_channel", "Suggestion Forum", "suggestions", false),
  channel("suggestions", "panel_channel", "Suggestion Panel channel", "suggestions"),
  channel(
    "suggestions",
    "mod_queue_channel",
    "Suggestions Mod Queue",
    "suggestions-mod-queue",
    true,
  ),
  channel("suggestions", "digest_channel", "Suggestion Digest channel", "suggestion-digest"),
  role("suggestions", "mod_role", "Suggestion Mod role", "Suggestion Moderator"),
  role("guild_access", "admin_role", "HAF Guild Administrator role", "HAF Administrator"),
];

const byKey = new Map(
  entries.map((entry) => [`${entry.surfaceKey}:${entry.dependencyKey}`, entry]),
);
const pairedAccessKeys = new Set([
  "tickets:ticket_category",
  "tickets:transcript_channel",
  "tickets:support_role",
  "evidence_vault:audit_channel",
  "evidence_vault:access_role",
  "image_rules:mod_queue_channel",
  "image_rules:mod_role",
  "bot_defense:mod_queue_channel",
  "bot_defense:mod_role",
  "ban_cases:forum_channel",
  "ban_cases:mod_role",
  "suggestions:mod_queue_channel",
  "suggestions:mod_role",
]);

export function readFeatureResourceCatalogEntry(
  surfaceKey: string,
  dependencyKey: string,
): FeatureResourceCatalogEntry | null {
  const key = `${surfaceKey}:${dependencyKey}`;
  const entry = byKey.get(key);
  return entry ? { ...entry, pairedAccess: pairedAccessKeys.has(key) } : null;
}

function channel(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
  isPrivate = false,
): FeatureResourceCatalogEntry {
  return resource(surfaceKey, dependencyKey, label, "text_channel", recommendedName, isPrivate);
}

function voice(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
): FeatureResourceCatalogEntry {
  return resource(surfaceKey, dependencyKey, label, "voice_channel", recommendedName, false);
}

function forum(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
  isPrivate: boolean,
): FeatureResourceCatalogEntry {
  return resource(surfaceKey, dependencyKey, label, "forum_channel", recommendedName, isPrivate);
}

function category(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
  isPrivate: boolean,
): FeatureResourceCatalogEntry {
  return resource(surfaceKey, dependencyKey, label, "category", recommendedName, isPrivate);
}

function role(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
): FeatureResourceCatalogEntry {
  return resource(surfaceKey, dependencyKey, label, "role", recommendedName, false);
}

function resource(
  surfaceKey: string,
  dependencyKey: string,
  label: string,
  kind: SetupResourceKind,
  recommendedName: string,
  isPrivate: boolean,
): FeatureResourceCatalogEntry {
  return {
    surfaceKey,
    dependencyKey,
    label,
    kind,
    recommendedName,
    relationship: "haf_configured",
    private: isPrivate,
    pairedAccess: false,
    permissionSummary:
      kind === "role"
        ? "Creates a non-mentionable role with no server permissions. Assignments and feature access remain explicit."
        : isPrivate
          ? "Hides the resource from @everyone and grants HAF the minimum access needed to operate it. Guild administrators retain access."
          : "Creates a normal Guild resource with Discord defaults. Publishing or enabling the feature remains a separate action.",
  };
}
