/**
 * The partial-emoji object Discord expects on a message component's `emoji`
 * field (buttons, select-menu options). `name` is required for unicode
 * emojis; `id` + `name` (+ `animated`) are required for custom guild emojis.
 *
 * @see https://discord.com/developers/docs/interactions/message-components#button-object-button-structure
 */
export interface DiscordButtonEmoji {
  id?: string;
  name: string;
  animated?: boolean;
}

/**
 * Convert a stored emoji string into the partial-emoji object Discord expects
 * on a button component.
 *
 * The {@link EmojiPicker} persists two shapes:
 *  - unicode emoji as the raw codepoints (e.g. `"✅"`), and
 *  - custom (guild) emoji in the `:name:id` reference form (e.g.
 *    `":verified:111"`), or `:a:name:id` when animated.
 *
 * The Discord button component rejects the raw `:name:id` string — it needs the
 * id and name split apart — so this parses it. Returns `undefined` for an empty
 * value (so callers can spread the field conditionally). Falls back to
 * `{ name: value }` for an unparseable custom form, matching the previous
 * inline behaviour across the codebase.
 */
export function parseButtonEmoji(value: string | null | undefined): DiscordButtonEmoji | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // Custom (animated): ":a:name:id"
  const animatedMatch = /^:a:([^:]+):(\d+)$/.exec(trimmed);
  if (animatedMatch) {
    const [, name, id] = animatedMatch;
    return { id, name: name ?? trimmed, animated: true };
  }

  // Custom (static): ":name:id"
  const staticMatch = /^:([^:]+):(\d+)$/.exec(trimmed);
  if (staticMatch) {
    const [, name, id] = staticMatch;
    return { id, name: name ?? trimmed, animated: false };
  }

  // Unicode (or any other raw string): pass through as the name.
  return { name: trimmed };
}
