import type { ConfigurationFeatureKey } from "./index";
import { isRecord } from "../unknown-parse";

export interface ConfigurationRestoreTokenPayload {
  version: 1;
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  targetRevisionId: string;
  currentHeadId: string;
  currentSnapshotHash: string;
  targetSnapshotHash: string;
  entitlementTier: string;
  expiresAtMs: number;
  nonce: string;
}

export async function signConfigurationRestoreToken(
  payload: ConfigurationRestoreTokenPayload,
  secret: string,
): Promise<string> {
  assertSigningSecret(secret);
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(encodedPayload, secret);
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

export async function verifyConfigurationRestoreToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<ConfigurationRestoreTokenPayload> {
  assertSigningSecret(secret);
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new Error("restore_preview_invalid");
  }
  const expected = await hmac(encodedPayload, secret);
  const supplied = decodeBase64Url(encodedSignature);
  if (!timingSafeEqual(expected, supplied)) throw new Error("restore_preview_invalid");

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
  } catch {
    throw new Error("restore_preview_invalid");
  }
  if (!isRestorePayload(payload)) throw new Error("restore_preview_invalid");
  if (payload.expiresAtMs <= nowMs) throw new Error("restore_preview_expired");
  return payload;
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function assertSigningSecret(secret: string): void {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("Configuration revision restore signing secret must be at least 32 bytes.");
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  }
  return difference === 0;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("restore_preview_invalid");
  }
}

function isRestorePayload(value: unknown): value is ConfigurationRestoreTokenPayload {
  if (!isRecord(value)) return false;
  const payload = value;
  return (
    payload.version === 1 &&
    typeof payload.guildId === "string" &&
    isFeature(payload.feature) &&
    typeof payload.resourceKey === "string" &&
    typeof payload.targetRevisionId === "string" &&
    typeof payload.currentHeadId === "string" &&
    typeof payload.currentSnapshotHash === "string" &&
    typeof payload.targetSnapshotHash === "string" &&
    typeof payload.entitlementTier === "string" &&
    typeof payload.expiresAtMs === "number" &&
    Number.isSafeInteger(payload.expiresAtMs) &&
    typeof payload.nonce === "string"
  );
}

function isFeature(value: unknown): value is ConfigurationFeatureKey {
  return (
    value === "tickets" ||
    value === "webhook-proxy" ||
    value === "mention-protection" ||
    value === "bot-defense" ||
    value === "member-verification" ||
    value === "guild-audit-log"
  );
}
