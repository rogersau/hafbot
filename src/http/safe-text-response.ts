export function safeTextResponse(body: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/plain; charset=utf-8");
  responseHeaders.set("cache-control", "private, no-store, max-age=0");
  responseHeaders.set(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  responseHeaders.set("referrer-policy", "no-referrer");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: responseHeaders });
}
