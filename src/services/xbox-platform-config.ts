import type { PlatformAuthConfig } from "./platform-auth-config";

export interface XboxPlatformConfigOptions {
  clientId: string;
  clientSecret: string;
}

const MS_AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MS_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_USER_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XBL_XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const XBL_PROFILE_URL = "https://profile.xboxlive.com/users/me/profile/settings";
const XBL_USER_AUTH_RELYING_PARTY = "http://auth.xboxlive.com";
const XBL_XSTS_RELYING_PARTY = "http://xboxlive.com";
const XBL_SCOPES = "xboxlive.signin xboxlive.offline_access";

export function createXboxPlatformConfig(options: XboxPlatformConfigOptions): PlatformAuthConfig {
  return {
    platformName: "xbox",
    displayName: "Xbox",
    iconUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Xbox_Logo.svg/512px-Xbox_Logo.svg.png",
    profileUrl: (platformId: string) => `https://account.xbox.com/profile?gamertag=${platformId}`,
    buildAuthUrl: ({ state, publicUrl }) => {
      const url = new URL(MS_AUTHORIZE_URL);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", `${publicUrl}/auth/xbox/callback`);
      url.searchParams.set("scope", XBL_SCOPES);
      url.searchParams.set("state", state);
      return url;
    },
    verifyAssertion: async (request: Request) => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const publicUrl = url.origin;

      if (!code) {
        return null;
      }

      const msTokenResponse = await fetch(MS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: `${publicUrl}/auth/xbox/callback`,
          grant_type: "authorization_code",
        }).toString(),
      });

      if (await logFailedResponse("Xbox MS token exchange", msTokenResponse)) {
        return null;
      }

      const msTokenData = (await msTokenResponse.json()) as { access_token?: string };
      if (!msTokenData.access_token) {
        console.error("Xbox MS token exchange response missing access_token", {
          body: msTokenData,
        });
        return null;
      }

      const userTokenResponse = await fetch(XBL_USER_AUTH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({
          RelyingParty: XBL_USER_AUTH_RELYING_PARTY,
          TokenType: "JWT",
          Properties: {
            AuthMethod: "RPS",
            SiteName: "user.auth.xboxlive.com",
            RpsTicket: `d=${msTokenData.access_token}`,
          },
        }),
      });

      if (await logFailedResponse("Xbox user authentication", userTokenResponse)) {
        return null;
      }

      const userTokenData = (await userTokenResponse.json()) as {
        Token?: string;
        DisplayClaims?: { xui?: Array<{ uhs?: string }> };
      };
      if (!userTokenData.Token || !userTokenData.DisplayClaims?.xui?.[0]?.uhs) {
        console.error("Xbox user authentication response missing Token or uhs", {
          body: userTokenData,
        });
        return null;
      }

      const xstsResponse = await fetch(XBL_XSTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({
          Properties: {
            SandboxId: "RETAIL",
            UserTokens: [userTokenData.Token],
          },
          RelyingParty: XBL_XSTS_RELYING_PARTY,
          TokenType: "JWT",
        }),
      });

      if (await logFailedResponse("Xbox XSTS exchange", xstsResponse)) {
        return null;
      }

      const xstsData = (await xstsResponse.json()) as {
        Token?: string;
        DisplayClaims?: { xui?: Array<{ uhs?: string }> };
      };
      if (!xstsData.Token || !xstsData.DisplayClaims?.xui?.[0]?.uhs) {
        console.error("Xbox XSTS response missing Token or uhs", { body: xstsData });
        return null;
      }

      const profileResponse = await fetch(`${XBL_PROFILE_URL}?settings=Gamertag`, {
        headers: {
          Authorization: `XBL3.0 x=${xstsData.DisplayClaims.xui[0].uhs};${xstsData.Token}`,
          "x-xbl-contract-version": "2",
          Accept: "application/json",
        },
      });

      if (await logFailedResponse("Xbox profile request", profileResponse)) {
        return null;
      }

      const profileData = (await profileResponse.json()) as {
        profileUsers?: Array<{ settings?: Array<{ id?: string; value?: string }> }>;
      };
      const gamertag = profileData.profileUsers?.[0]?.settings?.find(
        (s) => s.id === "Gamertag",
      )?.value;

      if (!gamertag) {
        console.error("Xbox profile response missing Gamertag setting", { body: profileData });
        return null;
      }

      return gamertag;
    },
  };
}

async function logFailedResponse(label: string, response: Response): Promise<boolean> {
  if (response.ok) {
    return false;
  }

  const body = await response.text();

  console.error(`${label} failed`, {
    status: response.status,
    statusText: response.statusText,
    body,
    correlationId: response.headers.get("x-xbl-correlation-id"),
  });

  return true;
}
