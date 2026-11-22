import assert from "node:assert/strict";
import test from "node:test";
import type { CommunityToolsService } from "../src/community-tools/service";
import { createWardogsCommunityData } from "../src/wardogs/community-data";
import { DEFAULT_GOLD_VOICE_FORMAT, type GoldPostFormat } from "../src/wardogs/gold-status";
import { createAdminApiHandler } from "./helpers/admin-api";

test("WARDOGS dashboard protects guild settings and only accepts a panel draft", async () => {
  const calls: unknown[] = [];
  let goldChannelId: string | null = null;
  let goldVoiceChannelId: string | null = null;
  let goldVoiceFormat = DEFAULT_GOLD_VOICE_FORMAT;
  let goldPostFormat: GoldPostFormat = "full";
  const communityTools = {
    async readWardogsSettings(guildId: string) {
      calls.push(["read", guildId]);
      return { goldChannelId, goldVoiceChannelId, goldVoiceFormat, goldPostFormat, panel: null };
    },
    async configureWardogsGold(
      guildId: string,
      channelId: string | null | undefined,
      voiceChannelId: string | null | undefined,
      formats: { voiceFormat?: string; postFormat?: GoldPostFormat },
    ) {
      calls.push(["gold", guildId, channelId, voiceChannelId, formats]);
      if (channelId !== undefined) goldChannelId = channelId;
      if (voiceChannelId !== undefined) goldVoiceChannelId = voiceChannelId;
      goldVoiceFormat = formats.voiceFormat ?? goldVoiceFormat;
      goldPostFormat = formats.postFormat ?? goldPostFormat;
    },
    async publishWardogsLinkPanel(
      guildId: string,
      draft: { channelId: string; title: string; description: string },
    ) {
      calls.push(["publish", guildId, draft]);
      return { ...draft, messageId: "600", botUserId: "700" };
    },
  } as unknown as CommunityToolsService;
  const handler = createAdminApiHandler({
    stores: {
      platformLink: {
        async readPlatformLinkConfig() {
          return { enabled: true };
        },
      },
    } as never,
    discordBotToken: "fixture-token",
    communityTools,
    wardogsCommunity: { data: createWardogsCommunityData() },
    adminAccess: {
      authorize: async (request, requirement) => {
        if (
          requirement.guildId === "100" &&
          (requirement.mode === "read" || request.headers.has("x-test-admin"))
        )
          return { ok: true };
        return { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } };
      },
    },
  });
  const url = new URL("https://haf.example/admin/api/wardogs/community");
  const read = async (guildId: string) => {
    const target = new URL(url);
    target.searchParams.set("guildId", guildId);
    return handler(new Request(target), target);
  };
  const post = (body: Record<string, unknown>, admin = false) =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(admin ? { "x-test-admin": "1" } : {}) },
        body: JSON.stringify({ guildId: "100", workspaceId: "workspace-a", ...body }),
      }),
      url,
    );
  const draft = {
    action: "publish-panel",
    channelId: "102",
    title: "Link WARDOGS",
    description: "",
  };

  assert.equal((await read("200")).status, 403);
  assert.equal((await post(draft)).status, 403);
  assert.equal((await post({ ...draft, messageId: "800" }, true)).status, 400);
  assert.deepEqual(calls, []);
  const initial = await read("100");
  assert.equal(initial.status, 200);
  assert.equal(((await initial.json()) as { canWrite: boolean }).canWrite, false);
  const published = await post(draft, true);
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json(), {
    panel: { channelId: "102", messageId: "600", title: "Link WARDOGS", description: "" },
  });
  assert.equal((await post({ action: "gold", channelId: "110" }, true)).status, 200);
  const voice = { action: "gold", voiceChannelId: "111" };
  assert.equal((await post(voice)).status, 403);
  assert.equal((await post({ ...voice, voiceChannelId: "not-a-channel" }, true)).status, 400);
  const saved = await post(voice, true);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    goldChannelId: "110",
    goldVoiceChannelId: "111",
    goldVoiceFormat: DEFAULT_GOLD_VOICE_FORMAT,
    goldPostFormat: "full",
  });
  const formats = { voiceFormat: "Gold {price} ({change})", postFormat: "chart" };
  assert.equal((await post({ action: "gold", ...formats })).status, 403);
  assert.equal((await post({ action: "gold", voiceFormat: "{count}" }, true)).status, 400);
  assert.equal((await post({ action: "gold", postFormat: "unknown" }, true)).status, 400);
  const savedFormats = await post({ action: "gold", ...formats }, true);
  assert.equal(savedFormats.status, 200);
  assert.deepEqual(await savedFormats.json(), {
    goldChannelId: "110",
    goldVoiceChannelId: "111",
    goldVoiceFormat: formats.voiceFormat,
    goldPostFormat: formats.postFormat,
  });
  assert.deepEqual(calls, [
    ["read", "100"],
    ["publish", "100", { title: draft.title, description: "", channelId: "102" }],
    ["gold", "100", "110", undefined, { voiceFormat: undefined, postFormat: undefined }],
    ["read", "100"],
    ["gold", "100", undefined, "111", { voiceFormat: undefined, postFormat: undefined }],
    ["read", "100"],
    ["gold", "100", undefined, undefined, formats],
    ["read", "100"],
  ]);
});
