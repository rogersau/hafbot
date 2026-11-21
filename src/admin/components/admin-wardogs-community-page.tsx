import { useState } from "react";
import type {
  WardogsCommunityDashboard,
  PublishedWardogsPanel,
} from "../../runtime/admin-routes/wardogs-community";
import type { WardogsGoldStatus, WardogsPublicStats } from "../../wardogs/community-data";
import { DEFAULT_WARDOGS_PANEL_TITLE, WARDOGS_PANEL_INSTRUCTIONS } from "../../wardogs/link-panel";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect } from "./guild-resource-select";
import { NavigationGuard } from "./navigation-guard";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const endpoint = "/admin/api/wardogs/community";
const number = new Intl.NumberFormat("en-US");
const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const roles = ["assault", "medic", "recon", "support", "driver", "pilot"];

interface Props {
  selectedGuildId: string;
  selectedWorkspaceId: string;
  initialData?: WardogsCommunityDashboard | null;
}

export function AdminWardogsCommunityPage({
  selectedGuildId,
  selectedWorkspaceId,
  initialData,
}: Props) {
  if (!selectedGuildId) return <NoGuildSelected feature="WARDOGS community" />;
  return (
    <main className="admin-feature-page space-y-6">
      <AdminPageHeader title="WARDOGS community" />
      {initialData?.enabled ? (
        <WardogsCommunitySettings
          key={`${selectedWorkspaceId}:${selectedGuildId}`}
          guildId={selectedGuildId}
          workspaceId={selectedWorkspaceId}
          initialData={initialData}
        />
      ) : (
        <PageFeedback
          error={
            initialData
              ? "WARDOGS community features are disabled for this installation."
              : "Could not load WARDOGS community settings."
          }
        />
      )}
    </main>
  );
}

function WardogsCommunitySettings({
  guildId,
  workspaceId,
  initialData,
}: {
  guildId: string;
  workspaceId: string;
  initialData: WardogsCommunityDashboard;
}) {
  const scope = { guildId, workspaceId };
  const {
    resources,
    loading: channelsLoading,
    error: channelsError,
  } = useGuildResources(workspaceId, guildId);
  const channels = resources?.textChannels ?? [];
  const [gold, setGold] = useState(initialData.gold);
  const [goldAvailable, setGoldAvailable] = useState(initialData.goldAvailable);
  const [savedGoldChannel, setSavedGoldChannel] = useState(initialData.goldChannelId ?? "");
  const [goldChannel, setGoldChannel] = useState(savedGoldChannel);
  const [goldSaved, setGoldSaved] = useState(false);
  const [panel, setPanel] = useState(initialData.panel);
  const [panelDraft, setPanelDraft] = useState(() => panelDraftFor(initialData.panel));
  const [panelSaved, setPanelSaved] = useState(false);
  const goldRequest = useAdminApi();
  const goldSave = useAdminApi();
  const panelPublish = useAdminApi();
  const goldDirty = goldChannel !== savedGoldChannel;
  const savedPanelDraft = panelDraftFor(panel);
  const panelDirty =
    panelDraft.channelId !== savedPanelDraft.channelId ||
    panelDraft.title !== savedPanelDraft.title ||
    panelDraft.description !== savedPanelDraft.description;
  const steamSetup = `/admin/${guildId}/player-link?${new URLSearchParams({ platform: "steam", ...(workspaceId ? { workspaceId } : {}) })}`;

  return (
    <>
      <NavigationGuard hasChanges={initialData.canWrite && (goldDirty || panelDirty)} />
      {channelsError && initialData.canWrite ? (
        <PageFeedback
          error={
            channelsError instanceof Error
              ? channelsError.message
              : "Could not load Discord channels."
          }
        />
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
        <SettingsBlock>
          <SectionHeader
            title="Gold Exchange"
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={goldRequest.loading}
                onClick={() => {
                  void goldRequest.run(
                    () =>
                      createAdminLoaderClient().getJson<WardogsCommunityDashboard>(endpoint, scope),
                    (data) => {
                      setGold(data.gold);
                      setGoldAvailable(data.goldAvailable);
                    },
                  );
                }}
              >
                {goldRequest.loading ? "Refreshing…" : "Refresh price"}
              </Button>
            }
          />
          <PageFeedback error={goldRequest.error} />
          {gold ? (
            <GoldPriceHistory gold={gold} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {goldAvailable
                ? "The price feed is temporarily unavailable."
                : "The bot operator needs to configure the gold price feed."}
            </p>
          )}
          <a
            className="inline-block text-sm text-primary underline"
            href="https://wardogserverlist.com/gold-bars"
            target="_blank"
            rel="noreferrer"
          >
            Data from WARDOGS Server List
          </a>
        </SettingsBlock>
        <SettingsBlock>
          <SectionHeader
            title="Daily gold updates"
            description="Posts the rate and recent history once per UTC day when the feed reports that day's price."
          />
          <p className="text-sm text-muted-foreground">
            {savedGoldChannel
              ? `Posting in #${channels.find(({ id }) => id === savedGoldChannel)?.name ?? savedGoldChannel}`
              : "Daily posts are off."}
          </p>
          {initialData.canWrite ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void goldSave.run(
                  () =>
                    createAdminLoaderClient().postJson<{ goldChannelId: string | null }>(
                      endpoint,
                      {
                        action: "gold",
                        channelId: goldChannel || null,
                      },
                      scope,
                    ),
                  ({ goldChannelId }) => {
                    setSavedGoldChannel(goldChannelId ?? "");
                    setGoldChannel(goldChannelId ?? "");
                    setGoldSaved(true);
                  },
                );
              }}
            >
              <FormField label="Daily update channel" htmlFor="wardogs-gold-channel">
                <ChannelSelect
                  id="wardogs-gold-channel"
                  channels={channels}
                  value={goldChannel}
                  allowClear
                  placeholder="Daily posts are off"
                  disabled={
                    channelsLoading || goldSave.loading || (!goldAvailable && !savedGoldChannel)
                  }
                  onChange={(value) => {
                    setGoldChannel(value);
                    setGoldSaved(false);
                  }}
                  creation={
                    goldAvailable
                      ? {
                          ...scope,
                          surfaceKey: "wardogs_community",
                          dependencyKey: "gold_channel",
                          label: "gold update channel",
                          recommendedName: "wardogs-gold",
                        }
                      : undefined
                  }
                />
              </FormField>
              <Button
                type="submit"
                disabled={goldSave.loading || !goldDirty || Boolean(goldChannel && !goldAvailable)}
              >
                {goldSave.loading ? "Saving…" : "Save daily updates"}
              </Button>
              <PageFeedback
                error={goldSave.error}
                message={goldSaved ? "Daily update settings saved." : null}
              />
            </form>
          ) : null}
        </SettingsBlock>
        <SettingsBlock>
          <SectionHeader
            title="WARDOGS link panel"
            description="Give members a place in Discord to link Steam and sync their WARDOGS stats."
          />
          {panel ? (
            <a
              className="text-sm text-primary underline"
              href={`https://discord.com/channels/${guildId}/${panel.channelId}/${panel.messageId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open published panel in Discord
            </a>
          ) : null}
          {!initialData.steamLinkReady ? (
            <p className="text-sm text-muted-foreground">
              <a className="text-primary underline" href={steamSetup}>
                Set up Steam Player Link
              </a>{" "}
              before publishing this panel.
            </p>
          ) : null}
          {initialData.steamLinkReady && !initialData.trackerConnectAvailable ? (
            <p className="text-sm text-muted-foreground">
              The sync button opens WARDOGS Tracker for Steam sign-in.
            </p>
          ) : null}
          {initialData.canWrite ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void panelPublish.run(
                  () =>
                    createAdminLoaderClient().postJson<{ panel: PublishedWardogsPanel }>(
                      endpoint,
                      { action: "publish-panel", ...panelDraft },
                      scope,
                    ),
                  (result) => {
                    setPanel(result.panel);
                    setPanelDraft(panelDraftFor(result.panel));
                    setPanelSaved(true);
                  },
                );
              }}
            >
              <fieldset
                className="space-y-4"
                disabled={!initialData.steamLinkReady || panelPublish.loading}
              >
                <FormField label="Link panel channel" htmlFor="wardogs-panel-channel">
                  <ChannelSelect
                    id="wardogs-panel-channel"
                    channels={channels}
                    value={panelDraft.channelId}
                    disabled={
                      channelsLoading || !initialData.steamLinkReady || panelPublish.loading
                    }
                    onChange={(channelId) => {
                      setPanelDraft({ ...panelDraft, channelId });
                      setPanelSaved(false);
                    }}
                    creation={{
                      ...scope,
                      surfaceKey: "wardogs_community",
                      dependencyKey: "panel_channel",
                      label: "link panel channel",
                      recommendedName: "link-wardogs",
                    }}
                  />
                </FormField>
                <FormField label="Panel title" htmlFor="wardogs-panel-title">
                  <Input
                    id="wardogs-panel-title"
                    value={panelDraft.title}
                    maxLength={100}
                    required
                    onChange={(event) => {
                      setPanelDraft({ ...panelDraft, title: event.target.value });
                      setPanelSaved(false);
                    }}
                  />
                </FormField>
                <FormField label="Panel message (optional)" htmlFor="wardogs-panel-message">
                  <Textarea
                    id="wardogs-panel-message"
                    value={panelDraft.description}
                    maxLength={800}
                    rows={2}
                    onChange={(event) => {
                      setPanelDraft({ ...panelDraft, description: event.target.value });
                      setPanelSaved(false);
                    }}
                  />
                </FormField>
                <Button type="submit" disabled={!panelDraft.channelId || !panelDraft.title.trim()}>
                  {panelPublish.loading
                    ? "Publishing…"
                    : panel?.channelId === panelDraft.channelId
                      ? "Update link panel"
                      : "Publish link panel"}
                </Button>
              </fieldset>
              <PageFeedback
                error={panelPublish.error}
                message={panelSaved ? "WARDOGS link panel published." : null}
              />
            </form>
          ) : null}
          <div
            className="space-y-2 rounded border-l-2 border-amber-500 bg-muted/35 p-3 text-sm"
            aria-label="Discord panel preview"
          >
            <p className="break-words font-semibold">
              {panelDraft.title || DEFAULT_WARDOGS_PANEL_TITLE}
            </p>
            {panelDraft.description ? (
              <p className="whitespace-pre-wrap break-words">{panelDraft.description}</p>
            ) : null}
            <p className="text-muted-foreground">{WARDOGS_PANEL_INSTRUCTIONS}</p>
            <div className="flex flex-wrap gap-2" aria-hidden="true">
              <span className="rounded bg-primary px-2.5 py-1 text-primary-foreground">
                Link Steam
              </span>
              <span className="rounded bg-muted px-2.5 py-1">Sync WARDOGS stats</span>
            </div>
          </div>
        </SettingsBlock>
        <PlayerStatsLookup guildId={guildId} workspaceId={workspaceId} />
      </div>
    </>
  );
}

function panelDraftFor(panel: PublishedWardogsPanel | null) {
  return {
    channelId: panel?.channelId ?? "",
    title: panel?.title ?? DEFAULT_WARDOGS_PANEL_TITLE,
    description: panel?.description ?? "",
  };
}

function GoldPriceHistory({ gold: { latest, history } }: { gold: WardogsGoldStatus }) {
  const yesterday = history.find(({ ts }) => ts === latest.ts - 86_400_000);
  const high = Math.max(latest.price, ...history.map(({ price }) => price));
  return (
    <div className="space-y-4">
      <div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight text-foreground sm:text-4xl">
          {number.format(latest.price)}
        </p>
        <p className="text-sm text-muted-foreground">
          Cash per gold bar · {day.format(latest.ts)} UTC
        </p>
        {yesterday ? (
          <p className="mt-1 text-sm tabular-nums">
            {percent.format(latest.price / yesterday.price - 1)} vs. yesterday
          </p>
        ) : null}
      </div>
      {history.length > 1 ? (
        <figure className="space-y-2">
          <figcaption className="text-sm font-medium">Price history (UTC)</figcaption>
          <ul className="space-y-1.5" aria-label="Cash per gold bar by UTC date">
            {history.map(({ ts, price }) => (
              <li
                key={ts}
                className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-2 text-xs tabular-nums"
              >
                <time dateTime={new Date(ts).toISOString()}>{day.format(ts)}</time>
                <div className="h-2 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-sm bg-amber-500"
                    style={{ width: `${(price / high) * 100}%` }}
                  />
                </div>
                <span className="min-w-14 text-right">{number.format(price)}</span>
              </li>
            ))}
          </ul>
        </figure>
      ) : null}
    </div>
  );
}

function PlayerStatsLookup({ guildId, workspaceId }: { guildId: string; workspaceId: string }) {
  const [steamId, setSteamId] = useState("");
  const [result, setResult] = useState<{
    steamId: string;
    stats: WardogsPublicStats | null;
  } | null>(null);
  const api = useAdminApi();
  return (
    <SettingsBlock>
      <SectionHeader
        title="Player stats"
        description="Look up a public WARDOGS Tracker snapshot by SteamID64."
      />
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const id = steamId.trim();
          setResult(null);
          void api.run(
            () =>
              createAdminLoaderClient().getJson<{ stats: WardogsPublicStats | null }>(
                `${endpoint}/player`,
                {
                  guildId,
                  workspaceId,
                  search: { steamId: id },
                },
              ),
            ({ stats }) => setResult({ steamId: id, stats }),
          );
        }}
      >
        <div className="min-w-0 flex-1">
          <FormField label="SteamID64" htmlFor="wardogs-steam-id">
            <Input
              id="wardogs-steam-id"
              inputMode="numeric"
              value={steamId}
              maxLength={17}
              required
              pattern="[0-9]{17}"
              onChange={(event) => setSteamId(event.target.value)}
            />
          </FormField>
        </div>
        <Button type="submit" disabled={api.loading || !/^\d{17}$/.test(steamId)}>
          {api.loading ? "Looking up…" : "Look up player"}
        </Button>
      </form>
      <PageFeedback error={api.error} />
      {result &&
        (result.stats ? (
          <div className="space-y-2" aria-live="polite">
            <p className="text-xl font-semibold">Level {number.format(result.stats.wardogLevel)}</p>
            <p className="text-sm">{number.format(result.stats.careerXp)} career XP</p>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {(
                [
                  ["Cash", result.stats.cash],
                  ["Gold bars", result.stats.gold],
                  ["Unlocks", result.stats.unlocks],
                ] as const
              ).map(([label, value]) =>
                value == null ? null : (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">{number.format(value)}</dd>
                  </div>
                ),
              )}
              {roles.map((role) => {
                const level = result.stats!.roles?.[role]?.level;
                return level === undefined ? null : (
                  <div key={role}>
                    <dt className="capitalize text-muted-foreground">{role}</dt>
                    <dd>Level {number.format(level)}</dd>
                  </div>
                );
              })}
            </dl>
            <p className="text-sm text-muted-foreground">
              Synced{" "}
              <time dateTime={result.stats.syncedAt}>
                {new Date(result.stats.syncedAt).toLocaleString()}
              </time>
            </p>
            <a
              className="text-sm text-primary underline"
              href={`https://wardogstracker.gg/profile/${result.steamId}`}
              target="_blank"
              rel="noreferrer"
            >
              View on WARDOGS Tracker
            </a>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            No public stats are available for this Steam account.
          </p>
        ))}
    </SettingsBlock>
  );
}
