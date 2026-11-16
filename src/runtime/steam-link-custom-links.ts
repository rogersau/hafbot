import type { PlatformLinkCustomLink } from "./contracts/platform-link-store";

export const DEFAULT_STEAM_LINK_CUSTOM_LINKS: PlatformLinkCustomLink[] = [
  { label: "CFTools", url: "https://app.cftools.cloud/profile/{steamId64}" },
];

export interface ResolvedSteamLinkCustomLink extends PlatformLinkCustomLink {
  issue: string | null;
}

export function resolveSteamLinkCustomLinks(
  customLinks: readonly PlatformLinkCustomLink[],
  steamId64: string,
): ResolvedSteamLinkCustomLink[] {
  return customLinks.map((customLink) => {
    const url = customLink.url.replaceAll("{steamId64}", steamId64);
    let issue: string | null = null;
    if (!customLink.label.trim()) {
      issue = "Enter a label for this custom link.";
    } else if (!customLink.url.includes("{steamId64}")) {
      issue = "Add {steamId64} to the URL template.";
    } else if (url.includes("{steamId64}")) {
      issue = "The SteamID64 placeholder was not fully resolved.";
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          issue = "Use an HTTP or HTTPS URL.";
        }
      } catch {
        issue = "The resolved URL is invalid.";
      }
    }
    return { label: customLink.label, url, issue };
  });
}
