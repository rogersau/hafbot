import assert from "node:assert/strict";
import test from "node:test";
import { htmlResponse } from "../src/http/html-response";

test("HTML profiles emit the hardened common baseline deterministically", () => {
  const response = htmlResponse({ profile: "admin", html: "<!doctype html>" });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin");
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /img-src [^;]*https:\/\/cdn\.jsdelivr\.net/,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /style-src-attr 'unsafe-inline'/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /script-src [^;]*unsafe-inline/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /(?:^|; )style-src [^;]*unsafe-inline/,
  );
});

test("admin HTML allows a caller-provided nonce only for style elements", () => {
  const response = htmlResponse({
    profile: "admin",
    html: "<!doctype html>",
    styleNonce: "picker-style-nonce",
  });
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /style-src [^;]*'nonce-picker-style-nonce'/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /script-src [^;]*nonce-picker-style-nonce/,
  );
});

test("HSTS is limited to the canonical production HTTPS host", () => {
  const production = htmlResponse({
    profile: "legal",
    html: "ok",
    requestUrl: new URL("https://hafbot.xyz/terms"),
  });
  const preview = htmlResponse({
    profile: "legal",
    html: "ok",
    requestUrl: new URL("https://preview.workers.dev/terms"),
  });
  assert.equal(
    production.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  assert.equal(preview.headers.get("strict-transport-security"), null);
});

test("callers cannot weaken mandatory HTML policy headers", () => {
  assert.throws(
    () =>
      htmlResponse({
        profile: "landing",
        html: "ok",
        headers: { "content-security-policy": "default-src *" },
      }),
    /policy owns/,
  );
});
