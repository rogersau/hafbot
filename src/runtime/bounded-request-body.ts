export type BoundedBodyResult =
  | { ok: true; text: string; bytes: Uint8Array; sha256: string }
  | { ok: false; reason: "too_large" | "invalid_utf8" };

export function trustedContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function readBoundedUtf8Body(
  request: Request,
  options: { maxBytes: number; canonicalMediaType?: string },
): Promise<BoundedBodyResult> {
  const declared = trustedContentLength(request);
  if (declared !== null && declared > options.maxBytes) return { ok: false, reason: "too_large" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (total + next.value.byteLength > options.maxBytes) {
          await reader.cancel("request body exceeds public ingress limit");
          return { ok: false, reason: "too_large" };
        }
        chunks.push(next.value);
        total += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
  const prefix = new TextEncoder().encode(
    `${options.canonicalMediaType ?? "application/octet-stream"}\0`,
  );
  const digestInput = new Uint8Array(prefix.byteLength + bytes.byteLength);
  digestInput.set(prefix);
  digestInput.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return { ok: true, text, bytes, sha256: hex(digest) };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
