import { rethrowDiscordRateLimit } from "./interaction-rate-limit";
import { buildEphemeralMessage, hasGuildAdminPermission } from "../discord-interactions";
import {
  buildConsideredReplyModal,
  buildSuggestionCategoryPicker,
  buildSuggestionEditModal,
  buildSuggestionSubmissionModal,
  SUGGESTION_CREATE_CUSTOM_ID,
  SUGGESTION_MODAL_CUSTOM_ID,
} from "../discord/suggestions";
import { SuggestionDomainError, type SuggestionService } from "../services/suggestion-service";
import type { ConsideredReplyPerspective, SuggestionMemberContext } from "../suggestions";
import type { DiscordInteraction } from "./app-types";
import { isRecord } from "../unknown-parse";
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

const PREFIX = "suggestions:";

export function isSuggestionInteraction(interaction: DiscordInteraction): boolean {
  return getInteractionCustomId(interaction)?.startsWith(PREFIX) === true;
}

export async function handleSuggestionComponentInteraction(
  interaction: DiscordInteraction,
  service: SuggestionService,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!customId || !guildId || !userId) return ephemeral("Unable to identify this interaction.");
  try {
    if (customId === SUGGESTION_CREATE_CUSTOM_ID) {
      const config = await service.getConfig(guildId);
      return Response.json(
        config.categories.length > 0
          ? buildSuggestionCategoryPicker(config)
          : buildSuggestionSubmissionModal(config),
      );
    }
    const parts = customId.split(":");
    if (parts[1] === "category") {
      const values =
        isRecord(interaction.data) && Array.isArray(interaction.data.values)
          ? interaction.data.values
          : [];
      const selected = typeof values[0] === "string" && values[0] !== "__none__" ? values[0] : null;
      return Response.json(
        buildSuggestionSubmissionModal(await service.getConfig(guildId), selected),
      );
    }
    if (parts[1] === "duplicate-confirm" && parts[2]) {
      const suggestion = await service.confirmDuplicateSubmission(guildId, parts[2], userId);
      return ephemeral(`Suggestion created: **${suggestion.title}**`);
    }
    if (parts[1] === "vote" && parts[2] && parts[3]) {
      const action = parts[2];
      if (action !== "support" && action !== "oppose" && action !== "remove") {
        return ephemeral("Unknown vote action.");
      }
      const suggestion = await service.setVote({
        guildId,
        suggestionId: parts[3],
        memberId: userId,
        value: action === "remove" ? null : action,
        member: memberContext(interaction),
      });
      return ephemeral(
        action === "remove"
          ? "Your Suggestion Vote was removed."
          : `Your **${action === "support" ? "Support" : "Oppose"}** vote was recorded. Participation: ${suggestion.supportCount + suggestion.opposeCount}.`,
      );
    }
    if (parts[1] === "reply" && parts[2]) {
      return Response.json(buildConsideredReplyModal(parts[2]));
    }
    if (parts[1] === "edit" && parts[2]) {
      const suggestion = await service.getSuggestion(guildId, parts[2]);
      if (suggestion.authorId !== userId)
        return ephemeral("Only the Suggestion author may edit it.");
      return Response.json(buildSuggestionEditModal(suggestion, await service.getConfig(guildId)));
    }
    if (parts[1] === "author-status" && parts[2] && parts[3]) {
      const suggestion = await service.getSuggestion(guildId, parts[2]);
      const next = suggestion.status === "needs_work" ? "gathering_feedback" : "needs_work";
      await service.transition({
        guildId,
        suggestionId: suggestion.id,
        actorUserId: userId,
        actorRoleIds: roleIds(interaction),
        isGuildAdmin: isAdmin(interaction),
        isAuthor: suggestion.authorId === userId,
        expectedRevision: Number(parts[3]),
        toStatus: next,
      });
      return ephemeral(
        next === "needs_work"
          ? "Suggestion marked Needs Work."
          : "Suggestion is gathering feedback.",
      );
    }
    if (parts[1] === "reply-resolution" && parts[2] && parts[3]) {
      const action = parts[2];
      if (action !== "keep" && action !== "restore" && action !== "delete") {
        return ephemeral("Unknown queue action.");
      }
      const reply = await service.getConsideredReplyTarget(parts[3]);
      if (!isInteractionBoundToGuild(interaction, reply.guildId)) {
        return ephemeral(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE);
      }
      if (action === "delete") {
        return Response.json({
          type: 9,
          data: {
            custom_id: await signSensitiveComponentId(
              `suggestions:reply-delete-submit:${parts[3]}`,
              componentIdSigner,
              { guildId },
            ),
            title: "Hard Delete Considered Reply",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "reason",
                    label: "Reason",
                    style: 2,
                    required: true,
                    max_length: 500,
                  },
                ],
              },
            ],
          },
        });
      }
      await service.resolveCollapsedReply({
        guildId,
        replyId: parts[3],
        actorUserId: userId,
        actorRoleIds: roleIds(interaction),
        isGuildAdmin: isAdmin(interaction),
        action: action === "keep" ? "keep-collapsed" : "restore",
      });
      return ephemeral(action === "keep" ? "Reply kept collapsed." : "Reply restored.");
    }
    return ephemeral("Unknown Suggestions action.");
  } catch (error) {
    rethrowDiscordRateLimit(error);
    return ephemeral(domainMessage(error));
  }
}

export async function handleSuggestionModalSubmitInteraction(
  interaction: DiscordInteraction,
  service: SuggestionService,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const guildId = interaction.guild_id;
  const userId = getInteractionUserId(interaction);
  if (!customId || !guildId || !userId) return ephemeral("Unable to identify this interaction.");
  const fields = parseInteractionModalFieldValues(interaction);
  try {
    if (
      customId === SUGGESTION_MODAL_CUSTOM_ID ||
      customId.startsWith(`${SUGGESTION_MODAL_CUSTOM_ID}:`)
    ) {
      const config = await service.getConfig(guildId);
      const category = customId.startsWith(`${SUGGESTION_MODAL_CUSTOM_ID}:`)
        ? decodeURIComponent(customId.slice(SUGGESTION_MODAL_CUSTOM_ID.length + 1))
        : null;
      const result = await service.submit({
        guildId,
        authorId: userId,
        title: fields["suggestion-title"] ?? "",
        answers: config.prompts.map((prompt) => ({
          promptId: prompt.id,
          promptLabel: prompt.label,
          answer: fields[`prompt-${prompt.id}`] ?? "",
        })),
        category,
      });
      if (result.kind === "created") {
        return ephemeral(`Suggestion created: **${result.suggestion.title}**`);
      }
      return Response.json({
        type: 4,
        data: {
          content: `Similar active Suggestions were found:\n${result.matches.map((match) => `• **${match.title}**`).join("\n")}\n\nThis warning does not block submission.`,
          flags: 64,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Submit Anyway",
                  custom_id: `suggestions:duplicate-confirm:${result.pending.id}`,
                },
              ],
            },
          ],
        },
      });
    }
    const parts = customId.split(":");
    if (parts[1] === "reply-submit" && parts[2]) {
      const perspective = parsePerspective(fields.perspective);
      if (!perspective)
        return ephemeral("Perspective must be Support, Oppose, Mixed, or Question.");
      await service.addConsideredReply({
        guildId,
        suggestionId: parts[2],
        authorId: userId,
        perspective,
        reasoning: fields.reasoning ?? "",
        improvement: fields.improvement,
      });
      return ephemeral("Your Considered Reply was posted.");
    }
    if (parts[1] === "edit-submit" && parts[2] && parts[3]) {
      const config = await service.getConfig(guildId);
      const current = await service.getSuggestion(guildId, parts[2]);
      await service.revise({
        guildId,
        suggestionId: parts[2],
        authorId: userId,
        expectedRevision: Number(parts[3]),
        title: fields["suggestion-title"] ?? "",
        category: current.category,
        answers: config.prompts.map((prompt) => ({
          promptId: prompt.id,
          promptLabel: prompt.label,
          answer: fields[`prompt-${prompt.id}`] ?? "",
        })),
      });
      return ephemeral("Suggestion updated and its prior revision was preserved.");
    }
    if (parts[1] === "reply-delete-submit" && parts[2]) {
      const reply = await service.getConsideredReplyTarget(parts[2]);
      if (!isInteractionBoundToGuild(interaction, reply.guildId)) {
        return ephemeral(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE);
      }
      await service.resolveCollapsedReply({
        guildId,
        replyId: parts[2],
        actorUserId: userId,
        actorRoleIds: roleIds(interaction),
        isGuildAdmin: isAdmin(interaction),
        action: "hard-delete",
        reason: fields.reason,
      });
      return ephemeral("Reply hard-deleted.");
    }
    return ephemeral("Unknown Suggestions modal.");
  } catch (error) {
    rethrowDiscordRateLimit(error);
    return ephemeral(domainMessage(error));
  }
}

function memberContext(interaction: DiscordInteraction): SuggestionMemberContext {
  const joined = interaction.member?.joined_at;
  return {
    isBot: false,
    isGuildMember: Boolean(interaction.member),
    roleIds: roleIds(interaction),
    joinedAtMs: joined ? Date.parse(joined) : null,
  };
}

function roleIds(interaction: DiscordInteraction): string[] {
  return Array.isArray(interaction.member?.roles)
    ? interaction.member.roles.filter((value): value is string => typeof value === "string")
    : [];
}

function isAdmin(interaction: DiscordInteraction): boolean {
  return hasGuildAdminPermission(interaction.member?.permissions ?? "0");
}

function parsePerspective(value: string | undefined): ConsideredReplyPerspective | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "support" ||
    normalized === "oppose" ||
    normalized === "mixed" ||
    normalized === "question"
    ? normalized
    : null;
}

function domainMessage(error: unknown): string {
  if (error instanceof SuggestionDomainError) return error.message;
  return "Suggestions could not complete that action. Please try again.";
}

function ephemeral(content: string): Response {
  return Response.json(buildEphemeralMessage(content));
}
