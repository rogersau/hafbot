const encoder = new TextEncoder();

/** Builds a pre-retirement cookie for negative authorization regression tests. */
export async function createLegacyAdminSessionCookie(
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const encodedPayload = encodeURIComponent(JSON.stringify({ exp: nowMs + 60 * 60 * 1000 }));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `admin_session=${encodedPayload}.${hex}`;
}
