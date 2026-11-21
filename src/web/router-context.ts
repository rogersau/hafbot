import type { WebRequestContext } from "./request-context";

export type AdminDocumentData = Pick<
  WebRequestContext["admin"],
  "authenticated" | "userProfile" | "playstationLinkEnabled" | "workerVersion"
>;

export interface WebRouterContext {
  admin?: AdminDocumentData;
}
