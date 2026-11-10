import { DISCORD_API, DiscordApiError, discordGetJson, discordRequest } from "./client";
import type { ClanChannelInput } from "../services/clan-service";
import {
  buildClanRequestButtonId,
  buildClanReviseButtonId,
  buildClanReviewButtonId,
  type Clan,
  type ClanManagementConfig,
  type ClanRequest,
} from "../clans";
import type { DiscordChannelResource } from "./guilds";
import { listGuildRoles } from "./guilds";
import { modifyChannel } from "./channels";
import { createChannelMessage, deleteChannel, editChannelMessage } from "./messages";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

export async function createClanCategory(
  guildId: string,
  name: string,
  token: string,
): Promise<{ id: string }> {
  return createGuildChannel(guildId, { name, type: 4 }, token);
}

export async function createClanRole(
  guildId: string,
  name: string,
  token: string,
): Promise<{ id: string }> {
  const response = await discordRequest(`${DISCORD_API}/guilds/${guildId}/roles`, "POST", token, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, permissions: "0", mentionable: false }),
  });
  return { id: ((await response.json()) as { id: string }).id };
}

export async function deleteClanRole(
  guildId: string,
  roleId: string,
  token: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${guildId}/roles/${roleId}`,
    "DELETE",
    token,
  );
  response.body?.cancel();
}

export async function createClanTextChannel(
  input: ClanChannelInput,
  token: string,
): Promise<{ id: string }> {
  return createGuildChannel(
    input.guildId,
    {
      name: input.name,
      type: 0,
      parent_id: input.parentId,
      permission_overwrites: clanOverwrites(input, false),
    },
    token,
  );
}

export async function createClanVoiceChannel(
  input: ClanChannelInput,
  token: string,
): Promise<{ id: string }> {
  return createGuildChannel(
    input.guildId,
    {
      name: input.name,
      type: 2,
      parent_id: input.parentId,
      permission_overwrites: clanOverwrites(input, true),
    },
    token,
  );
}

export async function upsertClanRequestPanel(
  config: ClanManagementConfig,
  token: string,
): Promise<{ messageId: string }> {
  if (!config.requestPanelChannelId) throw new Error("Clan request panel channel is unavailable.");
  const body = {
    embeds: [
      {
        title: config.requestPanelTitle ?? "Create a Clan",
        description:
          config.requestPanelDescription ?? "Submit a Clan creation request for staff review.",
        color: config.requestPanelColor ?? 0x5865f2,
        footer: { text: "A private review ticket will be created after submission." },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            custom_id: buildClanRequestButtonId(),
            label: config.requestPanelButtonLabel ?? "Create Clan",
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
  let message;
  try {
    message = config.requestPanelMessageId
      ? await editChannelMessage(
          config.requestPanelChannelId,
          config.requestPanelMessageId,
          body,
          token,
        )
      : await createChannelMessage(config.requestPanelChannelId, body, token);
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404) throw error;
    message = await createChannelMessage(config.requestPanelChannelId, body, token);
  }
  return { messageId: message.id };
}

export async function createClanRequestReviewTicket(
  input: {
    request: ClanRequest;
    config: ClanManagementConfig;
    botUserId: string;
  },
  token: string,
  componentIdSigner?: ComponentIdSigner,
): Promise<{ channelId: string; messageId: string }> {
  if (!input.config.requestReviewCategoryId)
    throw new Error("Clan review-ticket category is unavailable.");
  const channel = await createGuildChannel(
    input.request.guildId,
    {
      name: requestChannelName(input.request),
      type: 0,
      parent_id: input.config.requestReviewCategoryId,
      permission_overwrites: requestReviewOverwrites(input, false),
      topic: `Clan creation request ${input.request.id} from ${input.request.requesterId}`,
    },
    token,
  );
  try {
    const message = await createChannelMessage(
      channel.id,
      await signSensitiveMessageComponentIds(
        buildRequestReviewMessage(input.request),
        componentIdSigner,
        { guildId: input.request.guildId },
      ),
      token,
    );
    return { channelId: channel.id, messageId: message.id };
  } catch (error) {
    await deleteChannel(channel.id, token).catch(() => undefined);
    throw error;
  }
}

export async function updateClanRequestReviewTicket(
  input: {
    request: ClanRequest;
    config: ClanManagementConfig;
    botUserId: string;
  },
  token: string,
  componentIdSigner?: ComponentIdSigner,
): Promise<void> {
  if (!input.request.reviewChannelId || !input.request.reviewMessageId) return;
  await editChannelMessage(
    input.request.reviewChannelId,
    input.request.reviewMessageId,
    await signSensitiveMessageComponentIds(
      buildRequestReviewMessage(input.request),
      componentIdSigner,
      { guildId: input.request.guildId },
    ),
    token,
  );
  if (input.request.status === "approved" || input.request.status === "rejected") {
    await modifyChannel(
      input.request.reviewChannelId,
      {
        name: `closed-${requestChannelName(input.request)}`.slice(0, 100),
        permission_overwrites: requestReviewOverwrites(input, true),
      },
      token,
    );
  }
}

export async function setClanArchivedPermissions(
  input: {
    guildId: string;
    clan: Clan;
    archived: boolean;
    botUserId: string;
    staffRoleIds: string[];
  },
  token: string,
): Promise<void> {
  if (!input.clan.roleId) throw new Error("Clan Role is unavailable.");
  const common: ClanChannelInput = {
    guildId: input.guildId,
    parentId: "",
    name: "",
    clanRoleId: input.clan.roleId,
    botUserId: input.botUserId,
    staffRoleIds: input.staffRoleIds,
  };
  if (input.clan.textChannelId) {
    await modifyChannel(
      input.clan.textChannelId,
      { permission_overwrites: clanOverwrites(common, false, input.archived) },
      token,
    );
  }
  if (input.clan.voiceChannelId) {
    await modifyChannel(
      input.clan.voiceChannelId,
      { permission_overwrites: clanOverwrites(common, true, input.archived) },
      token,
    );
  }
}

export async function inspectClanResources(
  input: { guildId: string; clan: Clan; categoryId: string | null },
  token: string,
): Promise<string[]> {
  const missing: string[] = [];
  const roles = await listGuildRoles(input.guildId, token);
  if (!input.clan.roleId || !roles.some((role) => role.id === input.clan.roleId))
    missing.push("role");
  for (const [label, channelId] of [
    ["category", input.categoryId],
    ["text channel", input.clan.textChannelId],
    ["voice channel", input.clan.voiceChannelId],
  ] as const) {
    if (!channelId || !(await channelExists(channelId, token))) missing.push(label);
  }
  return missing;
}

async function createGuildChannel(
  guildId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ id: string }> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${guildId}/channels`,
    "POST",
    token,
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const channel = (await response.json()) as DiscordChannelResource;
  return { id: channel.id };
}

function requestChannelName(request: ClanRequest): string {
  const identity = `${request.tag}-${request.name}`
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `clan-${identity || request.id.slice(0, 8)}`.slice(0, 100);
}

function requestReviewOverwrites(
  input: { request: ClanRequest; config: ClanManagementConfig; botUserId: string },
  closed: boolean,
) {
  const access = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;
  return [
    { id: input.request.guildId, type: 0, allow: "0", deny: String(VIEW_CHANNEL) },
    { id: input.botUserId, type: 1, allow: String(access), deny: "0" },
    {
      id: input.request.requesterId,
      type: 1,
      allow: String(closed ? VIEW_CHANNEL | READ_MESSAGE_HISTORY : access),
      deny: String(closed ? SEND_MESSAGES : 0n),
    },
    ...input.config.reviewerRoleIds.map((id) => ({
      id,
      type: 0,
      allow: String(access),
      deny: "0",
    })),
  ];
}

function buildRequestReviewMessage(request: ClanRequest) {
  const status = request.status.replaceAll("-", " ");
  const fields = [
    { name: "Requester", value: `<@${request.requesterId}>\n${request.requesterId}`, inline: true },
    { name: "Clan", value: `${request.name} [${request.tag}]`, inline: true },
    { name: "Revision", value: String(request.revision), inline: true },
    { name: "Focus", value: request.focus, inline: false },
    { name: "Recruitment", value: request.recruitmentState.replaceAll("-", " "), inline: true },
    { name: "Description", value: request.description, inline: false },
    ...(request.proposedOfficerIds.length
      ? [
          {
            name: "Proposed officers",
            value: request.proposedOfficerIds.map((id) => `<@${id}>`).join(", "),
            inline: false,
          },
        ]
      : []),
    ...(request.reviewReason
      ? [{ name: "Review reason", value: request.reviewReason, inline: false }]
      : []),
  ];
  const components =
    request.status === "pending"
      ? [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3,
                custom_id: buildClanReviewButtonId(request, "approve"),
                label: "Approve",
              },
              {
                type: 2,
                style: 2,
                custom_id: buildClanReviewButtonId(request, "request-changes"),
                label: "Request changes",
              },
              {
                type: 2,
                style: 4,
                custom_id: buildClanReviewButtonId(request, "reject"),
                label: "Reject",
              },
            ],
          },
        ]
      : request.status === "changes-requested"
        ? [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  custom_id: buildClanReviseButtonId(request.id),
                  label: "Revise request",
                },
              ],
            },
          ]
        : [];
  return {
    content: `<@${request.requesterId}>`,
    embeds: [
      {
        title: `Clan creation review — ${request.name}`,
        description: `Status: **${status}**`,
        color:
          request.status === "approved"
            ? 0x57f287
            : request.status === "rejected"
              ? 0xed4245
              : request.status === "changes-requested"
                ? 0xfee75c
                : 0x5865f2,
        fields,
        footer: { text: `Request ${request.id}` },
      },
    ],
    components,
    allowed_mentions: { parse: [], users: [request.requesterId] },
  };
}

function clanOverwrites(input: ClanChannelInput, voice: boolean, archived = false) {
  const access = voice
    ? VIEW_CHANNEL | CONNECT | SPEAK
    : VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;
  const archivedAllow = voice ? VIEW_CHANNEL : VIEW_CHANNEL | READ_MESSAGE_HISTORY;
  const archivedDeny = voice ? CONNECT | SPEAK : SEND_MESSAGES;
  return [
    { id: input.guildId, type: 0, allow: "0", deny: String(VIEW_CHANNEL) },
    {
      id: input.clanRoleId,
      type: 0,
      allow: String(archived ? archivedAllow : access),
      deny: String(archived ? archivedDeny : 0n),
    },
    { id: input.botUserId, type: 1, allow: String(access), deny: "0" },
    ...input.staffRoleIds.map((id) => ({ id, type: 0, allow: String(access), deny: "0" })),
  ];
}

async function channelExists(channelId: string, token: string): Promise<boolean> {
  try {
    await discordGetJson<DiscordChannelResource>(`${DISCORD_API}/channels/${channelId}`, token);
    return true;
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return false;
    throw error;
  }
}
