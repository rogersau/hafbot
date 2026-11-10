export interface FeatureFlags {
  reactionRoles?: boolean;
  lfg: boolean;
  marketplace: boolean;
  events: boolean;
  tickets: boolean;
  blocklist: boolean;
  timedRoles: boolean;
  webhookProxy: boolean;
  adminUi: boolean;
  playerCount: boolean;
  steamLink: boolean;
  xboxLink: boolean;
  playstationLink: boolean;
  evidenceVault: boolean;
  imageRules: boolean;
  banCases: boolean;
  memberVerification: boolean;
  botDefense: boolean;
  mentionProtection: boolean;
  clans?: boolean;
  suggestions?: boolean;
  serverLevels?: boolean;
}

export const ALL_FEATURES_ENABLED: FeatureFlags = {
  reactionRoles: true,
  lfg: true,
  marketplace: true,
  events: true,
  tickets: true,
  blocklist: true,
  timedRoles: true,
  webhookProxy: true,
  adminUi: true,
  playerCount: true,
  steamLink: true,
  xboxLink: true,
  playstationLink: true,
  evidenceVault: true,
  imageRules: true,
  banCases: true,
  memberVerification: true,
  botDefense: true,
  mentionProtection: true,
  clans: true,
  suggestions: true,
  serverLevels: true,
};

function isDisabled(value: unknown): boolean {
  const normalized = normalizeFlagValue(value);
  if (!normalized) return false;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function parseFeatureFlags(env: {
  DISABLE_REACTION_ROLES?: string;
  DISABLE_LFG?: string;
  DISABLE_MARKETPLACE?: string;
  DISABLE_EVENTS?: string;
  DISABLE_TICKETS?: string;
  DISABLE_BLOCKLIST?: string;
  DISABLE_TIMED_ROLES?: string;
  DISABLE_WEBHOOK_PROXY?: string;
  DISABLE_ADMIN_UI?: string;
  DISABLE_PLAYER_COUNT?: string;
  DISABLE_STEAM_LINK?: string;
  DISABLE_XBOX_LINK?: string;
  DISABLE_PLAYSTATION_LINK?: string;
  DISABLE_EVIDENCE_VAULT?: string;
  DISABLE_IMAGE_RULES?: string;
  DISABLE_BAN_CASES?: string;
  DISABLE_MEMBER_VERIFICATION?: string;
  DISABLE_BOT_DEFENSE?: string;
  DISABLE_MENTION_PROTECTION?: string;
  DISABLE_CLANS?: string;
  DISABLE_SUGGESTIONS?: string;
  DISABLE_SERVER_LEVELS?: string;
  ENABLE_WEBHOOK_PROXY_LOGS?: string;
}): FeatureFlags {
  return {
    reactionRoles: !isDisabled(env.DISABLE_REACTION_ROLES),
    lfg: !isDisabled(env.DISABLE_LFG),
    marketplace: !isDisabled(env.DISABLE_MARKETPLACE),
    events: !isDisabled(env.DISABLE_EVENTS),
    tickets: !isDisabled(env.DISABLE_TICKETS),
    blocklist: !isDisabled(env.DISABLE_BLOCKLIST),
    timedRoles: !isDisabled(env.DISABLE_TIMED_ROLES),
    webhookProxy: !isDisabled(env.DISABLE_WEBHOOK_PROXY),
    adminUi: !isDisabled(env.DISABLE_ADMIN_UI),
    playerCount: !isDisabled(env.DISABLE_PLAYER_COUNT),
    steamLink: !isDisabled(env.DISABLE_STEAM_LINK),
    xboxLink: !isDisabled(env.DISABLE_XBOX_LINK),
    playstationLink: !isDisabled(env.DISABLE_PLAYSTATION_LINK),
    evidenceVault: !isDisabled(env.DISABLE_EVIDENCE_VAULT),
    imageRules: !isDisabled(env.DISABLE_IMAGE_RULES),
    banCases: !isDisabled(env.DISABLE_BAN_CASES),
    memberVerification: !isDisabled(env.DISABLE_MEMBER_VERIFICATION),
    botDefense: !isDisabled(env.DISABLE_BOT_DEFENSE),
    mentionProtection: !isDisabled(env.DISABLE_MENTION_PROTECTION),
    clans: !isDisabled(env.DISABLE_CLANS),
    suggestions: !isDisabled(env.DISABLE_SUGGESTIONS),
    serverLevels: !isDisabled(env.DISABLE_SERVER_LEVELS),
  };
}

function normalizeFlagValue(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
