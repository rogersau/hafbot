import type { TicketTranscriptBlobStore, TicketTranscriptCapabilityAccess } from "./contracts";

export async function purgeExpiredTicketTranscripts(input: {
  capabilities: TicketTranscriptCapabilityAccess;
  blobs: TicketTranscriptBlobStore;
  nowMs: number;
  limit: number;
}): Promise<number> {
  if (!input.blobs.deleteTranscriptArtifacts) return 0;
  const expired = await input.capabilities.listRetentionExpired(input.nowMs, input.limit);
  let purged = 0;
  for (const capability of expired) {
    try {
      await input.blobs.deleteTranscriptArtifacts(capability);
      if (
        await input.capabilities.deleteRetentionExpired({
          objectId: capability.objectId,
          nowMs: input.nowMs,
        })
      ) {
        purged += 1;
      }
    } catch (error) {
      console.error("Failed to purge expired Ticket transcript", capability.objectId, error);
    }
  }
  return purged;
}
