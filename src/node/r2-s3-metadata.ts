import { decodePortableObjectMetadata } from "../runtime/object-store";

const PORTABLE_METADATA_PREFIX = "hafm_";

/**
 * R2 maps Workers customMetadata to S3 x-amz-meta-* headers. The AWS SDK
 * lower-cases those header names, so canonicalize the two application-owned
 * keys while retaining any other ASCII metadata under its S3-visible name.
 */
export function decodeR2WorkersMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};
  const decoded = decodePortableObjectMetadata(metadata);
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    if (rawKey.toLowerCase().startsWith(PORTABLE_METADATA_PREFIX)) {
      const portableEntry = decodePortableObjectMetadata({ [rawKey]: rawValue });
      if (Object.keys(portableEntry).length === 0) {
        throw new Error(`R2 metadata key ${rawKey} uses an invalid portable encoding.`);
      }
      continue;
    }
    const key = canonicalR2MetadataKey(rawKey);
    if (Object.hasOwn(decoded, key)) {
      throw new Error(`R2 metadata key ${rawKey} collides after portable decoding.`);
    }
    decoded[key] = decodeRfc2047MetadataValue(rawValue, rawKey);
  }
  return decoded;
}

function canonicalR2MetadataKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === "contentclass") return "contentClass";
  if (lower === "visibility") return "visibility";
  return lower;
}

function decodeRfc2047MetadataValue(value: string, metadataKey: string): string {
  const encodedWord = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let output = "";
  let cursor = 0;
  let previousWasEncoded = false;
  let found = false;
  for (const match of value.matchAll(encodedWord)) {
    found = true;
    const index = match.index;
    const separator = value.slice(cursor, index);
    if (!(previousWasEncoded && /^\s*$/.test(separator))) output += separator;
    const charset = match[1]?.toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8") {
      throw new Error(`R2 metadata value for ${metadataKey} uses an unsupported charset.`);
    }
    output += decodeEncodedWord(match[2]!, match[3]!, metadataKey);
    cursor = index + match[0].length;
    previousWasEncoded = true;
  }
  if (!found) return value;
  return output + value.slice(cursor);
}

function decodeEncodedWord(encoding: string, value: string, metadataKey: string): string {
  let bytes: Uint8Array;
  if (encoding.toLowerCase() === "b") {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error(`R2 metadata value for ${metadataKey} has invalid Base64 encoding.`);
    }
    bytes = Buffer.from(value, "base64");
  } else {
    const result: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (character === "_") {
        result.push(0x20);
      } else if (character === "=") {
        const hexadecimal = value.slice(index + 1, index + 3);
        if (!/^[a-fA-F0-9]{2}$/.test(hexadecimal)) {
          throw new Error(
            `R2 metadata value for ${metadataKey} has invalid quoted-printable encoding.`,
          );
        }
        result.push(Number.parseInt(hexadecimal, 16));
        index += 2;
      } else {
        const code = character.charCodeAt(0);
        if (code > 0x7f) {
          throw new Error(
            `R2 metadata value for ${metadataKey} has invalid quoted-printable encoding.`,
          );
        }
        result.push(code);
      }
    }
    bytes = Uint8Array.from(result);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`R2 metadata value for ${metadataKey} is not valid UTF-8.`);
  }
}
