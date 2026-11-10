export function sensitiveBinaryResponse(
  body: BodyInit | null,
  options: { contentType: string; headers?: HeadersInit },
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", options.contentType);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  return new Response(body, { status: 200, headers });
}
