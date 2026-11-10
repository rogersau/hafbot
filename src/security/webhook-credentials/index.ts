export type PlaintextWebhookUrl = string & { readonly __plaintextWebhookUrl: unique symbol };
export type PlaintextWardogsRconSecret = string & {
  readonly __plaintextWardogsRconSecret: unique symbol;
};

export type WebhookCredentialOwner =
  | { kind: "proxy_destination"; guildId: string; publicId: string; destinationId: string }
  | { kind: "ban_lookup_notification"; guildId: string; publicId: string }
  | { kind: "suggestion_reply"; guildId: string; publicId: string }
  | { kind: "server_levels_webhook"; guildId: string; publicId: string }
  | { kind: "wardogs_rcon"; guildId: string; publicId: string }
  | { kind: "server_levels_data_api"; guildId: string; publicId: string };

export type WardogsRconCredentialOwner = Extract<WebhookCredentialOwner, { kind: "wardogs_rcon" }>;

export interface WebhookCredentialReference {
  credentialId: string;
  provider: "discord";
  fingerprint: string;
  maskedDisplay: string;
}

export interface MaskedWebhookCredential extends WebhookCredentialReference {
  configured: true;
}

export interface StoredCredentialEnvelopeV1 {
  version: 1;
  keyVersion: 1 | 2;
  nonce: string;
  ciphertext: string;
}

export interface ParsedDiscordWebhookCredential {
  canonicalUrl: PlaintextWebhookUrl;
  webhookId: string;
  token: string;
  maskedDisplay: string;
  fingerprint: string;
}

const APPROVED_HOSTS = new Set([
  "discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
]);
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export async function parseDiscordWebhookCredential(
  input: string,
): Promise<ParsedDiscordWebhookCredential> {
  if (input !== input.trim() || containsControlCharacter(input) || /%2f/i.test(input))
    throw new Error("Invalid Discord webhook URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid Discord webhook URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Discord webhook URL");
  const host = url.hostname.toLowerCase();
  if (!APPROVED_HOSTS.has(host)) throw new Error("Unsupported Discord webhook host");
  if (url.pathname.includes("//") || url.pathname.endsWith("/"))
    throw new Error("Invalid Discord webhook path");
  const segments = url.pathname.split("/");
  if (segments.length !== 5 || segments[1] !== "api" || segments[2] !== "webhooks")
    throw new Error("Invalid Discord webhook path");
  const webhookId = segments[3] ?? "";
  const token = segments[4] ?? "";
  if (!/^\d{6,32}$/.test(webhookId) || !TOKEN.test(token))
    throw new Error("Invalid Discord webhook credential");
  const canonicalUrl =
    `https://discord.com/api/webhooks/${webhookId}/${token}` as PlaintextWebhookUrl;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalUrl)),
  );
  const fingerprint = hex(digest);
  return {
    canonicalUrl,
    webhookId,
    token,
    fingerprint,
    maskedDisplay: `discord.com/api/webhooks/••••${webhookId.slice(-6)}/••••••••`,
  };
}

export interface WebhookCredentialKeyRing {
  activeWriteVersion: 1 | 2;
  keys: Partial<Record<1 | 2, CryptoKey>>;
}

export async function createWebhookCredentialKeyRing(input: {
  keyV1: string;
  keyV2?: string;
  activeWriteVersion?: 1 | 2;
}): Promise<WebhookCredentialKeyRing> {
  const keys: Partial<Record<1 | 2, CryptoKey>> = { 1: await importAesKey(input.keyV1) };
  if (input.keyV2) keys[2] = await importAesKey(input.keyV2);
  const activeWriteVersion = input.activeWriteVersion ?? 1;
  if (!keys[activeWriteVersion])
    throw new Error(`Webhook credential key V${activeWriteVersion} is unavailable`);
  return { activeWriteVersion, keys };
}

export async function encryptWebhookCredential(input: {
  plaintext: PlaintextWebhookUrl;
  credentialId: string;
  owner: WebhookCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
}): Promise<StoredCredentialEnvelopeV1> {
  return encryptCredential({ ...input, purpose: "discord-webhook" });
}

/**
 * Encrypt a WARDOGS RCON secret with the shared credential primitive and a
 * purpose-specific envelope binding. WARDOGS credentials must never be
 * interchangeable with Discord webhook credentials, even when the same key
 * ring is configured.
 */
export async function encryptWardogsRconCredential(input: {
  plaintext: PlaintextWardogsRconSecret;
  credentialId: string;
  owner: WardogsRconCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
}): Promise<StoredCredentialEnvelopeV1> {
  return encryptCredential({ ...input, purpose: "wardogs-rcon" });
}

async function encryptCredential(input: {
  plaintext: string;
  credentialId: string;
  owner: WebhookCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
  purpose: CredentialPurpose;
}): Promise<StoredCredentialEnvelopeV1> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const keyVersion = input.keyRing.activeWriteVersion;
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(credentialAad(input.credentialId, input.owner, input.purpose)),
    },
    input.keyRing.keys[keyVersion]!,
    new TextEncoder().encode(input.plaintext),
  );
  return {
    version: 1,
    keyVersion,
    nonce: base64url(nonce),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
}

export async function decryptWebhookCredential(input: {
  envelope: StoredCredentialEnvelopeV1;
  credentialId: string;
  owner: WebhookCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
}): Promise<PlaintextWebhookUrl> {
  return (await decryptCredential({ ...input, purpose: "discord-webhook" })) as PlaintextWebhookUrl;
}

export async function decryptWardogsRconCredential(input: {
  envelope: StoredCredentialEnvelopeV1;
  credentialId: string;
  owner: WardogsRconCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
}): Promise<PlaintextWardogsRconSecret> {
  return (await decryptCredential({
    ...input,
    purpose: "wardogs-rcon",
  })) as PlaintextWardogsRconSecret;
}

type CredentialPurpose = "discord-webhook" | "wardogs-rcon";

async function decryptCredential(input: {
  envelope: StoredCredentialEnvelopeV1;
  credentialId: string;
  owner: WebhookCredentialOwner;
  keyRing: WebhookCredentialKeyRing;
  purpose: CredentialPurpose;
}): Promise<string> {
  if (input.envelope.version !== 1) throw new Error("Unsupported webhook credential envelope");
  const key = input.keyRing.keys[input.envelope.keyVersion];
  if (!key) throw new Error("Webhook credential key version unavailable");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(fromBase64url(input.envelope.nonce)),
      additionalData: asArrayBuffer(credentialAad(input.credentialId, input.owner, input.purpose)),
    },
    key,
    asArrayBuffer(fromBase64url(input.envelope.ciphertext)),
  );
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
}

export function redactWebhookSecrets<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

const WEBHOOK_URL =
  /https:\/\/(?:canary\.|ptb\.)?(?:discord(?:app)?\.com)\/api\/webhooks\/(\d+)\/([A-Za-z0-9_-]+)/gi;
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string")
    return value
      .replace(WEBHOOK_URL, "https://discord.com/api/webhooks/$1/[REDACTED_WEBHOOK_TOKEN]")
      .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(token|secret|password|authorization|api[-_]?key|cookie|session|oauth)\s*[:=]\s*[^\s,}]+/gi,
        "$1=[REDACTED]",
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
  if (value instanceof Error) {
    const copy = new Error(redactValue(value.message, seen) as string);
    copy.name = value.name;
    if (value.stack) copy.stack = redactValue(value.stack, seen) as string;
    if (value.cause) copy.cause = redactValue(value.cause, seen);
    return copy;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }
  if (!isRecord(value) || seen.has(value)) return value;
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen),
    ]),
  );
}

const SENSITIVE_KEY =
  /authorization|cookie|set-cookie|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session|dsn|webhook|body/i;

function credentialAad(
  credentialId: string,
  owner: WebhookCredentialOwner,
  purpose: CredentialPurpose,
): Uint8Array {
  const context =
    purpose === "discord-webhook"
      ? "hafbot:webhook-credential:v1"
      : "hafbot:wardogs-rcon-credential:v1";
  const provider = purpose === "discord-webhook" ? "discord" : "wardogs";
  return new TextEncoder().encode(
    [
      context,
      credentialId,
      owner.guildId,
      owner.kind,
      owner.publicId,
      owner.kind === "proxy_destination" ? owner.destinationId : "",
      provider,
    ].join("\n"),
  );
}
async function importAesKey(value: string): Promise<CryptoKey> {
  const bytes = fromBase64(value);
  if (bytes.byteLength !== 32)
    throw new Error("Webhook credential keys must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", asArrayBuffer(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function fromBase64url(value: string): Uint8Array {
  return fromBase64(
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
}
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
import { isRecord } from "../../unknown-parse";
