import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { htmlResponseHeaders } from "../http/html-response";
import type { WebRequestContext } from "./request-context";

const documentSecurity = createMiddleware().server(async ({ request, context, next }) => {
  const nonce = context.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const { response } = await next({ context: { nonce } });
  if (
    (process.env.NODE_ENV === "development" && !context.nonce) ||
    !response.headers.get("content-type")?.startsWith("text/html") ||
    response.headers.has("content-security-policy")
  )
    return response;

  const url = new URL(request.url);
  const profile = url.pathname === "/" || url.pathname === "/changelog" ? "landing" : "admin";
  const headers = new Headers(response.headers);
  for (const [name, value] of htmlResponseHeaders({
    profile,
    requestUrl: url,
    scriptNonce: nonce,
    styleNonce: profile === "admin" ? nonce : undefined,
  }))
    headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
});

const guildAccess = createMiddleware().server(async ({ request, context, next }) => {
  const denied = await context.haf?.checkGuildAccess?.(request);
  return denied ?? next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    documentSecurity,
    createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === "serverFn" }),
    guildAccess,
  ],
}));

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: WebRequestContext };
  }
}
