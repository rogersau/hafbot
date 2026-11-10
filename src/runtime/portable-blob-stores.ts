import { buildManagedMediaStorageKey, type PublicManagedMediaStore } from "../managed-media";
import type { EvidenceVaultBlobStore } from "./app-types";
import type {
  GuildEntitlementStore,
  GuildR2QuotaStore,
  TicketTranscriptBlobStore,
} from "./contracts";
import type { ObjectStore } from "./object-store";
import { isPublicManagedMediaObject, PUBLIC_MANAGED_MEDIA_METADATA } from "./managed-media-object";
import { putManagedGuildObject } from "./portable-managed-object";

const PRIVATE_VISIBILITY = "private";

interface PortableBlobStoreOptions {
  objects: ObjectStore;
  guildEntitlements: GuildEntitlementStore;
  guildObjects: GuildR2QuotaStore;
  now?: () => number;
}

export function createPortableTicketTranscriptBlobStore(
  options: PortableBlobStoreOptions,
): TicketTranscriptBlobStore {
  return {
    async putHtml(key, html) {
      await putManagedGuildObject({
        key,
        body: html,
        contentType: "text/html; charset=utf-8",
        metadata: { visibility: PRIVATE_VISIBILITY, contentClass: "ticket-transcript" },
        ...managedOptions(options),
      });
    },

    async getHtml(key) {
      const object = await options.objects.get(key);
      return object ? new Response(object.body).text() : null;
    },

    async putAttachment(key, body, input) {
      await putManagedGuildObject({
        key,
        body,
        declaredSizeBytes: input.sizeBytes,
        contentType: input.contentType,
        metadata: { visibility: PRIVATE_VISIBILITY, contentClass: "ticket-transcript" },
        ...managedOptions(options),
      });
    },

    async getAttachment(key) {
      const object = await options.objects.get(key);
      return object ? { body: object.body, contentType: object.contentType } : null;
    },

    async deleteTranscriptArtifacts(input) {
      const htmlKey = `${input.guildId}/${input.channelId}/${input.objectId}.html`;
      await deleteAccountedObject(options, input.guildId, htmlKey);
      const prefix = `${input.guildId}/${input.channelId}/${input.objectId}/attachments/`;
      let cursor: string | undefined;
      do {
        const page = await options.objects.list({ prefix, cursor, limit: 1_000 });
        for (const object of page.objects) {
          await deleteAccountedObject(options, input.guildId, object.key);
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
    },
  };
}

export function createPortableEvidenceVaultBlobStore(
  options: PortableBlobStoreOptions,
): EvidenceVaultBlobStore {
  return {
    async putImage(key, body, input) {
      await putManagedGuildObject({
        key,
        body,
        declaredSizeBytes: input.sizeBytes,
        contentType: input.contentType,
        metadata: { visibility: PRIVATE_VISIBILITY, contentClass: "evidence-vault" },
        ...managedOptions(options),
      });
    },

    async getImage(key) {
      const object = await options.objects.get(key);
      return object ? { body: object.body, contentType: object.contentType } : null;
    },

    async deleteImage(key, input) {
      await deleteAccountedObject(options, input.guildId, key);
    },
  };
}

export function createPortablePublicManagedMediaStore(
  options: PortableBlobStoreOptions,
): PublicManagedMediaStore {
  return {
    async putImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      await putManagedGuildObject({
        key,
        body: input.body,
        declaredSizeBytes: input.sizeBytes,
        contentType: input.contentType,
        metadata: PUBLIC_MANAGED_MEDIA_METADATA,
        ...managedOptions(options),
      });
    },

    async getImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      const object = await options.objects.get(key);
      if (
        !object ||
        !isPublicManagedMediaObject({
          key,
          metadata: object.metadata,
          uploadedAt: object.uploadedAt,
        })
      ) {
        await object?.body.cancel().catch(() => undefined);
        return null;
      }
      return { body: object.body, contentType: object.contentType };
    },

    async deleteImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      await deleteAccountedObject(options, input.guildId, key);
    },
  };
}

function managedOptions(options: PortableBlobStoreOptions) {
  return {
    objects: options.objects,
    guildEntitlements: options.guildEntitlements,
    guildObjects: options.guildObjects,
    now: options.now,
  };
}

async function deleteAccountedObject(
  options: PortableBlobStoreOptions,
  guildId: string,
  key: string,
): Promise<void> {
  await options.objects.delete(key);
  await options.guildObjects.deleteObject({
    guildId,
    key,
    deletedAtMs: options.now?.() ?? Date.now(),
  });
}
