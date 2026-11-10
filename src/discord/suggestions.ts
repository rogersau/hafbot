import type {
  ConsideredReply,
  Suggestion,
  SuggestionsConfig,
  SuggestionStatus,
} from "../suggestions";
import type { SuggestionProjection } from "../services/suggestion-service";
import type { GuildResourceValidator } from "./guild-resource-validator";
import { createForumThread, modifyThread } from "./threads";
import {
  createChannelMessage,
  createReaction,
  createUserDmMessage,
  editChannelMessage,
  suppressMentions,
  type CreateChannelMessageInput,
  type DiscordEmbed,
} from "./messages";
import { DISCORD_API, discordRequest, discordRawRequest, parseDiscordJson } from "./client";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";

const STATUS_LABELS: Record<SuggestionStatus, string> = {
  gathering_feedback: "Gathering Feedback",
  needs_work: "Needs Work",
  under_review: "Under Review",
  planned: "Planned",
  implemented: "Implemented",
  rejected: "Rejected",
};

export const SUGGESTION_CREATE_CUSTOM_ID = "suggestions:create";
export const SUGGESTION_MODAL_CUSTOM_ID = "suggestions:submit";

export function suggestionVoteCustomId(id: string, value: "support" | "oppose" | "remove"): string {
  return `suggestions:vote:${value}:${id}`;
}

export function suggestionReplyCustomId(id: string): string {
  return `suggestions:reply:${id}`;
}

export function consideredReplyResolutionCustomId(
  id: string,
  action: "keep" | "restore" | "delete",
): string {
  return `suggestions:reply-resolution:${action}:${id}`;
}

export function buildSuggestionPanel(config: SuggestionsConfig): CreateChannelMessageInput {
  return {
    embeds: [
      {
        title: config.panelTitle,
        description: config.panelBody,
        color: 0x2b6cb0,
        footer: { text: "hafbot.xyz" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: config.panelButtonText,
            custom_id: SUGGESTION_CREATE_CUSTOM_ID,
          },
        ],
      },
    ],
    allowed_mentions: suppressMentions(),
  };
}

export function buildSuggestionSubmissionModal(
  config: SuggestionsConfig,
  category: string | null = null,
): unknown {
  return {
    type: 9,
    data: {
      custom_id: category
        ? `${SUGGESTION_MODAL_CUSTOM_ID}:${encodeURIComponent(category)}`
        : SUGGESTION_MODAL_CUSTOM_ID,
      title: "Create Suggestion",
      components: [
        modalTextInput("suggestion-title", "Title", true, 100),
        ...config.prompts.map((prompt) =>
          modalTextInput(`prompt-${prompt.id}`, prompt.label, prompt.required, 1000, 2),
        ),
      ],
    },
  };
}

export function buildSuggestionCategoryPicker(config: SuggestionsConfig): unknown {
  return {
    type: 4,
    data: {
      content: "Choose one optional Suggestion Category before continuing.",
      flags: 64,
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "suggestions:category",
              placeholder: "Suggestion Category",
              min_values: 1,
              max_values: 1,
              options: [
                { label: "No category", value: "__none__" },
                ...config.categories.map((category) => ({ label: category, value: category })),
              ],
            },
          ],
        },
      ],
    },
  };
}

export function buildConsideredReplyModal(suggestionId: string): unknown {
  return {
    type: 9,
    data: {
      custom_id: `suggestions:reply-submit:${suggestionId}`,
      title: "Add Considered Reply",
      components: [
        modalTextInput("perspective", "Perspective: Support, Oppose, Mixed, or Question", true, 20),
        modalTextInput("reasoning", "Your reasoning", true, 2000, 2),
        modalTextInput("improvement", "Improvement or alternative (optional)", false, 1000, 2),
      ],
    },
  };
}

export function buildSuggestionEditModal(
  suggestion: Suggestion,
  config: SuggestionsConfig,
): unknown {
  return {
    type: 9,
    data: {
      custom_id: `suggestions:edit-submit:${suggestion.id}:${suggestion.revision}`,
      title: "Edit Suggestion",
      components: [
        modalTextInput("suggestion-title", "Title", true, 100, 1, suggestion.title),
        ...config.prompts.map((prompt) =>
          modalTextInput(
            `prompt-${prompt.id}`,
            prompt.label,
            prompt.required,
            1000,
            2,
            suggestion.answers.find((answer) => answer.promptId === prompt.id)?.answer ?? "",
          ),
        ),
      ],
    },
  };
}

export function buildSuggestionStarter(suggestion: Suggestion): CreateChannelMessageInput {
  const fields = suggestion.answers
    .filter((answer) => answer.answer)
    .map((answer) => ({
      name: answer.promptLabel,
      value: safeField(answer.answer),
      inline: false,
    }));
  fields.push(
    { name: "Status", value: STATUS_LABELS[suggestion.status], inline: true },
    { name: "Category", value: suggestion.category ?? "None", inline: true },
    {
      name: "Votes",
      value: `Support **${suggestion.supportCount}** · Oppose **${suggestion.opposeCount}** · Participation **${suggestion.supportCount + suggestion.opposeCount}**`,
      inline: false,
    },
  );
  if (suggestion.outcome) {
    fields.push({
      name: "Outcome",
      value: safeField(
        `${suggestion.outcome.summary}${suggestion.outcome.nextStepOrLink ? `\n${suggestion.outcome.nextStepOrLink}` : ""}`,
      ),
      inline: false,
    });
  }
  const embed: DiscordEmbed = {
    title: suggestion.title,
    description: `Author: <@${suggestion.authorId}>\nID: ${suggestion.authorId}\nCreated: <t:${Math.floor(suggestion.createdAtMs / 1000)}:F>${suggestion.editedAtMs ? `\nEdited: <t:${Math.floor(suggestion.editedAtMs / 1000)}:R>` : ""}`,
    fields,
    color: statusColor(suggestion.status),
    footer: { text: "hafbot.xyz" },
    timestamp: new Date(suggestion.updatedAtMs).toISOString(),
  };
  const active =
    suggestion.status === "gathering_feedback" ||
    suggestion.status === "needs_work" ||
    suggestion.status === "under_review";
  return {
    embeds: [embed],
    components: active
      ? [
          {
            type: 1,
            components: [
              button("Support", 3, suggestionVoteCustomId(suggestion.id, "support")),
              button("Oppose", 4, suggestionVoteCustomId(suggestion.id, "oppose")),
              button("Remove Vote", 2, suggestionVoteCustomId(suggestion.id, "remove")),
              button("Add Considered Reply", 1, suggestionReplyCustomId(suggestion.id)),
            ],
          },
          {
            type: 1,
            components: [
              button("Edit Suggestion", 2, `suggestions:edit:${suggestion.id}`),
              button(
                suggestion.status === "needs_work" ? "Ready for feedback" : "Mark Needs Work",
                2,
                `suggestions:author-status:${suggestion.id}:${suggestion.revision}`,
              ),
            ],
          },
        ]
      : [],
    allowed_mentions: suppressMentions(),
  };
}

export function buildConsideredReplyMessage(reply: ConsideredReply): CreateChannelMessageInput {
  return {
    embeds: [
      {
        title: `${capitalize(reply.perspective)} · Considered Reply`,
        description: reply.reasoning,
        fields: reply.improvement
          ? [{ name: "Improvement or alternative", value: safeField(reply.improvement) }]
          : [],
        color: 0x475569,
        footer: { text: `Submitted by Discord user ${reply.authorId} · hafbot.xyz` },
        timestamp: new Date(reply.createdAtMs).toISOString(),
      },
    ],
    content: `<@${reply.authorId}>`,
    allowed_mentions: suppressMentions(),
  };
}

export function createDiscordSuggestionProjection(input: {
  token: string;
  componentIdSigner?: ComponentIdSigner;
  guildResources: GuildResourceValidator;
  readConfig(guildId: string): Promise<SuggestionsConfig>;
  resolveReplyWebhook?(
    guildId: string,
    credentialId: string,
  ): Promise<{ id: string; token: string }>;
}): SuggestionProjection {
  const requireSuggestionThread = async (
    guildId: string,
    threadId: string,
    config?: SuggestionsConfig,
  ): Promise<void> => {
    const resolvedConfig = config ?? (await input.readConfig(guildId));
    if (!resolvedConfig.forumChannelId) throw new Error("Suggestion Channel is not configured.");
    await (
      await input.guildResources.forGuild(guildId)
    ).requireThread(threadId, resolvedConfig.forumChannelId);
  };

  return {
    async createSuggestion(suggestion) {
      const config = await input.readConfig(suggestion.guildId);
      if (!config.forumChannelId) throw new Error("Suggestion Channel is not configured.");
      (await input.guildResources.forGuild(suggestion.guildId)).requireForumChannel(
        config.forumChannelId,
      );
      const thread = await createForumThread(
        {
          channelId: config.forumChannelId,
          name: suggestion.title,
          message: await signSensitiveMessageComponentIds(
            buildSuggestionStarter(suggestion),
            input.componentIdSigner,
            { guildId: suggestion.guildId },
          ),
          appliedTags: projectionTags(config, suggestion),
        },
        input.token,
      );
      return { threadId: thread.id, starterMessageId: thread.message.id };
    },
    async updateSuggestion(suggestion) {
      if (!suggestion.threadId || !suggestion.starterMessageId) return;
      const config = await input.readConfig(suggestion.guildId);
      await requireSuggestionThread(suggestion.guildId, suggestion.threadId, config);
      await editChannelMessage(
        suggestion.threadId,
        suggestion.starterMessageId,
        await signSensitiveMessageComponentIds(
          buildSuggestionStarter(suggestion),
          input.componentIdSigner,
          { guildId: suggestion.guildId },
        ),
        input.token,
      );
      await requireSuggestionThread(suggestion.guildId, suggestion.threadId, config);
      await modifyThread(
        suggestion.threadId,
        {
          name: suggestion.title,
          appliedTags: projectionTags(config, suggestion),
        },
        input.token,
      );
    },
    async setThreadLocked(suggestion, locked) {
      if (!suggestion.threadId) return;
      await requireSuggestionThread(suggestion.guildId, suggestion.threadId);
      await modifyThread(suggestion.threadId, { locked, archived: locked }, input.token);
    },
    async postStatusUpdate(suggestion, from, reason) {
      if (!suggestion.threadId) return;
      await requireSuggestionThread(suggestion.guildId, suggestion.threadId);
      await createChannelMessage(
        suggestion.threadId,
        {
          embeds: [
            {
              title: "Suggestion status updated",
              description: `${STATUS_LABELS[from]} → **${STATUS_LABELS[suggestion.status]}**${reason ? `\n\n${reason}` : ""}`,
              color: statusColor(suggestion.status),
              footer: { text: "hafbot.xyz" },
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: suppressMentions(),
        },
        input.token,
      );
    },
    async publishConsideredReply(reply) {
      const suggestionThread = resolveThread(reply);
      const config = await input.readConfig(reply.guildId);
      const webhook = await resolveReplyWebhook(input, config);
      await requireSuggestionThread(reply.guildId, suggestionThread, config);
      const message = await executeSuggestionWebhook(
        webhook.id,
        webhook.token,
        suggestionThread,
        buildConsideredReplyMessage(reply),
      );
      await requireSuggestionThread(reply.guildId, suggestionThread, config);
      await createReaction(suggestionThread, message.id, "🚩", input.token);
      return { messageId: message.id };
    },
    async collapseConsideredReply(reply) {
      if (!reply.webhookMessageId) return { queueMessageId: null };
      const config = await input.readConfig(reply.guildId);
      const webhook = await resolveReplyWebhook(input, config);
      await requireSuggestionThread(reply.guildId, resolveThread(reply), config);
      await editSuggestionWebhookMessage(webhook.id, webhook.token, reply.webhookMessageId, {
        embeds: [
          {
            title: "Considered Reply collapsed",
            description:
              "This reply crossed the community flag threshold and is awaiting staff review.",
            color: 0x64748b,
            footer: { text: "hafbot.xyz" },
          },
        ],
        content: "",
        allowed_mentions: suppressMentions(),
      });
      if (!config.modQueueChannelId) return { queueMessageId: null };
      (await input.guildResources.forGuild(reply.guildId)).requireTextChannel(
        config.modQueueChannelId,
      );
      const queue = await createChannelMessage(
        config.modQueueChannelId,
        await signSensitiveMessageComponentIds(
          {
            embeds: [
              {
                title: "Collapsed Considered Reply",
                description: reply.reasoning,
                fields: [
                  { name: "Author", value: `<@${reply.authorId}>\nID: ${reply.authorId}` },
                  { name: "Flags", value: String(reply.flagCount), inline: true },
                  { name: "Suggestion", value: reply.suggestionId, inline: true },
                ],
                color: 0xd97706,
                footer: { text: "hafbot.xyz" },
                timestamp: new Date().toISOString(),
              },
            ],
            components: [
              {
                type: 1,
                components: [
                  button("Keep Collapsed", 2, consideredReplyResolutionCustomId(reply.id, "keep")),
                  button(
                    "Restore Reply",
                    3,
                    consideredReplyResolutionCustomId(reply.id, "restore"),
                  ),
                  button("Hard Delete", 4, consideredReplyResolutionCustomId(reply.id, "delete")),
                ],
              },
            ],
            allowed_mentions: suppressMentions(),
          },
          input.componentIdSigner,
          { guildId: reply.guildId },
        ),
        input.token,
      );
      return { queueMessageId: queue.id };
    },
    async restoreConsideredReply(reply) {
      if (!reply.webhookMessageId) return;
      const config = await input.readConfig(reply.guildId);
      const webhook = await resolveReplyWebhook(input, config);
      await requireSuggestionThread(reply.guildId, resolveThread(reply), config);
      await editSuggestionWebhookMessage(
        webhook.id,
        webhook.token,
        reply.webhookMessageId,
        buildConsideredReplyMessage(reply),
      );
    },
    async deleteConsideredReply(reply) {
      if (!reply.webhookMessageId) return;
      const config = await input.readConfig(reply.guildId);
      const webhook = await resolveReplyWebhook(input, config);
      await requireSuggestionThread(reply.guildId, resolveThread(reply), config);
      await deleteSuggestionWebhookMessage(webhook.id, webhook.token, reply.webhookMessageId);
    },
    async resolveConsideredReplyQueue(reply) {
      if (!reply.queueMessageId) return;
      const config = await input.readConfig(reply.guildId);
      if (!config.modQueueChannelId) return;
      (await input.guildResources.forGuild(reply.guildId)).requireTextChannel(
        config.modQueueChannelId,
      );
      await editChannelMessage(
        config.modQueueChannelId,
        reply.queueMessageId,
        {
          embeds: [
            {
              title: "Considered Reply decision recorded",
              description: `Decision: **${reply.state.replaceAll("_", " ")}**`,
              fields: [
                { name: "Suggestion", value: reply.suggestionId, inline: true },
                { name: "Reply", value: reply.id, inline: true },
                {
                  name: "Resolved by",
                  value: reply.resolvedByUserId ? `<@${reply.resolvedByUserId}>` : "Unknown",
                },
                ...(reply.resolutionReason
                  ? [{ name: "Reason", value: safeField(reply.resolutionReason) }]
                  : []),
              ],
              color: reply.state === "restored" ? 0x16a34a : 0x64748b,
              footer: { text: "Terminal moderation decision · hafbot.xyz" },
              timestamp: new Date(reply.updatedAtMs).toISOString(),
            },
          ],
          components: [],
          allowed_mentions: suppressMentions(),
        },
        input.token,
      );
    },
    async notifyAuthorOfStatus(suggestion, from) {
      await createUserDmMessage(
        suggestion.authorId,
        {
          embeds: [
            {
              title: "Your Suggestion status changed",
              description: `**${suggestion.title}**\n${STATUS_LABELS[from]} → **${STATUS_LABELS[suggestion.status]}**${suggestion.threadId ? `\n\nhttps://discord.com/channels/${suggestion.guildId}/${suggestion.threadId}` : ""}`,
              color: statusColor(suggestion.status),
              footer: { text: "hafbot.xyz" },
            },
          ],
          allowed_mentions: suppressMentions(),
        },
        input.token,
      );
    },
    async publishDigest({ config, newSuggestions, needingFeedback, recentlyDecided }) {
      if (!config.digestChannelId) throw new Error("Suggestion Digest channel is unavailable.");
      (await input.guildResources.forGuild(config.guildId)).requireTextChannel(
        config.digestChannelId,
      );
      const message = await createChannelMessage(
        config.digestChannelId,
        {
          embeds: [
            {
              title: "Suggestion Digest",
              description:
                "A balanced view of new proposals, discussions needing input, and recent outcomes.",
              fields: [
                digestField("New Suggestions", newSuggestions),
                digestField("Needs more feedback", needingFeedback),
                digestField("Recently decided", recentlyDecided),
              ],
              color: 0x2563eb,
              footer: { text: "hafbot.xyz" },
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: suppressMentions(),
        },
        input.token,
      );
      return { messageId: message.id };
    },
  };
}

async function resolveReplyWebhook(
  input: {
    resolveReplyWebhook?(
      guildId: string,
      credentialId: string,
    ): Promise<{ id: string; token: string }>;
  },
  config: SuggestionsConfig,
): Promise<{ id: string; token: string }> {
  if (!config.replyWebhookId || !config.replyWebhookCredentialId || !input.resolveReplyWebhook) {
    throw new Error("Suggestions reply webhook is unavailable.");
  }
  const resolved = await input.resolveReplyWebhook(config.guildId, config.replyWebhookCredentialId);
  if (resolved.id !== config.replyWebhookId) {
    throw new Error("Suggestions reply webhook credential does not match its Discord webhook.");
  }
  return resolved;
}

export async function createManagedSuggestionWebhook(
  channelId: string,
  token: string,
): Promise<{ id: string; token: string }> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/webhooks`,
    "POST",
    token,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HAF Suggestions Replies" }),
    },
  );
  const webhook = await parseDiscordJson<{ id: string; token?: string }>(
    response,
    "Failed to create Suggestions reply webhook",
  );
  if (!webhook.token) throw new Error("Discord did not return a webhook token.");
  return { id: webhook.id, token: webhook.token };
}

async function executeSuggestionWebhook(
  webhookId: string,
  webhookToken: string,
  threadId: string,
  body: CreateChannelMessageInput,
): Promise<{ id: string }> {
  const response = await discordRawRequest(
    `${DISCORD_API}/webhooks/${webhookId}/${webhookToken}?wait=true&thread_id=${encodeURIComponent(threadId)}`,
    "POST",
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return parseDiscordJson(response, "Failed to post Considered Reply");
}

async function editSuggestionWebhookMessage(
  webhookId: string,
  webhookToken: string,
  messageId: string,
  body: CreateChannelMessageInput,
): Promise<void> {
  const response = await discordRawRequest(
    `${DISCORD_API}/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`,
    "PATCH",
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await parseDiscordJson(response, "Failed to edit Considered Reply");
}

async function deleteSuggestionWebhookMessage(
  webhookId: string,
  webhookToken: string,
  messageId: string,
): Promise<void> {
  const response = await discordRawRequest(
    `${DISCORD_API}/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`,
    "DELETE",
  );
  if (!response.ok) throw new Error(`Failed to delete Considered Reply (${response.status}).`);
  response.body?.cancel();
}

function projectionTags(config: SuggestionsConfig, suggestion: Suggestion): string[] {
  return [
    config.statusTagIds[suggestion.status],
    suggestion.category ? config.categoryTagIds[suggestion.category] : undefined,
  ].filter((value): value is string => Boolean(value));
}

function resolveThread(reply: ConsideredReply): string {
  const threadId = reply.threadId;
  if (!threadId) throw new Error("Suggestion thread is unavailable.");
  return threadId;
}

function modalTextInput(
  customId: string,
  label: string,
  required: boolean,
  maxLength: number,
  style = 1,
  value?: string,
): unknown {
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

function button(label: string, style: number, customId: string): unknown {
  return { type: 2, style, label, custom_id: customId };
}

function safeField(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1021)}…`;
}

function statusColor(status: SuggestionStatus): number {
  if (status === "implemented") return 0x16a34a;
  if (status === "rejected") return 0xdc2626;
  if (status === "planned") return 0x7c3aed;
  if (status === "under_review") return 0xd97706;
  return 0x2563eb;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function digestField(
  name: string,
  suggestions: Suggestion[],
): {
  name: string;
  value: string;
  inline: false;
} {
  return {
    name,
    value:
      suggestions.length > 0
        ? suggestions
            .map(
              (item) =>
                `• ${item.threadId ? `<#${item.threadId}>` : `**${item.title}**`} · ${item.supportCount + item.opposeCount} votes`,
            )
            .join("\n")
            .slice(0, 1024)
        : "Nothing to show this period.",
    inline: false,
  };
}
