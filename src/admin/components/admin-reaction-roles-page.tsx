import { useState } from "react";
import {
  MAX_REACTION_ROLE_OPTIONS,
  MAX_REACTION_ROLE_PANELS,
  isPublishedReactionRoleOption,
  parseReactionRoleEmoji,
  reactionRoleSettingsSchema,
  type ReactionRolePanel,
  type ReactionRoleSettings,
} from "../../reaction-roles";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { readResponseError } from "../lib/api";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsPanel } from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { EmojiPicker } from "./emoji-picker";
import { NavigationGuard } from "./navigation-guard";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const defaults: ReactionRoleSettings = {
  channelId: "",
  title: "Choose your games",
  description: "React below to unlock the channels for the games you play.",
  mode: "multiple",
  requiredRoleIds: [],
  blockedRoleIds: [],
  options: [{ emoji: "🟢", roleId: "", label: "" }],
};
const settingsOf = (panel: ReactionRolePanel | null): ReactionRoleSettings =>
  panel
    ? {
        channelId: panel.channelId,
        title: panel.title,
        description: panel.description,
        mode: panel.mode ?? "multiple",
        requiredRoleIds: panel.requiredRoleIds ?? [],
        blockedRoleIds: panel.blockedRoleIds ?? [],
        options: panel.options,
      }
    : defaults;

export function AdminReactionRolesPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: { panel: ReactionRolePanel | null; panels?: ReactionRolePanel[] } | null;
}) {
  const [panel, setPanel] = useState(initialData?.panel ?? null);
  const [panels, setPanels] = useState<ReactionRolePanel[]>(
    initialData?.panels ?? (initialData?.panel ? [initialData.panel] : []),
  );
  const [settings, setSettings] = useState<ReactionRoleSettings>(() =>
    settingsOf(initialData?.panel ?? null),
  );
  const api = useAdminApi();
  const toast = useToast();
  const confirmDialog = useConfirmDialog();
  const resources = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
    "/admin/api/reaction-roles/resources",
  );
  const dirty = JSON.stringify(settings) !== JSON.stringify(settingsOf(panel));

  if (!selectedGuildId) return <NoGuildSelected feature="Reaction Roles" />;
  if (!initialData)
    return (
      <PageFeedback error="Reaction Roles could not be loaded. Refresh the page to try again." />
    );

  async function request(method: string, path: string, body: object = {}) {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(panel ? { panelId: panel.id } : {}),
        ...body,
        guildId: selectedGuildId,
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
      }),
    });
    if (!response.ok)
      throw new Error(await readResponseError(response, "Reaction Roles could not be updated."));
    return response.json() as Promise<{
      panel: ReactionRolePanel | null;
      panels?: ReactionRolePanel[];
    }>;
  }

  const accept = (result: { panel: ReactionRolePanel | null; panels?: ReactionRolePanel[] }) => {
    if (result.panels) setPanels(result.panels);
    else
      setPanels((current) =>
        result.panel
          ? [...current.filter((entry) => entry.id !== result.panel!.id), result.panel]
          : current.filter((entry) => entry.id !== panel?.id),
      );
    setPanel(result.panel);
    setSettings(settingsOf(result.panel));
  };
  const save = (publish: boolean) => {
    const parsed = reactionRoleSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      api.setError(parsed.error.issues[0]?.message ?? "Check the panel settings.");
      return;
    }
    void api.run(
      async () => {
        const saved = await request("POST", "/admin/api/reaction-roles", {
          settings: parsed.data,
          panelId: panel?.id ?? null,
        });
        accept(saved);
        return publish
          ? request("POST", "/admin/api/reaction-roles/publish", { panelId: saved.panel?.id })
          : saved;
      },
      (result) => {
        accept(result);
        toast.success(
          publish ? "Reaction Roles published." : "Draft saved. Publish it when ready.",
        );
      },
    );
  };
  const remove = async () => {
    if (
      !(await confirmDialog.confirm({
        title: "Delete the reaction-role panel?",
        description:
          "HAF will remove this configuration and delete the message when it belongs to the current bot. Remove messages from a previous bot in Discord manually. Members keep their existing roles.",
        confirmLabel: "Delete panel",
        variant: "destructive",
      }))
    )
      return;
    void api.run(
      () => request("DELETE", "/admin/api/reaction-roles"),
      (result) => {
        accept(result);
        toast.success("Reaction-role panel configuration deleted.");
      },
    );
  };
  const changeOption = (
    index: number,
    change: Partial<ReactionRoleSettings["options"][number]>,
  ) => {
    setSettings((current) => ({
      ...current,
      options: current.options.map((option, i) =>
        i === index ? { ...option, ...change } : option,
      ),
    }));
  };
  const lockedChoice = (index: number) =>
    Boolean(
      panel?.messageId &&
      isPublishedReactionRoleOption(panel, settings.options[index]) &&
      settings.options.findIndex((option) => option.roleId === settings.options[index].roleId) ===
        index,
    );
  const selectPanel = async (next: ReactionRolePanel | null) => {
    if (
      dirty &&
      !(await confirmDialog.confirm({
        title: "Discard unsaved panel changes?",
        description: "Switching panels discards the changes in this editor.",
        confirmLabel: "Discard changes",
      }))
    )
      return;
    setPanel(next);
    setSettings(settingsOf(next));
    api.setError(null);
  };

  return (
    <div className="space-y-6">
      {confirmDialog.dialog}
      <NavigationGuard hasChanges={dirty} onDiscardChanges={() => setSettings(settingsOf(panel))} />
      <AdminPageHeader
        title="Reaction Roles"
        description="Let members choose games, regions, platforms, and notifications from independently managed role panels."
      />
      <PageFeedback error={api.error} />
      <SettingsPanel>
        <SectionHeader
          title="Role panels"
          description={`Keep up to ${MAX_REACTION_ROLE_PANELS} independent panels, with up to 20 choices in each.`}
        />
        <div className="flex flex-wrap gap-2">
          {panels.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant={entry.id === panel?.id ? "default" : "outline"}
              disabled={api.loading}
              onClick={() => void selectPanel(entry)}
              aria-pressed={entry.id === panel?.id}
            >
              Edit {entry.title}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={api.loading || panels.length >= MAX_REACTION_ROLE_PANELS}
            onClick={() => void selectPanel(null)}
          >
            New panel
          </Button>
        </div>
      </SettingsPanel>
      <SettingsPanel>
        <SectionHeader
          title={panel ? "Edit panel" : "New role panel"}
          description="Each panel has its own channel, selection mode, eligibility, and publish controls. HAF checks role permissions before publishing and assigning."
        />
        <p className="text-sm text-muted-foreground">
          Create a Discord role per game and give it access to that game's category. HAF needs
          Manage Roles and a role above your game roles, plus View Channel, Send Messages, Add
          Reactions, and Read Message History in this channel.
        </p>
        <FormField label="Panel channel" htmlFor="reaction-role-channel">
          <ChannelSelect
            id="reaction-role-channel"
            value={settings.channelId}
            onChange={(channelId) => setSettings({ ...settings, channelId })}
            channels={resources.resources?.textChannels ?? []}
            disabled={api.loading || Boolean(panel?.messageId)}
          />
        </FormField>
        <FormField label="Selection mode" htmlFor="reaction-role-mode">
          <select
            id="reaction-role-mode"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={settings.mode ?? "multiple"}
            disabled={api.loading}
            onChange={(event) =>
              setSettings({ ...settings, mode: event.target.value as "multiple" | "single" })
            }
          >
            <option value="multiple">Multiple roles</option>
            <option value="single">One role at a time</option>
          </select>
        </FormField>
        {settings.mode === "single" ? (
          <p className="text-sm text-muted-foreground">
            A new selection replaces the previous role and clears its reaction. HAF also needs
            Manage Messages in this channel.
          </p>
        ) : null}
        <FormField
          label="Required roles"
          htmlFor="reaction-role-required"
          hint="Members must hold every selected role before a new role can be granted. Leave empty to allow everyone."
        >
          <MultiRoleSelect
            id="reaction-role-required"
            roles={resources.resources?.roles ?? []}
            value={settings.requiredRoleIds ?? []}
            onChange={(requiredRoleIds) => setSettings({ ...settings, requiredRoleIds })}
            disabled={api.loading}
          />
        </FormField>
        <FormField
          label="Blocked roles"
          htmlFor="reaction-role-blocked"
          hint="Members holding any selected role cannot receive a new role from this panel. Existing roles are not removed when eligibility changes."
        >
          <MultiRoleSelect
            id="reaction-role-blocked"
            roles={resources.resources?.roles ?? []}
            value={settings.blockedRoleIds ?? []}
            onChange={(blockedRoleIds) => setSettings({ ...settings, blockedRoleIds })}
            disabled={api.loading}
          />
        </FormField>
        <FormField label="Title" htmlFor="reaction-role-title">
          <Input
            id="reaction-role-title"
            value={settings.title}
            maxLength={200}
            disabled={api.loading}
            onChange={(event) => setSettings({ ...settings, title: event.target.value })}
          />
        </FormField>
        <FormField label="Welcome message" htmlFor="reaction-role-description">
          <Textarea
            id="reaction-role-description"
            value={settings.description}
            maxLength={1000}
            disabled={api.loading}
            onChange={(event) => setSettings({ ...settings, description: event.target.value })}
          />
        </FormField>
        <SectionHeader
          title="Role choices"
          description="Choose an emoji, a game role, and the name members will see."
        />
        {settings.options.map((option, index) => (
          <fieldset
            key={index}
            className="space-y-3 rounded-lg border border-border p-4"
            disabled={api.loading}
          >
            <legend className="px-1 text-sm font-medium">Choice {index + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
              <FormField label="Emoji">
                <EmojiPicker
                  emojis={resources.resources?.emojis ?? []}
                  selectedValue={option.emoji}
                  onSelect={(selection) => changeOption(index, { emoji: selection.value })}
                  disabled={api.loading || lockedChoice(index)}
                />
              </FormField>
              <FormField label="Role" htmlFor={`reaction-role-${index}`}>
                <RoleSelect
                  id={`reaction-role-${index}`}
                  value={option.roleId}
                  roles={resources.resources?.roles ?? []}
                  disabled={api.loading || lockedChoice(index)}
                  onChange={(roleId) =>
                    changeOption(index, {
                      roleId,
                      ...(option.label
                        ? {}
                        : {
                            label:
                              resources.resources?.roles.find((role) => role.id === roleId)?.name ??
                              "",
                          }),
                    })
                  }
                />
              </FormField>
              <FormField label="Display name" htmlFor={`reaction-role-label-${index}`}>
                <Input
                  id={`reaction-role-label-${index}`}
                  value={option.label}
                  maxLength={80}
                  onChange={(event) => changeOption(index, { label: event.target.value })}
                />
              </FormField>
              <Button
                type="button"
                variant="outline"
                disabled={api.loading || lockedChoice(index) || settings.options.length === 1}
                onClick={() =>
                  setSettings({
                    ...settings,
                    options: settings.options.filter((_, i) => i !== index),
                  })
                }
              >
                Remove choice {index + 1}
              </Button>
            </div>
          </fieldset>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={api.loading || settings.options.length >= MAX_REACTION_ROLE_OPTIONS}
          onClick={() =>
            setSettings({
              ...settings,
              options: [...settings.options, { emoji: "", roleId: "", label: "" }],
            })
          }
        >
          Add role choice
        </Button>
        {panel?.messageId ? (
          <p className="text-sm text-muted-foreground">
            Published choices keep their emoji and role so existing reactions stay connected. You
            can rename them and add choices. Delete the panel to change its channel or replace
            existing mappings.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={api.loading} onClick={() => save(true)}>
            {api.loading ? "Updating…" : "Save and publish"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={api.loading || (!dirty && Boolean(panel))}
            onClick={() => save(false)}
          >
            Save draft
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              disabled={api.loading}
              onClick={() => setSettings(settingsOf(panel))}
            >
              Discard changes
            </Button>
          ) : null}
        </div>
        {panel ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <span className="text-sm" role="status">
              {panel.enabled
                ? "Active"
                : panel.messageId
                  ? "Paused — publish to apply saved changes"
                  : "Draft — not published"}
            </span>
            {panel.messageId ? (
              <a
                className="text-sm underline"
                href={`https://discord.com/channels/${selectedGuildId}/${panel.channelId}/${panel.messageId}`}
                target="_blank"
                rel="noreferrer"
              >
                View in Discord
              </a>
            ) : null}
            {panel.enabled ? (
              <Button
                type="button"
                variant="outline"
                disabled={api.loading || dirty}
                onClick={() =>
                  void api.run(
                    () => request("POST", "/admin/api/reaction-roles/enabled", { enabled: false }),
                    accept,
                  )
                }
              >
                Pause
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              disabled={api.loading}
              onClick={() => void remove()}
            >
              Delete panel
            </Button>
          </div>
        ) : null}
      </SettingsPanel>
      <SettingsPanel>
        <SectionHeader title="Message preview" />
        <div
          className="rounded-lg border border-border bg-[#313338] p-5 text-[#dbdee1]"
          aria-label="Reaction-role message preview"
        >
          <div className="mb-3 font-semibold text-[#b5d932]">
            HAF Bot <span className="rounded bg-[#5865f2] px-1 text-xs text-white">APP</span>
          </div>
          <h3 className="font-semibold">{settings.title}</h3>
          <p className="my-3 whitespace-pre-wrap">{settings.description}</p>
          <div className="space-y-1">
            {settings.options.map((option, index) => (
              <p key={index}>
                {previewEmoji(option.emoji)} — <strong>{option.label || "Game role"}</strong>
              </p>
            ))}
          </div>
          <p className="mt-4 text-sm">
            React to select your roles. Remove your reaction to remove a role.{" "}
            {settings.mode === "single"
              ? "Choose one role. A new selection replaces your previous choice."
              : "You can select more than one."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Preview reactions">
            {settings.options.map((option, index) => (
              <span
                key={index}
                className="rounded-md border border-[#5865f2] bg-[#5865f2]/20 px-3 py-1"
              >
                {previewEmoji(option.emoji)} 1
              </span>
            ))}
          </div>
        </div>
      </SettingsPanel>
    </div>
  );
}

function previewEmoji(value: string) {
  const emoji = parseReactionRoleEmoji(value);
  return emoji?.id ? (
    <img
      className="inline-block h-5 w-5"
      alt="Custom emoji"
      src={`https://cdn.discordapp.com/emojis/${emoji.id}.webp?size=32`}
    />
  ) : (
    (emoji?.display ?? "❔")
  );
}
