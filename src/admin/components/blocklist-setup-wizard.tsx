import type { GuildResources } from "../lib/guild-resources-cache";
import { FeatureSetupWizard } from "./feature-setup-wizard";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, MultiChannelSelect } from "./guild-resource-select";
import { BlocklistEmojiField } from "./blocklist-emoji-field";
import { Button } from "./ui/button";

type ChannelFilterMode = "include" | "exclude";

interface BlocklistSetupWizardProps {
  currentEmojis: readonly string[];
  resources: GuildResources | null;
  resourcesLoading?: boolean;
  channelMode: ChannelFilterMode;
  channelIds: string[];
  notificationChannelId: string;
  saving?: boolean;
  onSubmit: (emojis: string[]) => Promise<boolean> | boolean;
  onChannelModeChange: (mode: ChannelFilterMode) => void;
  onChannelIdsChange: (channelIds: string[]) => void;
  onNotificationChannelChange: (channelId: string) => void;
  onFinish: () => void;
}

export function BlocklistSetupWizard({
  currentEmojis,
  resources,
  resourcesLoading = false,
  channelMode,
  channelIds,
  notificationChannelId,
  saving = false,
  onSubmit,
  onChannelModeChange,
  onChannelIdsChange,
  onNotificationChannelChange,
  onFinish,
}: BlocklistSetupWizardProps) {
  const hasBlockedEmoji = currentEmojis.length > 0;

  return (
    <FeatureSetupWizard
      title="Blocklist setup wizard"
      description="Choose an unwanted reaction, decide where the rule applies, then review how to verify it safely."
      steps={[
        {
          id: "blocklist-emojis",
          label: "Block emoji",
          purpose: "Define the unwanted reaction HAF should remove.",
          changes: "Adds the selected emoji to this Guild's Reaction Rules Blocklist.",
          outcome: "HAF has at least one explicit reaction rule to enforce.",
          canContinue: hasBlockedEmoji,
          continueHint: hasBlockedEmoji ? null : "Block at least one emoji to continue.",
          content: (
            <SettingsBlock>
              <SectionHeader
                title="Choose a blocked emoji or emojis"
                description="Select a group of unwanted reactions, review the draft, and add them together. HAF Bot removes them whenever members use them as reactions."
              />
              <FormField
                label="Emoji"
                required
                hint="Select one or more emojis that members should not use as reactions."
              >
                <BlocklistEmojiField
                  currentEmojis={currentEmojis}
                  emojis={resources?.emojis ?? []}
                  loading={resourcesLoading && (resources?.emojis?.length ?? 0) === 0}
                  submitting={saving}
                  onSubmit={onSubmit}
                />
              </FormField>
              {hasBlockedEmoji ? (
                <p className="text-sm text-accent" role="status">
                  {currentEmojis.length === 1
                    ? "1 emoji is blocked."
                    : `${currentEmojis.length} emojis are blocked.`}
                </p>
              ) : null}
            </SettingsBlock>
          ),
        },
        {
          id: "blocklist-coverage",
          label: "Coverage & logging",
          purpose: "Control where the rule applies and where staff can see enforcement activity.",
          changes: "Updates channel scope and, optionally, the moderation log destination.",
          outcome: "The Blocklist applies only in the places you expect.",
          content: (
            <div className="space-y-5">
              <SettingsBlock>
                <SectionHeader
                  title="Choose Blocklist coverage"
                  description="Leave the channel list empty to enforce the Blocklist everywhere."
                />
                <div className="grid gap-3 md:grid-cols-[minmax(12rem,0.55fr)_minmax(0,1fr)]">
                  <FormField
                    label="Filter mode"
                    hint="Include applies the Blocklist only to selected channels. Exclude applies it everywhere except selected channels."
                  >
                    <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={channelMode === "include" ? "default" : "outline"}
                        onClick={() => onChannelModeChange("include")}
                      >
                        Include
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={channelMode === "exclude" ? "default" : "outline"}
                        onClick={() => onChannelModeChange("exclude")}
                      >
                        Exclude
                      </Button>
                    </div>
                  </FormField>
                  <FormField label="Channels" hint="Leave empty to apply the Blocklist everywhere.">
                    <MultiChannelSelect
                      channels={resources?.textChannels ?? []}
                      value={channelIds}
                      onChange={onChannelIdsChange}
                    />
                  </FormField>
                </div>
              </SettingsBlock>

              <SettingsBlock>
                <SectionHeader
                  title="Moderation logging"
                  description="Optionally post Blocklist changes and enforcement messages to a Discord channel."
                />
                <FormField
                  label="Moderation log channel (optional)"
                  htmlFor="wizard-bl-log-channel"
                >
                  <ChannelSelect
                    id="wizard-bl-log-channel"
                    channels={resources?.textChannels ?? []}
                    value={notificationChannelId}
                    onChange={onNotificationChannelChange}
                  />
                </FormField>
              </SettingsBlock>
            </div>
          ),
        },
        {
          id: "blocklist-verify",
          label: "Review & verify",
          purpose: "Confirm the rule's behavior before relying on it for moderation.",
          changes: "Saves the selected coverage and moderation-log settings.",
          outcome: "A controlled blocked reaction is removed in the intended channel.",
          content: (
            <SettingsBlock>
              <SectionHeader
                title="Review & verify the Blocklist"
                description="Your blocked emoji is already active. Finish saves the optional coverage and logging choices from the previous step."
              />
              <dl className="grid gap-3 rounded-md border bg-background p-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Blocked reactions</dt>
                  <dd className="font-medium text-foreground">{currentEmojis.length}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Coverage</dt>
                  <dd className="font-medium text-foreground">
                    {channelIds.length === 0
                      ? "All channels"
                      : `${channelMode === "include" ? "Only" : "All except"} ${channelIds.length} selected`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Moderation logging</dt>
                  <dd className="font-medium text-foreground">
                    {notificationChannelId ? "Selected channel" : "Not enabled"}
                  </dd>
                </div>
              </dl>
              <aside className="rounded-md border border-accent/30 bg-accent/5 p-4">
                <h3 className="text-sm font-semibold text-foreground">Safe first-success check</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  In a channel covered by this rule, add the blocked reaction to a test message. HAF
                  should remove it. If logging is enabled, confirm the enforcement entry appears.
                </p>
              </aside>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="accent"
                  loading={saving}
                  loadingLabel="Saving optional settings…"
                  disabled={saving}
                  onClick={onFinish}
                >
                  Finish setup
                </Button>
              </div>
            </SettingsBlock>
          ),
        },
      ]}
    />
  );
}
