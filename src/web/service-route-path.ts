export function serviceNotFound(): Response {
  return new Response("Not found", { status: 404 });
}

export function onServicePath(
  request: Request,
  path: string | RegExp,
  handle: () => Response | Promise<Response>,
): Response | Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const matches = typeof path === "string" ? path === pathname : path.test(pathname);
  return matches ? handle() : serviceNotFound();
}

export function rawGuildId(request: Request, guildId: string): string {
  return new URL(request.url).pathname.endsWith(`/${guildId}`) ? guildId : "";
}
