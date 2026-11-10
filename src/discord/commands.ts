import { DISCORD_API, discordRawRequest } from "./client";

export async function syncApplicationCommands(
  applicationId: string,
  botToken: string,
  commands: unknown[],
): Promise<void> {
  await syncCommands(
    `${DISCORD_API}/applications/${applicationId}/commands`,
    botToken,
    commands,
    "Failed to sync application commands",
  );
}

export async function syncGuildApplicationCommands(
  applicationId: string,
  guildId: string,
  botToken: string,
  commands: unknown[],
): Promise<void> {
  await syncCommands(
    `${DISCORD_API}/applications/${applicationId}/guilds/${guildId}/commands`,
    botToken,
    commands,
    "Failed to sync guild application commands",
  );
}

async function syncCommands(
  url: string,
  botToken: string,
  commands: unknown[],
  errorPrefix: string,
): Promise<void> {
  try {
    const response = await discordRawRequest(url, "PUT", {
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    response.body?.cancel();
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`${errorPrefix}: ${details}`, { cause: error });
  }
}

export function assertValidDiscordPublicKey(publicKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
    throw new Error("DISCORD_PUBLIC_KEY must be a 64-character hex string");
  }
  return publicKeyHex;
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  timestamp: string,
  body: string,
  signatureHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", hexToBuffer(publicKeyHex), "Ed25519", false, [
      "verify",
    ]);

    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBuffer(signatureHex),
      new TextEncoder().encode(`${timestamp}${body}`),
    );
  } catch {
    return false;
  }
}

function hexToBuffer(hex: string): ArrayBuffer {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("Invalid hex input");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
