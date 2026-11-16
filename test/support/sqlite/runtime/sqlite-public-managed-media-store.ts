import {
  buildManagedMediaStorageKey,
  type PublicManagedMediaStore,
} from "../../../../src/managed-media";
import type { GuildEntitlementStore, GuildR2QuotaStore } from "../../../../src/runtime/contracts";
import {
  isPublicManagedMediaObject,
  PUBLIC_MANAGED_MEDIA_METADATA,
} from "../../../../src/runtime/managed-media-object";
import { putManagedGuildR2Object } from "./r2-quota";

export function createSqlitePublicManagedMediaStore(options: {
  bucket: R2Bucket;
  guildEntitlements: GuildEntitlementStore;
  guildR2Objects: GuildR2QuotaStore;
  now?: () => number;
}): PublicManagedMediaStore {
  return {
    async putImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      await putManagedGuildR2Object({
        key,
        body: input.body,
        declaredSizeBytes: input.sizeBytes,
        bucket: options.bucket,
        guildEntitlements: options.guildEntitlements,
        guildR2Objects: options.guildR2Objects,
        putOptions: {
          httpMetadata: { contentType: input.contentType },
          customMetadata: PUBLIC_MANAGED_MEDIA_METADATA,
        },
      });
    },

    async getImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      const object = await options.bucket.get(key);
      if (
        !object ||
        !isPublicManagedMediaObject({
          key,
          metadata: object.customMetadata ?? {},
          uploadedAt: object.uploaded,
        })
      ) {
        await object?.body.cancel().catch(() => undefined);
        return null;
      }
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? null,
      };
    },

    async deleteImage(input) {
      const key = buildManagedMediaStorageKey(input.guildId, input.filename);
      await options.bucket.delete(key);
      await options.guildR2Objects.deleteObject({
        guildId: input.guildId,
        key,
        deletedAtMs: options.now?.() ?? Date.now(),
      });
    },
  };
}
