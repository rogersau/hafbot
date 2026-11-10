/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareSteamBanLookupStore } from "../src/runtime/cloudflare-steam-ban-lookup-store";

class FakeKV {
  public puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];

  async get<T>(): Promise<T | null> {
    return null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({
      key,
      value,
      ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}),
    });
  }
}

test("createCloudflareSteamBanLookupStore sets expirationTtl on writes", async () => {
  const kv = new FakeKV();
  const store = createCloudflareSteamBanLookupStore(kv as unknown as KVNamespace);

  await store.write("76561198000000001", {
    lastCheckedAtMs: 1,
    communityBanned: false,
    vacBanned: false,
    numberOfVacBans: 0,
    daysSinceLastBan: 0,
    numberOfGameBans: 0,
    economyBan: "none",
    gameBans: [],
  });

  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0]?.key, "steam_ban:76561198000000001");
  assert.equal(kv.puts[0]?.expirationTtl, 86400);
});
