import { isRecord } from "../unknown-parse";

export type ChannelPermissionCopyMode = "roles_only" | "exact";
export type PermissionOverwriteType = 0 | 1;

export interface PermissionOverwriteInput {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface NormalizedPermissionOverwrite {
  id: string;
  type: PermissionOverwriteType;
  allow: string;
  deny: string;
}

export interface ChannelPermissionState {
  id: string;
  guildId: string;
  type: number;
  parentId: string | null;
  permissionOverwrites: readonly PermissionOverwriteInput[];
}

export interface PermissionTransition {
  bit: number;
  name: string;
  from: "allow" | "deny" | "inherit";
  to: "allow" | "deny" | "inherit";
}

export interface PermissionOverwriteChange {
  id: string;
  type: PermissionOverwriteType;
  status: "added" | "removed" | "changed" | "unchanged";
  transitions: PermissionTransition[];
  toAllow: string[];
  toDeny: string[];
  toInherit: string[];
  retainedFromTarget: boolean;
}

export interface PermissionCopyFinding {
  code:
    | "actor_permission_missing"
    | "bot_manage_channels_missing"
    | "bot_manage_roles_missing"
    | "bot_permission_bits_unsettable"
    | "missing_role"
    | "missing_member"
    | "managed_role"
    | "role_hierarchy"
    | "bot_self_lockout"
    | "bot_access_preserved"
    | "category_sync_lost"
    | "category_children_unchanged";
  message: string;
}

export interface PermissionCopySafetyInput {
  guildId: string;
  actorIsOwner: boolean;
  actorPermissions: string;
  botPermissionsBefore: string;
  botPermissionsAfter: string;
  botSettablePermissions?: string;
  botHasAdministrator?: boolean;
  botHighestRolePosition: number | null;
  roles: readonly { id: string; position: number; managed?: boolean }[];
  validMemberIds: ReadonlySet<string>;
  resultingOverwrites: readonly NormalizedPermissionOverwrite[];
  botRecoveryPermissions?: readonly string[];
  targetIsCategory?: boolean;
  targetWasCategorySynced?: boolean;
  resultMatchesCategory?: boolean;
}

export interface PreviewTokenClaims {
  guildId: string;
  actorUserId: string;
  sourceChannelId: string;
  targetChannelId: string;
  mode: ChannelPermissionCopyMode;
  sourceFingerprint: string;
  targetFingerprint: string;
  expiresAtMs: number;
}

export interface SignedPreviewTokenClaims extends PreviewTokenClaims {
  nonce: string;
}

export type PreviewFreshness =
  | { ok: true }
  | { ok: false; code: "stale_source" | "stale_target" | "stale_source_and_target" };

export class ChannelPermissionCopyError extends Error {
  constructor(
    public readonly code:
      | "invalid_overwrite"
      | "duplicate_overwrite"
      | "unsupported_channel_type"
      | "source_equals_target"
      | "cross_guild"
      | "preview_token_invalid"
      | "preview_token_expired"
      | "preview_token_used",
    message: string,
  ) {
    super(message);
    this.name = "ChannelPermissionCopyError";
  }
}

export const SUPPORTED_CHANNEL_PERMISSION_COPY_TYPES = new Set([0, 2, 4, 5, 13, 15, 16]);

const PERMISSION_NAMES: Readonly<Record<number, string>> = {
  0: "Create Instant Invite",
  1: "Kick Members",
  2: "Ban Members",
  3: "Administrator",
  4: "Manage Channels",
  5: "Manage Guild",
  6: "Add Reactions",
  7: "View Audit Log",
  8: "Priority Speaker",
  9: "Stream",
  10: "View Channel",
  11: "Send Messages",
  12: "Send TTS Messages",
  13: "Manage Messages",
  14: "Embed Links",
  15: "Attach Files",
  16: "Read Message History",
  17: "Mention Everyone",
  18: "Use External Emojis",
  19: "View Guild Insights",
  20: "Connect",
  21: "Speak",
  22: "Mute Members",
  23: "Deafen Members",
  24: "Move Members",
  25: "Use Voice Activity",
  26: "Change Nickname",
  27: "Manage Nicknames",
  28: "Manage Roles",
  29: "Manage Webhooks",
  30: "Manage Guild Expressions",
  31: "Use Application Commands",
  32: "Request To Speak",
  33: "Manage Events",
  34: "Manage Threads",
  35: "Create Public Threads",
  36: "Create Private Threads",
  37: "Use External Stickers",
  38: "Send Messages In Threads",
  39: "Use Embedded Activities",
  40: "Moderate Members",
  41: "View Creator Monetization Analytics",
  42: "Use Soundboard",
  43: "Create Guild Expressions",
  44: "Create Events",
  45: "Use External Sounds",
  46: "Send Voice Messages",
  48: "Set Voice Channel Status",
  49: "Send Polls",
  50: "Use External Apps",
  51: "Pin Messages",
  52: "Bypass Slowmode",
};

const ADMINISTRATOR = 1n << 3n;
const MANAGE_CHANNELS = 1n << 4n;
const VIEW_CHANNEL = 1n << 10n;
const MANAGE_ROLES = 1n << 28n;
const BOT_RECOVERY_PERMISSIONS = VIEW_CHANNEL | MANAGE_CHANNELS | MANAGE_ROLES;

export function normalizePermissionOverwrites(
  overwrites: readonly PermissionOverwriteInput[],
): NormalizedPermissionOverwrite[] {
  const seen = new Set<string>();
  const normalized = overwrites.map((overwrite) => {
    if (!isSnowflake(overwrite.id) || (overwrite.type !== 0 && overwrite.type !== 1)) {
      throw new ChannelPermissionCopyError(
        "invalid_overwrite",
        "Invalid overwrite target or type.",
      );
    }
    const allow = parseUnsignedBits(overwrite.allow);
    const deny = parseUnsignedBits(overwrite.deny);
    if ((allow & deny) !== 0n) {
      throw new ChannelPermissionCopyError(
        "invalid_overwrite",
        "An overwrite cannot allow and deny the same permission.",
      );
    }
    const key = `${overwrite.type}:${overwrite.id}`;
    if (seen.has(key)) {
      throw new ChannelPermissionCopyError("duplicate_overwrite", "Duplicate overwrite target.");
    }
    seen.add(key);
    return {
      id: overwrite.id,
      type: overwrite.type as PermissionOverwriteType,
      allow: String(allow),
      deny: String(deny),
    };
  });
  return normalized.sort(compareOverwrites);
}

export function mergePermissionOverwrites(
  source: readonly PermissionOverwriteInput[],
  target: readonly PermissionOverwriteInput[],
  mode: ChannelPermissionCopyMode,
): NormalizedPermissionOverwrite[] {
  const normalizedSource = normalizePermissionOverwrites(source);
  const normalizedTarget = normalizePermissionOverwrites(target);
  if (mode === "exact") return normalizedSource;
  return [
    ...normalizedSource.filter((item) => item.type === 0),
    ...normalizedTarget.filter((item) => item.type === 1),
  ].sort(compareOverwrites);
}

export function preserveBotRecoveryAccess(
  overwrites: readonly PermissionOverwriteInput[],
  botUserId: string,
  botPermissionsAfterCopy: string,
): { overwrites: NormalizedPermissionOverwrite[]; preservedPermissions: string[] } {
  if (!isSnowflake(botUserId)) {
    throw new ChannelPermissionCopyError("invalid_overwrite", "Invalid HAF Bot member ID.");
  }
  const normalized = normalizePermissionOverwrites(overwrites);
  const permissionsAfterCopy = parseUnsignedBits(botPermissionsAfterCopy);
  const missing = hasBits(permissionsAfterCopy, ADMINISTRATOR)
    ? 0n
    : BOT_RECOVERY_PERMISSIONS & ~permissionsAfterCopy;
  if (missing === 0n) return { overwrites: normalized, preservedPermissions: [] };

  const existing = normalized.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === botUserId,
  );
  const replacement: NormalizedPermissionOverwrite = {
    id: botUserId,
    type: 1,
    allow: String(BigInt(existing?.allow ?? "0") | missing),
    deny: String(BigInt(existing?.deny ?? "0") & ~missing),
  };
  return {
    overwrites: [...normalized.filter((overwrite) => overwrite !== existing), replacement].sort(
      compareOverwrites,
    ),
    preservedPermissions: permissionNames(missing),
  };
}

export function diffPermissionOverwrites(
  before: readonly PermissionOverwriteInput[],
  after: readonly PermissionOverwriteInput[],
  options: { mode?: ChannelPermissionCopyMode } = {},
): PermissionOverwriteChange[] {
  const beforeMap = overwriteMap(normalizePermissionOverwrites(before));
  const afterMap = overwriteMap(normalizePermissionOverwrites(after));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return keys.map((key) => {
    const oldValue = beforeMap.get(key);
    const newValue = afterMap.get(key);
    const transitions = permissionTransitions(oldValue, newValue);
    return {
      id: (newValue ?? oldValue)!.id,
      type: (newValue ?? oldValue)!.type,
      status: !oldValue
        ? "added"
        : !newValue
          ? "removed"
          : transitions.length
            ? "changed"
            : "unchanged",
      transitions,
      toAllow: transitions.filter((item) => item.to === "allow").map((item) => item.name),
      toDeny: transitions.filter((item) => item.to === "deny").map((item) => item.name),
      toInherit: transitions.filter((item) => item.to === "inherit").map((item) => item.name),
      retainedFromTarget:
        options.mode === "roles_only" &&
        oldValue?.type === 1 &&
        newValue != null &&
        transitions.length === 0,
    };
  });
}

export async function fingerprintChannelPermissionState(
  state: ChannelPermissionState,
): Promise<string> {
  validateChannelPermissionCopyChannel(state);
  const canonical = JSON.stringify({
    id: state.id,
    guildId: state.guildId,
    type: state.type,
    parentId: state.parentId,
    permissionOverwrites: normalizePermissionOverwrites(state.permissionOverwrites),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function validateChannelPermissionCopySelection(
  guildId: string,
  source: ChannelPermissionState,
  target: ChannelPermissionState,
): void {
  validateChannelPermissionCopyChannel(source);
  validateChannelPermissionCopyChannel(target);
  if (source.guildId !== guildId || target.guildId !== guildId) {
    throw new ChannelPermissionCopyError(
      "cross_guild",
      "Both channels must belong to the selected Guild.",
    );
  }
  if (source.id === target.id) {
    throw new ChannelPermissionCopyError("source_equals_target", "Source and target must differ.");
  }
}

export function evaluatePreviewFreshness(
  expected: Pick<PreviewTokenClaims, "sourceFingerprint" | "targetFingerprint">,
  current: Pick<PreviewTokenClaims, "sourceFingerprint" | "targetFingerprint">,
): PreviewFreshness {
  const sourceChanged = expected.sourceFingerprint !== current.sourceFingerprint;
  const targetChanged = expected.targetFingerprint !== current.targetFingerprint;
  if (sourceChanged && targetChanged) return { ok: false, code: "stale_source_and_target" };
  if (sourceChanged) return { ok: false, code: "stale_source" };
  if (targetChanged) return { ok: false, code: "stale_target" };
  return { ok: true };
}

export function evaluatePermissionCopySafety(input: PermissionCopySafetyInput): {
  blockers: PermissionCopyFinding[];
  warnings: PermissionCopyFinding[];
} {
  const blockers: PermissionCopyFinding[] = [];
  const warnings: PermissionCopyFinding[] = [];
  const actor = parseUnsignedBits(input.actorPermissions);
  const botBefore = parseUnsignedBits(input.botPermissionsBefore);
  const botAfter = parseUnsignedBits(input.botPermissionsAfter);
  const botSettable = parseUnsignedBits(input.botSettablePermissions ?? input.botPermissionsBefore);
  const botAdmin = input.botHasAdministrator || hasBits(botBefore, ADMINISTRATOR);
  if (!input.actorIsOwner && !hasBits(actor, ADMINISTRATOR | MANAGE_CHANNELS, true)) {
    blockers.push(
      finding(
        "actor_permission_missing",
        "You need Administrator or Manage Channels in this Guild.",
      ),
    );
  }
  if (!botAdmin && !hasBits(botBefore, MANAGE_CHANNELS)) {
    blockers.push(
      finding("bot_manage_channels_missing", "HAF Bot needs Manage Channels on the target."),
    );
  }
  const roleMap = new Map(input.roles.map((role) => [role.id, role]));
  const referencedRoles = input.resultingOverwrites.filter(
    (item) => item.type === 0 && item.id !== input.guildId,
  );
  if (referencedRoles.length > 0 && !botAdmin && !hasBits(botBefore, MANAGE_ROLES)) {
    blockers.push(
      finding("bot_manage_roles_missing", "HAF Bot needs Manage Roles to apply role overwrites."),
    );
  }
  const resultingBits = input.resultingOverwrites.reduce(
    (bits, overwrite) => bits | BigInt(overwrite.allow) | BigInt(overwrite.deny),
    0n,
  );
  const unsettableBits = resultingBits & ~botSettable;
  if (!botAdmin && unsettableBits !== 0n) {
    blockers.push(
      finding(
        "bot_permission_bits_unsettable",
        `HAF Bot cannot set these permissions on the target: ${permissionNames(unsettableBits).join(
          ", ",
        )}.`,
      ),
    );
  }
  for (const overwrite of input.resultingOverwrites) {
    if (overwrite.type === 1 && !input.validMemberIds.has(overwrite.id)) {
      blockers.push(finding("missing_member", `Member ${overwrite.id} is no longer in the Guild.`));
      continue;
    }
    if (overwrite.type !== 0 || overwrite.id === input.guildId) continue;
    const role = roleMap.get(overwrite.id);
    if (!role) blockers.push(finding("missing_role", `Role ${overwrite.id} no longer exists.`));
    else if (role.managed)
      blockers.push(finding("managed_role", `Role ${overwrite.id} is managed by an integration.`));
    else if (
      !botAdmin &&
      (input.botHighestRolePosition == null || role.position >= input.botHighestRolePosition)
    ) {
      blockers.push(
        finding("role_hierarchy", `Role ${overwrite.id} is not below HAF Bot's highest role.`),
      );
    }
  }
  if (
    !botAdmin &&
    (!hasBits(botAfter, VIEW_CHANNEL) ||
      !hasBits(botAfter, MANAGE_CHANNELS) ||
      !hasBits(botAfter, MANAGE_ROLES))
  ) {
    blockers.push(
      finding(
        "bot_self_lockout",
        "The result would prevent HAF Bot from viewing, managing, or repairing the target channel.",
      ),
    );
  }
  if (input.botRecoveryPermissions?.length) {
    warnings.push(
      finding(
        "bot_access_preserved",
        `HAF Bot safety access will be added for: ${input.botRecoveryPermissions.join(", ")}.`,
      ),
    );
  }
  if (input.targetWasCategorySynced && input.resultMatchesCategory === false) {
    warnings.push(
      finding("category_sync_lost", "The target will no longer be synchronised with its category."),
    );
  }
  if (input.targetIsCategory) {
    warnings.push(
      finding(
        "category_children_unchanged",
        "Child channels are not directly changed by this copy.",
      ),
    );
  }
  return { blockers, warnings };
}

export function createPreviewTokenManager(secret: string) {
  if (!secret) throw new Error("Preview token secret is required.");
  const verify = async (token: string, nowMs = Date.now()): Promise<SignedPreviewTokenClaims> => {
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra) tokenError("preview_token_invalid");
    const expectedSignature = await hmac(secret, payload);
    let supplied: Uint8Array;
    try {
      supplied = base64UrlToBytes(suppliedSignature);
    } catch {
      tokenError("preview_token_invalid");
    }
    if (bytesToBase64Url(supplied!) !== suppliedSignature) tokenError("preview_token_invalid");
    if (!timingSafeEqual(expectedSignature, supplied!)) tokenError("preview_token_invalid");
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    } catch {
      tokenError("preview_token_invalid");
    }
    if (!isSignedClaims(decoded)) tokenError("preview_token_invalid");
    if (decoded.expiresAtMs <= nowMs) tokenError("preview_token_expired");
    const { version: _version, ...claims } = decoded;
    return claims;
  };
  return {
    async sign(claims: PreviewTokenClaims): Promise<string> {
      validateClaims(claims);
      const payload = bytesToBase64Url(
        new TextEncoder().encode(
          JSON.stringify({ version: 1, nonce: crypto.randomUUID(), ...claims }),
        ),
      );
      return `${payload}.${bytesToBase64Url(await hmac(secret, payload))}`;
    },
    verify,
    verifyAndConsume: verify,
  };
}

function validateChannelPermissionCopyChannel(channel: ChannelPermissionState): void {
  if (
    !isSnowflake(channel.id) ||
    !isSnowflake(channel.guildId) ||
    !SUPPORTED_CHANNEL_PERMISSION_COPY_TYPES.has(channel.type)
  ) {
    throw new ChannelPermissionCopyError(
      "unsupported_channel_type",
      "This channel cannot own permission overwrites.",
    );
  }
  normalizePermissionOverwrites(channel.permissionOverwrites);
}

function permissionTransitions(
  before: NormalizedPermissionOverwrite | undefined,
  after: NormalizedPermissionOverwrite | undefined,
): PermissionTransition[] {
  const oldAllow = BigInt(before?.allow ?? "0");
  const oldDeny = BigInt(before?.deny ?? "0");
  const newAllow = BigInt(after?.allow ?? "0");
  const newDeny = BigInt(after?.deny ?? "0");
  let changed = oldAllow | oldDeny | newAllow | newDeny;
  const result: PermissionTransition[] = [];
  for (let bit = 0; changed !== 0n; bit++, changed >>= 1n) {
    if ((changed & 1n) === 0n) continue;
    const flag = 1n << BigInt(bit);
    const from = stateForBit(oldAllow, oldDeny, flag);
    const to = stateForBit(newAllow, newDeny, flag);
    if (from !== to)
      result.push({ bit, name: PERMISSION_NAMES[bit] ?? `Permission ${bit}`, from, to });
  }
  return result;
}

function permissionNames(bits: bigint): string[] {
  const names: string[] = [];
  for (let bit = 0; bits !== 0n; bit++, bits >>= 1n) {
    if ((bits & 1n) !== 0n) names.push(PERMISSION_NAMES[bit] ?? `Permission ${bit}`);
  }
  return names;
}

function stateForBit(allow: bigint, deny: bigint, bit: bigint): "allow" | "deny" | "inherit" {
  return (allow & bit) !== 0n ? "allow" : (deny & bit) !== 0n ? "deny" : "inherit";
}

function parseUnsignedBits(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new ChannelPermissionCopyError(
      "invalid_overwrite",
      "Permission bitsets must be unsigned decimal strings.",
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new ChannelPermissionCopyError("invalid_overwrite", "Permission bitset is invalid.");
  }
}

function compareOverwrites(
  left: NormalizedPermissionOverwrite,
  right: NormalizedPermissionOverwrite,
): number {
  return (
    left.type - right.type ||
    (BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0)
  );
}

function overwriteMap(
  values: NormalizedPermissionOverwrite[],
): Map<string, NormalizedPermissionOverwrite> {
  return new Map(values.map((value) => [`${value.type}:${value.id}`, value]));
}

function isSnowflake(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function hasBits(value: bigint, bits: bigint, any = false): boolean {
  return any ? (value & bits) !== 0n : (value & bits) === bits;
}

function finding(code: PermissionCopyFinding["code"], message: string): PermissionCopyFinding {
  return { code, message };
}

function validateClaims(claims: PreviewTokenClaims): void {
  if (
    !isSnowflake(claims.guildId) ||
    !isSnowflake(claims.actorUserId) ||
    !isSnowflake(claims.sourceChannelId) ||
    !isSnowflake(claims.targetChannelId) ||
    claims.sourceChannelId === claims.targetChannelId ||
    (claims.mode !== "roles_only" && claims.mode !== "exact") ||
    !claims.sourceFingerprint ||
    !claims.targetFingerprint ||
    !Number.isSafeInteger(claims.expiresAtMs)
  ) {
    tokenError("preview_token_invalid");
  }
}

function isSignedClaims(
  value: unknown,
): value is PreviewTokenClaims & { version: 1; nonce: string } {
  if (!isRecord(value)) return false;
  const claims = value;
  try {
    validateClaims(claims as unknown as PreviewTokenClaims);
  } catch {
    return false;
  }
  return claims.version === 1 && typeof claims.nonce === "string" && claims.nonce.length > 0;
}

function tokenError(
  code: "preview_token_invalid" | "preview_token_expired" | "preview_token_used",
): never {
  throw new ChannelPermissionCopyError(code, code.replaceAll("_", " "));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
