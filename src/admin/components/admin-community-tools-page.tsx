import { useRef, useState } from "react";
import {
  contentFeedSchema,
  customReplySchema,
  moderationRuleSchema,
  recurringMessageSchema,
  type CommunityConfig,
  type CommunityFeature,
  type ConfigSnapshot,
} from "../../community-tools/config";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { AdminBanAppealsPanel } from "./admin-ban-appeals-panel";

export interface CommunityToolsLoaderData extends ConfigSnapshot {
  guildId: string;
  twitchAvailable: boolean;
  status?: { deliveries: Array<Record<string, unknown>>; feeds: Array<Record<string, unknown>> };
}
interface Props {
  selectedGuildId: string;
  selectedWorkspaceId: string;
  initialData?: CommunityToolsLoaderData | null;
}
const labels: Record<CommunityFeature, string> = {
  automation: "Custom Replies and Schedules",
  moderation: "Chat Moderation",
  feeds: "Content Feeds",
};
const descriptions: Record<CommunityFeature, string> = {
  automation: "Answer common questions and repeat announcements on a schedule.",
  moderation: "Configure chat rules, staff access and private member reports.",
  feeds: "Share new videos, streams and community updates automatically.",
};
export const AdminAutomationPage = (props: Props) => (
  <CommunityToolsPage {...props} feature="automation" />
);
export const AdminChatModerationPage = (props: Props) => (
  <CommunityToolsPage {...props} feature="moderation" />
);
export const AdminContentFeedsPage = (props: Props) => (
  <CommunityToolsPage {...props} feature="feeds" />
);
function CommunityToolsPage(props: Props & { feature: CommunityFeature }) {
  if (!props.selectedGuildId) return <NoGuildSelected feature={labels[props.feature]} />;
  if (!props.initialData || props.initialData.guildId !== props.selectedGuildId)
    return <PageFeedback error="Settings could not be loaded. Refresh this page to try again." />;
  return (
    <CommunityToolsEditor
      key={`${props.selectedWorkspaceId}:${props.selectedGuildId}:${props.feature}`}
      {...props}
      initialData={props.initialData}
    />
  );
}
function CommunityToolsEditor({
  selectedGuildId,
  selectedWorkspaceId,
  feature,
  initialData,
}: Props & { feature: CommunityFeature; initialData: CommunityToolsLoaderData }) {
  const [config, setConfigState] = useState<CommunityConfig>(initialData.config);
  const [saved, setSaved] = useState(initialData.config);
  const [revision, setRevision] = useState(initialData.revision);
  const [message, setMessage] = useState<string | null>(null);
  const setConfig = (value: CommunityConfig) => {
    setConfigState(value);
    setMessage(null);
  };
  const [cases, setCases] = useState<Array<{
    id: string;
    userId: string;
    action: string;
    reason: string;
  }> | null>(null);
  const api = useAdminApi();
  const saving = useRef(false);
  const { resources, loading: resourcesLoading } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
  );
  const channels = resources?.textChannels ?? [];
  const roles = resources?.roles ?? [];
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  async function save() {
    if (saving.current) return;
    saving.current = true;
    const snapshot = config;
    try {
      await api.run(async () => {
        const result = await createAdminLoaderClient().postJson<ConfigSnapshot>(
          `/admin/api/community-${feature}`,
          { config: snapshot, revision },
          { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
        );
        setConfig(result.config);
        setSaved(result.config);
        setRevision(result.revision);
        setMessage("Settings saved.");
      });
    } finally {
      saving.current = false;
    }
  }
  const enabled = (label: string, value: boolean, onChange: (value: boolean) => void) => (
    <label className="flex items-center gap-2">
      <Switch aria-label={label} checked={value} onCheckedChange={onChange} />
      {label}
    </label>
  );
  return (
    <section className="admin-feature-page space-y-6">
      <AdminPageHeader title={labels[feature]} description={descriptions[feature]} />
      <NavigationGuard hasChanges={dirty} />
      <UnsavedChangesIndicator hasChanges={dirty} />
      <PageFeedback error={api.error} message={message} />
      <fieldset disabled={api.loading} className="space-y-6">
        {enabled(`Enable ${labels[feature]}`, config.enabled, (value) =>
          setConfig({ ...config, enabled: value }),
        )}
        {"commands" in config && (
          <>
            <SectionHeader
              title="Custom replies"
              description="Match member messages or invoke a reply with /custom name. Use {user} for the member mention."
            />
            {config.commands.map((command, index) => {
              const update = (change: Partial<typeof command>) =>
                setConfig({
                  ...config,
                  commands: config.commands.map((item, i) =>
                    i === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <SettingsBlock key={index}>
                  <div className="flex justify-between gap-3">
                    {enabled(`Enable reply ${index + 1}`, command.enabled, (value) =>
                      update({ enabled: value }),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setConfig({
                          ...config,
                          commands: config.commands.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove reply
                    </Button>
                  </div>
                  <FormField label="Command name">
                    <Input
                      value={command.id}
                      maxLength={40}
                      onChange={(event) => update({ id: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Message trigger">
                    <Input
                      value={command.trigger}
                      maxLength={100}
                      onChange={(event) => update({ trigger: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Match">
                    <select
                      className="admin-input"
                      value={command.match}
                      onChange={(event) =>
                        update({ match: event.target.value as typeof command.match })
                      }
                    >
                      <option value="exact">Exact message</option>
                      <option value="prefix">Starts with</option>
                      <option value="contains">Contains</option>
                    </select>
                  </FormField>
                  <FormField label="Reply">
                    <Textarea
                      value={command.response}
                      maxLength={1800}
                      onChange={(event) => update({ response: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Allowed channels (empty means all)">
                    <MultiChannelPicker
                      channels={channels}
                      value={command.channelIds}
                      onChange={(channelIds) => update({ channelIds })}
                    />
                  </FormField>
                  <FormField label="Required roles (any selected role)">
                    <MultiRoleSelect
                      roles={roles}
                      value={command.requiredRoleIds}
                      onChange={(requiredRoleIds) => update({ requiredRoleIds })}
                    />
                  </FormField>
                  <FormField label="Member cooldown in seconds">
                    <Input
                      type="number"
                      min={5}
                      max={86400}
                      value={command.cooldownSeconds}
                      onChange={(event) => update({ cooldownSeconds: Number(event.target.value) })}
                    />
                  </FormField>
                </SettingsBlock>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={config.commands.length >= 50}
              onClick={() =>
                setConfig({
                  ...config,
                  commands: [
                    ...config.commands,
                    customReplySchema.parse({
                      id: newId("reply"),
                      trigger: "!connect",
                      response: "Ask a server admin to add your connection details.",
                    }),
                  ],
                })
              }
            >
              Add custom reply
            </Button>
            <SectionHeader
              title="Recurring messages"
              description="Publish once per interval from the chosen start time. Missed intervals are skipped rather than replayed. Role notifications are opt in."
            />
            {config.schedules.map((schedule, index) => {
              const update = (change: Partial<typeof schedule>) =>
                setConfig({
                  ...config,
                  schedules: config.schedules.map((item, i) =>
                    i === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <SettingsBlock key={schedule.id}>
                  <div className="flex justify-between gap-3">
                    {enabled(`Enable schedule ${index + 1}`, schedule.enabled, (value) =>
                      update({ enabled: value }),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setConfig({
                          ...config,
                          schedules: config.schedules.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove schedule
                    </Button>
                  </div>
                  <FormField label="Destination">
                    <ChannelSelect
                      channels={channels}
                      value={schedule.channelId}
                      onChange={(channelId) => update({ channelId })}
                    />
                  </FormField>
                  <FormField label="Message">
                    <Textarea
                      value={schedule.content}
                      maxLength={1800}
                      onChange={(event) => update({ content: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Repeat every (minutes)">
                    <Input
                      type="number"
                      min={15}
                      max={43200}
                      value={schedule.intervalMinutes}
                      onChange={(event) => update({ intervalMinutes: Number(event.target.value) })}
                    />
                  </FormField>
                  <FormField label="First publication (UTC)">
                    <Input
                      type="datetime-local"
                      value={new Date(schedule.startsAtMs).toISOString().slice(0, 16)}
                      onChange={(event) => {
                        const startsAtMs = Date.parse(`${event.target.value}:00Z`);
                        if (Number.isFinite(startsAtMs)) update({ startsAtMs });
                      }}
                    />
                  </FormField>
                  <FormField label="Notify roles">
                    <MultiRoleSelect
                      roles={roles}
                      value={schedule.notifyRoleIds}
                      onChange={(notifyRoleIds) => update({ notifyRoleIds })}
                    />
                  </FormField>
                </SettingsBlock>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={config.schedules.length >= 10}
              onClick={() =>
                setConfig({
                  ...config,
                  schedules: [
                    ...config.schedules,
                    recurringMessageSchema.parse({
                      id: newId("schedule"),
                      channelId: channels[0]?.id ?? "1",
                      content: "Your community announcement",
                      intervalMinutes: 1440,
                      startsAtMs: Date.now() + 60000,
                    }),
                  ],
                })
              }
            >
              Add recurring message
            </Button>
          </>
        )}
        {"rules" in config && (
          <>
            <FormField label="Moderator roles">
              <MultiRoleSelect
                roles={roles}
                value={config.moderatorRoleIds}
                onChange={(moderatorRoleIds) => setConfig({ ...config, moderatorRoleIds })}
              />
            </FormField>
            <FormField label="Private member-report channel">
              <ChannelSelect
                channels={channels}
                value={config.reportChannelId ?? ""}
                onChange={(reportChannelId) =>
                  setConfig({ ...config, reportChannelId: reportChannelId || null })
                }
              />
            </FormField>
            <p>
              Staff use /mod for warnings, history, timeouts, kicks, bans, unbans and filtered
              message cleanup. Account actions also require the staff member’s Discord permission
              and role hierarchy.
            </p>
            {config.rules.map((rule, index) => {
              const update = (change: Partial<typeof rule>) =>
                setConfig({
                  ...config,
                  rules: config.rules.map((item, i) =>
                    i === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <SettingsBlock key={rule.id}>
                  <div className="flex justify-between gap-3">
                    {enabled(`Enable rule ${index + 1}`, rule.enabled, (value) =>
                      update({ enabled: value }),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setConfig({ ...config, rules: config.rules.filter((_, i) => i !== index) })
                      }
                    >
                      Remove rule
                    </Button>
                  </div>
                  <FormField label="Rule name">
                    <Input
                      value={rule.name}
                      maxLength={80}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Trigger">
                    <select
                      className="admin-input"
                      value={rule.trigger}
                      onChange={(event) =>
                        update({ trigger: event.target.value as typeof rule.trigger })
                      }
                    >
                      <option value="words">Words or phrases</option>
                      <option value="domains">Linked domains</option>
                      <option value="invites">Discord invites</option>
                      <option value="message-rate">Message rate</option>
                    </select>
                  </FormField>
                  {["words", "domains"].includes(rule.trigger) && (
                    <FormField label="Values (one per line)">
                      <Textarea
                        value={rule.values.join("\n")}
                        onChange={(event) =>
                          update({
                            values: event.target.value.split("\n").map((value) => value.trim()),
                          })
                        }
                      />
                    </FormField>
                  )}
                  {rule.trigger === "message-rate" && (
                    <FormField label="Messages before triggering">
                      <Input
                        type="number"
                        min={3}
                        max={100}
                        value={rule.messageLimit}
                        onChange={(event) => update({ messageLimit: Number(event.target.value) })}
                      />
                    </FormField>
                  )}
                  <FormField label="Count violations within (seconds)">
                    <Input
                      type="number"
                      min={5}
                      max={86400}
                      value={rule.windowSeconds}
                      onChange={(event) => update({ windowSeconds: Number(event.target.value) })}
                    />
                  </FormField>
                  <FormField label="Channels (empty means all)">
                    <MultiChannelPicker
                      channels={channels}
                      value={rule.channelIds}
                      onChange={(channelIds) => update({ channelIds })}
                    />
                  </FormField>
                  <FormField label="Excluded roles">
                    <MultiRoleSelect
                      roles={roles}
                      value={rule.excludedRoleIds}
                      onChange={(excludedRoleIds) => update({ excludedRoleIds })}
                    />
                  </FormField>
                  {enabled("Delete triggering messages", rule.deleteMessage, (value) =>
                    update({ deleteMessage: value }),
                  )}
                  {enabled("Post a warning", rule.warn, (value) => update({ warn: value }))}
                  <FormField label="Timeout after violations (0 disables timeouts)">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={rule.timeoutAfter}
                      onChange={(event) => update({ timeoutAfter: Number(event.target.value) })}
                    />
                  </FormField>
                  {rule.timeoutAfter > 0 && (
                    <FormField label="Timeout duration (minutes)">
                      <Input
                        type="number"
                        min={1}
                        max={40320}
                        value={rule.timeoutMinutes}
                        onChange={(event) => update({ timeoutMinutes: Number(event.target.value) })}
                      />
                    </FormField>
                  )}
                </SettingsBlock>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={config.rules.length >= 25}
              onClick={() =>
                setConfig({
                  ...config,
                  rules: [
                    ...config.rules,
                    moderationRuleSchema.parse({
                      id: newId("rule"),
                      name: "New rule",
                      trigger: "invites",
                    }),
                  ],
                })
              }
            >
              Add moderation rule
            </Button>
          </>
        )}
        {"feeds" in config && (
          <>
            <p>
              New subscriptions first record the current content without posting historical updates.
              Checks run about every five minutes. Each check posts at most three new items.
            </p>
            {!initialData.twitchAvailable && (
              <p>
                Twitch alerts need operator setup before they can be enabled. YouTube, Reddit and
                RSS do not need Twitch setup.
              </p>
            )}
            {config.feeds.map((feed, index) => {
              const update = (change: Partial<typeof feed>) =>
                setConfig({
                  ...config,
                  feeds: config.feeds.map((item, i) =>
                    i === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <SettingsBlock key={feed.id}>
                  <div className="flex justify-between gap-3">
                    {enabled(`Enable feed ${index + 1}`, feed.enabled, (value) =>
                      update({ enabled: value }),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setConfig({ ...config, feeds: config.feeds.filter((_, i) => i !== index) })
                      }
                    >
                      Remove feed
                    </Button>
                  </div>
                  <FormField label="Feed name">
                    <Input
                      value={feed.name}
                      maxLength={80}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Provider">
                    <select
                      className="admin-input"
                      value={feed.provider}
                      onChange={(event) =>
                        update({ provider: event.target.value as typeof feed.provider, source: "" })
                      }
                    >
                      <option value="rss">RSS or Atom</option>
                      <option value="youtube">YouTube</option>
                      <option value="reddit">Reddit</option>
                      <option value="twitch">Twitch</option>
                    </select>
                  </FormField>
                  <FormField
                    label={
                      feed.provider === "rss"
                        ? "Public HTTPS feed URL"
                        : feed.provider === "youtube"
                          ? "YouTube channel ID (UC…)"
                          : feed.provider === "reddit"
                            ? "Subreddit name"
                            : "Twitch login name"
                    }
                  >
                    <Input
                      value={feed.source}
                      maxLength={1000}
                      onChange={(event) => update({ source: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Destination">
                    <ChannelSelect
                      channels={channels}
                      value={feed.channelId}
                      onChange={(channelId) => update({ channelId })}
                    />
                  </FormField>
                  <FormField label="Notify roles">
                    <MultiRoleSelect
                      roles={roles}
                      value={feed.notifyRoleIds}
                      onChange={(notifyRoleIds) => update({ notifyRoleIds })}
                    />
                  </FormField>
                </SettingsBlock>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={config.feeds.length >= 10}
              onClick={() =>
                setConfig({
                  ...config,
                  feeds: [
                    ...config.feeds,
                    contentFeedSchema.parse({
                      id: newId("feed"),
                      name: "Community updates",
                      provider: "rss",
                      source: "https://example.com/feed.xml",
                      channelId: channels[0]?.id ?? "1",
                    }),
                  ],
                })
              }
            >
              Add content feed
            </Button>
          </>
        )}
        <Button
          type="button"
          disabled={!dirty || api.loading || resourcesLoading}
          onClick={() => void save()}
        >
          {api.loading ? "Saving…" : "Save settings"}
        </Button>
      </fieldset>
      {feature === "moderation" && (
        <>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={api.loading}
              onClick={() =>
                void api.run(async () => {
                  const result = await createAdminLoaderClient().getJson<{
                    cases: NonNullable<typeof cases>;
                  }>("/admin/api/community-moderation/history", {
                    guildId: selectedGuildId,
                    workspaceId: selectedWorkspaceId,
                  });
                  setCases(result.cases);
                })
              }
            >
              View recent moderation activity
            </Button>
            {cases && (
              <ul>
                {cases.map((entry) => (
                  <li key={entry.id}>
                    {entry.action}: {entry.reason} · {entry.userId}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <AdminBanAppealsPanel
            selectedGuildId={selectedGuildId}
            selectedWorkspaceId={selectedWorkspaceId}
          />
        </>
      )}
      {initialData.status && (
        <div>
          {feature === "feeds" && "feeds" in config && (
            <>
              <SectionHeader title="Latest source checks" />
              {config.feeds.map((feed) => {
                const state = initialData.status?.feeds.find((entry) => entry.feed_id === feed.id);
                return (
                  <p key={feed.id}>
                    {feed.name}:{" "}
                    {state
                      ? state.last_error
                        ? String(state.last_error)
                        : `Checked ${new Date(Number(state.checked_at_ms)).toLocaleString()}`
                      : "Awaiting first check"}
                  </p>
                );
              })}
            </>
          )}
          <SectionHeader title="Recent deliveries" />
          {initialData.status.deliveries
            .filter((entry) => entry.feature === feature)
            .slice(0, 10)
            .map((entry) => (
              <p key={String(entry.id)}>
                {String(entry.status)}
                {entry.last_error ? ` — ${String(entry.last_error)}` : ""}
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
function MultiChannelPicker({
  channels,
  value,
  onChange,
}: {
  channels: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <select
      className="admin-input"
      multiple
      aria-label="Selected channels"
      value={value}
      onChange={(event) =>
        onChange(Array.from(event.target.selectedOptions).map((option) => option.value))
      }
    >
      {channels.map((channel) => (
        <option key={channel.id} value={channel.id}>
          #{channel.name}
        </option>
      ))}
    </select>
  );
}
