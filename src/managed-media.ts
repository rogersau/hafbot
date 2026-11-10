const MANAGED_MEDIA_CONTENT_TYPE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type ManagedMediaContentType = keyof typeof MANAGED_MEDIA_CONTENT_TYPE_EXTENSIONS;

export const MANAGED_MEDIA_CONTENT_TYPES = Object.keys(
  MANAGED_MEDIA_CONTENT_TYPE_EXTENSIONS,
) as ManagedMediaContentType[];
export const MAX_MANAGED_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_MANAGED_MEDIA_BASE64_LENGTH = Math.ceil(MAX_MANAGED_MEDIA_BYTES / 3) * 4;

export interface PublicManagedMediaStore {
  putImage(input: {
    guildId: string;
    filename: string;
    body: ArrayBuffer;
    contentType: ManagedMediaContentType;
    sizeBytes: number;
  }): Promise<void>;
  getImage(input: { guildId: string; filename: string }): Promise<{
    body: ReadableStream<Uint8Array> | ArrayBuffer | string;
    contentType: string | null;
  } | null>;
  deleteImage(input: { guildId: string; filename: string }): Promise<void>;
}

export interface ManagedMediaUpload {
  url: string;
  filename: string;
  contentType: ManagedMediaContentType;
  sizeBytes: number;
}

export class ManagedMediaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ManagedMediaError";
  }
}

export class ManagedMediaService {
  constructor(
    private readonly blobs: PublicManagedMediaStore | undefined,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async upload(input: {
    guildId: string;
    contentType: string;
    dataBase64: string;
    requestOrigin: string;
  }): Promise<ManagedMediaUpload> {
    if (!this.blobs) {
      throw new ManagedMediaError("Managed image storage is not configured.", 503);
    }

    if (!isManagedMediaContentType(input.contentType)) {
      throw new ManagedMediaError("Use a PNG, JPEG, GIF, or WebP image.");
    }

    const bytes = decodeManagedMediaBase64(input.dataBase64);
    if (bytes.byteLength === 0) {
      throw new ManagedMediaError("The selected image is empty.");
    }
    if (bytes.byteLength > MAX_MANAGED_MEDIA_BYTES) {
      throw new ManagedMediaError("Images must be 8 MB or smaller.");
    }
    if (!matchesImageSignature(input.contentType, bytes)) {
      throw new ManagedMediaError("The uploaded file does not match its image type.");
    }

    const extension = MANAGED_MEDIA_CONTENT_TYPE_EXTENSIONS[input.contentType];
    // Opaque immutable names let Discord and the public route cache each upload safely.
    const filename = `${this.createId()}.${extension}`;
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    try {
      await this.blobs.putImage({
        guildId: input.guildId,
        filename,
        body,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("R2 storage quota exceeded") ||
          error.message.includes("Object storage quota exceeded"))
      ) {
        throw new ManagedMediaError("This image would exceed the Guild R2 storage quota.");
      }
      throw error;
    }

    const origin = new URL(input.requestOrigin).origin;
    return {
      url: `${origin}/managed-media/${encodeURIComponent(input.guildId)}/${filename}`,
      filename,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
    };
  }

  async delete(input: { guildId: string; filename: string }): Promise<void> {
    await this.blobs?.deleteImage(input);
  }
}

export function isManagedMediaContentType(value: string): value is ManagedMediaContentType {
  return Object.hasOwn(MANAGED_MEDIA_CONTENT_TYPE_EXTENSIONS, value);
}

export function buildManagedMediaStorageKey(guildId: string, filename: string): string {
  if (!isSafeManagedMediaSegment(guildId) || !isManagedMediaFilename(filename)) {
    throw new ManagedMediaError("Invalid managed image path.");
  }
  return `${guildId}/managed-media/${filename}`;
}

export function parseManagedMediaPath(
  pathname: string,
): { guildId: string; filename: string; key: string } | null {
  const match = /^\/managed-media\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;

  try {
    const guildId = decodeURIComponent(match[1] ?? "");
    const filename = decodeURIComponent(match[2] ?? "");
    return { guildId, filename, key: buildManagedMediaStorageKey(guildId, filename) };
  } catch {
    return null;
  }
}

function decodeManagedMediaBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length > MAX_MANAGED_MEDIA_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new ManagedMediaError("The uploaded image data is invalid.");
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new ManagedMediaError("The uploaded image data is invalid.");
  }
}

function matchesImageSignature(contentType: ManagedMediaContentType, bytes: Uint8Array): boolean {
  if (contentType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  if (contentType === "image/gif") {
    return startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a");
  }
  return startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP");
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function isSafeManagedMediaSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isManagedMediaFilename(value: string): boolean {
  return /^[0-9a-f-]{36}\.(?:png|jpg|gif|webp)$/.test(value);
}
