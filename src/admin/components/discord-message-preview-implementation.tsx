import {
  DiscordActionRow,
  DiscordButton,
  DiscordEmbed,
  DiscordEmbedDescription,
  DiscordEmbedField,
  DiscordEmbedFields,
  DiscordEmbedFooter,
  DiscordMessage,
  DiscordMessages,
} from "@skyra/discord-components-react";
import type { ButtonVariant, DiscordMessagePreviewProps } from "./discord-message-preview";
import { DiscordMarkdown } from "./markdown-editor";

const buttonTypeMap: Record<ButtonVariant, "primary" | "secondary" | "success" | "destructive"> = {
  primary: "primary",
  secondary: "secondary",
  success: "success",
  danger: "destructive",
  destructive: "destructive",
};

export function DiscordMessagePreviewImplementation({
  author = "HAF Bot",
  authorAvatar,
  content,
  embedTitle,
  embedDescription,
  embedColor = "#5865f2",
  embedImage,
  embedThumbnail,
  embedFooter,
  embedFields,
  buttons,
}: DiscordMessagePreviewProps) {
  const hasEmbed = Boolean(
    embedTitle ||
    embedDescription ||
    embedImage ||
    embedThumbnail ||
    embedFooter ||
    (embedFields && embedFields.length > 0),
  );

  return (
    <DiscordMessages lightTheme={false}>
      <DiscordMessage author={author} avatar={authorAvatar} bot>
        {content ? <DiscordMarkdown source={content} /> : null}
        {hasEmbed ? (
          <DiscordEmbed
            slot="embeds"
            color={embedColor}
            embedTitle={embedTitle}
            authorName={author}
            image={embedImage}
            thumbnail={embedThumbnail}
          >
            {embedDescription && (
              <DiscordEmbedDescription slot="description">
                <DiscordMarkdown source={embedDescription} />
              </DiscordEmbedDescription>
            )}
            {embedFields && embedFields.length > 0 && (
              <DiscordEmbedFields slot="fields">
                {embedFields.map((field, index) => (
                  <DiscordEmbedField
                    key={index}
                    fieldTitle={field.name}
                    inline={field.inline ?? false}
                  >
                    <DiscordMarkdown source={field.value} />
                  </DiscordEmbedField>
                ))}
              </DiscordEmbedFields>
            )}
            {embedFooter && (
              <DiscordEmbedFooter
                slot="footer"
                footerImage={embedFooter.iconUrl}
                timestamp={undefined}
              >
                {embedFooter.text}
              </DiscordEmbedFooter>
            )}
          </DiscordEmbed>
        ) : null}
        {buttons && buttons.length > 0 && (
          <DiscordActionRow slot="components">
            {buttons.map((button, index) => (
              <DiscordButton
                key={index}
                type={buttonTypeMap[button.variant ?? "secondary"]}
                emoji={button.emoji}
                disabled={button.disabled}
              >
                {button.label}
              </DiscordButton>
            ))}
          </DiscordActionRow>
        )}
      </DiscordMessage>
    </DiscordMessages>
  );
}
