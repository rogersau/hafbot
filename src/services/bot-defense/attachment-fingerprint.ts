import { isRecord } from "../../unknown-parse";

const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 3000;
const MAX_ACTIVE_MESSAGES = 4;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
let activeMessages = 0;

/** Exact complete image-set matching. Never fetch message links, embeds, or proxy URLs. */
export async function fingerprintImageAttachments(
  attachments: unknown[],
  fetchAttachment: typeof fetch = fetch,
): Promise<string | null> {
  if (!attachments.length || attachments.length > MAX_ATTACHMENTS) return null;

  const images: Array<{ url: string; size: number }> = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (
      !isRecord(attachment) ||
      typeof attachment.content_type !== "string" ||
      !IMAGE_TYPES.has(attachment.content_type) ||
      typeof attachment.size !== "number" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size <= 0 ||
      typeof attachment.url !== "string" ||
      !isDiscordAttachmentUrl(attachment.url)
    ) {
      return null;
    }
    totalBytes += attachment.size;
    if (totalBytes > MAX_TOTAL_BYTES) return null;
    images.push({ url: attachment.url, size: attachment.size });
  }

  // No unbounded wait queue or URL cache. Busy isolates fail open.
  if (activeMessages >= MAX_ACTIVE_MESSAGES) return null;
  activeMessages += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const digests: string[] = [];
    for (const image of images) {
      const response = await fetchAttachment(image.url, {
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return null;
      }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== image.size) {
        await response.body.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(image.size);
      let offset = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (controller.signal.aborted || offset + chunk.value.byteLength > image.size) {
            return null;
          }
          bytes.set(chunk.value, offset);
          offset += chunk.value.byteLength;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (offset !== image.size || controller.signal.aborted) return null;
      digests.push(await sha256(bytes));
    }
    if (controller.signal.aborted) return null;
    // Keep multiplicity, ignore ordering, and separate this namespace from text hashes.
    return sha256(new TextEncoder().encode(`bot-defense:images:v1:${digests.sort().join(":")}`));
  } catch {
    // Expired URLs, CDN failures and malformed bodies must not trigger moderation.
    // Do not log signed URLs or attachment bytes.
    return null;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    activeMessages -= 1;
  }
}

function isDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net") &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /^\/attachments\/\d+\/\d+\/[^/]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
