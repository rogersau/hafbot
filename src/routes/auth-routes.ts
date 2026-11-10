export interface AuthRouteOptions {
  handle: (request: Request) => Promise<Response>;
  onDiscordSignInCompleted?: (request: Request) => void;
}

export interface AuthRouteHandler {
  (request: Request): Promise<Response | null>;
}

export function createAuthRoutes(options: AuthRouteOptions): AuthRouteHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/auth" && !url.pathname.startsWith("/api/auth/")) {
      return null;
    }

    const response = await options.handle(request);
    if (
      url.pathname === "/api/auth/callback/discord" &&
      response.status >= 300 &&
      response.status < 400 &&
      !new URL(response.headers.get("location") ?? "/", url).searchParams.has("error")
    ) {
      options.onDiscordSignInCompleted?.(request);
    }
    return response;
  };
}
