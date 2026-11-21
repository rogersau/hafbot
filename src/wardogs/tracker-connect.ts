import { z } from "zod";
import { htmlResponse } from "../http/html-response";
import type { OneTimeTokenStore } from "../runtime/contracts/one-time-token-store";
import type { PlatformLinkIdentityReader } from "../services/platform-link-identity-reader";
import { fetchWardogsCommunity, STEAM_ID64, WARDOGS_TRACKER_URL } from "./community-data";

export const TRACKER_CONNECT_START_PATH = "/auth/wardogs/start";
export const TRACKER_CONNECT_CALLBACK_PATH = "/auth/wardogs/callback";
const COOKIE_PREFIX = "__Host-haf-wardogs-";
const TICKET_LIFETIME_MS = 15 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ticketPattern =
  /^(\d{17,20})\.(\d{17,20})\.(\d{17})\.([a-f0-9-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;
const connectResponse = z.object({ steamId: z.string().regex(STEAM_ID64), synced: z.boolean() });
const encoder = new TextEncoder();

interface SyncIdentity {
  guildId: string;
  userId: string;
  steamId: string;
}

export function createWardogsTrackerConnect(options: {
  publicUrl: string;
  clientId: string;
  apiKey: string;
  signingSecret: string;
  links: Pick<PlatformLinkIdentityReader, "readIdentity">;
  oneTimeTokens: OneTimeTokenStore;
  isGuildSuspended?: (guildId: string) => Promise<boolean>;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const redirectUri = new URL(TRACKER_CONNECT_CALLBACK_PATH, options.publicUrl);
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const signingKey = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  async function verifyTicket(ticket: string | null) {
    const match = ticket?.match(ticketPattern);
    if (!ticket || !match) return null;
    const guildId = match[1]!;
    const userId = match[2]!;
    const steamId = match[3]!;
    const nonce = match[4]!;
    const expiresAtMs = Number(match[5]);
    if (!UUID.test(nonce) || expiresAtMs <= now()) return null;
    const tag = Uint8Array.from(
      atob(match[6]!.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (char) => char.charCodeAt(0),
    );
    const claims = ticket.slice(0, ticket.lastIndexOf("."));
    if (!(await crypto.subtle.verify("HMAC", await signingKey, tag, signatureInput(claims))))
      return null;
    return { guildId, userId, steamId, nonce, expiresAtMs };
  }

  async function hasActiveLink(identity: SyncIdentity): Promise<boolean> {
    if (await options.isGuildSuspended?.(identity.guildId)) return false;
    const link = await options.links.readIdentity(
      identity.guildId,
      identity.userId,
      "steam",
      identity.steamId,
    );
    return link?.active === true && link.assurance === "authenticated";
  }

  return {
    async createStartUrl(identity: SyncIdentity): Promise<string> {
      const claims = [
        identity.guildId,
        identity.userId,
        identity.steamId,
        crypto.randomUUID(),
        now() + TICKET_LIFETIME_MS,
      ].join(".");
      const tag = new Uint8Array(
        await crypto.subtle.sign("HMAC", await signingKey, signatureInput(claims)),
      );
      const signature = btoa(String.fromCharCode(...tag))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const url = new URL(TRACKER_CONNECT_START_PATH, redirectUri);
      url.searchParams.set("ticket", `${claims}.${signature}`);
      return url.href;
    },

    async start(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const ticket = url.searchParams.get("ticket");
      const identity = await verifyTicket(ticket);
      if (
        url.origin !== redirectUri.origin ||
        !ticket ||
        !identity ||
        !(await hasActiveLink(identity))
      ) {
        return result(
          url,
          400,
          "Sync link unavailable",
          "Run /wardogs sync in Discord to get a new link for your verified Steam account.",
        );
      }
      const upstream = new URL("/api/connect", WARDOGS_TRACKER_URL);
      upstream.searchParams.set("client_id", options.clientId);
      upstream.searchParams.set("redirect_uri", redirectUri.href);
      upstream.searchParams.set("state", identity.nonce);
      return new Response(null, {
        status: 302,
        headers: {
          location: upstream.href,
          "set-cookie": syncCookie(
            identity.nonce,
            ticket,
            Math.ceil((identity.expiresAtMs - now()) / 1000),
          ),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },

    async callback(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const state = url.searchParams.get("state") ?? "";
      if (url.origin !== redirectUri.origin || !UUID.test(state)) {
        return result(
          url,
          400,
          "Sync link unavailable",
          "Run /wardogs sync in Discord to start again.",
        );
      }
      const finish = (status: number, title: string, message: string) =>
        result(url, status, title, message, syncCookie(state, "", 0));
      const prefix = `${COOKIE_PREFIX}${state}=`;
      const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix));
      const identity = await verifyTicket(cookie?.slice(prefix.length) ?? null);
      if (!identity || identity.nonce !== state || !(await hasActiveLink(identity))) {
        return finish(400, "Sync link unavailable", "Run /wardogs sync in Discord to start again.");
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 512) {
        const message =
          url.searchParams.get("error_code") === "game_running"
            ? "Close WARDOGS and run /wardogs sync in Discord to try again."
            : "Return to Discord and run /wardogs sync if you want to try again.";
        return finish(400, "Sync incomplete", message);
      }
      const consumed = await options.oneTimeTokens.consume({
        nonce: `wardogs-sync:${state}`,
        expiresAtMs: identity.expiresAtMs,
        consumedAtMs: now(),
      });
      if (!consumed)
        return finish(
          400,
          "Sync link already used",
          "Run /wardogs sync in Discord for a new link.",
        );

      try {
        const response = await fetchWardogsCommunity(
          fetcher,
          `${WARDOGS_TRACKER_URL}/api/v1/connect/token`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({ code, redirect_uri: redirectUri.href }),
          },
        );
        if (!response.ok) throw new Error("WARDOGS Tracker exchange failed");
        // Connect may include private stats. Only the account match and sync outcome are needed here.
        const synced = connectResponse.parse(await response.json());
        if (synced.steamId !== identity.steamId) {
          return finish(
            403,
            "Different Steam account",
            "Run /wardogs sync again and sign in to the Steam account you chose in Discord.",
          );
        }
        if (!synced.synced) {
          return finish(
            200,
            "Sync pending",
            "WARDOGS Tracker could not refresh your progression. Close the game and try again from Discord.",
          );
        }
        return finish(
          200,
          "WARDOGS stats synced",
          "Return to Discord and run /wardogs stats to look up your public snapshot.",
        );
      } catch {
        return finish(
          502,
          "Sync unavailable",
          "WARDOGS Tracker could not complete the request. Return to Discord and try again shortly.",
        );
      }
    },
  };
}

export type WardogsTrackerConnect = ReturnType<typeof createWardogsTrackerConnect>;

function signatureInput(claims: string) {
  return encoder.encode(`hafbot:wardogs-tracker-sync:v1\n${claims}`);
}

function syncCookie(nonce: string, value: string, maxAge: number): string {
  return `${COOKIE_PREFIX}${nonce}=${value}; Path=/; Max-Age=${Math.max(maxAge, 0)}; HttpOnly; Secure; SameSite=Lax`;
}

function result(
  url: URL,
  status: number,
  title: string,
  message: string,
  clearCookie?: string,
): Response {
  return htmlResponse({
    profile: "platform-link-result",
    requestUrl: url,
    status,
    headers: clearCookie ? { "set-cookie": clearCookie } : undefined,
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><main><h1>${title}</h1><p>${message}</p></main></html>`,
  });
}
