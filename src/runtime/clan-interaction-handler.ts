import {
  buildClanRequestModalId,
  buildClanReviewReasonModalId,
  parseClanInteractionId,
  type ClanRecruitmentState,
  type ClanRequest,
} from "../clans";
import { editOriginalInteractionResponse } from "../discord";
import { buildEphemeralMessage } from "../discord-interactions";
import {
  DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_MODAL_RESPONSE,
} from "../discord/constants";
import type { ClanService } from "../services/clan-service";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import {
  getInteractionCustomId,
  getInteractionUserId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import {
  GUILD_BOUND_INTERACTION_DENIAL_MESSAGE,
  isInteractionBoundToGuild,
} from "./interaction-guild-binding";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveComponentId } from "../security/sensitive-component-ids";

export function isClanInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return typeof customId === "string" && parseClanInteractionId(customId) !== null;
}

export async function handleClanComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  service: ClanService,
  waitUntil?: (promise: Promise<unknown>) => void,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const parsed = parseClanInteractionId(getInteractionCustomId(interaction) ?? "");
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!parsed || !guildId || !userId)
    return Response.json(buildEphemeralMessage("Unsupported Clan interaction."));

  if (parsed.action === "request") {
    const existing = await stores.clans?.readPendingRequestByRequester(guildId, userId);
    if (existing?.status === "pending") {
      return Response.json(
        buildEphemeralMessage(
          existing.reviewChannelId
            ? `Your Clan Request is already being reviewed in <#${existing.reviewChannelId}>.`
            : "Your Clan Request is already pending review.",
        ),
      );
    }
    return Response.json(buildClanRequestModal(existing ?? undefined));
  }

  if (parsed.action === "revise") {
    const request = await stores.clans?.readRequest(guildId, parsed.requestId);
    if (!request || request.requesterId !== userId || request.status !== "changes-requested")
      return Response.json(buildEphemeralMessage("This Clan Request cannot be revised by you."));
    return Response.json(buildClanRequestModal(request));
  }

  if (parsed.action === "review") {
    const request = await stores.clans?.readRequestById(parsed.requestId);
    if (!request || !isInteractionBoundToGuild(interaction, request.guildId)) {
      return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
    }
    if (parsed.decision !== "approve") {
      return Response.json({
        type: DISCORD_MODAL_RESPONSE,
        data: {
          custom_id: await signSensitiveComponentId(
            buildClanReviewReasonModalId(
              { id: parsed.requestId, revision: parsed.revision },
              parsed.decision,
            ),
            componentIdSigner,
            { guildId },
          ),
          title: parsed.decision === "reject" ? "Reject Clan Request" : "Request Clan Changes",
          components: [textInput("review_reason", "Reason", true, 1000, undefined, 2)],
        },
      });
    }
    return deferClanAction(interaction, waitUntil, async () => {
      await service.reviewRequest({
        guildId,
        requestId: parsed.requestId,
        reviewerId: userId,
        reviewerRoleIds: memberRoleIds(interaction),
        isGuildAdmin: hasAdministratorPermission(interaction.member?.permissions),
        expectedRevision: parsed.revision,
        decision: "approve",
      });
      return `Clan Request approved and provisioned by <@${userId}>.`;
    });
  }

  return Response.json(buildEphemeralMessage("Unsupported Clan interaction."));
}

export async function handleClanModalSubmitInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  service: ClanService,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const parsed = parseClanInteractionId(getInteractionCustomId(interaction) ?? "");
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!parsed || !guildId || !userId)
    return Response.json(buildEphemeralMessage("Unsupported Clan form."));
  const fields = parseInteractionModalFieldValues(interaction);

  if (parsed.action === "request-modal") {
    if (parsed.requestId) {
      const request = await stores.clans?.readRequestById(parsed.requestId);
      if (!request || !isInteractionBoundToGuild(interaction, request.guildId)) {
        return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
      }
    }
    return deferClanAction(interaction, waitUntil, async () => {
      const recruitmentState = parseRecruitment(fields.recruitment ?? "");
      let request: ClanRequest;
      if (parsed.requestId && parsed.revision) {
        request = await service.reviseRequest({
          guildId,
          requestId: parsed.requestId,
          requesterId: userId,
          expectedRevision: parsed.revision,
          name: fields.name ?? "",
          tag: fields.tag ?? "",
          description: fields.description ?? "",
          focus: fields.focus ?? "",
          recruitmentState,
        });
      } else {
        const createdAtMs = Number(BigInt(userId) >> 22n) + 1_420_070_400_000;
        const rawMember = interaction.member as typeof interaction.member & { joined_at?: string };
        request = await service.submitRequest({
          guildId,
          requesterId: userId,
          name: fields.name ?? "",
          tag: fields.tag ?? "",
          description: fields.description ?? "",
          focus: fields.focus ?? "",
          recruitmentState,
          eligibility: {
            isBot: false,
            roleIds: memberRoleIds(interaction),
            accountCreatedAtMs: createdAtMs,
            guildJoinedAtMs: rawMember?.joined_at ? Date.parse(rawMember.joined_at) : createdAtMs,
          },
        });
      }
      const current = await stores.clans?.readRequest(guildId, request.id);
      return current?.reviewChannelId
        ? `Your Clan Request is ready for review in <#${current.reviewChannelId}>.`
        : "Your Clan Request was submitted. Its private review ticket is being prepared.";
    });
  }

  if (parsed.action === "review-reason") {
    const request = await stores.clans?.readRequestById(parsed.requestId);
    if (!request || !isInteractionBoundToGuild(interaction, request.guildId)) {
      return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
    }
    return deferClanAction(interaction, waitUntil, async () => {
      await service.reviewRequest({
        guildId,
        requestId: parsed.requestId,
        reviewerId: userId,
        reviewerRoleIds: memberRoleIds(interaction),
        isGuildAdmin: hasAdministratorPermission(interaction.member?.permissions),
        expectedRevision: parsed.revision,
        decision: parsed.decision,
        reason: fields.review_reason ?? "",
      });
      return parsed.decision === "reject"
        ? `Clan Request rejected by <@${userId}>.`
        : `Changes requested by <@${userId}>.`;
    });
  }

  return Response.json(buildEphemeralMessage("Unsupported Clan form."));
}

function buildClanRequestModal(request?: ClanRequest) {
  return {
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id: buildClanRequestModalId(request),
      title: request ? "Revise Clan Request" : "Create a Clan",
      components: [
        textInput("name", "Clan name", true, 100, request?.name),
        textInput("tag", "Clan tag", true, 12, request?.tag),
        textInput("description", "Description", true, 1000, request?.description, 2),
        textInput("focus", "Game or platform focus", true, 200, request?.focus),
        textInput(
          "recruitment",
          "Recruitment: open, invite, or closed",
          true,
          20,
          request ? formatRecruitment(request.recruitmentState) : "open",
        ),
      ],
    },
  };
}

function textInput(
  customId: string,
  label: string,
  required: boolean,
  maxLength: number,
  value?: string,
  style = 1,
) {
  return {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: customId,
        label,
        style,
        required,
        max_length: maxLength,
        ...(value ? { value } : {}),
      },
    ],
  };
}

function memberRoleIds(interaction: DiscordInteraction): string[] {
  return Array.isArray(interaction.member?.roles)
    ? interaction.member.roles.filter((id): id is string => typeof id === "string")
    : [];
}

function hasAdministratorPermission(value: string | undefined): boolean {
  try {
    return (BigInt(value ?? "0") & 8n) === 8n;
  } catch {
    return false;
  }
}

function parseRecruitment(value: string): ClanRecruitmentState {
  switch (value.trim().toLowerCase()) {
    case "open":
    case "applications open":
    case "applications-open":
      return "applications-open";
    case "invite":
    case "invite only":
    case "invite-only":
      return "invite-only";
    case "closed":
      return "closed";
    default:
      throw new Error("Recruitment must be open, invite, or closed.");
  }
}

function formatRecruitment(value: ClanRecruitmentState): string {
  return value === "applications-open" ? "open" : value === "invite-only" ? "invite" : "closed";
}

function deferClanAction(
  interaction: DiscordInteraction,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  action: () => Promise<string>,
): Promise<Response> {
  if (!waitUntil) {
    return action()
      .then((message) => Response.json(buildEphemeralMessage(message)))
      .catch((error) =>
        Response.json(
          buildEphemeralMessage(error instanceof Error ? error.message : "Clan action failed."),
        ),
      );
  }
  waitUntil(
    action()
      .then((message) => updateDeferred(interaction, message))
      .catch((error) =>
        updateDeferred(interaction, error instanceof Error ? error.message : "Clan action failed."),
      ),
  );
  return Promise.resolve(
    Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    }),
  );
}

async function updateDeferred(interaction: DiscordInteraction, content: string): Promise<void> {
  if (!interaction.application_id || !interaction.token) return;
  await editOriginalInteractionResponse(interaction.application_id, interaction.token, {
    content,
    allowed_mentions: { parse: [] },
  });
}
