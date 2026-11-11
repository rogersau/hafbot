import { and, eq } from "drizzle-orm";
import { serverLevelCredentials } from "../db/app-schema";
import type {
  ServerLevelCredentialPurpose,
  ServerLevelCredentialStore,
  StoredServerLevelCredential,
} from "../../../../src/server-levels/credentials";
import { createD1DrizzleDatabase } from "./drizzle-db";

type CredentialRow = typeof serverLevelCredentials.$inferSelect;

export function createSqliteServerLevelCredentialStore(
  database: D1Database,
): ServerLevelCredentialStore {
  const db = createD1DrizzleDatabase(database);
  return {
    async readById(credentialId) {
      const row = await db
        .select()
        .from(serverLevelCredentials)
        .where(eq(serverLevelCredentials.credentialId, credentialId))
        .limit(1)
        .get();
      return row ? fromRow(row) : null;
    },
    async readByOwner(configuredGameServerId, purpose) {
      const row = await db
        .select()
        .from(serverLevelCredentials)
        .where(
          and(
            eq(serverLevelCredentials.configuredGameServerId, configuredGameServerId),
            eq(serverLevelCredentials.purpose, purpose),
          ),
        )
        .limit(1)
        .get();
      return row ? fromRow(row) : null;
    },
    async upsert(credential) {
      const values = toRow(credential);
      await db
        .insert(serverLevelCredentials)
        .values(values)
        .onConflictDoUpdate({
          target: serverLevelCredentials.credentialId,
          set: {
            keyVersion: values.keyVersion,
            nonce: values.nonce,
            ciphertext: values.ciphertext,
            fingerprint: values.fingerprint,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },
    async delete(credentialId, configuredGameServerId) {
      await db
        .delete(serverLevelCredentials)
        .where(
          and(
            eq(serverLevelCredentials.credentialId, credentialId),
            eq(serverLevelCredentials.configuredGameServerId, configuredGameServerId),
          ),
        )
        .run();
    },
  };
}

function fromRow(row: CredentialRow): StoredServerLevelCredential {
  const purpose = parsePurpose(row.purpose);
  const keyVersion = Number(row.keyVersion);
  if (keyVersion !== 1 && keyVersion !== 2) {
    throw new Error("Stored Server Levels credential key version is invalid.");
  }
  return {
    credentialId: row.credentialId,
    guildId: row.guildId,
    configuredGameServerId: row.configuredGameServerId,
    purpose,
    envelope: {
      version: 1,
      keyVersion,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
    },
    fingerprint: row.fingerprint,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toRow(
  credential: StoredServerLevelCredential,
): typeof serverLevelCredentials.$inferInsert {
  return {
    credentialId: credential.credentialId,
    guildId: credential.guildId,
    configuredGameServerId: credential.configuredGameServerId,
    purpose: credential.purpose,
    keyVersion: String(credential.envelope.keyVersion),
    nonce: credential.envelope.nonce,
    ciphertext: credential.envelope.ciphertext,
    fingerprint: credential.fingerprint,
    createdAtMs: credential.createdAtMs,
    updatedAtMs: credential.updatedAtMs,
  };
}

function parsePurpose(value: string): ServerLevelCredentialPurpose {
  if (value === "webhook_secret" || value === "data_api") return value;
  throw new Error("Stored Server Levels credential purpose is invalid.");
}
