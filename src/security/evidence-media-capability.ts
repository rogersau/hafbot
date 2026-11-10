const PURPOSE = "hafbot:evidence-media:v1";
const MAX_FUTURE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;

export interface EvidenceMediaClaims {
  version: 1;
  guildId: string;
  recordId: string;
  imageId: string;
  expiresAtSeconds: number;
}

export type CapabilityFailureReason =
  | "malformed"
  | "unsupported_version"
  | "expired"
  | "future_expiry"
  | "invalid_signature";

export interface EvidenceMediaCapability {
  issue(claims: Omit<EvidenceMediaClaims, "version">): Promise<string>;
  verify(
    token: string,
    expected: Omit<EvidenceMediaClaims, "version" | "expiresAtSeconds">,
  ): Promise<
    { ok: true; expiresAtSeconds: number } | { ok: false; reason: CapabilityFailureReason }
  >;
}

export function createEvidenceMediaCapability(
  secret: string,
  options: { now?: () => number } = {},
): EvidenceMediaCapability {
  if (!secret.trim()) throw new Error("EVIDENCE_MEDIA_SIGNING_SECRET must be configured");
  const now = options.now ?? (() => Date.now());
  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  async function signature(input: string): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", await keyPromise, new TextEncoder().encode(input)),
    );
  }

  return {
    async issue(claims) {
      validateClaimPart(claims.guildId);
      validateClaimPart(claims.recordId);
      validateClaimPart(claims.imageId);
      const expiresAtSeconds = Math.trunc(claims.expiresAtSeconds);
      const input = canonicalInput({ ...claims, expiresAtSeconds });
      return `v1.${expiresAtSeconds}.${base64url(await signature(input))}`;
    },

    async verify(token, expected) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      if (parts[0] !== "v1") return { ok: false, reason: "unsupported_version" };
      if (!/^\d{1,12}$/.test(parts[1] ?? "")) return { ok: false, reason: "malformed" };
      const expiresAtSeconds = Number(parts[1]);
      const nowSeconds = Math.floor(now() / 1000);
      if (expiresAtSeconds < nowSeconds - CLOCK_SKEW_SECONDS)
        return { ok: false, reason: "expired" };
      if (expiresAtSeconds > nowSeconds + MAX_FUTURE_SECONDS)
        return { ok: false, reason: "future_expiry" };
      let supplied: Uint8Array;
      try {
        supplied = fromBase64url(parts[2] ?? "");
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const wanted = await signature(canonicalInput({ ...expected, expiresAtSeconds }));
      if (!timingSafeEqual(wanted, supplied)) return { ok: false, reason: "invalid_signature" };
      return { ok: true, expiresAtSeconds };
    },
  };
}

function canonicalInput(claims: Omit<EvidenceMediaClaims, "version">): string {
  return [
    PURPOSE,
    "1",
    claims.guildId,
    claims.recordId,
    claims.imageId,
    String(claims.expiresAtSeconds),
  ].join("\n");
}

function validateClaimPart(value: string): void {
  if (!value || containsControlCharacter(value))
    throw new Error("Invalid evidence media capability claim");
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
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
