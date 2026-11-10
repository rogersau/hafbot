import { useMemo, useState } from "react";

import type {
  EventRecord,
  EventReminder,
  EventSignup,
  EventSignupGroup,
  EventStatus,
} from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { copyTextToClipboard } from "../lib/clipboard";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { Textarea } from "./ui/textarea";
import { ChevronDownIcon } from "./ui/icons";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EventsLoaderData } from "../lib/admin-route-loaders";
import { eventsClient } from "../generated/admin-client/events";
import { EventRecurrenceControls } from "./event-recurrence-controls";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { DiscordMarkdown } from "./markdown-editor";
import {
  DISCORD_USER_ID_HINT,
  discordUserIdError,
  parseDiscordUserId,
} from "../lib/discord-user-id";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface EventResource {
  guildId: string;
  recurrences?: import("../../event-recurrence").EventRecurrenceSummary[];
  templates: EventsLoaderData["templates"];
  events: EventsLoaderData["events"];
}

interface PendingDraftAction {
  title: string;
  description: string;
  changedFields?: string[];
  continueAction: () => void | Promise<void>;
  discardAction?: () => void | Promise<void>;
}

type EventTeamBulkPreview = Awaited<
  ReturnType<typeof eventsClient.previewBulkFormation>
>["preview"];

type EventDraft = Omit<
  EventRecord,
  | "id"
  | "status"
  | "messageId"
  | "threadId"
  | "signupCutoffAtMs"
  | "createdAtMs"
  | "updatedAtMs"
  | "publishedAtMs"
  | "cancelledAtMs"
  | "endedAtMs"
  | "archivedAtMs"
> & { eventId?: string; signupCutoffAtMs: number | null };

export function AdminEventsPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: EventsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Events"
        description="Create scheduled Discord events with flexible Signup Groups, waitlists, reminders, and roster management."
        readinessFeature="events"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Events" />
      ) : (
        <EventsEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function EventsEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: EventsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<EventResource>(
    initialData ?? { guildId: selectedGuildId, templates: [], events: [] },
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    resource.events[0]?.event.id ?? null,
  );
  const [draft, setDraft] = useState<EventDraft>(() =>
    resource.events[0]?.event
      ? draftFromEvent(resource.events[0].event)
      : createBlankDraft(selectedGuildId),
  );
  const [savedDraftSnapshot, setSavedDraftSnapshot] = useState<EventDraft>(draft);
  const [saving, setSaving] = useState(false);
  const [publishingEventId, setPublishingEventId] = useState<string | null>(null);
  const [pendingDraftAction, setPendingDraftAction] = useState<PendingDraftAction | null>(null);
  const [pendingDraftActionBusy, setPendingDraftActionBusy] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const selectedEvent = useMemo(
    () => resource.events.find((entry) => entry.event.id === selectedEventId) ?? null,
    [resource.events, selectedEventId],
  );

  async function refreshEvents(nextSelectedEventId = selectedEventId): Promise<boolean> {
    let authoritativeRefreshSucceeded = false;
    await api.run(
      () =>
        eventsClient.get({
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        }),
      (data) => {
        setResource(data);
        const nextEvent =
          data.events.find((entry) => entry.event.id === nextSelectedEventId) ??
          data.events[0] ??
          null;
        setSelectedEventId(nextEvent?.event.id ?? null);
        const nextDraft = nextEvent
          ? draftFromEvent(nextEvent.event)
          : createBlankDraft(selectedGuildId);
        setDraft(nextDraft);
        setSavedDraftSnapshot(nextDraft);
        authoritativeRefreshSucceeded = true;
      },
    );
    if (!authoritativeRefreshSucceeded) return false;
    return refreshAdminRouteData(onRouteDataRefresh, (error) => {
      api.setError(
        error instanceof Error
          ? `Event saved, but the page could not refresh: ${error.message}`
          : "Event saved, but the page could not refresh.",
      );
    });
  }

  function selectEventNow(event: EventRecord, nextDraft = draftFromEvent(event)) {
    setSelectedEventId(event.id);
    setDraft(nextDraft);
    setSavedDraftSnapshot(nextDraft);
    api.setError(null);
  }

  function startNewEventNow(nextDraft = createBlankDraft(selectedGuildId)) {
    setSelectedEventId(null);
    setDraft(nextDraft);
    setSavedDraftSnapshot(nextDraft);
    api.setError(null);
  }

  async function saveEvent(): Promise<boolean> {
    const error = validateDraft(draft);
    if (error) {
      api.setError(error);
      return false;
    }

    setSaving(true);
    api.setError(null);
    try {
      const payload = toApiPayload(draft, selectedWorkspaceId);
      const saved = draft.eventId
        ? await eventsClient.update({ ...payload, eventId: draft.eventId })
        : await eventsClient.create(payload);
      // The mutation response is authoritative even when the subsequent route
      // reconciliation fails. Keep the returned ID and values locally so a
      // retry cannot create a duplicate event.
      const savedDraft = draftFromEvent(saved.event);
      setDraft(savedDraft);
      setSavedDraftSnapshot(savedDraft);
      toast.success(draft.eventId ? "Event saved." : "Event draft created.");
      return await refreshEvents(saved.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Event.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveTemplate() {
    const error = validateTemplateDraft(draft);
    if (error) {
      api.setError(error);
      return;
    }
    api.setError(null);
    try {
      await eventsClient.createTemplate({
        workspaceId: selectedWorkspaceId,
        guildId: draft.guildId,
        name: draft.title.trim() || "Event template",
        description: draft.description.trim(),
        signupMode: draft.signupMode,
        participationMode: draft.participationMode,
        requiredTeamSize: draft.requiredTeamSize,
        threadEnabled: draft.threadEnabled,
        waitlistedMembersJoinThread: draft.waitlistedMembersJoinThread,
        groups: draft.groups,
        reminders: draft.reminders,
      });
      toast.success("Event template saved.");
      await refreshEvents(selectedEventId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Event template.");
    }
  }

  function applyTemplateNow(templateId: string, baseDraft = draft) {
    const template = resource.templates.find((item) => item.id === templateId);
    if (!template) return;
    setDraft({
      ...baseDraft,
      templateId: template.id,
      description: template.description,
      signupMode: template.signupMode,
      participationMode: template.participationMode,
      requiredTeamSize: template.requiredTeamSize,
      threadEnabled: template.threadEnabled,
      waitlistedMembersJoinThread: template.waitlistedMembersJoinThread,
      groups: template.groups,
      reminders: template.reminders,
    });
  }

  function requestDraftAction(action: PendingDraftAction) {
    if (!hasUnsavedChanges) {
      void action.continueAction();
      return;
    }
    setPendingDraftAction(action);
  }

  function selectEvent(event: EventRecord) {
    requestDraftAction({
      title: "Switch Event?",
      description: "Your current Event draft has unsaved changes.",
      continueAction: () => selectEventNow(event),
      discardAction: () => selectEventNow(event),
    });
  }

  function startNewEvent() {
    requestDraftAction({
      title: "Start a new Event?",
      description: "Your current Event draft has unsaved changes.",
      continueAction: () => startNewEventNow(),
      discardAction: () => startNewEventNow(),
    });
  }

  function applyTemplate(templateId: string) {
    const template = resource.templates.find((item) => item.id === templateId);
    if (!template) return;
    const changedFields = templateChangeSummary(draft, template);
    if (changedFields.length === 0 || !hasUnsavedChanges) {
      applyTemplateNow(templateId);
      return;
    }
    requestDraftAction({
      title: "Apply Event template?",
      description: "Applying this template will replace the following fields in your draft:",
      changedFields,
      continueAction: () => applyTemplateNow(templateId, draft),
      discardAction: () => applyTemplateNow(templateId, savedDraftSnapshot),
    });
  }

  async function saveAndContinueDraftAction() {
    if (!pendingDraftAction) return;
    const action = pendingDraftAction;
    setPendingDraftActionBusy(true);
    const saved = await saveEvent();
    setPendingDraftActionBusy(false);
    if (!saved) return;
    setPendingDraftAction(null);
    await action.continueAction();
  }

  async function discardDraftAction() {
    if (!pendingDraftAction) return;
    const action = pendingDraftAction;
    setPendingDraftAction(null);
    await action.discardAction?.();
  }

  function discardDraftChanges() {
    setDraft(savedDraftSnapshot);
    api.setError(null);
  }

  async function runEventAction(
    action: "publish" | "cancel" | "archive",
    event: EventRecord,
    message: string,
  ) {
    if (action !== "publish") {
      const confirmed = await confirm({
        title: `${capitalize(action)} Event?`,
        description: message,
        confirmLabel: capitalize(action),
        variant: action === "cancel" ? "destructive" : "default",
      });
      if (!confirmed) return;
    }

    setPublishingEventId(event.id);
    api.setError(null);
    try {
      const body = { guildId: event.guildId, eventId: event.id, workspaceId: selectedWorkspaceId };
      if (action === "publish") await eventsClient.publish(body);
      if (action === "cancel") await eventsClient.cancel(body);
      if (action === "archive") await eventsClient.archive(body);
      toast.success(`Event ${action === "publish" ? "published" : `${action}d`}.`);
      await refreshEvents(event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action} Event.`);
    } finally {
      setPublishingEventId(null);
    }
  }

  async function addManualSignup(input: {
    userId: string;
    groupId: string;
    status: EventSignup["status"];
  }) {
    if (!selectedEvent) return;
    const parsedUserId = parseDiscordUserId(input.userId);
    if (!parsedUserId.ok) {
      api.setError(parsedUserId.error);
      return;
    }
    api.setError(null);
    try {
      await eventsClient.signup({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        userId: parsedUserId.id,
        groupId: input.groupId,
        status: input.status,
      });
      toast.success("Signup updated.");
      await refreshEvents(selectedEvent.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update signup.");
    }
  }

  async function removeManualSignup(signup: EventSignup) {
    if (!selectedEvent) return;
    const confirmed = await confirm({
      title: "Remove signup?",
      description: `Remove Discord user ID ${signup.userId} from ${
        selectedEvent.event.groups.find((group) => group.id === signup.groupId)?.label ??
        signup.groupId
      } (${signup.status === "confirmed" ? "Confirmed" : "Waitlisted"})? The waitlist will be promoted if needed.`,
      confirmLabel: "Remove signup",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    try {
      await eventsClient.removeSignup({
        workspaceId: selectedWorkspaceId,
        guildId: signup.guildId,
        eventId: signup.eventId,
        userId: signup.userId,
        groupId: signup.groupId,
      });
      toast.success("Signup removed.");
      await refreshEvents(selectedEvent.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove signup.");
    }
  }

  async function createAdminEventTeam(input: { userId: string; groupId: string; name: string }) {
    if (!selectedEvent) return;
    const parsedUserId = parseDiscordUserId(input.userId);
    if (!parsedUserId.ok) {
      api.setError(parsedUserId.error);
      return;
    }
    try {
      await eventsClient.createTeam({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        userId: parsedUserId.id,
        groupId: input.groupId,
        name: input.name,
      });
      toast.success("Event Team created.");
      await refreshEvents(selectedEvent.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create Event Team.");
    }
  }

  async function assignAdminEventTeamMember(input: { teamId: string; userId: string }) {
    if (!selectedEvent) return;
    const parsedUserId = parseDiscordUserId(input.userId);
    if (!parsedUserId.ok) {
      api.setError(parsedUserId.error);
      return;
    }
    try {
      await eventsClient.assignTeamMember({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        teamId: input.teamId,
        userId: parsedUserId.id,
      });
      toast.success("Event Team member assigned.");
      await refreshEvents(selectedEvent.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign Event Team member.");
    }
  }

  async function overrideAdminEventTeam(input: {
    teamId: string;
    action: "rename" | "disband" | "transfer_captain" | "remove_member";
    name?: string;
    userId?: string;
    newCaptainUserId?: string;
  }) {
    if (!selectedEvent) return;
    const parsedUserId = input.userId ? parseDiscordUserId(input.userId) : null;
    const parsedCaptainId = input.newCaptainUserId
      ? parseDiscordUserId(input.newCaptainUserId)
      : null;
    if (parsedUserId && !parsedUserId.ok) {
      api.setError(parsedUserId.error);
      return;
    }
    if (parsedCaptainId && !parsedCaptainId.ok) {
      api.setError(parsedCaptainId.error);
      return;
    }
    try {
      await eventsClient.overrideTeam({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        teamId: input.teamId,
        action: input.action,
        confirmed: true,
        name: input.name,
        userId: parsedUserId?.ok ? parsedUserId.id : undefined,
        newCaptainUserId: parsedCaptainId?.ok ? parsedCaptainId.id : undefined,
      });
      toast.success("Event Team override applied.");
      await refreshEvents(selectedEvent.event.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply Event Team override.");
    }
  }

  async function exportAdminEventRoster() {
    if (!selectedEvent) return;
    try {
      const result = await eventsClient.exportRoster({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
      });
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Event roster exported.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export the Event roster.");
    }
  }

  async function previewAdminEventTeamBulk(input: {
    groupId: string;
    strategy: "signup_order" | "shuffle";
    fillPartialTeams: boolean;
    includeIncomplete: boolean;
    namePrefix: string;
  }): Promise<EventTeamBulkPreview | null> {
    if (!selectedEvent) return null;
    try {
      const result = await eventsClient.previewBulkFormation({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        ...input,
      });
      toast.success("Bulk Event Team preview generated.");
      return result.preview;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to preview Event Teams.");
      return null;
    }
  }

  async function commitAdminEventTeamBulk(preview: EventTeamBulkPreview): Promise<boolean> {
    if (!selectedEvent) return false;
    try {
      await eventsClient.commitBulkFormation({
        workspaceId: selectedWorkspaceId,
        guildId: selectedEvent.event.guildId,
        eventId: selectedEvent.event.id,
        preview,
      });
      toast.success("Bulk Event Team formation committed.");
      await refreshEvents(selectedEvent.event.id);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to commit Event Teams.");
      return false;
    }
  }

  const signupCounts = selectedEvent
    ? countSignups(selectedEvent.signups)
    : new Map<string, SignupCount>();
  const timeZone = getLocalTimeZoneLabel();
  const activeEvent = selectedEvent?.event ?? null;
  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(draft, savedDraftSnapshot);
  const eventActions = [
    ...(activeEvent?.status === "draft" || activeEvent?.status === "scheduled"
      ? [
          {
            label: activeEvent.status === "draft" ? "Publish to Discord" : "Update in Discord",
            loading: publishingEventId === activeEvent.id,
            disabled: hasUnsavedChanges || saving,
            variant: "secondary" as const,
            onClick: () =>
              void runEventAction(
                "publish",
                activeEvent,
                "This posts or updates the canonical Discord Event message.",
              ),
          },
        ]
      : []),
    ...(activeEvent?.status === "scheduled" || activeEvent?.status === "live"
      ? [
          {
            label: "Cancel event",
            loading: publishingEventId === activeEvent.id,
            variant: "destructive" as const,
            onClick: () =>
              void runEventAction(
                "cancel",
                activeEvent,
                "This closes signups and stops future reminders for this Event.",
              ),
          },
        ]
      : []),
    ...(activeEvent?.status === "ended" || activeEvent?.status === "cancelled"
      ? [
          {
            label: "Archive event",
            loading: publishingEventId === activeEvent.id,
            variant: "outline" as const,
            onClick: () =>
              void runEventAction(
                "archive",
                activeEvent,
                "This hides the Event from active organizer workflows.",
              ),
          },
        ]
      : []),
    {
      label: draft.eventId ? "Save changes" : "Create event",
      loading: saving,
      disabled: !hasUnsavedChanges,
      variant: "accent" as const,
      onClick: () => void saveEvent(),
    },
  ];

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardDraftChanges} />
      {confirmDialog}
      <Dialog
        open={pendingDraftAction !== null}
        onOpenChange={(open) => {
          if (!open && !pendingDraftActionBusy) setPendingDraftAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingDraftAction?.title}</DialogTitle>
            <DialogDescription>{pendingDraftAction?.description}</DialogDescription>
          </DialogHeader>
          {pendingDraftAction?.changedFields?.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
              {pendingDraftAction.changedFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter className="flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={pendingDraftActionBusy}
              onClick={() => setPendingDraftAction(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingDraftActionBusy}
              onClick={() => void discardDraftAction()}
            >
              Discard changes
            </Button>
            <Button
              type="button"
              variant="default"
              loading={pendingDraftActionBusy}
              onClick={() => void saveAndContinueDraftAction()}
            >
              Save and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PageFeedback error={api.error} />
      <EventNavigator
        events={resource.events}
        selectedEventId={selectedEventId}
        onSelect={selectEvent}
        onNew={startNewEvent}
      />
      <EventRecurrenceControls
        key={selectedEvent?.event.id ?? "new-event"}
        guildId={selectedGuildId}
        workspaceId={selectedWorkspaceId}
        event={selectedEvent?.event ?? null}
        series={resource.recurrences ?? []}
        disabled={hasUnsavedChanges || saving}
        onChanged={async () => {
          await refreshEvents();
        }}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <SettingsBlock>
            <SectionHeader
              title={draft.eventId ? "Event details" : "Create an event"}
              description="The essentials members will see in Discord."
              actions={<UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />}
            />
            <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
              <FormField label="Template" htmlFor="event-template">
                <Select disabled={resource.templates.length === 0} onValueChange={applyTemplate}>
                  <SelectTrigger id="event-template" className="sm:w-72">
                    <SelectValue placeholder="Apply a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {resource.templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <Button type="button" size="sm" variant="outline" onClick={saveTemplate}>
                Save Template
              </Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Event title" htmlFor="event-title" required>
                <Input
                  id="event-title"
                  value={draft.title}
                  placeholder="Friday night raid"
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </FormField>
              <FormField label="Publish channel" htmlFor="event-channel" required>
                <ChannelSelect
                  id="event-channel"
                  channels={resources?.textChannels ?? []}
                  value={draft.channelId}
                  onChange={(channelId) => setDraft({ ...draft, channelId })}
                />
              </FormField>
              <div className="md:col-span-2">
                <FormField label="Description" htmlFor="event-description">
                  <Textarea
                    id="event-description"
                    className="min-h-24"
                    value={draft.description}
                    placeholder="Share the plan, requirements, meeting point, or anything members should know."
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </FormField>
              </div>
            </div>
          </SettingsBlock>

          <SettingsBlock>
            <SectionHeader
              title="Schedule and signups"
              description="When the event runs and how members can join."
            />
            <div className="space-y-5">
              <div>
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">Local schedule</h3>
                  <span className="text-xs text-muted-foreground">Times shown in {timeZone}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <FormField
                    label="Starts"
                    htmlFor="event-start"
                    hint={`Your local time (${timeZone})`}
                    required
                  >
                    <Input
                      id="event-start"
                      type="datetime-local"
                      value={formatDatetimeInput(draft.startsAtMs)}
                      onChange={(event) =>
                        setDraft({ ...draft, startsAtMs: parseLocalDatetime(event.target.value) })
                      }
                    />
                  </FormField>
                  <FormField label="Ends" htmlFor="event-end" hint="Optional">
                    <Input
                      id="event-end"
                      type="datetime-local"
                      value={draft.endsAtMs ? formatDatetimeInput(draft.endsAtMs) : ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          endsAtMs: event.target.value
                            ? parseLocalDatetime(event.target.value)
                            : null,
                        })
                      }
                    />
                  </FormField>
                  <FormField
                    label="Signups close"
                    htmlFor="event-cutoff"
                    hint="Defaults to the event start"
                  >
                    <Input
                      id="event-cutoff"
                      type="datetime-local"
                      value={
                        draft.signupCutoffAtMs ? formatDatetimeInput(draft.signupCutoffAtMs) : ""
                      }
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          signupCutoffAtMs: event.target.value
                            ? parseLocalDatetime(event.target.value)
                            : null,
                        })
                      }
                    />
                  </FormField>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Discord automatically shows these times in each member's timezone.
                </p>
              </div>
              <div className="grid gap-4 border-t pt-5 md:grid-cols-2">
                <FormField label="Participation mode" htmlFor="event-participation-mode">
                  <Select
                    value={draft.participationMode}
                    onValueChange={(participationMode: EventRecord["participationMode"]) =>
                      setDraft({
                        ...draft,
                        participationMode,
                        signupMode:
                          participationMode === "team" ? "single_choice" : draft.signupMode,
                        requiredTeamSize:
                          participationMode === "team" ? (draft.requiredTeamSize ?? 2) : null,
                      })
                    }
                  >
                    <SelectTrigger id="event-participation-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="individual">Individual</SelectItem>
                      <SelectItem value="team">Event Teams</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                {draft.participationMode === "team" ? (
                  <FormField
                    label="Required Event Team size"
                    htmlFor="event-required-team-size"
                    hint="2 to 50 participants"
                  >
                    <Input
                      id="event-required-team-size"
                      type="number"
                      min={2}
                      max={50}
                      value={draft.requiredTeamSize ?? 2}
                      onChange={(event) =>
                        setDraft({ ...draft, requiredTeamSize: Number(event.target.value) })
                      }
                    />
                  </FormField>
                ) : null}
                <FormField label="Signup mode" htmlFor="event-signup-mode">
                  <Select
                    value={draft.signupMode}
                    disabled={draft.participationMode === "team"}
                    onValueChange={(signupMode: EventRecord["signupMode"]) =>
                      setDraft({ ...draft, signupMode })
                    }
                  >
                    <SelectTrigger id="event-signup-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single_choice">Single group per member</SelectItem>
                      <SelectItem value="multi_choice">Multiple groups per member</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label="Discord thread" htmlFor="event-thread">
                  <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
                    <Checkbox
                      id="event-thread"
                      checked={draft.threadEnabled}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, threadEnabled: checked === true })
                      }
                    />
                    Create a thread when published
                  </label>
                </FormField>
                <FormField label="Waitlist thread access" htmlFor="event-waitlist-thread">
                  <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
                    <Checkbox
                      id="event-waitlist-thread"
                      checked={draft.waitlistedMembersJoinThread}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, waitlistedMembersJoinThread: checked === true })
                      }
                    />
                    Include waitlisted members
                  </label>
                </FormField>
              </div>
            </div>
          </SettingsBlock>

          <SettingsBlock>
            <SectionHeader
              title="Signup Groups"
              description="Model parties, squads, raider benches, PvP teams, vendor slots, or any other roster shape."
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setDraft({ ...draft, groups: [...draft.groups, createGroup()] })}
                >
                  Add Group
                </Button>
              }
            />
            {draft.participationMode === "team" &&
            draft.requiredTeamSize !== null &&
            draft.groups.some(
              (group) => group.capacity !== null && group.capacity % draft.requiredTeamSize! !== 0,
            ) ? (
              <p
                className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
                role="status"
              >
                {`A Signup Group capacity does not divide evenly into Event Teams of ${draft.requiredTeamSize}. The remainder stays available for unassigned or incomplete participants.`}
              </p>
            ) : null}
            <div className="space-y-3">
              {draft.groups.map((group, index) => (
                <div key={group.id} className="rounded-md border bg-background/40 p-3">
                  <div className="grid gap-3 lg:grid-cols-[1fr_120px_140px_auto]">
                    <FormField label="Label" htmlFor={`event-group-${group.id}-label`}>
                      <Input
                        id={`event-group-${group.id}-label`}
                        value={group.label}
                        onChange={(event) =>
                          updateGroup(setDraft, group.id, { label: event.target.value })
                        }
                      />
                    </FormField>
                    <FormField label="Capacity" htmlFor={`event-group-${group.id}-capacity`}>
                      <Input
                        id={`event-group-${group.id}-capacity`}
                        type="number"
                        min={1}
                        value={group.capacity ?? ""}
                        onChange={(event) =>
                          updateGroup(setDraft, group.id, {
                            capacity: event.target.value ? Number(event.target.value) : null,
                          })
                        }
                      />
                    </FormField>
                    <FormField label="Emoji" htmlFor={`event-group-${group.id}-emoji`}>
                      <Input
                        id={`event-group-${group.id}-emoji`}
                        value={group.emoji ?? ""}
                        onChange={(event) =>
                          updateGroup(setDraft, group.id, { emoji: event.target.value || null })
                        }
                      />
                    </FormField>
                    <div className="flex items-end gap-2">
                      <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
                        <Checkbox
                          checked={group.waitlistEnabled}
                          onCheckedChange={(checked) =>
                            updateGroup(setDraft, group.id, { waitlistEnabled: checked === true })
                          }
                        />
                        Waitlist
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={draft.groups.length <= 1}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            groups: current.groups.filter((candidate) => candidate.id !== group.id),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-3">
                    <FormField label="Allowed roles" htmlFor={`event-group-${group.id}-allowed`}>
                      <MultiRoleSelect
                        id={`event-group-${group.id}-allowed`}
                        roles={resources?.roles ?? []}
                        value={group.allowedRoleIds}
                        onChange={(allowedRoleIds) =>
                          updateGroup(setDraft, group.id, { allowedRoleIds })
                        }
                      />
                    </FormField>
                    <FormField label="Blocked roles" htmlFor={`event-group-${group.id}-blocked`}>
                      <MultiRoleSelect
                        id={`event-group-${group.id}-blocked`}
                        roles={resources?.roles ?? []}
                        value={group.blockedRoleIds}
                        onChange={(blockedRoleIds) =>
                          updateGroup(setDraft, group.id, { blockedRoleIds })
                        }
                      />
                    </FormField>
                    <FormField label="Grant role" htmlFor={`event-group-${group.id}-grant`}>
                      <div className="flex gap-2">
                        <RoleSelect
                          id={`event-group-${group.id}-grant`}
                          roles={resources?.roles ?? []}
                          value={group.grantRoleId ?? ""}
                          onChange={(grantRoleId) =>
                            updateGroup(setDraft, group.id, { grantRoleId: grantRoleId || null })
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => updateGroup(setDraft, group.id, { grantRoleId: null })}
                        >
                          Clear
                        </Button>
                      </div>
                    </FormField>
                  </div>
                  {selectedEvent ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Group {index + 1}: {signupCounts.get(group.id)?.confirmed ?? 0} confirmed,{" "}
                      {signupCounts.get(group.id)?.waitlisted ?? 0} waitlisted
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </SettingsBlock>

          <SettingsBlock>
            <SectionHeader
              title="Reminders"
              description="Reminders are sent in the Event channel or thread. Direct messages are intentionally not used."
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setDraft({ ...draft, reminders: [...draft.reminders, createReminder()] })
                  }
                >
                  Add Reminder
                </Button>
              }
            />
            {draft.reminders.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No reminders configured.
              </p>
            ) : (
              <div className="space-y-3">
                {draft.reminders.map((reminder) => (
                  <div
                    key={reminder.id}
                    className="grid gap-3 rounded-md border bg-background/40 p-3 md:grid-cols-[110px_180px_1fr_auto]"
                  >
                    <FormField
                      label="Minutes before"
                      htmlFor={`event-reminder-${reminder.id}-offset`}
                      hint={formatReminderOffset(reminder.offsetMinutes)}
                    >
                      <Input
                        id={`event-reminder-${reminder.id}-offset`}
                        type="number"
                        min={0}
                        value={reminder.offsetMinutes}
                        onChange={(event) =>
                          updateReminder(setDraft, reminder.id, {
                            offsetMinutes: Number(event.target.value),
                          })
                        }
                      />
                    </FormField>
                    <FormField label="Audience" htmlFor={`event-reminder-${reminder.id}-audience`}>
                      <Select
                        value={reminder.audience}
                        onValueChange={(audience: EventReminder["audience"]) =>
                          updateReminder(setDraft, reminder.id, { audience })
                        }
                      >
                        <SelectTrigger id={`event-reminder-${reminder.id}-audience`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="signed_up">Signed up</SelectItem>
                          <SelectItem value="waitlisted">Waitlisted</SelectItem>
                          <SelectItem value="channel_public">Channel public</SelectItem>
                          <SelectItem value="signup_group">Signup Group</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Message" htmlFor={`event-reminder-${reminder.id}-message`}>
                      <Input
                        id={`event-reminder-${reminder.id}-message`}
                        value={reminder.message}
                        onChange={(event) =>
                          updateReminder(setDraft, reminder.id, { message: event.target.value })
                        }
                      />
                    </FormField>
                    <div className="flex items-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            reminders: current.reminders.filter(
                              (candidate) => candidate.id !== reminder.id,
                            ),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsBlock>

          {selectedEvent ? (
            <>
              {selectedEvent.event.participationMode === "team" ? (
                <EventTeamsPanel
                  entry={selectedEvent}
                  onCreateTeam={createAdminEventTeam}
                  onAssignMember={assignAdminEventTeamMember}
                  onOverrideTeam={overrideAdminEventTeam}
                  onExport={exportAdminEventRoster}
                  onPreviewBulk={previewAdminEventTeamBulk}
                  onCommitBulk={commitAdminEventTeamBulk}
                />
              ) : null}
              <RosterTable
                signups={selectedEvent.signups}
                groups={selectedEvent.event.groups}
                onAddSignup={addManualSignup}
                onRemoveSignup={removeManualSignup}
              />
            </>
          ) : null}
        </div>
        <aside className="xl:sticky xl:top-5">
          <EventMessagePreview
            draft={draft}
            status={activeEvent?.status ?? "draft"}
            signups={selectedEvent?.signups ?? []}
            channelName={
              resources?.textChannels.find((channel) => channel.id === draft.channelId)?.name
            }
          />
        </aside>
      </div>
      <AdminBottomActionBar actions={eventActions} />
    </div>
  );
}

function EventNavigator({
  events,
  selectedEventId,
  onSelect,
  onNew,
}: {
  events: EventResource["events"];
  selectedEventId: string | null;
  onSelect: (event: EventRecord) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-y border-border/70 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
        {selectedEventId === null ? (
          <div className="min-w-44 shrink-0 rounded-md border border-primary/60 bg-primary/10 px-3 py-2">
            <p className="truncate text-sm font-semibold text-foreground">New event</p>
            <p className="text-xs text-muted-foreground">Not saved yet</p>
          </div>
        ) : null}
        {events.map(({ event, signups }) => {
          const selected = selectedEventId === event.id;
          const confirmed = signups.filter((signup) => signup.status === "confirmed").length;
          return (
            <button
              key={event.id}
              type="button"
              className={`min-w-48 shrink-0 rounded-md border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-primary/60 bg-primary/10"
                  : "border-border/70 bg-background/30 hover:bg-muted/40"
              }`}
              onClick={() => onSelect(event)}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold text-foreground">{event.title}</p>
                <StatusBadge status={event.status} />
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {formatLocalDateTime(event.startsAtMs)} | {confirmed} going
              </p>
            </button>
          );
        })}
        {events.length === 0 && selectedEventId !== null ? (
          <p className="text-sm text-muted-foreground">No events yet</p>
        ) : null}
      </div>
      <Button type="button" size="sm" className="shrink-0" onClick={onNew}>
        New event
      </Button>
    </div>
  );
}

function EventMessagePreview({
  draft,
  status,
  signups,
  channelName,
}: {
  draft: EventDraft;
  status: EventStatus;
  signups: EventSignup[];
  channelName?: string;
}) {
  const counts = countSignups(signups);
  const accentColor =
    status === "cancelled"
      ? "border-l-[#ed4245]"
      : status === "ended"
        ? "border-l-[#949ba4]"
        : "border-l-[#5865f2]";

  return (
    <SettingsBlock className="overflow-hidden">
      <SectionHeader
        title="Message preview"
        description={channelName ? `#${channelName}` : "No channel selected"}
      />
      <div
        data-testid="event-discord-preview"
        className="rounded-md bg-[#313338] p-4 text-[#dbdee1] shadow-inner"
      >
        <div className="flex items-start gap-3">
          <img
            src="/favicon.ico"
            alt=""
            className="h-10 w-10 shrink-0 rounded-full bg-[#5865f2] object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-semibold text-white">HAF Bot</span>
              <span className="rounded-[3px] bg-[#5865f2] px-1 py-px text-[10px] font-semibold uppercase leading-4 text-white">
                App
              </span>
              <span className="text-xs text-[#949ba4]">Today</span>
            </div>
            <div className={`rounded-[4px] border-l-4 ${accentColor} bg-[#2b2d31] p-3`}>
              <h3 className="break-words text-sm font-semibold text-white">
                {draft.title.trim() || "Your event title"}
              </h3>
              {draft.description.trim() ? (
                <div className="mt-2 text-xs leading-5 text-[#dbdee1]">
                  <DiscordMarkdown source={draft.description.trim()} />
                </div>
              ) : null}
              <dl className="mt-3 space-y-1 text-xs leading-5">
                <div>
                  <dt className="inline font-semibold text-white">Starts: </dt>
                  <dd className="inline">{formatLocalDateTime(draft.startsAtMs)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-white">Signups close: </dt>
                  <dd className="inline">
                    {formatRelativeDateTime(draft.signupCutoffAtMs ?? draft.startsAtMs)}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-white">Status: </dt>
                  <dd className="inline">{capitalize(status)}</dd>
                </div>
              </dl>
              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                {draft.groups.map((group) => {
                  const count = counts.get(group.id) ?? { confirmed: 0, waitlisted: 0 };
                  return (
                    <div key={group.id} className="min-w-0">
                      <p className="truncate text-xs font-semibold text-white">
                        {group.emoji ? `${group.emoji} ` : ""}
                        {group.label || "Unnamed group"}
                      </p>
                      <p className="text-[11px] text-[#b5bac1]">
                        {group.capacity === null
                          ? "open confirmed"
                          : `${count.confirmed}/${group.capacity} confirmed`}
                        {count.waitlisted ? ` | ${count.waitlisted} waiting` : ""}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 border-t border-white/10 pt-2 text-[10px] text-[#949ba4]">
                hafbot.xyz
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {draft.groups.length <= 5 ? (
                draft.groups.map((group) => (
                  <span
                    key={group.id}
                    className="rounded-[3px] bg-[#4e5058] px-2.5 py-1.5 text-xs font-medium text-white"
                  >
                    {group.emoji ? `${group.emoji} ` : ""}
                    {group.label || "Unnamed group"}
                  </span>
                ))
              ) : (
                <span className="flex w-full items-center justify-between rounded-[3px] bg-[#1e1f22] px-3 py-2 text-xs text-[#b5bac1]">
                  Choose a signup group
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <span className="inline-block rounded-[3px] bg-[#da373c] px-2.5 py-1.5 text-xs font-medium text-white">
                Leave event
              </span>
            </div>
          </div>
        </div>
      </div>
    </SettingsBlock>
  );
}

function EventTeamsPanel({
  entry,
  onCreateTeam,
  onAssignMember,
  onOverrideTeam,
  onExport,
  onPreviewBulk,
  onCommitBulk,
}: {
  entry: EventsLoaderData["events"][number];
  onCreateTeam: (input: { userId: string; groupId: string; name: string }) => Promise<void>;
  onAssignMember: (input: { teamId: string; userId: string }) => Promise<void>;
  onOverrideTeam: (input: {
    teamId: string;
    action: "rename" | "disband" | "transfer_captain" | "remove_member";
    name?: string;
    userId?: string;
    newCaptainUserId?: string;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onPreviewBulk: (input: {
    groupId: string;
    strategy: "signup_order" | "shuffle";
    fillPartialTeams: boolean;
    includeIncomplete: boolean;
    namePrefix: string;
  }) => Promise<EventTeamBulkPreview | null>;
  onCommitBulk: (preview: EventTeamBulkPreview) => Promise<boolean>;
}) {
  const activeTeams = entry.teams.filter((team) => team.status === "active");
  const [teamName, setTeamName] = useState("");
  const [captainUserId, setCaptainUserId] = useState("");
  const [groupId, setGroupId] = useState(entry.event.groups[0]?.id ?? "");
  const [teamId, setTeamId] = useState(activeTeams[0]?.id ?? "");
  const [memberUserId, setMemberUserId] = useState("");
  const [bulkStrategy, setBulkStrategy] = useState<"signup_order" | "shuffle">("signup_order");
  const [fillPartialTeams, setFillPartialTeams] = useState(false);
  const [includeIncomplete, setIncludeIncomplete] = useState(false);
  const [bulkNamePrefix, setBulkNamePrefix] = useState("Team");
  const [bulkPreview, setBulkPreview] = useState<EventTeamBulkPreview | null>(null);
  const assignedUserIds = new Set(entry.memberships.map((membership) => membership.userId));
  const unassigned = entry.signups.filter((signup) => !assignedUserIds.has(signup.userId));
  const readinessByTeamId = new Map(entry.readiness.map((summary) => [summary.teamId, summary]));
  const groupById = new Map(entry.event.groups.map((group) => [group.id, group.label]));
  const teamById = new Map(entry.teams.map((team) => [team.id, team]));
  const pendingProposals = entry.proposals.filter((proposal) => proposal.status === "pending");
  const failedDeliveries = entry.deliveries.filter((delivery) => delivery.status === "failed");
  const { dialog: overrideConfirmDialog, confirm: confirmOverride } = useConfirmDialog();
  async function requestOverride(input: {
    teamId: string;
    action: "rename" | "disband" | "transfer_captain" | "remove_member";
    name?: string;
    userId?: string;
    newCaptainUserId?: string;
  }) {
    const team = teamById.get(input.teamId);
    const confirmed = await confirmOverride({
      title: "Confirm Event Team override",
      description: `This administrator override will ${input.action.replaceAll("_", " ")} ${team?.name ?? input.teamId}. It changes the authoritative roster immediately.`,
      confirmLabel: "Apply override",
      variant: "destructive",
    });
    if (confirmed) await onOverrideTeam(input);
  }

  return (
    <SettingsBlock>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          title="Event Teams"
          description="Inspect readiness, create teams, and assign signed-up participants."
        />
        <Button type="button" size="sm" variant="outline" onClick={() => void onExport()}>
          Export CSV
        </Button>
      </div>
      <div
        className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-3"
        aria-label="Event Team readiness summary"
      >
        <p>
          <span className="font-semibold">Ready:</span>{" "}
          {entry.readiness.filter((summary) => summary.ready).length}
        </p>
        <p>
          <span className="font-semibold">Incomplete:</span>{" "}
          {entry.readiness.filter((summary) => !summary.ready).length}
        </p>
        <p>
          <span className="font-semibold">Unassigned pool:</span> {unassigned.length} (
          {unassigned.filter((signup) => signup.status === "confirmed").length} confirmed ·{" "}
          {unassigned.filter((signup) => signup.status === "waitlisted").length} waitlisted)
        </p>
      </div>
      {entry.event.requiredTeamSize !== null &&
      entry.event.groups.some(
        (group) => group.capacity !== null && group.capacity % entry.event.requiredTeamSize! !== 0,
      ) ? (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          role="status"
        >
          {`A Signup Group capacity does not divide evenly into Event Teams of ${entry.event.requiredTeamSize}. The remainder stays available for unassigned or incomplete participants.`}
        </p>
      ) : null}

      <div className="space-y-2 rounded-md border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">Pending proposals</p>
          <Badge variant={pendingProposals.length > 0 ? "warning" : "default"}>
            {pendingProposals.length}
          </Badge>
        </div>
        {pendingProposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending invitations or join requests.</p>
        ) : (
          pendingProposals.map((proposal) => (
            <div
              key={proposal.id}
              className="grid gap-1 border-t pt-2 text-xs sm:grid-cols-[auto_1fr_auto]"
            >
              <Badge variant="default">
                {proposal.kind === "invitation" ? "Invitation" : "Join request"}
              </Badge>
              <p>
                {teamById.get(proposal.teamId)?.name ?? proposal.teamId} ·{" "}
                <span className="font-mono">
                  {proposal.kind === "invitation"
                    ? proposal.targetUserId
                    : proposal.requesterUserId}
                </span>
              </p>
              <time dateTime={new Date(proposal.createdAtMs).toISOString()}>
                {new Date(proposal.createdAtMs).toLocaleString()}
              </time>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-md border bg-background/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Delivery warnings</p>
            <Badge variant={failedDeliveries.length > 0 ? "warning" : "default"}>
              {failedDeliveries.length}
            </Badge>
          </div>
          {failedDeliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed Event Team deliveries.</p>
          ) : (
            failedDeliveries.map((delivery) => (
              <p key={delivery.id} className="text-xs">
                {delivery.kind === "notification" ? "Notification" : "Canonical message refresh"} ·{" "}
                {delivery.terminalFailureReason ?? delivery.lastError ?? "Delivery failed"}
              </p>
            ))
          )}
          <p className="text-xs text-muted-foreground">
            Roster-at-start snapshots: {entry.snapshots.length}
          </p>
        </div>

        <div className="space-y-2 rounded-md border bg-background/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Integrity and expiry</p>
            <Badge
              variant={
                entry.integrityWarnings.length > 0 || entry.expiredProposalCount > 0
                  ? "warning"
                  : "default"
              }
            >
              {entry.integrityWarnings.length + entry.expiredProposalCount}
            </Badge>
          </div>
          <p className="text-xs">
            Expired proposals: <strong>{entry.expiredProposalCount}</strong>
          </p>
          {entry.integrityWarnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No structural roster warnings.</p>
          ) : (
            entry.integrityWarnings.map((warning) => (
              <p key={warning} className="text-xs text-warning-foreground">
                {warning}
              </p>
            ))
          )}
        </div>
      </div>

      <div className="space-y-2 rounded-md border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">Audit history</p>
          <Badge variant="default">{entry.audit.length}</Badge>
        </div>
        {entry.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Event Team roster changes recorded.</p>
        ) : (
          entry.audit.slice(0, 20).map((record) => (
            <div
              key={record.id}
              className="grid gap-1 border-t pt-2 text-xs sm:grid-cols-[1fr_auto]"
            >
              <p>
                <span className="font-semibold">{record.action}</span> · {record.targetType}{" "}
                <span className="font-mono">{record.targetId}</span> · by{" "}
                <span className="font-mono">{record.actorUserId}</span>
              </p>
              <time dateTime={new Date(record.occurredAtMs).toISOString()}>
                {new Date(record.occurredAtMs).toLocaleString()}
              </time>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-3 rounded-md border bg-background/40 p-3 md:grid-cols-4">
        <FormField label="Event Team name" htmlFor="event-team-name">
          <Input
            id="event-team-name"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            placeholder="Night Owls"
          />
        </FormField>
        <FormField label="Captain Discord user ID" htmlFor="event-team-captain">
          <Input
            id="event-team-captain"
            value={captainUserId}
            onChange={(event) => setCaptainUserId(event.target.value)}
            placeholder="123456789012345678"
          />
        </FormField>
        <FormField label="Signup Group" htmlFor="event-team-group">
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger id="event-team-group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entry.event.groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            disabled={!teamName.trim() || !captainUserId.trim() || !groupId}
            onClick={() =>
              void onCreateTeam({ userId: captainUserId, groupId, name: teamName.trim() })
            }
          >
            Create Event Team
          </Button>
        </div>
      </div>

      <div className="space-y-3 rounded-md border bg-background/40 p-3">
        <div>
          <p className="text-sm font-semibold">Bulk formation</p>
          <p className="text-xs text-muted-foreground">
            Preview one Signup Group at a time. Existing Event Teams stay intact unless you choose
            to fill partial rosters.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <FormField label="Signup Group" htmlFor="event-team-bulk-group">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="event-team-bulk-group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entry.event.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Strategy" htmlFor="event-team-bulk-strategy">
            <Select
              value={bulkStrategy}
              onValueChange={(value: "signup_order" | "shuffle") => setBulkStrategy(value)}
            >
              <SelectTrigger id="event-team-bulk-strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="signup_order">Signup order</SelectItem>
                <SelectItem value="shuffle">One-time shuffle</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Generated name prefix" htmlFor="event-team-bulk-prefix">
            <Input
              id="event-team-bulk-prefix"
              value={bulkNamePrefix}
              maxLength={32}
              onChange={(event) => setBulkNamePrefix(event.target.value)}
            />
          </FormField>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                void onPreviewBulk({
                  groupId,
                  strategy: bulkStrategy,
                  fillPartialTeams,
                  includeIncomplete,
                  namePrefix: bulkNamePrefix,
                }).then(setBulkPreview)
              }
            >
              Generate preview
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={fillPartialTeams}
              onCheckedChange={(checked) => setFillPartialTeams(checked === true)}
            />
            Fill partial Event Teams first
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeIncomplete}
              onCheckedChange={(checked) => setIncludeIncomplete(checked === true)}
            />
            Include incomplete remainder
          </label>
        </div>
        {bulkPreview ? (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              Stable revision <span className="font-mono">{bulkPreview.revision}</span> ·{" "}
              {bulkPreview.unassignedUserIds.length} remain unassigned
            </p>
            {bulkPreview.proposals.map((proposal, index) => (
              <div
                key={`${proposal.existingTeamId ?? "new"}-${index}`}
                className="grid gap-2 rounded-md border p-2 md:grid-cols-[1fr_1fr_auto]"
              >
                <FormField
                  label={`Event Team ${index + 1} name`}
                  htmlFor={`event-team-bulk-name-${index}`}
                >
                  <Input
                    id={`event-team-bulk-name-${index}`}
                    value={proposal.name}
                    maxLength={40}
                    disabled={proposal.existingTeamId !== null}
                    onChange={(event) =>
                      setBulkPreview({
                        ...bulkPreview,
                        proposals: bulkPreview.proposals.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, name: event.target.value }
                            : candidate,
                        ),
                      })
                    }
                  />
                </FormField>
                <FormField
                  label="Captain Discord user ID"
                  htmlFor={`event-team-bulk-captain-${index}`}
                >
                  <Select
                    value={proposal.captainUserId}
                    disabled={proposal.existingTeamId !== null}
                    onValueChange={(captainUserId) =>
                      setBulkPreview({
                        ...bulkPreview,
                        proposals: bulkPreview.proposals.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, captainUserId } : candidate,
                        ),
                      })
                    }
                  >
                    <SelectTrigger id={`event-team-bulk-captain-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {proposal.memberUserIds.map((userId) => (
                        <SelectItem key={userId} value={userId}>
                          {userId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <p className="self-end pb-2 text-xs">
                  {proposal.memberUserIds.length}/{entry.event.requiredTeamSize} members
                  {proposal.incomplete ? " · incomplete" : ""}
                </p>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              disabled={bulkPreview.proposals.length === 0}
              onClick={() =>
                void onCommitBulk(bulkPreview).then((committed) => {
                  if (committed) setBulkPreview(null);
                })
              }
            >
              Commit bulk formation
            </Button>
          </div>
        ) : null}
      </div>

      {activeTeams.length > 0 ? (
        <div className="grid gap-3 rounded-md border bg-background/40 p-3 md:grid-cols-3">
          <FormField label="Event Team" htmlFor="event-team-assignment">
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger id="event-team-assignment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activeTeams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Participant Discord user ID" htmlFor="event-team-member">
            <Input
              id="event-team-member"
              value={memberUserId}
              onChange={(event) => setMemberUserId(event.target.value)}
              placeholder="123456789012345678"
            />
          </FormField>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              disabled={!teamId || !memberUserId.trim()}
              onClick={() => void onAssignMember({ teamId, userId: memberUserId })}
            >
              Assign participant
            </Button>
          </div>
        </div>
      ) : null}

      {entry.teams.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No Event Teams have been created.
        </p>
      ) : (
        <div className="space-y-2">
          {entry.teams.map((team) => {
            const readiness = readinessByTeamId.get(team.id);
            const members = entry.memberships.filter((membership) => membership.teamId === team.id);
            return (
              <div
                key={team.id}
                className="grid gap-2 rounded-md border bg-background/40 p-3 text-sm md:grid-cols-[1fr_1fr_auto_auto]"
              >
                <div>
                  <p className="font-semibold">{team.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {groupById.get(team.groupId) ?? team.groupId}
                  </p>
                </div>
                <p>
                  Captain <span className="font-mono text-xs">{team.captainUserId}</span>
                </p>
                <p>
                  {members.length}/{entry.event.requiredTeamSize ?? "—"} members
                </p>
                <Badge
                  variant={
                    team.status === "disbanded"
                      ? "default"
                      : readiness?.ready
                        ? "success"
                        : "warning"
                  }
                >
                  {team.status === "disbanded"
                    ? "Disbanded"
                    : readiness?.ready
                      ? "Ready"
                      : readiness?.reasons.includes("member_waitlisted")
                        ? "Awaiting capacity"
                        : "Incomplete"}
                </Badge>
                <div className="flex flex-wrap gap-2 md:col-span-4">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const nextName = window.prompt("New Event Team name", team.name)?.trim();
                      if (nextName && nextName !== team.name) {
                        void requestOverride({ teamId: team.id, action: "rename", name: nextName });
                      }
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const nextCaptain = window
                        .prompt("New captain Discord user ID", team.captainUserId)
                        ?.trim();
                      if (nextCaptain && nextCaptain !== team.captainUserId) {
                        void requestOverride({
                          teamId: team.id,
                          action: "transfer_captain",
                          newCaptainUserId: nextCaptain,
                        });
                      }
                    }}
                  >
                    Transfer captain
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const member = window.prompt("Member Discord user ID to remove")?.trim();
                      if (member) {
                        void requestOverride({
                          teamId: team.id,
                          action: "remove_member",
                          userId: member,
                        });
                      }
                    }}
                  >
                    Remove member
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => void requestOverride({ teamId: team.id, action: "disband" })}
                  >
                    Disband
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {overrideConfirmDialog}
    </SettingsBlock>
  );
}

function RosterTable({
  signups,
  groups,
  onAddSignup,
  onRemoveSignup,
}: {
  signups: EventSignup[];
  groups: EventSignupGroup[];
  onAddSignup: (input: {
    userId: string;
    groupId: string;
    status: EventSignup["status"];
  }) => Promise<void>;
  onRemoveSignup: (signup: EventSignup) => Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [status, setStatus] = useState<EventSignup["status"]>("confirmed");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | EventSignup["status"]>("all");
  const [pendingRemovalKey, setPendingRemovalKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const toast = useToast();
  const groupById = new Map(groups.map((group) => [group.id, group.label]));

  async function submitSignup() {
    const trimmedUserId = userId.trim();
    const parsedUserId = parseDiscordUserId(trimmedUserId);
    if (!parsedUserId.ok) {
      setUserIdError(parsedUserId.error);
      return;
    }
    if (!groupId) return;
    setUserIdError(null);
    setSaving(true);
    try {
      await onAddSignup({ userId: parsedUserId.id, groupId, status });
      setUserId("");
    } finally {
      setSaving(false);
    }
  }

  async function copySignupId(id: string) {
    try {
      await copyTextToClipboard(id);
      setCopiedId(id);
      toast.success("Discord user ID copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to copy Discord user ID.");
    }
  }

  async function removeSignup(signup: EventSignup) {
    const key = `${signup.userId}-${signup.groupId}`;
    if (pendingRemovalKey) return;
    setPendingRemovalKey(key);
    try {
      await onRemoveSignup(signup);
    } finally {
      setPendingRemovalKey(null);
    }
  }

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSignups = signups.filter((signup) => {
    if (normalizedSearch && !signup.userId.toLocaleLowerCase().includes(normalizedSearch)) {
      return false;
    }
    if (groupFilter !== "all" && signup.groupId !== groupFilter) return false;
    if (statusFilter !== "all" && signup.status !== statusFilter) return false;
    return true;
  });
  const signupCounts = countSignups(signups);
  const confirmedTotal = signups.filter((signup) => signup.status === "confirmed").length;
  const waitlistedTotal = signups.filter((signup) => signup.status === "waitlisted").length;
  const columns: ResponsiveTableColumn<EventSignup>[] = [
    {
      header: "Discord user ID",
      cell: (signup) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{signup.userId}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copySignupId(signup.userId)}
          >
            {copiedId === signup.userId ? "Copied" : "Copy ID"}
          </Button>
        </div>
      ),
      className: "font-mono text-xs",
    },
    {
      header: "Signup Group",
      cell: (signup) => groupById.get(signup.groupId) ?? signup.groupId,
    },
    {
      header: "Status",
      cell: (signup) => (
        <Badge variant={signup.status === "confirmed" ? "success" : "warning"}>
          {signup.status === "confirmed" ? "Confirmed" : "Waitlisted"}
        </Badge>
      ),
    },
    {
      header: "Signed up",
      cell: (signup) => (
        <time
          dateTime={new Date(signup.createdAtMs).toISOString()}
          title={formatLocalDateTime(signup.createdAtMs)}
        >
          {formatRelativeAge(signup.createdAtMs)}
        </time>
      ),
    },
    {
      header: "Action",
      cell: (signup) => {
        const key = `${signup.userId}-${signup.groupId}`;
        return (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={pendingRemovalKey === key}
            disabled={pendingRemovalKey !== null}
            onClick={() => void removeSignup(signup)}
          >
            Remove
          </Button>
        );
      },
    },
  ];

  return (
    <SettingsBlock>
      <SectionHeader title="Current signups" description="Search and manage the Event roster." />
      <div className="grid gap-3 rounded-md border bg-background/40 p-3 md:grid-cols-[1fr_180px_150px_auto]">
        <FormField
          label="Discord user ID"
          htmlFor="event-manual-user"
          hint={DISCORD_USER_ID_HINT}
          error={userIdError ?? undefined}
        >
          <Input
            id="event-manual-user"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setUserIdError(discordUserIdError(event.target.value));
            }}
            placeholder="123456789012345678 or <@123456789012345678>"
          />
        </FormField>
        <FormField label="Group" htmlFor="event-manual-group">
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger id="event-manual-group">
              <SelectValue placeholder="Select group" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Status" htmlFor="event-manual-status">
          <Select value={status} onValueChange={(value: EventSignup["status"]) => setStatus(value)}>
            <SelectTrigger id="event-manual-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="waitlisted">Waitlisted</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={!userId.trim() || !groupId}
            onClick={submitSignup}
          >
            Add
          </Button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 rounded-md border bg-background/40 p-3 md:grid-cols-[1fr_180px_180px]">
        <FormField label="Search Discord user IDs" htmlFor="event-roster-search">
          <Input
            id="event-roster-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by Discord user ID"
          />
        </FormField>
        <FormField label="Filter by Signup Group" htmlFor="event-roster-group-filter">
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger id="event-roster-group-filter">
              <SelectValue placeholder="All Signup Groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Signup Groups</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Filter by status" htmlFor="event-roster-status-filter">
          <Select
            value={statusFilter}
            onValueChange={(value: "all" | EventSignup["status"]) => setStatusFilter(value)}
          >
            <SelectTrigger id="event-roster-status-filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="waitlisted">Waitlisted</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <div
        className="mt-4 grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Roster summary"
      >
        <p>
          <span className="font-semibold">Total confirmed:</span> {confirmedTotal}
        </p>
        <p>
          <span className="font-semibold">Total waitlisted:</span> {waitlistedTotal}
        </p>
        <p>
          <span className="font-semibold">Visible signups:</span> {filteredSignups.length}
        </p>
        <p>
          <span className="font-semibold">Groups at capacity:</span>{" "}
          {
            groups.filter(
              (group) =>
                group.capacity !== null &&
                (signupCounts.get(group.id)?.confirmed ?? 0) >= group.capacity,
            ).length
          }
        </p>
      </div>
      <div
        className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground"
        aria-label="Signup Group capacity summary"
      >
        {groups.map((group) => {
          const count = signupCounts.get(group.id) ?? { confirmed: 0, waitlisted: 0 };
          const atCapacity = group.capacity !== null && count.confirmed >= group.capacity;
          return (
            <span key={group.id} className="rounded-md border px-2 py-1">
              {group.label}: {count.confirmed}/{group.capacity === null ? "∞" : group.capacity}{" "}
              confirmed
              {count.waitlisted ? ` · ${count.waitlisted} waitlisted` : ""}
              {atCapacity ? " · At capacity" : ""}
            </span>
          );
        })}
      </div>
      {signups.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No one has signed up yet.
        </p>
      ) : filteredSignups.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No signups match the current search and filters.
        </p>
      ) : (
        <ResponsiveTable
          rows={filteredSignups}
          rowKey={(signup) => `${signup.userId}-${signup.groupId}`}
          columns={columns}
          emptyMessage="No signups match the current search and filters."
        />
      )}
    </SettingsBlock>
  );
}

function StatusBadge({ status }: { status: EventStatus }) {
  const variant =
    status === "live" || status === "scheduled"
      ? "success"
      : status === "cancelled"
        ? "danger"
        : status === "draft"
          ? "warning"
          : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

function draftFromEvent(event: EventRecord): EventDraft {
  return {
    eventId: event.id,
    guildId: event.guildId,
    templateId: event.templateId,
    title: event.title,
    description: event.description,
    channelId: event.channelId,
    startsAtMs: event.startsAtMs,
    endsAtMs: event.endsAtMs,
    signupCutoffAtMs: event.signupCutoffAtMs,
    signupMode: event.signupMode,
    participationMode: event.participationMode,
    requiredTeamSize: event.requiredTeamSize,
    threadEnabled: event.threadEnabled,
    waitlistedMembersJoinThread: event.waitlistedMembersJoinThread,
    groups: event.groups,
    reminders: event.reminders,
  };
}

function createBlankDraft(guildId: string): EventDraft {
  const now = Date.now();
  const startsAtMs = roundToNextHour(now + 60 * 60 * 1000);
  return {
    guildId,
    templateId: null,
    title: "",
    description: "",
    channelId: "",
    startsAtMs,
    endsAtMs: startsAtMs + 2 * 60 * 60 * 1000,
    signupCutoffAtMs: startsAtMs,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: true,
    waitlistedMembersJoinThread: false,
    groups: [createGroup("Attending")],
    reminders: [createReminder(60)],
  };
}

function createGroup(label = "Group"): EventSignupGroup {
  const id = createClientId("group");
  return {
    id,
    label,
    emoji: null,
    capacity: null,
    waitlistEnabled: true,
    allowedRoleIds: [],
    blockedRoleIds: [],
    grantRoleId: null,
  };
}

function createReminder(offsetMinutes = 30): EventReminder {
  return {
    id: createClientId("reminder"),
    offsetMinutes,
    audience: "signed_up",
    signupGroupIds: [],
    message: "Event starts soon.",
    sentAtMs: null,
  };
}

function updateGroup(
  setDraft: (update: (current: EventDraft) => EventDraft) => void,
  groupId: string,
  patch: Partial<EventSignupGroup>,
) {
  setDraft((current) => ({
    ...current,
    groups: current.groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
  }));
}

function updateReminder(
  setDraft: (update: (current: EventDraft) => EventDraft) => void,
  reminderId: string,
  patch: Partial<EventReminder>,
) {
  setDraft((current) => ({
    ...current,
    reminders: current.reminders.map((reminder) =>
      reminder.id === reminderId ? { ...reminder, ...patch } : reminder,
    ),
  }));
}

function toApiPayload(
  draft: EventDraft,
  workspaceId: string,
): Parameters<typeof eventsClient.create>[0] {
  return {
    workspaceId,
    guildId: draft.guildId,
    templateId: draft.templateId,
    title: draft.title.trim(),
    description: draft.description.trim(),
    channelId: draft.channelId,
    startsAtMs: draft.startsAtMs,
    endsAtMs: draft.endsAtMs,
    signupCutoffAtMs: draft.signupCutoffAtMs,
    signupMode: draft.signupMode,
    participationMode: draft.participationMode,
    requiredTeamSize: draft.requiredTeamSize,
    threadEnabled: draft.threadEnabled,
    waitlistedMembersJoinThread: draft.waitlistedMembersJoinThread,
    groups: draft.groups.map((group) => ({
      ...group,
      label: group.label.trim(),
      emoji: group.emoji?.trim() || null,
    })),
    reminders: draft.reminders.map((reminder) => ({
      ...reminder,
      message: reminder.message.trim(),
    })),
  };
}

function validateDraft(draft: EventDraft): string | null {
  if (!draft.title.trim()) return "Event title is required.";
  if (!draft.channelId.trim()) return "Event channel is required.";
  if (!Number.isFinite(draft.startsAtMs) || draft.startsAtMs <= 0) return "Start time is required.";
  if (draft.endsAtMs && draft.endsAtMs <= draft.startsAtMs)
    return "End time must be after start time.";
  if (draft.groups.length === 0) return "Add at least one Signup Group.";
  if (draft.groups.some((group) => !group.label.trim())) return "Every Signup Group needs a label.";
  if (
    draft.participationMode === "team" &&
    (!Number.isInteger(draft.requiredTeamSize) ||
      draft.requiredTeamSize === null ||
      draft.requiredTeamSize < 2 ||
      draft.requiredTeamSize > 50)
  ) {
    return "Required Event Team size must be between 2 and 50.";
  }
  return null;
}

function validateTemplateDraft(draft: EventDraft): string | null {
  if (draft.groups.length === 0) return "Add at least one Signup Group.";
  if (draft.groups.some((group) => !group.label.trim())) return "Every Signup Group needs a label.";
  if (
    draft.participationMode === "team" &&
    (!Number.isInteger(draft.requiredTeamSize) ||
      draft.requiredTeamSize === null ||
      draft.requiredTeamSize < 2 ||
      draft.requiredTeamSize > 50)
  ) {
    return "Required Event Team size must be between 2 and 50.";
  }
  return null;
}

function templateChangeSummary(draft: EventDraft, template: EventsLoaderData["templates"][number]) {
  const changedFields: string[] = [];
  if (draft.description.trim() !== template.description.trim()) changedFields.push("Description");
  if (draft.signupMode !== template.signupMode) changedFields.push("Signup mode");
  if (
    draft.participationMode !== template.participationMode ||
    draft.requiredTeamSize !== template.requiredTeamSize
  ) {
    changedFields.push("Participation mode");
  }
  if (
    draft.threadEnabled !== template.threadEnabled ||
    draft.waitlistedMembersJoinThread !== template.waitlistedMembersJoinThread
  ) {
    changedFields.push("Thread settings");
  }
  if (JSON.stringify(draft.groups) !== JSON.stringify(template.groups)) {
    changedFields.push("Signup Groups");
  }
  if (JSON.stringify(draft.reminders) !== JSON.stringify(template.reminders)) {
    changedFields.push("Reminders");
  }
  return changedFields;
}

interface SignupCount {
  confirmed: number;
  waitlisted: number;
}

function countSignups(signups: EventSignup[]) {
  const counts = new Map<string, SignupCount>();
  for (const signup of signups) {
    const count = counts.get(signup.groupId) ?? { confirmed: 0, waitlisted: 0 };
    if (signup.status === "confirmed") count.confirmed += 1;
    else count.waitlisted += 1;
    counts.set(signup.groupId, count);
  }
  return counts;
}

export function formatDatetimeInput(ms: number) {
  const date = new Date(ms);
  const parts = [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
  ];
  return `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}`;
}

export function parseLocalDatetime(value: string) {
  return new Date(value).getTime();
}

function formatLocalDateTime(ms: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function formatRelativeDateTime(ms: number) {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds >= 86_400
      ? [86_400, "day"]
      : absoluteSeconds >= 3_600
        ? [3_600, "hour"]
        : absoluteSeconds >= 60
          ? [60, "minute"]
          : [1, "second"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(seconds / divisor),
    unit,
  );
}

function formatRelativeAge(ms: number) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    seconds >= 86_400
      ? [86_400, "day"]
      : seconds >= 3_600
        ? [3_600, "hour"]
        : seconds >= 60
          ? [60, "minute"]
          : [1, "second"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    -Math.round(seconds / divisor),
    unit,
  );
}

function getLocalTimeZoneLabel() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZoneName = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  return timeZoneName ? `${timeZone} (${timeZoneName})` : timeZone;
}

function formatReminderOffset(minutes: number) {
  if (minutes === 0) return "At the event start";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} before`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} before`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m before`;
}

function padDatePart(value: number) {
  return value.toString().padStart(2, "0");
}

function roundToNextHour(ms: number) {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime() + 60 * 60 * 1000;
}

function createClientId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
