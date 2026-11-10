/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  createPlatformLinkIdentityReader,
  getPlatformIdentityAssurance,
  type PlatformIdentityAssurance,
} from "../src/services/platform-link-identity-reader";
import type {
  PlatformLink,
  PlatformLinkPlatform,
} from "../src/runtime/contracts/platform-link-store";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

test("Platform Link classifies every supported identity flow and the manual override", () => {
  const expectedByPlatform = {
    discord: "unsupported",
    steam: "authenticated",
    xbox: "authenticated",
    playstation: "self_reported",
    cftools: "unsupported",
  } as const satisfies Record<PlatformLinkPlatform, PlatformIdentityAssurance | "unsupported">;

  for (const platform of Object.keys(expectedByPlatform) as PlatformLinkPlatform[]) {
    const assurance = expectedByPlatform[platform];
    const link = createLink({ platform });
    if (assurance === "unsupported") {
      assert.throws(() => getPlatformIdentityAssurance(link), /not a supported Platform Link/);
    } else {
      assert.equal(getPlatformIdentityAssurance(link), assurance);
    }
    assert.equal(getPlatformIdentityAssurance({ ...link, manual: true }), "administrative");
  }
});

test("Platform Link identity reader lists active identities for exactly one Guild member", async () => {
  const requestedSteam = createLink({
    platformId: "steam-1",
    metadataJson: '{"profile":"private"}',
  });
  const requestedPlayStation = createLink({
    platform: "playstation",
    platformId: "psn-1",
    linkedAtMs: 2,
  });
  const fixture = createReaderFixture([
    requestedSteam,
    requestedPlayStation,
    createLink({ platformId: "inactive", active: false }),
    createLink({ guildId: "guild-2", platformId: "other-guild" }),
    createLink({ userId: "user-2", platformId: "other-user" }),
  ]);
  const reader = createPlatformLinkIdentityReader(fixture.store);

  const identities = await reader.listActiveIdentities("guild-1", "user-1");

  assert.deepEqual(
    [...identities].sort((left, right) => left.platformId.localeCompare(right.platformId)),
    [
      {
        guildId: "guild-1",
        userId: "user-1",
        platform: "playstation",
        platformId: "psn-1",
        active: true,
        assurance: "self_reported",
        linkedAtMs: 2,
      },
      {
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam",
        platformId: "steam-1",
        active: true,
        assurance: "authenticated",
        linkedAtMs: 1,
      },
    ],
  );
});

test("Platform Link identity reader filters by platform without collapsing multiple links", async () => {
  const fixture = createReaderFixture([
    createLink({ platformId: "steam-1" }),
    createLink({ platformId: "steam-2" }),
    createLink({ platform: "xbox", platformId: "xbox-1" }),
  ]);
  const reader = createPlatformLinkIdentityReader(fixture.store);

  const identities = await reader.listActiveIdentities("guild-1", "user-1", "steam");

  assert.deepEqual(identities.map((identity) => identity.platformId).sort(), [
    "steam-1",
    "steam-2",
  ]);
});

test("Platform Link identity reader revalidates one exact identity within its Guild member scope", async () => {
  const fixture = createReaderFixture([
    createLink({ platformId: "active-steam" }),
    createLink({
      platform: "xbox",
      platformId: "inactive-xbox",
      active: false,
      manual: true,
      actionedByUserId: "staff-1",
    }),
  ]);
  const reader = createPlatformLinkIdentityReader(fixture.store);

  assert.deepEqual(await reader.readIdentity("guild-1", "user-1", "steam", "active-steam"), {
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "active-steam",
    active: true,
    assurance: "authenticated",
    linkedAtMs: 1,
  });
  assert.deepEqual(await reader.readIdentity("guild-1", "user-1", "xbox", "inactive-xbox"), {
    guildId: "guild-1",
    userId: "user-1",
    platform: "xbox",
    platformId: "inactive-xbox",
    active: false,
    assurance: "administrative",
    linkedAtMs: 1,
  });
  assert.equal(await reader.readIdentity("guild-2", "user-1", "steam", "active-steam"), null);
  assert.equal(await reader.readIdentity("guild-1", "user-2", "steam", "active-steam"), null);
});

function createLink(overrides: Partial<PlatformLink> = {}): PlatformLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "platform-id",
    linkedAtMs: 1,
    manual: false,
    actionedByUserId: null,
    metadataJson: null,
    active: true,
    ...overrides,
  };
}

function createReaderFixture(links: PlatformLink[]) {
  const fixture = createProductionRuntimeStores();
  const ready = (async () => {
    for (const link of links) await fixture.stores.platformLink.upsertPlatformLink(link);
  })();
  return {
    store: afterStoreSeed(fixture.stores.platformLink, ready),
  };
}
