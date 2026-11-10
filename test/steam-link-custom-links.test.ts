/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import { resolveSteamLinkCustomLinks } from "../src/runtime/steam-link-custom-links";

test("resolveSteamLinkCustomLinks renders the same SteamID64 template used by production", () => {
  assert.deepEqual(
    resolveSteamLinkCustomLinks(
      [{ label: "CFTools", url: "https://example.com/profile/{steamId64}" }],
      "76561198000000000",
    ),
    [
      {
        label: "CFTools",
        url: "https://example.com/profile/76561198000000000",
        issue: null,
      },
    ],
  );
});

test("resolveSteamLinkCustomLinks identifies unresolved and invalid templates", () => {
  const results = resolveSteamLinkCustomLinks(
    [
      { label: "Missing placeholder", url: "https://example.com/profile" },
      { label: "Invalid URL", url: "not a url/{steamId64}" },
    ],
    "76561198000000000",
  );

  assert.equal(results[0]?.issue, "Add {steamId64} to the URL template.");
  assert.equal(results[1]?.issue, "The resolved URL is invalid.");
});
