import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export function compressedSizes(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  return {
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9, mtime: 0 }).length,
    brotliBytes: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

export function staticClosure(entryFile, chunks) {
  const files = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const imported of chunks[file]?.imports ?? []) visit(imported);
  };
  visit(entryFile);
  return [...files].sort();
}

export function packageName(moduleId) {
  const marker = "node_modules/";
  const index = moduleId.lastIndexOf(marker);
  if (index === -1) return null;
  const parts = moduleId.slice(index + marker.length).split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function logicalId(facadeModuleId) {
  if (facadeModuleId === "src/admin/main.tsx") return "admin-entry";
  const name = facadeModuleId?.match(/src\/admin\/components\/(.+)\.tsx$/)?.[1];
  if (name === "emoji-picker-implementation") return "interaction.unicodeEmojiPicker";
  if (name === "discord-message-preview-implementation") return "interaction.discordPreview";
  if (name === "admin-overview-page") return "route.overview";
  if (name === "user-profile-page") return "route.profile";
  if (name === "admin-billing-page") return "route.billing";
  if (name === "admin-tickets-page-with-history") return "route.tickets";
  if (name?.startsWith("admin-") && name.endsWith("-page")) {
    return `route.${name.slice(6, -5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`;
  }
  return null;
}

export function findInlineDataUrls(source) {
  const matches =
    String(source).match(
      /data:([a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*)(;base64)?,([A-Za-z0-9+/=%._~-]+)/g,
    ) ?? [];
  return matches.map((value) => {
    const [, mimeType, base64, payload] = value.match(
      /^data:([^;,]+)(;base64)?,([A-Za-z0-9+/=%._~-]+)$/,
    );
    return {
      mimeType,
      decodedBytes: base64
        ? Buffer.from(payload, "base64").length
        : Buffer.byteLength(decodeURIComponent(payload)),
    };
  });
}
