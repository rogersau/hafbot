import type { TicketPanelConfig } from "../../types";
import { DiscordMessagePreview } from "./discord-message-preview";
import { EditorPanel, SectionHeader } from "./admin-form-layout";
import { formatHexColor } from "./ui/color-input";

export function TicketPanelPreview({ value }: { value: TicketPanelConfig }) {
  const hasEmbed =
    value.panelTitle ?? value.panelEmoji ?? value.panelDescription ?? value.panelFooter;
  const title = [value.panelEmoji, value.panelTitle || "(No title)"].filter(Boolean).join(" ");

  return (
    <EditorPanel>
      <SectionHeader title="Panel preview" />
      <DiscordMessagePreview
        content={
          hasEmbed ? undefined : "Open a ticket by choosing the option that fits your request."
        }
        embedTitle={hasEmbed ? title : undefined}
        embedDescription={value.panelDescription || undefined}
        embedColor={formatHexColor(value.panelColor ?? 0x57f287)}
        embedFooter={value.panelFooter ? { text: value.panelFooter } : undefined}
        buttons={value.ticketTypes
          .filter((type) => type.enabled !== false)
          .map((ticketType) => ({
            label: ticketType.label || "(Unnamed)",
            emoji: ticketType.emoji ?? undefined,
            variant: ticketType.buttonStyle,
          }))}
      />
    </EditorPanel>
  );
}
