import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { CommunityToolsError, type ContentFeed } from "./config";

export interface FeedEntry {
  id: string;
  title: string;
  url: string;
}
export type FeedTransport = (url: string) => Promise<string>;

export function isPublicFeedAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function feedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommunityToolsError("Enter a valid public HTTPS feed URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.includes(".") ||
    isIP(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(url.hostname)
  )
    throw new CommunityToolsError(
      "Feeds require a public HTTPS hostname on port 443 without credentials.",
    );
  return url;
}
/** Pins a validated IPv4 result into the actual TLS request; redirects are revalidated. */
export async function fetchPublicFeed(value: string, redirects = 0): Promise<string> {
  const url = feedUrl(value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CommunityToolsError("Feed DNS lookup timed out.")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!records.length || records.some(({ address }) => !isPublicFeedAddress(address)))
    throw new CommunityToolsError("The feed hostname must resolve only to public IPv4 addresses.");
  const response = await new Promise<{ status: number; location?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          family: 4,
          headers: {
            Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
            "Accept-Encoding": "identity",
            "User-Agent": "HAFBot-Feeds/1.0 (+https://hafbot.xyz)",
          },
          lookup: ((_host, _options, callback) =>
            callback(null, records[0].address, 4)) as LookupFunction,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 512 * 1024) {
              res.destroy(new Error("Feed exceeds the 512 KiB limit."));
            } else chunks.push(chunk);
          });
          res.on("error", () => reject(new CommunityToolsError("Could not read the feed.")));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      const timeout = setTimeout(() => req.destroy(new Error("Feed request timed out.")), 10000);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", () =>
        reject(new CommunityToolsError("Could not fetch the feed. Check its public HTTPS URL.")),
      );
      req.end();
    },
  );
  if (response.status >= 300 && response.status < 400) {
    if (!response.location || redirects >= 2)
      throw new CommunityToolsError("The feed redirected too many times.");
    return fetchPublicFeed(new URL(response.location, url).href, redirects + 1);
  }
  if (response.status !== 200)
    throw new CommunityToolsError("The feed provider did not return a successful response.");
  return response.body;
}

function plain(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const number = code.toLowerCase().startsWith("x")
        ? parseInt(code.slice(1), 16)
        : Number(code);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name] ?? "",
    )
    .trim();
}
function tag(entry: string, name: string): string {
  return plain(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, "i").exec(entry)?.[1] ?? "",
  );
}
export function parseSyndication(xml: string): FeedEntry[] {
  if (Buffer.byteLength(xml, "utf8") > 512 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new CommunityToolsError("The feed format is unsupported.");
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml))
    throw new CommunityToolsError("This URL does not contain an RSS or Atom feed.");
  const entries: FeedEntry[] = [];
  for (const match of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi)) {
    const body = match[2];
    let link = tag(body, "link");
    if (!link) {
      const links = body.match(/<link\b[^>]*>/gi) ?? [];
      for (const candidate of links) {
        if (/\brel\s*=\s*["'](?:self|enclosure)["']/i.test(candidate)) continue;
        link = plain(/\bhref\s*=\s*["']([^"']+)["']/i.exec(candidate)?.[1] ?? "");
        if (link) break;
      }
    }
    try {
      const url = feedUrl(link).href;
      const title = tag(body, "title").slice(0, 250) || "New community update";
      const id = (tag(body, "guid") || tag(body, "id") || url).slice(0, 1000);
      if (!entries.some((item) => item.id === id)) entries.push({ id, title, url });
    } catch {
      /* Invalid entry links are never posted. */
    }
    if (entries.length === 50) break;
  }
  return entries;
}
export function contentFeedUrl(feed: ContentFeed): string {
  if (feed.provider === "youtube") {
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(feed.source))
      throw new CommunityToolsError("YouTube subscriptions need a channel ID beginning with UC.");
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(feed.source)}`;
  }
  if (feed.provider === "reddit") {
    if (!/^[A-Za-z0-9_]{2,21}$/.test(feed.source))
      throw new CommunityToolsError("Enter the subreddit name without r/.");
    return `https://www.reddit.com/r/${encodeURIComponent(feed.source)}/new/.rss`;
  }
  if (feed.provider === "twitch") {
    if (!/^[A-Za-z0-9_]{1,25}$/.test(feed.source))
      throw new CommunityToolsError("Enter the Twitch channel login name.");
    return `https://www.twitch.tv/${feed.source.toLowerCase()}`;
  }
  return feedUrl(feed.source).href;
}

export class ContentFeedReader {
  private accessToken: { value: string; expiresAtMs: number } | null = null;
  readonly twitchAvailable: boolean;
  constructor(
    private readonly options: {
      clientId?: string;
      clientSecret?: string;
      transport?: FeedTransport;
      fetch?: typeof fetch;
    } = {},
  ) {
    for (const value of [options.clientId, options.clientSecret])
      if (value !== undefined && value !== "" && !/^[A-Za-z0-9]{20,128}$/.test(value))
        throw new CommunityToolsError("Twitch credentials must contain 20–128 letters and digits.");
    if (Boolean(options.clientId) !== Boolean(options.clientSecret))
      throw new CommunityToolsError(
        "Both TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required for Twitch feeds.",
      );
    this.twitchAvailable = Boolean(options.clientId && options.clientSecret);
  }
  async read(feed: ContentFeed): Promise<FeedEntry[]> {
    const url = contentFeedUrl(feed);
    if (feed.provider !== "twitch")
      return parseSyndication(await (this.options.transport ?? fetchPublicFeed)(url));
    if (!this.twitchAvailable)
      throw new CommunityToolsError(
        "Twitch feeds are unavailable until the HAF operator configures Twitch credentials.",
        503,
      );
    const send = this.options.fetch ?? fetch;
    if (!this.accessToken || this.accessToken.expiresAtMs <= Date.now()) {
      const result = await send("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId!,
          client_secret: this.options.clientSecret!,
          grant_type: "client_credentials",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) {
        await result.body?.cancel();
        throw new CommunityToolsError("Twitch authentication failed.", 503);
      }
      const body = (await result.json()) as { access_token?: unknown; expires_in?: unknown };
      if (
        typeof body.access_token !== "string" ||
        !Number.isSafeInteger(body.expires_in) ||
        Number(body.expires_in) < 60
      )
        throw new CommunityToolsError("Twitch returned an invalid authentication response.", 503);
      this.accessToken = {
        value: body.access_token,
        expiresAtMs: Date.now() + (Number(body.expires_in) - 60) * 1000,
      };
    }
    const response = await send(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(feed.source)}`,
      {
        headers: {
          "Client-Id": this.options.clientId!,
          Authorization: `Bearer ${this.accessToken.value}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      if (response.status === 401) this.accessToken = null;
      await response.body?.cancel();
      throw new CommunityToolsError("Twitch could not check the stream.", 503);
    }
    const body = (await response.json()) as { data?: Array<{ id?: unknown; title?: unknown }> };
    if (!Array.isArray(body.data))
      throw new CommunityToolsError("Twitch returned an invalid stream response.", 503);
    return body.data.slice(0, 1).flatMap((entry) =>
      typeof entry.id === "string"
        ? [
            {
              id: entry.id,
              title: typeof entry.title === "string" ? entry.title.slice(0, 250) : "Live on Twitch",
              url,
            },
          ]
        : [],
    );
  }
}
