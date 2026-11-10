import type { CommerceLoaderData } from "../lib/admin-route-loaders";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";

export default function AdminCommerceSalesPanelSettings({
  salesPanel,
  panelChannels,
  panelChannelId,
  panelTitle,
  panelDescription,
  busyAction,
  onTitleChange,
  onDescriptionChange,
  onChannelChange,
  onPublish,
  onUnpublish,
}: {
  salesPanel: CommerceLoaderData["salesPanel"];
  panelChannels: NonNullable<CommerceLoaderData["panelChannels"]>;
  panelChannelId: string;
  panelTitle: string;
  panelDescription: string;
  busyAction: string | null;
  onTitleChange: (title: string) => void;
  onDescriptionChange: (description: string) => void;
  onChannelChange: (channelId: string) => void;
  onPublish: (title: string, description: string) => void;
  onUnpublish: () => void;
}) {
  const published = Boolean(salesPanel?.messageId);
  const moving = published && salesPanel?.channelId !== panelChannelId;
  const saving = busyAction === "sales-panel:publish" || busyAction === "sales-panel:refresh";
  return (
    <SettingsBlock>
      <SectionHeader
        title="Commerce sales panel"
        description="Write the message your community will see, then publish it with buttons to your HAF storefront."
      />
      <div className="grid gap-4">
        <FormField
          label="Panel title"
          htmlFor="commerce-sales-panel-title"
          hint={`${panelTitle.length}/256 characters`}
          required
        >
          <input
            id="commerce-sales-panel-title"
            className="admin-input h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={panelTitle}
            maxLength={256}
            onChange={(event) => onTitleChange(event.target.value)}
          />
        </FormField>
        <FormField
          label="Panel description"
          htmlFor="commerce-sales-panel-description"
          hint={`${panelDescription.length}/4096 characters. Optional; panel copy and offering details may be shortened to fit Discord's 6,000-character embed limit.`}
        >
          <textarea
            id="commerce-sales-panel-description"
            className="admin-textarea min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={panelDescription}
            maxLength={4096}
            rows={4}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </FormField>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          label="Discord text channel"
          htmlFor="commerce-sales-panel-channel"
          hint="The bot needs View Channel and Send Messages."
          required
        >
          <select
            id="commerce-sales-panel-channel"
            className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
            value={panelChannelId}
            onChange={(event) => onChannelChange(event.target.value)}
          >
            <option value="">Select a text channel</option>
            {panelChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </FormField>
        <p className="self-center text-sm">Status: {published ? "Published" : "Not published"}</p>
      </div>
      {panelChannels.length === 0 ? (
        <p className="text-sm text-destructive">
          No bot-accessible text channels found. Grant View Channel and Send Messages, then reload.
        </p>
      ) : null}
      {salesPanel?.lastErrorCode ? (
        <p className="text-sm text-destructive">
          Last refresh failed ({salesPanel.lastErrorCode}). Retry or remove and republish.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {published ? (
          <Button
            type="button"
            variant="destructive"
            disabled={Boolean(busyAction)}
            onClick={onUnpublish}
          >
            {busyAction === "sales-panel:unpublish" ? "Removing…" : "Remove sales panel"}
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={Boolean(busyAction) || panelChannels.length === 0 || !panelTitle.trim()}
          onClick={() => onPublish(panelTitle, panelDescription)}
        >
          {saving
            ? "Saving…"
            : moving
              ? "Move sales panel"
              : published
                ? "Refresh sales panel"
                : "Publish sales panel"}
        </Button>
      </div>
    </SettingsBlock>
  );
}
