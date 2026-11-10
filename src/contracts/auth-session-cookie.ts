import { getCookies } from "better-auth/cookies";

export const CUSTOMER_AUTH_COOKIE_PREFIX = "better-auth";

export function getCustomerAuthCookieSettings(baseUrl: string) {
  const useSecureCookies = new URL(baseUrl).protocol === "https:";
  const advanced = {
    cookiePrefix: CUSTOMER_AUTH_COOKIE_PREFIX,
    useSecureCookies,
  } as const;
  return {
    advanced,
    sessionToken: getCookies({ baseURL: baseUrl, advanced }).sessionToken,
  };
}
