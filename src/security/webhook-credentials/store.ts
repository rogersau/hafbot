import {
  decryptWebhookCredential,
  encryptWebhookCredential,
  parseDiscordWebhookCredential,
  type MaskedWebhookCredential,
  type PlaintextWebhookUrl,
  type StoredCredentialEnvelopeV1,
  type WebhookCredentialKeyRing,
  type WebhookCredentialOwner,
  type WebhookCredentialReference,
} from "./index";

export interface StoredWebhookCredential extends WebhookCredentialReference {
  owner: WebhookCredentialOwner;
  envelope: StoredCredentialEnvelopeV1;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookCredentialStore {
  readById(credentialId: string): Promise<StoredWebhookCredential | null>;
  readByOwner(owner: WebhookCredentialOwner): Promise<StoredWebhookCredential | null>;
  upsert(credential: StoredWebhookCredential): Promise<void>;
  delete(credentialId: string, owner: WebhookCredentialOwner): Promise<void>;
}

export interface RevealedWebhookCredential {
  url: PlaintextWebhookUrl;
  fingerprint: string;
}

export class WebhookCredentialStoreUnavailableError extends Error {
  constructor() {
    super("Webhook credential store unavailable");
    this.name = "WebhookCredentialStoreUnavailableError";
  }
}

export class WebhookCredentialService {
  constructor(
    private readonly store: WebhookCredentialStore,
    private readonly keyRing: WebhookCredentialKeyRing | Promise<WebhookCredentialKeyRing>,
  ) {}

  async replace(
    owner: WebhookCredentialOwner,
    url: string,
    credentialId = crypto.randomUUID(),
    nowMs = Date.now(),
  ): Promise<MaskedWebhookCredential> {
    const parsed = await parseDiscordWebhookCredential(url);
    const existing = await this.store.readByOwner(owner);
    const resolvedCredentialId = existing?.credentialId ?? credentialId;
    const envelope = await encryptWebhookCredential({
      plaintext: parsed.canonicalUrl,
      credentialId: resolvedCredentialId,
      owner,
      keyRing: await this.keyRing,
    });
    const credential: StoredWebhookCredential = {
      credentialId: resolvedCredentialId,
      owner,
      provider: "discord",
      fingerprint: parsed.fingerprint,
      maskedDisplay: parsed.maskedDisplay,
      envelope,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.upsert(credential);
    return this.toMasked(credential);
  }

  async preserve(
    credentialId: string,
    owner: WebhookCredentialOwner,
  ): Promise<MaskedWebhookCredential> {
    return this.toMasked(await this.readOwned(credentialId, owner));
  }

  async masked(
    credentialId: string,
    owner: WebhookCredentialOwner,
  ): Promise<MaskedWebhookCredential> {
    return this.toMasked(await this.readOwned(credentialId, owner));
  }

  async reveal(
    credentialId: string,
    owner: WebhookCredentialOwner,
  ): Promise<RevealedWebhookCredential> {
    const credential = await this.readOwned(credentialId, owner);
    return {
      url: await decryptWebhookCredential({
        envelope: credential.envelope,
        credentialId,
        owner,
        keyRing: await this.keyRing,
      }),
      fingerprint: credential.fingerprint,
    };
  }

  async resolve(
    credentialId: string,
    owner: WebhookCredentialOwner,
  ): Promise<RevealedWebhookCredential> {
    return this.reveal(credentialId, owner);
  }

  async remove(credentialId: string, owner: WebhookCredentialOwner): Promise<void> {
    await this.readOwned(credentialId, owner);
    await this.store.delete(credentialId, owner);
  }

  private async readOwned(
    credentialId: string,
    owner: WebhookCredentialOwner,
  ): Promise<StoredWebhookCredential> {
    let credential: StoredWebhookCredential | null;
    try {
      credential = await this.store.readById(credentialId);
    } catch {
      throw new WebhookCredentialStoreUnavailableError();
    }
    if (!credential || !sameOwner(credential.owner, owner)) {
      throw new Error("Webhook credential not found");
    }
    return credential;
  }

  private toMasked(credential: StoredWebhookCredential): MaskedWebhookCredential {
    return {
      configured: true,
      credentialId: credential.credentialId,
      provider: credential.provider,
      fingerprint: credential.fingerprint,
      maskedDisplay: credential.maskedDisplay,
    };
  }
}

function sameOwner(left: WebhookCredentialOwner, right: WebhookCredentialOwner): boolean {
  return (
    left.kind === right.kind &&
    left.guildId === right.guildId &&
    left.publicId === right.publicId &&
    (left.kind !== "proxy_destination" ||
      (right.kind === "proxy_destination" && left.destinationId === right.destinationId))
  );
}
