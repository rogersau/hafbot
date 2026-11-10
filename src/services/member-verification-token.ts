export async function signAttemptToken(
  attempt: { id: string; guildId: string; userId: string; expiresAtMs: number },
  secretKey: string,
): Promise<string> {
  const data = `${attempt.id}:${attempt.guildId}:${attempt.userId}:${attempt.expiresAtMs}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function verifyAttemptToken(
  attempt: { id: string; guildId: string; userId: string; expiresAtMs: number },
  signature: string,
  secretKey: string,
): Promise<boolean> {
  try {
    const expected = await signAttemptToken(attempt, secretKey);
    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(signature);
    if (a.length !== b.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  } catch {
    return false;
  }
}
