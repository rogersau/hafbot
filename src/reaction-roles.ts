import { z } from "zod";

export const MAX_REACTION_ROLE_OPTIONS = 20;
export const MAX_REACTION_ROLE_PANELS = 10;
const snowflake = z.string().regex(/^[1-9]\d{0,19}$/, "Choose a Discord resource.");

export function parseReactionRoleEmoji(value: string) {
  const trimmed = value.trim();
  const custom = /^<?(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>?$/.exec(trimmed);
  if (custom) {
    return {
      key: `custom:${custom[3]}`,
      display: `<${custom[1]}:${custom[2]}:${custom[3]}>`,
      api: `${custom[2]}:${custom[3]}`,
      id: custom[3],
    };
  }
  if (
    !trimmed ||
    trimmed.length > 64 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(trimmed) ||
    [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(trimmed)].length !== 1
  )
    return null;
  return {
    key: trimmed.normalize("NFC").replace(/\ufe0f/g, ""),
    display: trimmed,
    api: trimmed,
    id: null,
  };
}

export const reactionRoleOptionSchema = z.object({
  emoji: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => parseReactionRoleEmoji(value) !== null, "Choose one emoji."),
  roleId: snowflake,
  label: z.string().trim().min(1).max(80),
});

export const reactionRoleSettingsSchema = z
  .object({
    channelId: snowflake,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1000),
    mode: z.enum(["multiple", "single"]).optional(),
    requiredRoleIds: z.array(snowflake).max(20).optional(),
    blockedRoleIds: z.array(snowflake).max(20).optional(),
    options: z.array(reactionRoleOptionSchema).min(1).max(MAX_REACTION_ROLE_OPTIONS),
  })
  .superRefine((settings, context) => {
    const emojis = new Set<string>();
    const roles = new Set<string>();
    settings.options.forEach((option, index) => {
      const key = parseReactionRoleEmoji(option.emoji)?.key ?? option.emoji;
      if (emojis.has(key))
        context.addIssue({
          code: "custom",
          path: ["options", index, "emoji"],
          message: "Each emoji can appear only once.",
        });
      if (roles.has(option.roleId))
        context.addIssue({
          code: "custom",
          path: ["options", index, "roleId"],
          message: "Each role can appear only once.",
        });
      emojis.add(key);
      roles.add(option.roleId);
    });
    const required = settings.requiredRoleIds ?? [];
    const blocked = settings.blockedRoleIds ?? [];
    if (required.some((id) => blocked.includes(id)))
      context.addIssue({
        code: "custom",
        path: ["blockedRoleIds"],
        message: "A role cannot be both required and blocked.",
      });
    if ([...required, ...blocked].some((id) => roles.has(id)))
      context.addIssue({
        code: "custom",
        path: ["requiredRoleIds"],
        message: "Eligibility roles must be separate from this panel's selectable roles.",
      });
    if (new Set(required).size !== required.length || new Set(blocked).size !== blocked.length)
      context.addIssue({
        code: "custom",
        path: ["requiredRoleIds"],
        message: "Choose each eligibility role only once.",
      });
    if (
      settings.options.every((option) => parseReactionRoleEmoji(option.emoji) !== null) &&
      reactionRoleMessage(settings).content.length > 2000
    ) {
      context.addIssue({
        code: "custom",
        path: ["description"],
        message: "The panel exceeds Discord's message limit. Shorten the text or role labels.",
      });
    }
  });

export type ReactionRoleOption = z.infer<typeof reactionRoleOptionSchema>;
export type ReactionRoleSettings = z.infer<typeof reactionRoleSettingsSchema>;
export interface ReactionRolePanel extends ReactionRoleSettings {
  guildId: string;
  id: string;
  botUserId: string;
  messageId: string | null;
  publishedOptions: ReactionRoleOption[];
  activatedAtMs: number | null;
  enabled: boolean;
  updatedAtMs: number;
}

export function isPublishedReactionRoleOption(
  panel: ReactionRolePanel,
  option: ReactionRoleOption,
) {
  const key = parseReactionRoleEmoji(option.emoji)?.key;
  if (!key) return false;
  return panel.publishedOptions.some(
    (published) =>
      published.roleId === option.roleId && parseReactionRoleEmoji(published.emoji)?.key === key,
  );
}

export function reactionRoleMessage(panel: ReactionRoleSettings) {
  return {
    content: `**${panel.title}**\n\n${panel.description}\n\n${panel.options.map((option) => `${parseReactionRoleEmoji(option.emoji)!.display} — **${option.label}**`).join("\n")}\n\nReact to select your roles. Remove your reaction to remove a role. ${panel.mode === "single" ? "Choose one role. A new selection replaces your previous choice." : "You can select more than one."}${panel.requiredRoleIds?.length || panel.blockedRoleIds?.length ? " Role eligibility applies to new selections." : ""}`,
    allowed_mentions: { parse: [] as Array<"roles" | "users" | "everyone"> },
  };
}
