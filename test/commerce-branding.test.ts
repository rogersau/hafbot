import assert from "node:assert/strict";
import test from "node:test";

import {
  commerceAccentForeground,
  commerceAccentHex,
  validateCommerceBrandingInput,
} from "../src/commerce/branding";
import { renderCommercePage } from "../src/routes/commerce-branding";

test("Commerce branding validates a bounded accent and trims the seller tagline", () => {
  assert.deepEqual(
    validateCommerceBrandingInput({ accentColor: 0x12abef, tagline: "  Welcome  " }),
    { accentColor: 0x12abef, tagline: "Welcome" },
  );
  assert.equal(commerceAccentHex(0x12abef), "#12abef");
  assert.equal(commerceAccentForeground(0xffffff), "#10131a");
  assert.equal(commerceAccentForeground(0x10131a), "#ffffff");
  assert.equal(commerceAccentForeground(0x999999), "#10131a");
  assert.throws(
    () => validateCommerceBrandingInput({ accentColor: 0x1000000, tagline: "ok" }),
    /24-bit integer/,
  );
  assert.throws(
    () => validateCommerceBrandingInput({ accentColor: 1, tagline: "x".repeat(161) }),
    /160 characters/,
  );
});

test("Commerce shell escapes seller text and rejects arbitrary image hosts", async () => {
  const response = renderCommercePage({
    title: "Offer <title>",
    branding: {
      guildName: "Guild <img src=x>",
      guildIconUrl: "https://cdn.discordapp.com/avatars/not-a-guild/path.png",
      accentColor: 0x5865f2,
      tagline: "<script>alert(1)</script>",
    },
    content: "<p>fixed content</p>",
  });
  const html = await response.text();
  assert.match(html, /Guild &lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.doesNotMatch(html, /avatars\/not-a-guild/);
  assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /img-src 'self' data: https:\/\/cdn\.discordapp\.com/);
});
