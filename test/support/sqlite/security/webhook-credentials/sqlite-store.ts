import { and, eq, isNull } from "drizzle-orm";
import { webhookCredentials } from "../../db/app-schema";
import { createD1DrizzleDatabase } from "../../runtime/drizzle-db";
import type {
  StoredCredentialEnvelopeV1,
  WebhookCredentialOwner,
} from "../../../../../src/security/webhook-credentials/index";
import type {
  StoredWebhookCredential,
  WebhookCredentialStore,
} from "../../../../../src/security/webhook-credentials/store";

type WebhookCredentialRow = typeof webhookCredentials.$inferSelect;
type WebhookCredentialInsert = typeof webhookCredentials.$inferInsert;

export function createSqliteWebhookCredentialStore(database: D1Database): WebhookCredentialStore {
  const db = createD1DrizzleDatabase(database);
  return {
    async readById(credentialId) {
      const row = await db
        .select()
        .from(webhookCredentials)
        .where(eq(webhookCredentials.credentialId, credentialId))
        .limit(1)
        .get();
      return row ? fromRow(row) : null;
    },
    async readByOwner(owner) {
      const row = await db
        .select()
        .from(webhookCredentials)
        .where(
          and(
            eq(webhookCredentials.guildId, owner.guildId),
            eq(webhookCredentials.ownerKind, owner.kind),
            eq(webhookCredentials.publicId, owner.publicId),
            owner.kind === "proxy_destination"
              ? eq(webhookCredentials.destinationId, owner.destinationId)
              : isNull(webhookCredentials.destinationId),
          ),
        )
        .limit(1)
        .get();
      return row ? fromRow(row) : null;
    },
    async upsert(credential) {
      const row = toRow(credential);
      await db
        .insert(webhookCredentials)
        .values(row)
        .onConflictDoUpdate({
          target: webhookCredentials.credentialId,
          set: {
            envelopeJson: row.envelopeJson,
            fingerprint: row.fingerprint,
            maskedDisplay: row.maskedDisplay,
            updatedAtMs: row.updatedAtMs,
          },
        })
        .run();
    },
    async delete(credentialId, owner) {
      await db
        .delete(webhookCredentials)
        .where(
          and(
            eq(webhookCredentials.credentialId, credentialId),
            eq(webhookCredentials.guildId, owner.guildId),
            eq(webhookCredentials.publicId, owner.publicId),
          ),
        )
        .run();
    },
  };
}

function fromRow(row: WebhookCredentialRow): StoredWebhookCredential {
  const owner: WebhookCredentialOwner =
    row.ownerKind === "proxy_destination" && row.destinationId
      ? {
          kind: "proxy_destination",
          guildId: row.guildId,
          publicId: row.publicId,
          destinationId: row.destinationId,
        }
      : row.ownerKind === "suggestion_reply"
        ? { kind: "suggestion_reply", guildId: row.guildId, publicId: row.publicId }
        : { kind: "ban_lookup_notification", guildId: row.guildId, publicId: row.publicId };
  return {
    credentialId: row.credentialId,
    owner,
    provider: "discord",
    envelope: JSON.parse(row.envelopeJson) as StoredCredentialEnvelopeV1,
    fingerprint: row.fingerprint,
    maskedDisplay: row.maskedDisplay,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toRow(credential: StoredWebhookCredential): WebhookCredentialInsert {
  return {
    credentialId: credential.credentialId,
    guildId: credential.owner.guildId,
    ownerKind: credential.owner.kind,
    publicId: credential.owner.publicId,
    destinationId:
      credential.owner.kind === "proxy_destination" ? credential.owner.destinationId : null,
    provider: credential.provider,
    envelopeJson: JSON.stringify(credential.envelope),
    fingerprint: credential.fingerprint,
    maskedDisplay: credential.maskedDisplay,
    createdAtMs: credential.createdAtMs,
    updatedAtMs: credential.updatedAtMs,
  };
}
