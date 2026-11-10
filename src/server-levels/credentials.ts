import {
  decryptWebhookCredential,
  encryptWebhookCredential,
  type PlaintextWebhookUrl,
  type StoredCredentialEnvelopeV1,
  type WebhookCredentialKeyRing,
  type WebhookCredentialOwner,
} from "../security/webhook-credentials";
import { isRecord } from "../unknown-parse";

export type ServerLevelCredentialPurpose = "webhook_secret" | "data_api";

export interface StoredServerLevelCredential {
  credentialId: string;
  guildId: string;
  configuredGameServerId: string;
  purpose: ServerLevelCredentialPurpose;
  envelope: StoredCredentialEnvelopeV1;
  fingerprint: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ServerLevelCredentialStore {
  readById(credentialId: string): Promise<StoredServerLevelCredential | null>;
  readByOwner(
    configuredGameServerId: string,
    purpose: ServerLevelCredentialPurpose,
  ): Promise<StoredServerLevelCredential | null>;
  upsert(credential: StoredServerLevelCredential): Promise<void>;
  delete(credentialId: string, configuredGameServerId: string): Promise<void>;
}

export interface RotatedServerLevelSecret {
  credentialId: string;
  secret: string;
  fingerprint: string;
}

export interface ServerLevelDataApiCredentials {
  applicationId: string;
  secret: string;
  accessToken: string | null;
  accessTokenExpiresAtMs: number | null;
}

export class ServerLevelCredentialService {
  constructor(
    private readonly store: ServerLevelCredentialStore,
    private readonly keyRing: WebhookCredentialKeyRing | Promise<WebhookCredentialKeyRing>,
  ) {}

  async rotateWebhookSecret(input: {
    guildId: string;
    configuredGameServerId: string;
    nowMs?: number;
    createId?: () => string;
  }): Promise<RotatedServerLevelSecret> {
    const secret = secureSecret();
    return this.storeWebhookSecret({ ...input, secret });
  }

  async storeWebhookSecret(input: {
    guildId: string;
    configuredGameServerId: string;
    secret: string;
    nowMs?: number;
    createId?: () => string;
  }): Promise<RotatedServerLevelSecret> {
    if (!/^[\x21-\x7e]{8,500}$/.test(input.secret)) {
      throw new Error("The CFTools webhook secret has an invalid format.");
    }
    const nowMs = input.nowMs ?? Date.now();
    const secret = input.secret;
    const existing = await this.store.readByOwner(input.configuredGameServerId, "webhook_secret");
    const credentialId = existing?.credentialId ?? input.createId?.() ?? crypto.randomUUID();
    const owner = credentialOwner(input.guildId, input.configuredGameServerId, "webhook_secret");
    const envelope = await encryptWebhookCredential({
      plaintext: secret as PlaintextWebhookUrl,
      credentialId,
      owner,
      keyRing: await this.keyRing,
    });
    const fingerprint = await sha256Hex(secret);
    await this.store.upsert({
      credentialId,
      guildId: input.guildId,
      configuredGameServerId: input.configuredGameServerId,
      purpose: "webhook_secret",
      envelope,
      fingerprint,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
    return { credentialId, secret, fingerprint };
  }

  async verifyHephaistosSignature(input: {
    credentialId: string;
    guildId: string;
    configuredGameServerId: string;
    deliveryId: string;
    suppliedSignature: string;
  }): Promise<boolean> {
    if (!/^[a-fA-F0-9]{64}$/.test(input.suppliedSignature)) return false;
    const expectedSecret = await this.readWebhookSecret(input);
    if (expectedSecret === null) return false;
    // Native Hephaistos signs the delivery ID plus its provider-issued secret. Ingress separately
    // persists a digest of the exact bounded body and rejects a replay that changes that body.
    const expected = await sha256(`${input.deliveryId}${expectedSecret}`);
    return timingSafeEqual(hexBytes(input.suppliedSignature), expected);
  }

  async verifyWebhookSecret(input: {
    credentialId: string;
    guildId: string;
    configuredGameServerId: string;
    suppliedSecret: string;
  }): Promise<boolean> {
    const expected = await this.readWebhookSecret(input);
    if (expected === null) return false;
    const [suppliedHash, expectedHash] = await Promise.all([
      sha256(input.suppliedSecret),
      sha256(expected),
    ]);
    return timingSafeEqual(suppliedHash, expectedHash);
  }

  async storeDataApiCredentials(input: {
    guildId: string;
    configuredGameServerId: string;
    applicationId: string;
    secret: string;
    accessToken?: string | null;
    accessTokenExpiresAtMs?: number | null;
    nowMs?: number;
    createId?: () => string;
  }): Promise<{ credentialId: string; fingerprint: string }> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.applicationId)) {
      throw new Error("The CFTools application ID has an invalid format.");
    }
    if (!/^[\x21-\x7e]{8,500}$/.test(input.secret)) {
      throw new Error("The CFTools Data API secret has an invalid format.");
    }
    const accessToken = input.accessToken ?? null;
    const accessTokenExpiresAtMs = input.accessTokenExpiresAtMs ?? null;
    if (accessToken !== null && !/^[\x21-\x7e]{1,4000}$/.test(accessToken)) {
      throw new Error("The CFTools Data API token has an invalid format.");
    }
    if (
      (accessToken === null) !== (accessTokenExpiresAtMs === null) ||
      (accessTokenExpiresAtMs !== null &&
        (!Number.isSafeInteger(accessTokenExpiresAtMs) || accessTokenExpiresAtMs < 0))
    ) {
      throw new Error("The CFTools Data API token expiry is invalid.");
    }
    const nowMs = input.nowMs ?? Date.now();
    const existing = await this.store.readByOwner(input.configuredGameServerId, "data_api");
    const credentialId = existing?.credentialId ?? input.createId?.() ?? crypto.randomUUID();
    const plaintext = JSON.stringify({
      applicationId: input.applicationId,
      secret: input.secret,
      accessToken,
      accessTokenExpiresAtMs,
    });
    const envelope = await encryptWebhookCredential({
      plaintext: plaintext as PlaintextWebhookUrl,
      credentialId,
      owner: credentialOwner(input.guildId, input.configuredGameServerId, "data_api"),
      keyRing: await this.keyRing,
    });
    const fingerprint = await sha256Hex(`${input.applicationId}:${input.secret}`);
    await this.store.upsert({
      credentialId,
      guildId: input.guildId,
      configuredGameServerId: input.configuredGameServerId,
      purpose: "data_api",
      envelope,
      fingerprint,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
    return { credentialId, fingerprint };
  }

  async readDataApiCredentials(input: {
    guildId: string;
    configuredGameServerId: string;
  }): Promise<ServerLevelDataApiCredentials | null> {
    const credential = await this.store.readByOwner(input.configuredGameServerId, "data_api");
    if (!credential || credential.guildId !== input.guildId) return null;
    const plaintext = await this.decryptCredential(credential);
    if (plaintext === null) return null;
    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (!isDataApiCredentials(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async storeDataApiAccessToken(input: {
    guildId: string;
    configuredGameServerId: string;
    accessToken: string;
    accessTokenExpiresAtMs: number;
    nowMs?: number;
  }): Promise<void> {
    const credentials = await this.readDataApiCredentials(input);
    if (!credentials) throw new Error("CFTools Data API credentials are not configured.");
    await this.storeDataApiCredentials({
      ...input,
      applicationId: credentials.applicationId,
      secret: credentials.secret,
    });
  }

  async hasDataApiCredential(input: {
    guildId: string;
    configuredGameServerId: string;
  }): Promise<boolean> {
    return (await this.readDataApiCredentials(input)) !== null;
  }

  async deleteDataApiCredential(input: {
    guildId: string;
    configuredGameServerId: string;
  }): Promise<void> {
    const credential = await this.store.readByOwner(input.configuredGameServerId, "data_api");
    if (credential?.guildId === input.guildId) {
      await this.store.delete(credential.credentialId, input.configuredGameServerId);
    }
  }

  private async readWebhookSecret(input: {
    credentialId: string;
    guildId: string;
    configuredGameServerId: string;
  }): Promise<string | null> {
    const credential = await this.store.readById(input.credentialId);
    if (
      !credential ||
      credential.guildId !== input.guildId ||
      credential.configuredGameServerId !== input.configuredGameServerId ||
      credential.purpose !== "webhook_secret"
    ) {
      return null;
    }
    try {
      return await this.decryptCredential(credential);
    } catch {
      return null;
    }
  }

  private async decryptCredential(credential: StoredServerLevelCredential): Promise<string | null> {
    try {
      return await decryptWebhookCredential({
        envelope: credential.envelope,
        credentialId: credential.credentialId,
        owner: credentialOwner(
          credential.guildId,
          credential.configuredGameServerId,
          credential.purpose,
        ),
        keyRing: await this.keyRing,
      });
    } catch {
      return null;
    }
  }

  async deleteCredential(input: {
    credentialId: string;
    configuredGameServerId: string;
  }): Promise<void> {
    await this.store.delete(input.credentialId, input.configuredGameServerId);
  }
}

function isDataApiCredentials(value: unknown): value is ServerLevelDataApiCredentials {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    typeof candidate.applicationId === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(candidate.applicationId) &&
    typeof candidate.secret === "string" &&
    /^[\x21-\x7e]{8,500}$/.test(candidate.secret) &&
    (candidate.accessToken === null ||
      (typeof candidate.accessToken === "string" &&
        /^[\x21-\x7e]{1,4000}$/.test(candidate.accessToken))) &&
    (candidate.accessTokenExpiresAtMs === null ||
      (Number.isSafeInteger(candidate.accessTokenExpiresAtMs) &&
        (candidate.accessTokenExpiresAtMs as number) >= 0)) &&
    (candidate.accessToken === null) === (candidate.accessTokenExpiresAtMs === null)
  );
}

function credentialOwner(
  guildId: string,
  configuredGameServerId: string,
  purpose: ServerLevelCredentialPurpose,
): WebhookCredentialOwner {
  return {
    kind: purpose === "webhook_secret" ? "server_levels_webhook" : "server_levels_data_api",
    guildId,
    publicId: configuredGameServerId,
  };
}

function secureSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
