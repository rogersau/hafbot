import type { TicketPanelConfig, TicketTypeConfig } from "../../types";
import { DISCORD_MODAL_LABEL_MAX_LENGTH } from "../../discord/constants";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { PresetNumberInput } from "./ui/preset-number-input";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, RoleSelect } from "./guild-resource-select";
import { EmojiPicker } from "./emoji-picker";
import { MarkdownEditor } from "./markdown-editor";
import {
  TicketPanelPreview,
  createEmptyTicketType,
  type GuildResources,
} from "./ticket-panel-editor";
import { FeatureSetupWizard } from "./feature-setup-wizard";

interface TicketSetupWizardProps {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  onChange: (next: TicketPanelConfig) => void;
  defaultStep?: number | string;
  moreOptionsOpen?: boolean;
  onSaveDraft?: () => void;
  onSaveAndPublish?: () => void;
  selectedGuildId?: string;
  selectedWorkspaceId?: string;
}

const SUGGESTED_PANEL_TITLE = "Support tickets";
const SUGGESTED_PANEL_DESCRIPTION =
  "Need help from staff? Choose the ticket type that best matches your request and we will open a private channel for you.";

export function validateTicketSetupWizardMinimum(value: TicketPanelConfig): string[] {
  const issues: string[] = [];
  if (!value.panelChannelId.trim()) issues.push("Select a panel channel.");
  if (!value.categoryChannelId.trim()) issues.push("Select a ticket category.");
  if (!value.transcriptChannelId.trim()) issues.push("Select a transcript channel.");
  if (value.ticketTypes.length === 0) {
    issues.push("Add at least one ticket type.");
    return issues;
  }

  value.ticketTypes.forEach((ticketType, index) => {
    const label = `ticket type ${index + 1}`;
    if (!ticketType.label.trim()) issues.push(`Enter a label for ${label}.`);
    if (!ticketType.supportRoleId.trim()) issues.push(`Select a support role for ${label}.`);
    if (!ticketType.channelNamePrefix.trim()) {
      issues.push(`Enter a channel name prefix for ${label}.`);
    }
  });

  return issues;
}

export function formatTicketSetupWizardMinimumErrors(issues: string[]): string | null {
  if (issues.length === 0) return null;
  return `Complete the required ticket panel fields before saving: ${issues.join(" ")}`;
}

function defaultChannelNamePrefix(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function TicketSetupWizard({
  guildResources,
  value,
  onChange,
  defaultStep = 0,
  moreOptionsOpen = false,
  onSaveDraft,
  onSaveAndPublish,
  selectedGuildId,
  selectedWorkspaceId,
}: TicketSetupWizardProps) {
  const setupGuildId = selectedGuildId ?? value.guildId;
  const setupWorkspaceId = selectedWorkspaceId ?? "";

  function patch(next: Partial<TicketPanelConfig>) {
    onChange({ ...value, ...next });
  }

  function updateTicketType(index: number, updater: (t: TicketTypeConfig) => TicketTypeConfig) {
    onChange({
      ...value,
      ticketTypes: value.ticketTypes.map((t, i) => (i === index ? updater(t) : t)),
    });
  }

  function addTicketType() {
    onChange({
      ...value,
      ticketTypes: [...value.ticketTypes, createEmptyTicketType(value.ticketTypes.length)],
    });
  }

  return (
    <FeatureSetupWizard
      title="Tickets setup wizard"
      description="Build the complete member-to-staff support flow, then publish and test it. Nothing is published until the final step."
      defaultStep={defaultStep}
      steps={[
        {
          id: "ticket-panel",
          label: "Member entry point",
          purpose: "Give members one clear place to ask staff for help.",
          changes: "Prepares the public panel channel and the message members will see.",
          outcome: "Members can understand where to start and which support option to choose.",
          content: (
            <StepMemberEntry
              guildResources={guildResources}
              value={value}
              patch={patch}
              moreOptionsOpen={moreOptionsOpen}
              selectedGuildId={setupGuildId}
              selectedWorkspaceId={setupWorkspaceId}
            />
          ),
        },
        {
          id: "ticket-types",
          label: "Staff & request types",
          purpose: "Route each kind of request to the staff responsible for handling it.",
          changes: "Defines member choices, support roles, and new ticket channel names.",
          outcome: "Every request type has a clear label and a staff role that can respond.",
          content: (
            <StepTicketTypes
              guildResources={guildResources}
              value={value}
              updateTicketType={updateTicketType}
              addTicketType={addTicketType}
              selectedGuildId={setupGuildId}
              selectedWorkspaceId={setupWorkspaceId}
            />
          ),
        },
        {
          id: "ticket-private-space",
          label: "Private ticket space",
          purpose: "Keep each member request private while allowing the right staff to help.",
          changes: "Selects the Discord category where HAF creates private ticket channels.",
          outcome: "New tickets have a safe destination with predictable channel organization.",
          content: (
            <StepPrivateTickets
              guildResources={guildResources}
              value={value}
              patch={patch}
              selectedGuildId={setupGuildId}
              selectedWorkspaceId={setupWorkspaceId}
            />
          ),
        },
        {
          id: "ticket-closure",
          label: "Closure & records",
          purpose: "Make sure staff can close a request without losing its history.",
          changes: "Selects the transcript destination and optional staff workflow controls.",
          outcome: "Closed tickets leave a staff-visible record and follow your chosen limits.",
          content: (
            <StepClosure
              guildResources={guildResources}
              value={value}
              patch={patch}
              moreOptionsOpen={moreOptionsOpen}
              selectedGuildId={setupGuildId}
              selectedWorkspaceId={setupWorkspaceId}
            />
          ),
        },
        {
          id: "ticket-review",
          label: "Publish & test",
          purpose: "Check how every piece connects before members can use it.",
          changes: "Saves the configuration and, if you choose Publish, posts the member panel.",
          outcome:
            "A private test ticket can be opened, handled by staff, closed, and transcribed.",
          content: (
            <StepReview
              value={value}
              onSaveDraft={onSaveDraft}
              onSaveAndPublish={onSaveAndPublish}
            />
          ),
        },
      ]}
    />
  );
}

function StepMemberEntry({
  guildResources,
  value,
  patch,
  moreOptionsOpen,
  selectedGuildId,
  selectedWorkspaceId,
}: {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  patch: (next: Partial<TicketPanelConfig>) => void;
  moreOptionsOpen: boolean;
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="Member entry point"
        description="Choose where members find Tickets and what the support panel tells them. HAF does not publish it until the final step."
      />
      <div>
        <FormField
          label="Panel channel"
          htmlFor="wizard-panel-channel"
          required
          hint="Channel where members will see the support panel."
        >
          <ChannelSelect
            id="wizard-panel-channel"
            value={value.panelChannelId}
            onChange={(v) => patch({ panelChannelId: v })}
            channels={guildResources.textChannels}
            placeholder="Select a channel"
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "tickets",
              dependencyKey: "panel_channel",
              label: "panel channel",
              recommendedName: "support-tickets",
            }}
          />
        </FormField>
      </div>

      <div className="space-y-4 rounded-md border bg-background p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">Panel content</h3>
            <p className="text-xs text-muted-foreground">
              This is the copy members see above the ticket buttons.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              patch({
                panelTitle: value.panelTitle ?? SUGGESTED_PANEL_TITLE,
                panelDescription: value.panelDescription ?? SUGGESTED_PANEL_DESCRIPTION,
              })
            }
          >
            Use suggested copy
          </Button>
        </div>
        <div className="rounded-md border border-dashed bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground">Suggested panel copy</p>
          <p className="mt-1 text-sm font-medium text-foreground">{SUGGESTED_PANEL_TITLE}</p>
          <p className="mt-1 text-sm text-muted-foreground">{SUGGESTED_PANEL_DESCRIPTION}</p>
        </div>
        <FormField label="Panel title" htmlFor="wizard-panel-title">
          <Input
            id="wizard-panel-title"
            value={value.panelTitle ?? ""}
            onChange={(e) => patch({ panelTitle: e.currentTarget.value || null })}
            placeholder={SUGGESTED_PANEL_TITLE}
          />
        </FormField>
        <FormField label="Panel description" htmlFor="wizard-panel-description">
          <MarkdownEditor
            id="wizard-panel-description"
            flavor="full"
            rows={4}
            value={value.panelDescription ?? ""}
            onChange={(next) => patch({ panelDescription: next.trim().length > 0 ? next : null })}
            placeholder={SUGGESTED_PANEL_DESCRIPTION}
          />
        </FormField>
      </div>

      <details open={moreOptionsOpen} className="group rounded-md border p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between marker:hidden">
          <span className="text-sm font-medium">More options</span>
          <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="mt-3 space-y-4">
          <FormField label="Embed emoji" htmlFor="wizard-panel-emoji">
            <EmojiPicker
              emojis={guildResources.emojis ?? []}
              selectedValue={value.panelEmoji}
              onSelect={(selection) => patch({ panelEmoji: selection.value })}
            />
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Panel footer" htmlFor="wizard-panel-footer">
              <Input
                id="wizard-panel-footer"
                value={value.panelFooter ?? ""}
                onChange={(e) => patch({ panelFooter: e.currentTarget.value || null })}
                placeholder="Contact staff for help"
              />
            </FormField>
          </div>
        </div>
      </details>
    </SettingsBlock>
  );
}

function StepTicketTypes({
  guildResources,
  value,
  updateTicketType,
  addTicketType,
  selectedGuildId,
  selectedWorkspaceId,
}: {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  updateTicketType: (index: number, updater: (t: TicketTypeConfig) => TicketTypeConfig) => void;
  addTicketType: () => void;
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  if (value.ticketTypes.length === 0) {
    return (
      <SettingsBlock>
        <SectionHeader
          title="Ticket types"
          description="Add at least one ticket type so members can choose why they need help."
        />
        <p className="text-sm text-muted-foreground">No ticket types yet.</p>
        <Button type="button" variant="accent" size="sm" onClick={addTicketType}>
          Add ticket type
        </Button>
      </SettingsBlock>
    );
  }

  return (
    <SettingsBlock>
      <SectionHeader
        title="Ticket types"
        description="Set the label and support role for each ticket type. Add more types if needed."
      />
      <div className="space-y-4">
        {value.ticketTypes.map((ticketType, index) => (
          <div key={ticketType.id ?? index} className="rounded-md border p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                label="Ticket type label"
                htmlFor={`wizard-type-label-${index}`}
                required
                hint="Name members see on the ticket button, such as Bug report or Ban appeal."
                error={
                  ticketType.label.length > DISCORD_MODAL_LABEL_MAX_LENGTH
                    ? `Ticket Type label must be ${DISCORD_MODAL_LABEL_MAX_LENGTH} characters or fewer.`
                    : undefined
                }
              >
                <div className="space-y-1">
                  <Input
                    id={`wizard-type-label-${index}`}
                    value={ticketType.label}
                    maxLength={DISCORD_MODAL_LABEL_MAX_LENGTH}
                    onChange={(e) =>
                      updateTicketType(index, (t) => {
                        const nextLabel = e.currentTarget.value;
                        return {
                          ...t,
                          label: nextLabel,
                          channelNamePrefix:
                            t.channelNamePrefix.trim().length > 0
                              ? t.channelNamePrefix
                              : defaultChannelNamePrefix(nextLabel),
                        };
                      })
                    }
                    placeholder="Bug report"
                  />
                  <p className="text-right text-xs text-muted-foreground">
                    {ticketType.label.length} / {DISCORD_MODAL_LABEL_MAX_LENGTH} characters
                  </p>
                </div>
              </FormField>
              <FormField
                label="Support role"
                htmlFor={`wizard-type-role-${index}`}
                required
                hint="Staff role that can view and manage tickets of this type."
              >
                <RoleSelect
                  id={`wizard-type-role-${index}`}
                  roles={guildResources.roles}
                  value={ticketType.supportRoleId}
                  onChange={(roleId) =>
                    updateTicketType(index, (t) => ({ ...t, supportRoleId: roleId }))
                  }
                  placeholder="Select a role"
                  creation={{
                    guildId: selectedGuildId,
                    workspaceId: selectedWorkspaceId,
                    surfaceKey: "tickets",
                    dependencyKey: "support_role",
                    label: "support role",
                    recommendedName: ticketType.label.trim()
                      ? `${ticketType.label} Support`
                      : "Ticket Support",
                    accessChannelIds: [value.categoryChannelId, value.transcriptChannelId].filter(
                      Boolean,
                    ),
                  }}
                />
              </FormField>
              <FormField
                label="Channel name prefix"
                htmlFor={`wizard-type-prefix-${index}`}
                required
                hint="Prefix for new ticket channel names, for example support-username."
              >
                <Input
                  id={`wizard-type-prefix-${index}`}
                  value={ticketType.channelNamePrefix}
                  onChange={(e) =>
                    updateTicketType(index, (t) => ({
                      ...t,
                      channelNamePrefix: e.currentTarget.value,
                    }))
                  }
                  placeholder="support"
                />
              </FormField>
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addTicketType}>
          Add another ticket type
        </Button>
      </div>
    </SettingsBlock>
  );
}

function StepPrivateTickets({
  guildResources,
  value,
  patch,
  selectedGuildId,
  selectedWorkspaceId,
}: {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  patch: (next: Partial<TicketPanelConfig>) => void;
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="Private ticket space"
        description="HAF creates one private channel per request inside this category. The member and the selected support role receive access."
      />
      <FormField
        label="Ticket category"
        htmlFor="wizard-category"
        required
        hint="Category where new private ticket channels will be created."
      >
        <ChannelSelect
          id="wizard-category"
          channels={guildResources.categories}
          value={value.categoryChannelId}
          onChange={(v) => patch({ categoryChannelId: v })}
          placeholder="Select a category"
          creation={{
            guildId: selectedGuildId,
            workspaceId: selectedWorkspaceId,
            surfaceKey: "tickets",
            dependencyKey: "ticket_category",
            label: "ticket category",
            recommendedName: "Support Tickets",
            accessRoleIds: value.ticketTypes
              .map((ticketType) => ticketType.supportRoleId)
              .filter(Boolean),
          }}
        />
      </FormField>
      <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
        Members cannot see one another&apos;s tickets. HAF applies the category permissions when it
        creates each ticket channel.
      </div>
    </SettingsBlock>
  );
}

function StepClosure({
  guildResources,
  value,
  patch,
  moreOptionsOpen,
  selectedGuildId,
  selectedWorkspaceId,
}: {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  patch: (next: Partial<TicketPanelConfig>) => void;
  moreOptionsOpen: boolean;
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="Closure & staff records"
        description="When staff close a ticket, HAF posts its transcript here so the request remains reviewable."
      />
      <FormField
        label="Transcript channel"
        htmlFor="wizard-transcript"
        required
        hint="Keep this channel staff-only because transcripts can contain private member information."
      >
        <ChannelSelect
          id="wizard-transcript"
          value={value.transcriptChannelId}
          onChange={(v) => patch({ transcriptChannelId: v })}
          channels={guildResources.textChannels}
          placeholder="Select a channel"
          creation={{
            guildId: selectedGuildId,
            workspaceId: selectedWorkspaceId,
            surfaceKey: "tickets",
            dependencyKey: "transcript_channel",
            label: "transcript channel",
            recommendedName: "ticket-transcripts",
            accessRoleIds: value.ticketTypes
              .map((ticketType) => ticketType.supportRoleId)
              .filter(Boolean),
          }}
        />
      </FormField>

      <details open={moreOptionsOpen} className="group rounded-md border p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between marker:hidden">
          <span className="text-sm font-medium">Optional staff workflow</span>
          <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="mt-3 space-y-4">
          <div className="rounded-md border bg-background p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
              <span>Enable ticket claiming</span>
              <Switch
                checked={value.enableTicketClaiming}
                onCheckedChange={(checked) => patch({ enableTicketClaiming: checked === true })}
              />
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Adds claim controls so staff can show who is handling a request.
            </p>
          </div>
          <div className="rounded-md border bg-background p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
              <span>AI transcript summaries</span>
              <Switch
                checked={value.aiTranscriptSummariesEnabled ?? false}
                onCheckedChange={(checked) =>
                  patch({ aiTranscriptSummariesEnabled: checked === true })
                }
              />
            </label>
          </div>
          <FormField label="Ticket creation limit" htmlFor="wizard-ticket-limit">
            <PresetNumberInput
              id="wizard-ticket-limit"
              min={1}
              max={50}
              value={value.ticketCreationLimit === null ? "" : String(value.ticketCreationLimit)}
              presets={[
                { label: "1", value: "1" },
                { label: "3", value: "3" },
                { label: "5", value: "5" },
                { label: "Unlimited", value: "" },
              ]}
              onChange={(next) =>
                patch({
                  ticketCreationLimit: next.trim().length === 0 ? null : Number(next),
                })
              }
              placeholder="Unlimited"
            />
          </FormField>
        </div>
      </details>
    </SettingsBlock>
  );
}

function StepReview({
  value,
  onSaveDraft,
  onSaveAndPublish,
}: {
  value: TicketPanelConfig;
  onSaveDraft?: () => void;
  onSaveAndPublish?: () => void;
}) {
  const issues = validateTicketSetupWizardMinimum(value);
  const canSave = issues.length === 0;
  return (
    <div className="space-y-5">
      <SettingsBlock>
        <SectionHeader
          title="Review, publish & test"
          description="Confirm the member entry point, staff access, private channel destination, and transcript record before publishing."
        />
        {!canSave ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-100">
              Complete the required setup fields before saving.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-100/80">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {canSave ? (
          <dl className="grid gap-3 rounded-md border bg-background p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Member panel</dt>
              <dd className="font-medium text-foreground">Selected Discord channel</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Private tickets</dt>
              <dd className="font-medium text-foreground">Selected category</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Staff routing</dt>
              <dd className="font-medium text-foreground">
                {value.ticketTypes.length} request{" "}
                {value.ticketTypes.length === 1 ? "type" : "types"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Closed tickets</dt>
              <dd className="font-medium text-foreground">Transcript channel selected</dd>
            </div>
          </dl>
        ) : null}
      </SettingsBlock>
      <TicketPanelPreview value={value} />
      <aside className="rounded-md border border-accent/30 bg-accent/5 p-4">
        <h3 className="text-sm font-semibold text-foreground">After publishing, test the flow</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
          <li>Open the published panel as a test member and create a private ticket.</li>
          <li>Confirm the selected support role can see and respond to it.</li>
          <li>Close the ticket and confirm its transcript appears for staff.</li>
        </ol>
      </aside>
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={!canSave} onClick={onSaveDraft}>
          Save draft
        </Button>
        <Button type="button" variant="accent" disabled={!canSave} onClick={onSaveAndPublish}>
          Save and publish
        </Button>
      </div>
    </div>
  );
}
