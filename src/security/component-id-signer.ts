const FORMAT_VERSION = "1";
const PURPOSE_NAMESPACE = "hafbot:component-id:v1";
// A 48-bit tag is sufficient for Discord's rate-limited online attack surface
// while retaining room for the longest supported component payload.
const TAG_BYTES = 6;
const MAX_CUSTOM_ID_LENGTH = 100;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 30;

const PURPOSE_CODES = {
  "ban-case-complete": "b",
  "ban-case-actions": "E",
  "ban-case-enforcement": "F",
  "bot-defense-confirm": "c",
  "bot-defense-dismiss": "d",
  "image-rules-approve": "e",
  "image-rules-restore": "f",
  "evidence-vault-view": "g",
  "evidence-vault-details": "h",
  "clan-review-approve": "i",
  "clan-review-request-changes": "j",
  "clan-review-reject": "k",
  "clan-review-reason": "l",
  "suggestion-reply-keep": "m",
  "suggestion-reply-restore": "n",
  "suggestion-reply-delete": "o",
  "suggestion-reply-delete-submit": "p",
  "ticket-claim": "q",
  "ticket-close": "r",
  "ticket-close-request": "s",
  "ticket-close-confirm": "t",
  "ticket-close-decline": "u",
  "ticket-template-reply": "v",
  "member-verification-panel": "w",
  "member-verification-dm": "x",
  "lfg-renew": "y",
  "lfg-application-accept": "z",
  "lfg-application-reject": "A",
  "suggestion-author-status": "B",
  "commerce-review-approve": "C",
  "commerce-review-reject": "D",
  "lfg-close-confirm": "G",
  "lfg-close-cancel": "H",
} as const;

export type ComponentIdPurpose = keyof typeof PURPOSE_CODES;

export type ComponentIdVerificationFailure =
  | "malformed"
  | "unsupported_version"
  | "expired"
  | "future_expiry"
  | "invalid_signature";

export interface SignedComponentIdInspection {
  purpose: ComponentIdPurpose;
  customId: string;
  expiresAtSeconds: number | null;
}

export interface ComponentIdSigner {
  issue(input: {
    purpose: ComponentIdPurpose;
    customId: string;
    guildId: string;
    actorUserId?: string;
    expiresAtMs?: number;
  }): Promise<string>;
  inspect(value: string): SignedComponentIdInspection | null;
  verify(
    value: string,
    expected: { guildId: string; actorUserId?: string },
  ): Promise<
    | { ok: true; purpose: ComponentIdPurpose; customId: string; expiresAtSeconds: number | null }
    | { ok: false; reason: ComponentIdVerificationFailure }
  >;
}

export function createComponentIdSigner(
  input: { currentSecret: string; previousSecret?: string },
  options: { now?: () => number } = {},
): ComponentIdSigner {
  assertSecret(input.currentSecret, "COMPONENT_ID_SIGNING_SECRET");
  if (input.previousSecret) {
    assertSecret(input.previousSecret, "COMPONENT_ID_PREVIOUS_SIGNING_SECRET");
  }

  const now = options.now ?? Date.now;
  const currentKey = importHmacKey(input.currentSecret);
  const previousKey = input.previousSecret ? importHmacKey(input.previousSecret) : null;

  return {
    async issue(claims) {
      validateClaimPart(claims.guildId);
      validateClaimPart(claims.actorUserId ?? "");
      validatePayload(claims.customId);
      const expiresAtSeconds = claims.expiresAtMs ? normalizeExpiry(claims.expiresAtMs, now) : null;
      const tag = await sign(currentKey, canonicalInput({ ...claims, expiresAtSeconds }));
      const value = encodeEnvelope({
        purpose: claims.purpose,
        customId: claims.customId,
        expiresAtSeconds,
        tag,
      });
      if (value.length > MAX_CUSTOM_ID_LENGTH) {
        throw new Error("Signed component custom ID exceeds Discord's 100-character limit.");
      }
      return value;
    },

    inspect(value) {
      const parsed = parseEnvelope(value);
      return parsed.ok
        ? {
            purpose: parsed.purpose,
            customId: parsed.customId,
            expiresAtSeconds: parsed.expiresAtSeconds,
          }
        : null;
    },

    async verify(value, expected) {
      const parsed = parseEnvelope(value);
      if (!parsed.ok) return parsed;
      const nowSeconds = Math.floor(now() / 1000);
      if (
        parsed.expiresAtSeconds !== null &&
        parsed.expiresAtSeconds < nowSeconds - CLOCK_SKEW_SECONDS
      ) {
        return { ok: false, reason: "expired" };
      }
      if (
        parsed.expiresAtSeconds !== null &&
        parsed.expiresAtSeconds > nowSeconds + MAX_EXPIRY_SECONDS
      ) {
        return { ok: false, reason: "future_expiry" };
      }

      const canonical = canonicalInput({
        purpose: parsed.purpose,
        customId: parsed.customId,
        guildId: expected.guildId,
        actorUserId: expected.actorUserId,
        expiresAtSeconds: parsed.expiresAtSeconds,
      });
      const currentTag = await sign(currentKey, canonical);
      if (timingSafeEqual(currentTag, parsed.tag)) {
        return {
          ok: true,
          purpose: parsed.purpose,
          customId: parsed.customId,
          expiresAtSeconds: parsed.expiresAtSeconds,
        };
      }
      if (previousKey) {
        const previousTag = await sign(previousKey, canonical);
        if (timingSafeEqual(previousTag, parsed.tag)) {
          return {
            ok: true,
            purpose: parsed.purpose,
            customId: parsed.customId,
            expiresAtSeconds: parsed.expiresAtSeconds,
          };
        }
      }
      return { ok: false, reason: "invalid_signature" };
    },
  };
}

function normalizeExpiry(expiresAtMs: number, now: () => number): number {
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new Error("Component ID expiry must be a safe integer.");
  }
  const expiresAtSeconds = Math.trunc(expiresAtMs / 1000);
  const nowSeconds = Math.floor(now() / 1000);
  if (expiresAtSeconds <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("Component ID expiry must be in the future.");
  }
  if (expiresAtSeconds > nowSeconds + MAX_EXPIRY_SECONDS) {
    throw new Error("Component ID expiry must be within 24 hours.");
  }
  return expiresAtSeconds;
}

function encodeEnvelope(input: {
  purpose: ComponentIdPurpose;
  customId: string;
  expiresAtSeconds: number | null;
  tag: Uint8Array;
}): string {
  const header = `${FORMAT_VERSION}${PURPOSE_CODES[input.purpose]}`;
  const tag = base64url(input.tag);
  return input.expiresAtSeconds === null
    ? `${header}.${input.customId}.${tag}`
    : `${header}.${input.customId}.${input.expiresAtSeconds.toString(36)}.${tag}`;
}

function parseEnvelope(value: string):
  | {
      ok: true;
      purpose: ComponentIdPurpose;
      customId: string;
      expiresAtSeconds: number | null;
      tag: Uint8Array;
    }
  | { ok: false; reason: ComponentIdVerificationFailure } {
  const parts = value.split(".");
  if (parts[0] === undefined || !parts[0].startsWith(FORMAT_VERSION)) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (parts[0].length !== 2) return { ok: false, reason: "unsupported_version" };
  const purpose = purposeForCode(parts[0][1] ?? "");
  if (!purpose) return { ok: false, reason: "unsupported_version" };
  if (parts.length !== 3 && parts.length !== 4) return { ok: false, reason: "malformed" };

  const customId = parts[1] ?? "";
  if (!isValidPayload(customId)) return { ok: false, reason: "malformed" };
  const expiryPart = parts.length === 4 ? parts[2] : undefined;
  const tagPart = parts.at(-1) ?? "";
  const expiresAtSeconds = expiryPart === undefined ? null : parseExpiry(expiryPart);
  if (expiryPart !== undefined && expiresAtSeconds === null) {
    return { ok: false, reason: "malformed" };
  }
  let tag: Uint8Array;
  try {
    tag = fromBase64url(tagPart);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (tag.byteLength !== TAG_BYTES) return { ok: false, reason: "malformed" };
  return { ok: true, purpose, customId, expiresAtSeconds, tag };
}

function canonicalInput(input: {
  purpose: ComponentIdPurpose;
  customId: string;
  guildId: string;
  actorUserId?: string;
  expiresAtSeconds: number | null;
}): string {
  return [
    PURPOSE_NAMESPACE,
    FORMAT_VERSION,
    input.purpose,
    input.customId,
    input.guildId,
    input.actorUserId ?? "",
    input.expiresAtSeconds === null ? "" : String(input.expiresAtSeconds),
  ].join("\n");
}

function purposeForCode(code: string): ComponentIdPurpose | null {
  for (const [purpose, purposeCode] of Object.entries(PURPOSE_CODES)) {
    if (purposeCode === code) return purpose as ComponentIdPurpose;
  }
  return null;
}

function parseExpiry(value: string): number | null {
  if (!/^[0-9a-z]{1,10}$/.test(value)) return null;
  const expiry = Number.parseInt(value, 36);
  return Number.isSafeInteger(expiry) ? expiry : null;
}

function validatePayload(value: string): void {
  if (!isValidPayload(value)) {
    throw new Error("Component ID payload must use the supported compact character set.");
  }
}

function isValidPayload(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9:_~-]+$/.test(value);
}

function validateClaimPart(value: string): void {
  if (containsControlCharacter(value)) {
    throw new Error("Component ID claim contains a control character.");
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertSecret(secret: string, name: string): void {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error(`${name} must be at least 32 bytes.`);
  }
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(key: Promise<CryptoKey>, input: string): Promise<Uint8Array> {
  const fullTag = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(input)),
  );
  return fullTag.slice(0, TAG_BYTES);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
