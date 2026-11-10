/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  handlePlayStationLinkButton,
  handlePlayStationLinkedCountCommand,
  handlePlayStationLinkModalSubmit,
  handlePlayStationLinkSetupCommand,
  handlePlayStationManualLinkCommand,
  handlePlayStationPanelCommand,
  handlePlayStationRequestCommand,
  handlePlayStationSyncRolesCommand,
  handlePlayStationUnlinkCommand,
  handlePlayStationWhoisCommand,
} from "../src/runtime/playstation-link-interaction-handler";
import type { DiscordInteraction } from "../src/runtime/app-types";
import type {
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import {
  createPlatformLinkService,
  type PlatformLinkService,
} from "../src/services/platform-link-service";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

test("PlayStation link button opens a PSN Online ID modal", async () => {
  const service = createService({ configs: [createConfig()] });

  const response = await handlePlayStationLinkButton(createButtonInteraction(), service);
  const body = JSON.parse(await response.text());

  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "playstation_link_modal");
  assert.equal(body.data.components[0].components[0].label, "PSN Online ID");
});

test("PlayStation link button reports missing setup", async () => {
  const service = createService();

  const response = await handlePlayStationLinkButton(createButtonInteraction(), service);
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /not been set up for PlayStation linking/);
});

test("PlayStation link button blocks relink when allowRelink is false", async () => {
  const service = createService({
    configs: [createConfig({ allowRelink: false })],
    links: [createLink({ platformId: "Player_One" })],
  });

  const response = await handlePlayStationLinkButton(createButtonInteraction(), service);
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /already linked to PSN Online ID: Player_One/);
});

test("PlayStation link button allows a required relink even when ordinary relinking is disabled", async () => {
  const service = createService({
    configs: [createConfig({ allowRelink: false, requireRelinkOnRejoin: true })],
    links: [createLink({ platformId: "Player_One", active: false })],
  });

  const response = await handlePlayStationLinkButton(createButtonInteraction(), service);
  const body = JSON.parse(await response.text());

  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "playstation_link_modal");
});

test("PlayStation modal self-link saves an unverified manual link and logs without actionedBy", async () => {
  const links: PlatformLink[] = [];
  const assignedRoles: Array<{ guildId: string; userId: string; platform: string }> = [];
  const logs: Array<{ type: string; actionedBy?: string }> = [];
  const service = createService({
    links,
    configs: [createConfig({ linkedRoleId: "role-1" })],
    assignLinkedRole: async (guildId, userId, platform) => {
      assignedRoles.push({ guildId, userId, platform });
    },
    sendLogEmbed: async (_guildId, type, data) => {
      logs.push({ type, actionedBy: data.actionedBy });
    },
  });

  const response = await handlePlayStationLinkModalSubmit(
    createModalInteraction("Player_One"),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Linked your PlayStation account/);
  const [savedLink] = await service.listLinks("guild-1", "playstation");
  assert.deepEqual(
    {
      userId: savedLink!.userId,
      platform: savedLink!.platform,
      platformId: savedLink!.platformId,
      manual: savedLink!.manual,
      actionedByUserId: savedLink!.actionedByUserId,
    },
    {
      userId: "user-1",
      platform: "playstation",
      platformId: "Player_One",
      manual: true,
      actionedByUserId: null,
    },
  );
  assert.deepEqual(assignedRoles, [
    { guildId: "guild-1", userId: "user-1", platform: "playstation" },
  ]);
  assert.deepEqual(logs, [{ type: "manual", actionedBy: undefined }]);
});

test("PlayStation modal rejects invalid PSN Online IDs", async () => {
  const service = createService({ configs: [createConfig()] });

  for (const psnId of ["ab", "1Player", "Player!", "PlayerNameThatIsTooLong", "   "]) {
    const response = await handlePlayStationLinkModalSubmit(createModalInteraction(psnId), service);
    const body = JSON.parse(await response.text());
    assert.match(body.data.content, /Invalid PSN Online ID/, psnId);
  }
});

test("PlayStation manual-link accepts admin override IDs that fail strict PSN validation", async () => {
  const links: PlatformLink[] = [];
  const service = createService({ links, configs: [createConfig()] });

  const response = await handlePlayStationManualLinkCommand(
    createCommandInteraction("manual-link", [
      { type: 6, name: "user", value: "target-1" },
      { type: 3, name: "psn_id", value: "legacy id with spaces" },
    ]),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Manually linked/);
  const [savedLink] = await service.listLinks("guild-1", "playstation");
  assert.equal(savedLink?.platformId, "legacy id with spaces");
  assert.equal(savedLink?.actionedByUserId, "user-1");
});

test("PlayStation setup persists supplied config", async () => {
  const configs: PlatformLinkConfig[] = [];
  const service = createService({ configs });

  const response = await handlePlayStationLinkSetupCommand(
    createCommandInteraction("setup", [
      { type: 8, name: "psn_linked_role", value: "role-1" },
      { type: 7, name: "log_channel", value: "channel-logs" },
      { type: 3, name: "panel_title", value: "Join PlayStation" },
      { type: 3, name: "panel_description", value: "Type your PSN Online ID." },
      { type: 3, name: "panel_button_label", value: "Link PS" },
      { type: 3, name: "panel_button_style", value: "Success" },
      { type: 5, name: "allow_relink", value: false },
      { type: 5, name: "allow_multiple_links", value: true },
    ]),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Setup saved/);
  const savedConfig = await service.readConfig("guild-1", "playstation");
  assert.deepEqual(
    {
      platform: savedConfig?.platform,
      linkedRoleId: savedConfig?.linkedRoleId,
      logChannelId: savedConfig?.logChannelId,
      panelTitle: savedConfig?.panelTitle,
      panelDescription: savedConfig?.panelDescription,
      panelButtonLabel: savedConfig?.panelButtonLabel,
      panelButtonStyle: savedConfig?.panelButtonStyle,
      allowRelink: savedConfig?.allowRelink,
      allowMultipleLinks: savedConfig?.allowMultipleLinks,
    },
    {
      platform: "playstation",
      linkedRoleId: "role-1",
      logChannelId: "channel-logs",
      panelTitle: "Join PlayStation",
      panelDescription: "Type your PSN Online ID.",
      panelButtonLabel: "Link PS",
      panelButtonStyle: "Success",
      allowRelink: false,
      allowMultipleLinks: true,
    },
  );
});

test("PlayStation setup uses White-Label Bot display name in default description", async () => {
  const configs: PlatformLinkConfig[] = [];
  const service = createService({ configs });

  const response = await handlePlayStationLinkSetupCommand(
    createCommandInteraction("setup", [
      { type: 8, name: "psn_linked_role", value: "role-1" },
      { type: 7, name: "log_channel", value: "channel-logs" },
    ]),
    service,
    async () => "Custom Bot",
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Setup saved/);
  const savedConfig = await service.readConfig("guild-1", "playstation");
  assert.match(savedConfig?.panelDescription ?? "", /Custom Bot stores the PSN Online ID/);
  assert.doesNotMatch(savedConfig?.panelDescription ?? "", /HAF Bot/);
});

test("PlayStation panel command posts a link button", async () => {
  const service = createService({
    configs: [
      createConfig({
        panelTitle: "Join PlayStation",
        panelDescription: "Type your PSN Online ID.",
        panelButtonLabel: "Link PS",
        panelButtonStyle: "Success",
      }),
    ],
  });
  const originalFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedRequests.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "message-1" }), { status: 200 });
  }) as typeof fetch;

  try {
    const response = await handlePlayStationPanelCommand(
      createCommandInteraction("panel", []),
      service,
      "bot-token",
    );
    const body = JSON.parse(await response.text());
    const request = capturedRequests[0];
    assert.ok(request);
    const payload = JSON.parse(String(request.init?.body));

    assert.match(body.data.content, /panel posted/);
    assert.match(request.url, /\/channels\/channel-1\/messages/);
    assert.equal(payload.embeds[0].title, "Join PlayStation");
    assert.equal(payload.components[0].components[0].custom_id, "playstation_link_button");
    assert.equal(payload.components[0].components[0].label, "Link PS");
    assert.equal(payload.components[0].components[0].style, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlayStation request command posts a button without an embed", async () => {
  const service = createService({
    configs: [createConfig({ panelButtonLabel: "Link PS", panelButtonStyle: "Success" })],
  });
  const originalFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedRequests.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "message-1" }), { status: 200 });
  }) as typeof fetch;

  try {
    const response = await handlePlayStationRequestCommand(
      createCommandInteraction("request", []),
      service,
      "bot-token",
    );
    const body = JSON.parse(await response.text());
    const payload = JSON.parse(String(capturedRequests[0]?.init?.body));

    assert.match(body.data.content, /request posted/);
    assert.equal(payload.embeds, undefined);
    assert.equal(payload.components[0].components[0].custom_id, "playstation_link_button");
    assert.equal(payload.components[0].components[0].label, "Link PS");
    assert.equal(payload.components[0].components[0].style, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlayStation whois displays platform metadata and profile URL", async () => {
  const service = createService({
    links: [createLink({ platformId: "Player_One", linkedAtMs: 1000 })],
    configs: [createConfig()],
  });

  const response = await handlePlayStationWhoisCommand(
    createCommandInteraction("whois", [{ type: 6, name: "user", value: "user-1" }]),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Platform:\*\* PlayStation/);
  assert.match(body.data.content, /PSN Online ID:\*\* Player_One/);
  assert.match(body.data.content, /https:\/\/psnprofiles.com\/Player_One/);
});

test("PlayStation unlink with psn_id removes only the selected link", async () => {
  const links = [
    createLink({ platformId: "Player_One" }),
    createLink({ platformId: "Player_Two" }),
  ];
  const service = createService({ links, configs: [createConfig({ allowMultipleLinks: true })] });

  const response = await handlePlayStationUnlinkCommand(
    createCommandInteraction("unlink", [
      { type: 6, name: "user", value: "user-1" },
      { type: 3, name: "psn_id", value: "Player_One" },
    ]),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Unlinked <@user-1>/);
  assert.deepEqual(
    (await service.listLinks("guild-1", "playstation")).map((link) => link.platformId),
    ["Player_Two"],
  );
});

test("PlayStation linkedcount returns PlayStation link count", async () => {
  const service = createService({
    links: [
      createLink({ platformId: "Player_One" }),
      createLink({ platformId: "Player_Two" }),
      createLink({ platformId: "Player_Three", active: false }),
    ],
  });

  const response = await handlePlayStationLinkedCountCommand(
    createCommandInteraction("linkedcount", []),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /\*\*2\*\*/);
});

test("PlayStation syncroles returns sync result counts", async () => {
  const service = createService({
    syncLinkedRoles: async () => ({ total: 4, fixed: 3, skipped: 1, failed: 0 }),
  });

  const response = await handlePlayStationSyncRolesCommand(
    createCommandInteraction("syncroles", []),
    service,
  );
  const body = JSON.parse(await response.text());

  assert.match(body.data.content, /Linked PlayStation users: \*\*4\*\*/);
  assert.match(body.data.content, /Roles fixed: \*\*3\*\*/);
  assert.match(body.data.content, /Skipped: \*\*1\*\*/);
  assert.match(body.data.content, /Failed: \*\*0\*\*/);
});

function createButtonInteraction(): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    member: { user: { id: "user-1" } },
    data: { custom_id: "playstation_link_button" },
  };
}

function createModalInteraction(value: string): DiscordInteraction {
  return {
    type: 5,
    guild_id: "guild-1",
    member: { user: { id: "user-1" } },
    data: {
      custom_id: "playstation_link_modal",
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: "psn_online_id", value }],
        },
      ],
    },
  };
}

function createCommandInteraction(
  subcommand: string,
  options: Array<Record<string, unknown>>,
): DiscordInteraction {
  return {
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1" } },
    data: {
      name: "playstationlink",
      options: [{ type: 1, name: subcommand, options }],
    },
  };
}

function createConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "playstation",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your PlayStation account",
    panelDescription: "Link your PlayStation account",
    panelButtonLabel: "Link PlayStation",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createLink(overrides: Partial<PlatformLink> = {}): PlatformLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    platform: "playstation",
    platformId: "Player_One",
    linkedAtMs: 1,
    manual: true,
    actionedByUserId: null,
    metadataJson: null,
    active: true,
    ...overrides,
  };
}

function createService(
  options: {
    configs?: PlatformLinkConfig[];
    links?: PlatformLink[];
    assignLinkedRole?: PlatformLinkService["assignLinkedRole"];
    sendLogEmbed?: PlatformLinkService["sendLogEmbed"];
    syncLinkedRoles?: PlatformLinkService["syncLinkedRoles"];
  } = {},
): PlatformLinkService {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.platformLink;
  const ready = (async () => {
    for (const config of options.configs ?? []) await rawStore.upsertPlatformLinkConfig(config);
    for (const link of options.links ?? []) await rawStore.upsertPlatformLink(link);
  })();
  const service = createPlatformLinkService({
    platformLinkStore: afterStoreSeed(rawStore, ready),
    discordBotToken: "token",
  });
  if (options.assignLinkedRole) service.assignLinkedRole = options.assignLinkedRole;
  if (options.sendLogEmbed) service.sendLogEmbed = options.sendLogEmbed;
  if (options.syncLinkedRoles) service.syncLinkedRoles = options.syncLinkedRoles;
  return service;
}
