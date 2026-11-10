const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";

export interface SteamAuthUrlOptions {
  realm: string;
  returnTo: string;
  state: string;
}

export function buildSteamAuthUrl(options: SteamAuthUrlOptions): string {
  const url = new URL(STEAM_OPENID_URL);
  const params = url.searchParams;

  params.set("openid.ns", "http://specs.openid.net/auth/2.0");
  params.set("openid.mode", "checkid_setup");
  params.set("openid.return_to", `${options.returnTo}?state=${encodeURIComponent(options.state)}`);
  params.set("openid.realm", options.realm);
  params.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
  params.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");

  return url.toString();
}

export async function verifySteamAssertion(requestUrl: string): Promise<string | null> {
  const url = new URL(requestUrl);
  const formData = new URLSearchParams();

  for (const [key, value] of url.searchParams) {
    if (key === "openid.mode") {
      formData.set(key, "check_authentication");
    } else {
      formData.set(key, value);
    }
  }

  // Ensure mode is check_authentication
  formData.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    return null;
  }

  const text = await response.text();

  if (!text.includes("is_valid:true")) {
    return null;
  }

  const claimedId = url.searchParams.get("openid.claimed_id");
  if (!claimedId) {
    return null;
  }

  const match = claimedId.match(/steamcommunity\.com\/openid\/id\/(\d+)/);
  return match ? match[1] : null;
}
