import Picker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";

export interface EmojiPickerImplementationProps {
  onSelect: (emoji: string) => void;
  disabledUnicode: readonly string[];
}

const pickerThemeStyle: React.CSSProperties = {
  "--epr-bg-color": "hsl(var(--popover))",
  "--epr-text-color": "hsl(var(--foreground))",
  "--epr-picker-border-color": "hsl(var(--border))",
  "--epr-search-input-bg-color": "hsl(var(--input))",
  "--epr-search-input-bg-color-active": "hsl(var(--secondary))",
  "--epr-search-border-color": "hsl(var(--border))",
  "--epr-search-border-color-active": "hsl(var(--ring))",
  "--epr-hover-bg-color": "hsl(var(--secondary))",
  "--epr-focus-bg-color": "hsl(var(--secondary))",
  "--epr-highlight-color": "hsl(var(--accent))",
  "--epr-category-label-bg-color": "hsl(var(--popover))",
  "--epr-category-label-text-color": "hsl(var(--muted-foreground))",
  "--epr-category-icon-active-color": "hsl(var(--accent))",
  "--epr-emoji-variation-indicator-color": "hsl(var(--accent))",
  "--epr-emoji-variation-picker-bg-color": "hsl(var(--popover))",
  "--epr-preview-text-color": "hsl(var(--muted-foreground))",
  "--epr-preview-border-color": "hsl(var(--border))",
} as React.CSSProperties;

export function EmojiPickerImplementation({
  onSelect,
  disabledUnicode,
}: EmojiPickerImplementationProps) {
  const styleNonce = document.getElementById("admin-root")?.dataset.cspStyleNonce;

  return (
    <Picker
      emojiStyle={EmojiStyle.APPLE}
      height={340}
      hiddenEmojis={disabledUnicode.map((emoji) =>
        Array.from(emoji, (character) => character.codePointAt(0)!.toString(16)).join("-"),
      )}
      lazyLoadEmojis
      nonce={styleNonce}
      onEmojiClick={(emoji: EmojiClickData) => onSelect(emoji.emoji)}
      previewConfig={{ showPreview: false }}
      searchPlaceHolder="Search unicode emojis"
      style={pickerThemeStyle}
      theme={Theme.DARK}
      width="100%"
    />
  );
}
