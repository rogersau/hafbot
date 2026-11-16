import assert from "node:assert/strict";
import test from "node:test";

import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";
import { createPostgresPlatformLinkStore } from "../src/runtime/postgres/postgres-platform-link-store";
import { createPlatformLinkService } from "../src/services/platform-link-service";
import { withFreshPostgres } from "./support/postgres";

const skip = process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured";

/** The canonical read omits enabled when the stored flag is the default enabled state. */
function asStored(config: PlatformLinkConfig): PlatformLinkConfig {
  const copy = { ...config };
  if (copy.enabled === true) delete copy.enabled;
  return copy;
}

function createConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: "role-1",
    logChannelId: null,
    gameAppIds: [221100],
    panelTitle: "Link Steam",
    panelDescription: "Link your Steam account.",
    panelButtonLabel: "Link Steam",
    panelButtonStyle: "Primary",
    panelColor: 123,
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: true,
    whoisFields: ["steamId64"],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

test(
  "Platform Link config save rejects atomically when the database refuses an enabled change",
  { skip },
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresPlatformLinkStore(database);
      const service = createPlatformLinkService({
        platformLinkStore: store,
        discordBotToken: "token",
      });
      const previous = createConfig({ enabled: false });
      await service.saveConfig(previous);
      await database.execute(`
        CREATE OR REPLACE FUNCTION reject_platform_link_enabled_change()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.enabled <> OLD.enabled THEN
            RAISE EXCEPTION 'enabled changes are rejected by the test gate';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await database.execute(`
        CREATE TRIGGER reject_platform_link_enabled_change
        BEFORE UPDATE ON platform_link_configs
        FOR EACH ROW EXECUTE FUNCTION reject_platform_link_enabled_change()
      `);

      const next = createConfig({
        enabled: true,
        panelTitle: "Changed title",
        updatedAtMs: previous.updatedAtMs + 1,
      });
      await assert.rejects(service.saveConfig(next), (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause;
        assert.match(String(cause ?? error), /enabled changes are rejected/);
        return true;
      });

      assert.deepEqual(await service.readConfig("guild-1", "steam"), previous);
      assert.deepEqual(await store.readPlatformLinkConfig("guild-1", "steam"), previous);
    });
  },
);

test(
  "Platform Link config upserts persist explicit enabled, preserve omitted flags, and stay row-scoped",
  { skip },
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresPlatformLinkStore(database);
      const service = createPlatformLinkService({
        platformLinkStore: store,
        discordBotToken: "token",
      });
      const steam = createConfig({ enabled: false, panelTitle: "Steam disabled" });
      const xbox = createConfig({
        guildId: "guild-1",
        platform: "xbox",
        enabled: false,
        panelTitle: "Xbox disabled",
      });
      const otherGuild = createConfig({
        guildId: "guild-2",
        enabled: true,
        panelTitle: "Other Guild enabled",
      });
      await service.saveConfig(steam);
      await service.saveConfig(xbox);
      await service.saveConfig(otherGuild);

      const metadataOnly = createConfig({
        panelTitle: "Metadata only",
        updatedAtMs: steam.updatedAtMs + 1,
      });
      await service.saveConfig(metadataOnly);
      assert.deepEqual(await service.readConfig("guild-1", "steam"), {
        ...metadataOnly,
        enabled: false,
      });

      const enabled = createConfig({
        enabled: true,
        panelTitle: "Steam enabled",
        updatedAtMs: steam.updatedAtMs + 2,
      });
      await service.saveConfig(enabled);
      assert.deepEqual(await service.readConfig("guild-1", "steam"), asStored(enabled));

      const disabledAgain = createConfig({
        enabled: false,
        panelTitle: "Steam disabled again",
        updatedAtMs: steam.updatedAtMs + 3,
      });
      await service.saveConfig(disabledAgain);
      assert.equal((await service.readConfig("guild-1", "steam"))?.enabled, false);

      assert.deepEqual(await service.readConfig("guild-1", "xbox"), xbox);
      assert.deepEqual(await service.readConfig("guild-2", "steam"), asStored(otherGuild));
    });
  },
);
