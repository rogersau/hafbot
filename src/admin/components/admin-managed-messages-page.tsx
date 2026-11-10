import { ConfigurationActions } from "./configuration-actions";
import { Component, lazy, Suspense, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  ManagedMessage,
  ManagedMessageAnnouncement,
  ManagedMessageDraft as PersistedManagedMessageDraft,
  ManagedMessageEmbed,
  ManagedMessageEmbedField,
  ManagedMessageLinkButton,
  MessageTemplate,
} from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { managedMessagesClient } from "../generated/admin-client/managed-messages";
import type { ManagedMessagesLoaderData } from "../lib/admin-route-loaders";
import { DiscordMessagePreview } from "./discord-message-preview";
import { MarkdownEditor } from "./markdown-editor";
import { ManagedMediaUpload } from "./managed-media-upload";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const ManagedMessageLinkButtonEditor = lazy(() => import("./managed-message-link-button-editor"));

/** Dispatches Save and continue to the active editor's mutation. */
export function saveAndContinueMutation<T>(
  mode: "managed-message" | "template",
  mutations: {
    managedMessage: () => Promise<T>;
    template: () => Promise<T>;
  },
): Promise<T> {
  return mode === "template" ? mutations.template() : mutations.managedMessage();
}

interface ManagedMessageEditorDraft {
  id: string | null;
  internalName: string;
  channelId: string;
  embeds: ManagedMessageEmbed[];
  buttons: ManagedMessageLinkButton[];
  announcement: ManagedMessageAnnouncement;
  availableForTicketReplies: boolean;
}

interface EditorSnapshot {
  draft: ManagedMessageEditorDraft;
  mode: "managed-message" | "template";
  scheduledLocal: string;
}

type ProductDialogRequest =
  | { kind: "unsaved"; continueAction: () => void }
  | {
      kind: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      action: () => void;
    }
  | { kind: "duplicate"; template: MessageTemplate; name: string; error?: string };

export function AdminManagedMessagesPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ManagedMessagesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const guildId = selectedGuildId.trim();
  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Managed Messages"
        description="Publish durable information as bot-owned Discord messages."
        readinessFeature="managed-messages"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!guildId ? (
        <NoGuildSelected feature="Managed Messages" />
      ) : (
        <ManagedMessagesEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={guildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function ManagedMessagesEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ManagedMessagesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<ManagedMessage[]>(initialData?.messages ?? []);
  const [managedDrafts, setManagedDrafts] = useState<PersistedManagedMessageDraft[]>(
    initialData?.drafts ?? [],
  );
  const [templates, setTemplates] = useState<MessageTemplate[]>(initialData?.templates ?? []);
  const [draft, setDraft] = useState<ManagedMessageEditorDraft>(() =>
    createDraft(initialData?.messages[0]),
  );
  const [tab, setTab] = useState<"messages" | "editor">("messages");
  const [editorMode, setEditorMode] = useState<"managed-message" | "template">("managed-message");
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState<EditorSnapshot>(() =>
    createEditorSnapshot(createDraft(initialData?.messages[0]), "managed-message", ""),
  );
  const [dialogRequest, setDialogRequest] = useState<ProductDialogRequest | null>(null);
  const tabReturnFocus = useRef<HTMLButtonElement | null>(null);
  const pendingAfterSave = useRef<(() => void) | null>(null);
  const api = useAdminApi();
  const toast = useToast();
  const textChannels = initialData?.resources.textChannels ?? [];
  const roles = initialData?.resources.roles ?? [];
  const limit = initialData?.entitlement ? initialData.entitlement.limits.managedMessagesMax : 3;
  const templateLimit =
    initialData?.entitlement?.limits.messageTemplatesMax === undefined
      ? 3
      : initialData.entitlement.limits.messageTemplatesMax;
  const canWrite = initialData?.canWrite ?? true;

  const hasUnsavedChanges =
    canWrite &&
    tab === "editor" &&
    !snapshotsEqual(createEditorSnapshot(draft, editorMode, scheduledLocal), savedSnapshot);

  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === draft.id) ?? null,
    [draft.id, messages],
  );
  const selectedDraft = useMemo(
    () => managedDrafts.find((messageDraft) => messageDraft.id === draft.id) ?? null,
    [draft.id, managedDrafts],
  );

  function loadEditor(
    nextDraft: ManagedMessageEditorDraft,
    mode: "managed-message" | "template",
    schedule = "",
  ) {
    setDraft(nextDraft);
    setEditorMode(mode);
    setScheduledLocal(schedule);
    setSavedSnapshot(createEditorSnapshot(nextDraft, mode, schedule));
    setTab("editor");
    api.setError(null);
  }

  function protectNavigation(action: () => void) {
    if (!hasUnsavedChanges) {
      action();
      return;
    }
    const focused = document.activeElement;
    tabReturnFocus.current =
      focused?.getAttribute("role") === "tab" ? (focused as HTMLButtonElement) : null;
    setDialogRequest({ kind: "unsaved", continueAction: action });
  }

  function startNew() {
    if (!canWrite) return;
    protectNavigation(() => loadEditor(createDraft(), "managed-message"));
  }

  function startTemplate() {
    if (!canWrite) return;
    protectNavigation(() => loadEditor(createDraft(), "template"));
  }

  function editTemplate(template: MessageTemplate) {
    protectNavigation(() => loadEditor(draftFromTemplate(template), "template"));
  }

  function createFromTemplate(template: MessageTemplate) {
    protectNavigation(() =>
      loadEditor(
        {
          ...draftFromTemplate(template),
          id: null,
          internalName: "",
          channelId: "",
          availableForTicketReplies: false,
        },
        "managed-message",
      ),
    );
  }

  function editMessage(message: ManagedMessage) {
    protectNavigation(() => loadEditor(draftFromMessage(message), "managed-message"));
  }

  function editDraft(messageDraft: PersistedManagedMessageDraft) {
    const schedule =
      messageDraft.scheduledAtMs === null ? "" : localDateTimeValue(messageDraft.scheduledAtMs);
    protectNavigation(() =>
      loadEditor(draftFromPersistedDraft(messageDraft), "managed-message", schedule),
    );
  }

  async function performSave(republish = false) {
    if (!canWrite) return;
    setTab("editor");
    if (!draft.internalName.trim()) {
      api.setError("Internal name is required.");
      return;
    }
    if (!draft.channelId) {
      api.setError("Choose a destination channel.");
      return;
    }
    if (draft.embeds.some((embed) => !embed.description.trim())) {
      api.setError("Every embed needs a description.");
      return;
    }
    const buttonError = validateLinkButtons(draft.buttons);
    if (buttonError) {
      api.setError(buttonError);
      return;
    }
    await api.run(
      async () =>
        managedMessagesClient.save({
          action: republish ? "republish" : undefined,
          guildId: selectedGuildId,
          id: draft.id,
          internalName: draft.internalName,
          channelId: draft.channelId,
          embeds: draft.embeds,
          buttons: draft.buttons,
          announcement: draft.announcement,
          workspaceId: selectedWorkspaceId || undefined,
        }),
      (result) => {
        if (!("message" in result)) throw new Error("Managed Message save returned no message.");
        const { message } = result;
        setMessages((current) => {
          const withoutSaved = current.filter((entry) => entry.id !== message.id);
          return [...withoutSaved, message].sort((left, right) =>
            left.internalName.localeCompare(right.internalName),
          );
        });
        setDraft(draftFromMessage(message));
        setSavedSnapshot(createEditorSnapshot(draftFromMessage(message), "managed-message", ""));
        toast.success("Managed Message saved.");
        void refreshAdminRouteData(onRouteDataRefresh);
        continueAfterSuccessfulSave();
      },
      (message) => toast.error(message),
    );
  }

  function continueAfterSuccessfulSave() {
    const continuation = pendingAfterSave.current;
    pendingAfterSave.current = null;
    continuation?.();
  }

  function cancelPendingContinuation() {
    pendingAfterSave.current = null;
  }

  async function save() {
    if (!canWrite) return;
    if (!validateEditor()) return;
    setDialogRequest({
      kind: "confirm",
      title:
        selectedMessage?.status === "missing"
          ? "Repair Managed Message?"
          : selectedMessage?.status === "unpublished"
            ? "Publish Managed Message?"
            : selectedMessage
              ? "Save Managed Message?"
              : "Publish Managed Message?",
      description: publishSummary(draft, textChannels, roles, selectedMessage),
      confirmLabel:
        selectedMessage?.status === "missing"
          ? "Repair"
          : selectedMessage?.status === "unpublished"
            ? "Publish"
            : selectedMessage
              ? "Save changes"
              : "Publish",
      action: () => void performSave(selectedMessage?.status === "unpublished"),
    });
  }

  function validateEditor(): boolean {
    if (!draft.internalName.trim()) {
      api.setError("Internal name is required.");
      return false;
    }
    if (!draft.channelId) {
      api.setError("Choose a destination channel.");
      return false;
    }
    if (draft.embeds.some((embed) => !embed.description.trim())) {
      api.setError("Every embed needs a description.");
      return false;
    }
    const buttonError = validateLinkButtons(draft.buttons);
    if (buttonError) {
      api.setError(buttonError);
      return false;
    }
    return true;
  }

  async function runDraftAction(action: "save-draft" | "publish-draft" | "schedule") {
    if (!canWrite || !validateEditor()) return;
    const scheduledAtMs = action === "schedule" ? new Date(scheduledLocal).getTime() : undefined;
    if (
      action === "schedule" &&
      (!Number.isFinite(scheduledAtMs) || scheduledAtMs! <= Date.now())
    ) {
      api.setError("Choose a future date and time for the Scheduled Publish.");
      return;
    }
    if (action === "publish-draft") {
      setDialogRequest({
        kind: "confirm",
        title: "Publish Managed Message?",
        description: publishSummary(draft, textChannels, roles),
        confirmLabel: "Publish now",
        action: () => void performDraftAction(action, scheduledAtMs),
      });
      return;
    }

    await performDraftAction(action, scheduledAtMs);
  }

  async function performDraftAction(
    action: "save-draft" | "publish-draft" | "schedule",
    scheduledAtMs?: number,
  ) {
    await api.run(
      async () =>
        managedMessagesClient.save({
          action,
          guildId: selectedGuildId,
          id: draft.id,
          internalName: draft.internalName,
          channelId: draft.channelId,
          embeds: draft.embeds,
          buttons: draft.buttons,
          announcement: draft.announcement,
          ...(scheduledAtMs === undefined ? {} : { scheduledAtMs }),
          workspaceId: selectedWorkspaceId || undefined,
        }),
      (result) => {
        const savedDraft = "draft" in result ? result.draft : undefined;
        const message = "message" in result ? result.message : undefined;
        if (savedDraft) {
          setManagedDrafts((current) => [
            ...current.filter((entry) => entry.id !== savedDraft.id),
            savedDraft,
          ]);
          setDraft(draftFromPersistedDraft(savedDraft));
          setSavedSnapshot(
            createEditorSnapshot(
              draftFromPersistedDraft(savedDraft),
              "managed-message",
              savedDraft.scheduledAtMs === null ? "" : localDateTimeValue(savedDraft.scheduledAtMs),
            ),
          );
          setScheduledLocal(
            savedDraft.scheduledAtMs === null ? "" : localDateTimeValue(savedDraft.scheduledAtMs),
          );
          toast.success(savedDraft.status === "scheduled" ? "Publish scheduled." : "Draft saved.");
        }
        if (message) {
          setManagedDrafts((current) => current.filter((entry) => entry.id !== message.id));
          setMessages((current) => [
            ...current.filter((entry) => entry.id !== message.id),
            message,
          ]);
          setDraft(draftFromMessage(message));
          setSavedSnapshot(createEditorSnapshot(draftFromMessage(message), "managed-message", ""));
          setScheduledLocal("");
          toast.success("Managed Message published.");
        }
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  function changePublication(message: ManagedMessage) {
    const publish = message.status === "unpublished";
    setDialogRequest({
      kind: "confirm",
      title: `${publish ? "Publish" : "Unpublish"} Managed Message?`,
      description: publish
        ? "Publish without repeating notifications."
        : "Remove from Discord; keep all saved settings.",
      confirmLabel: publish ? "Publish" : "Unpublish",
      action: () => {
        void api.run(
          () =>
            managedMessagesClient.save({
              ...message,
              action: publish ? "republish" : "unpublish",
              workspaceId: selectedWorkspaceId || undefined,
            }),
          (result) => {
            if (!("message" in result)) throw new Error("Expected a message.");
            setMessages((current) =>
              current.map((entry) => (entry.id === result.message.id ? result.message : entry)),
            );
            toast.success(`Managed Message ${publish ? "published" : "unpublished"}.`);
            void refreshAdminRouteData(onRouteDataRefresh);
          },
          (message) => toast.error(message),
        );
      },
    });
  }

  async function remove(message: ManagedMessage) {
    setDialogRequest({
      kind: "confirm",
      title: "Delete Managed Message?",
      description: `Delete “${message.internalName}” from HAF configuration? Its Discord message will also be removed when present.`,
      confirmLabel: "Delete",
      action: () => void performRemove(message),
    });
  }

  async function performRemove(message: ManagedMessage) {
    await api.run(
      async () =>
        managedMessagesClient.delete({
          guildId: selectedGuildId,
          id: message.id,
          workspaceId: selectedWorkspaceId || undefined,
        }),
      () => {
        setMessages((current) => current.filter((entry) => entry.id !== message.id));
        if (draft.id === message.id) {
          setDraft(createDraft());
          setTab("messages");
        }
        toast.success("Managed Message deleted.");
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  async function cancelSchedule(messageDraft: PersistedManagedMessageDraft) {
    await api.run(
      async () =>
        managedMessagesClient.save({
          action: "cancel-schedule",
          guildId: selectedGuildId,
          id: messageDraft.id,
          internalName: messageDraft.internalName,
          channelId: messageDraft.channelId,
          embeds: messageDraft.embeds,
          buttons: messageDraft.buttons,
          announcement: messageDraft.announcement,
          workspaceId: selectedWorkspaceId || undefined,
        }),
      (result) => {
        if (!("draft" in result)) throw new Error("Schedule cancellation returned no draft.");
        const cancelled = result.draft;
        setManagedDrafts((current) => [
          ...current.filter((entry) => entry.id !== cancelled.id),
          cancelled,
        ]);
        if (draft.id === cancelled.id) {
          setDraft(draftFromPersistedDraft(cancelled));
          setScheduledLocal("");
        }
        toast.success("Scheduled Publish cancelled.");
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  async function removeDraft(messageDraft: PersistedManagedMessageDraft) {
    setDialogRequest({
      kind: "confirm",
      title: "Delete Managed Message Draft?",
      description: `Delete draft “${messageDraft.internalName}”? This removes only the HAF draft and does not affect Discord content.`,
      confirmLabel: "Delete draft",
      action: () => void performRemoveDraft(messageDraft),
    });
  }

  async function performRemoveDraft(messageDraft: PersistedManagedMessageDraft) {
    await api.run(
      async () =>
        managedMessagesClient.delete({
          guildId: selectedGuildId,
          id: messageDraft.id,
          draft: true,
          workspaceId: selectedWorkspaceId || undefined,
        }),
      () => {
        setManagedDrafts((current) => current.filter((entry) => entry.id !== messageDraft.id));
        if (draft.id === messageDraft.id) {
          setDraft(createDraft());
          setScheduledLocal("");
          setTab("messages");
        }
        toast.success("Managed Message Draft deleted.");
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  async function saveTemplate() {
    if (!canWrite) return;
    if (!draft.internalName.trim()) {
      api.setError("Internal name is required.");
      return;
    }
    if (draft.embeds.some((embed) => !embed.description.trim())) {
      api.setError("Every embed needs a description.");
      return;
    }
    await api.run(
      async () =>
        managedMessagesClient.saveTemplate({
          guildId: selectedGuildId,
          workspaceId: selectedWorkspaceId || undefined,
          id: draft.id,
          internalName: draft.internalName,
          embeds: draft.embeds,
          availableForTicketReplies: draft.availableForTicketReplies,
        }),
      ({ template }) => {
        setTemplates((current) =>
          [...current.filter((entry) => entry.id !== template.id), template].sort((left, right) =>
            left.internalName.localeCompare(right.internalName),
          ),
        );
        setDraft(draftFromTemplate(template));
        setSavedSnapshot(createEditorSnapshot(draftFromTemplate(template), "template", ""));
        toast.success("Message Template saved.");
        void refreshAdminRouteData(onRouteDataRefresh);
        continueAfterSuccessfulSave();
      },
      (message) => toast.error(message),
    );
  }

  async function duplicateTemplate(template: MessageTemplate) {
    setDialogRequest({ kind: "duplicate", template, name: `${template.internalName} copy` });
  }

  async function performDuplicateTemplate(template: MessageTemplate, internalName: string) {
    await api.run(
      async () =>
        managedMessagesClient.saveTemplate({
          action: "duplicate",
          guildId: selectedGuildId,
          workspaceId: selectedWorkspaceId || undefined,
          id: template.id,
          internalName,
        }),
      ({ template: duplicated }) => {
        setTemplates((current) =>
          [...current, duplicated].sort((left, right) =>
            left.internalName.localeCompare(right.internalName),
          ),
        );
        toast.success("Message Template duplicated.");
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  async function removeTemplate(template: MessageTemplate) {
    setDialogRequest({
      kind: "confirm",
      title: "Delete Message Template?",
      description: `Delete “${template.internalName}”? Managed Messages created from it keep their copied content.`,
      confirmLabel: "Delete template",
      action: () => void performRemoveTemplate(template),
    });
  }

  async function performRemoveTemplate(template: MessageTemplate) {
    await api.run(
      async () =>
        managedMessagesClient.deleteTemplate({
          guildId: selectedGuildId,
          workspaceId: selectedWorkspaceId || undefined,
          id: template.id,
        }),
      () => {
        setTemplates((current) => current.filter((entry) => entry.id !== template.id));
        if (editorMode === "template" && draft.id === template.id) {
          setDraft(createDraft());
          setEditorMode("managed-message");
          setTab("messages");
        }
        toast.success("Message Template deleted.");
        void refreshAdminRouteData(onRouteDataRefresh);
      },
      (message) => toast.error(message),
    );
  }

  return (
    <div className="space-y-5">
      <NavigationGuardBoundary>
        <NavigationGuard
          hasChanges={hasUnsavedChanges}
          onDiscardChanges={() => {
            restoreSavedSnapshot();
          }}
        />
      </NavigationGuardBoundary>
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <PageFeedback error={api.error} />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border bg-muted/20 p-4">
        <div>
          <p className="font-display text-sm font-semibold">
            {messages.length + managedDrafts.length} Managed Message items
          </p>
          <p className="text-xs text-muted-foreground">
            {limit === null
              ? "Unlimited under this plan."
              : `Free tier: ${messages.length + managedDrafts.length} of ${limit} used.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={startTemplate}
            disabled={!canWrite || (templateLimit !== null && templates.length >= templateLimit)}
          >
            New Message Template
          </Button>
          <Button
            onClick={startNew}
            disabled={
              !canWrite || (limit !== null && messages.length + managedDrafts.length >= limit)
            }
          >
            New Managed Message
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === "messages") protectNavigation(() => setTab("messages"));
          else if (next === "editor") setTab("editor");
        }}
      >
        <TabsList aria-label="Managed Messages">
          <TabsTrigger value="messages">Existing Messages</TabsTrigger>
          {canWrite || draft.id ? (
            <TabsTrigger value="editor">
              {editorMode === "template"
                ? draft.id
                  ? "Edit Template"
                  : "Create Template"
                : canWrite
                  ? draft.id
                    ? "Edit Message"
                    : "Create Message"
                  : "View Message"}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>

      {tab === "messages" ? (
        <div className="space-y-5">
          <SettingsBlock>
            <SectionHeader
              title="Existing Messages"
              description="Each entry owns one canonical Discord message."
            />
            {messages.length === 0 && managedDrafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Managed Messages have been saved yet.
              </p>
            ) : (
              <div className="divide-y rounded-[4px] border">
                {managedDrafts.map((messageDraft) => (
                  <div
                    key={messageDraft.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{messageDraft.internalName}</p>
                      <p className="text-xs text-muted-foreground">
                        <Destination
                          channelId={messageDraft.channelId}
                          textChannels={textChannels}
                        />
                        {messageDraft.scheduledAtMs === null ? null : (
                          <>
                            {" · "}
                            <ScheduleSummary timestampMs={messageDraft.scheduledAtMs} />
                          </>
                        )}
                      </p>
                      {messageDraft.failureReason ? (
                        <p className="text-xs text-destructive">{messageDraft.failureReason}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={messageDraft.status === "failed" ? "danger" : "warning"}>
                        {messageDraft.status === "scheduled"
                          ? "Scheduled"
                          : messageDraft.status === "failed"
                            ? "Failed"
                            : "Draft"}
                      </Badge>
                      <Button size="sm" variant="outline" onClick={() => editDraft(messageDraft)}>
                        {canWrite ? "Edit" : "View"}
                      </Button>
                      {canWrite && messageDraft.status === "scheduled" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void cancelSchedule(messageDraft)}
                        >
                          Cancel Schedule
                        </Button>
                      ) : null}
                      {canWrite ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void removeDraft(messageDraft)}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{message.internalName}</p>
                      <p className="text-xs text-muted-foreground">
                        <Destination channelId={message.channelId} textChannels={textChannels} />
                        {" · "}
                        {message.status !== "unpublished" ? (
                          <a
                            href={`https://discord.com/channels/${selectedGuildId}/${message.channelId}/${message.messageId}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline decoration-dotted underline-offset-2"
                          >
                            Open in Discord
                          </a>
                        ) : null}
                        <details className="mt-1">
                          <summary className="cursor-pointer">Show IDs</summary>
                          <span>
                            Channel {message.channelId} · Message {message.messageId}
                          </span>
                        </details>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          message.status === "published"
                            ? "success"
                            : message.status === "unpublished"
                              ? "default"
                              : "warning"
                        }
                      >
                        {message.status[0]!.toUpperCase() + message.status.slice(1)}
                      </Badge>
                      <Button size="sm" variant="outline" onClick={() => editMessage(message)}>
                        {canWrite ? (message.status === "missing" ? "Repair" : "Edit") : "View"}
                      </Button>
                      {canWrite ? (
                        <ConfigurationActions
                          label={message.internalName}
                          actions={[
                            {
                              label: message.status === "unpublished" ? "Publish" : "Unpublish",
                              disabled:
                                api.loading || (draft.id === message.id && hasUnsavedChanges),
                              onSelect: () => changePublication(message),
                            },
                            {
                              label: "Delete",
                              disabled: api.loading,
                              onSelect: () => void remove(message),
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsBlock>
          <SettingsBlock>
            <SectionHeader
              title="Message Templates"
              description={
                templateLimit === null
                  ? `${templates.length} templates · Unlimited under this plan.`
                  : `${templates.length} of ${templateLimit} templates used.`
              }
            />
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Message Templates have been saved yet.
              </p>
            ) : (
              <div className="divide-y rounded-[4px] border">
                {templates.map((template) => (
                  <div
                    key={template.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{template.internalName}</p>
                      <p className="text-xs text-muted-foreground">
                        {template.embeds.length} embed{template.embeds.length === 1 ? "" : "s"}
                        {template.availableForTicketReplies
                          ? " · Available for Ticket Replies"
                          : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => createFromTemplate(template)}
                      >
                        Create Message
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => editTemplate(template)}>
                        {canWrite ? "Edit" : "View"}
                      </Button>
                      {canWrite ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void duplicateTemplate(template)}
                          >
                            Duplicate
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void removeTemplate(template)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsBlock>
        </div>
      ) : (
        <Editor
          selectedGuildId={selectedGuildId}
          selectedWorkspaceId={selectedWorkspaceId}
          draft={draft}
          setDraft={setDraft}
          selectedMessage={selectedMessage}
          selectedDraft={selectedDraft}
          textChannels={textChannels}
          roles={roles}
          readOnly={!canWrite}
          saving={api.loading}
          onSave={() => void save()}
          onSaveDraft={() => void runDraftAction("save-draft")}
          onPublish={() => void runDraftAction("publish-draft")}
          onSchedule={() => void runDraftAction("schedule")}
          scheduledLocal={scheduledLocal}
          setScheduledLocal={setScheduledLocal}
          mode={editorMode}
          onSaveTemplate={() => void saveTemplate()}
          onDiscard={restoreSavedSnapshot}
        />
      )}
      <ProductDialog
        request={dialogRequest}
        returnFocus={dialogRequest?.kind === "unsaved" ? tabReturnFocus.current : null}
        loading={api.loading}
        onClose={() => {
          cancelPendingContinuation();
          setDialogRequest(null);
        }}
        onConfirm={() => {
          const request = dialogRequest;
          if (!request) return;
          if (request.kind === "unsaved") {
            cancelPendingContinuation();
            restoreSavedSnapshot();
            setDialogRequest(null);
            request.continueAction();
          } else if (request.kind === "confirm") {
            setDialogRequest(null);
            request.action();
          } else {
            const name = request.name.trim();
            if (!name) {
              setDialogRequest({ ...request, error: "Enter a template name." });
              return;
            }
            if (name.length > 100) {
              setDialogRequest({
                ...request,
                error: "Template names must be 100 characters or fewer.",
              });
              return;
            }
            if (
              templates.some(
                (template) => template.internalName.toLowerCase() === name.toLowerCase(),
              )
            ) {
              setDialogRequest({ ...request, error: "A template with this name already exists." });
              return;
            }
            setDialogRequest(null);
            void performDuplicateTemplate(request.template, name);
          }
        }}
        onUnsavedSave={async () => {
          if (!dialogRequest || dialogRequest.kind !== "unsaved") return;
          pendingAfterSave.current = () => {
            const next = dialogRequest.continueAction;
            setDialogRequest(null);
            next();
          };
          await saveAndContinueMutation(editorMode, {
            managedMessage: performSave,
            template: saveTemplate,
          });
        }}
        onNameChange={(name) => {
          if (dialogRequest?.kind === "duplicate")
            setDialogRequest({ ...dialogRequest, name, error: undefined });
        }}
      />
    </div>
  );

  function restoreSavedSnapshot() {
    setDraft(cloneDraft(savedSnapshot.draft));
    setEditorMode(savedSnapshot.mode);
    setScheduledLocal(savedSnapshot.scheduledLocal);
    api.setError(null);
  }
}

function Editor({
  selectedGuildId,
  selectedWorkspaceId,
  draft,
  setDraft,
  selectedMessage,
  selectedDraft,
  textChannels,
  roles,
  readOnly,
  saving,
  onSave,
  onSaveDraft,
  onPublish,
  onSchedule,
  scheduledLocal,
  setScheduledLocal,
  mode,
  onSaveTemplate,
  onDiscard,
}: {
  selectedGuildId: string;
  selectedWorkspaceId: string;
  draft: ManagedMessageEditorDraft;
  setDraft: (draft: ManagedMessageEditorDraft) => void;
  selectedMessage: ManagedMessage | null;
  selectedDraft: PersistedManagedMessageDraft | null;
  textChannels: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  readOnly: boolean;
  saving: boolean;
  onSave: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
  onSchedule: () => void;
  scheduledLocal: string;
  setScheduledLocal: (value: string) => void;
  mode: "managed-message" | "template";
  onSaveTemplate: () => void;
  onDiscard: () => void;
}) {
  const updateEmbed = (index: number, patch: Partial<ManagedMessageEmbed>) => {
    setDraft({
      ...draft,
      embeds: draft.embeds.map((embed, i) => (i === index ? { ...embed, ...patch } : embed)),
    });
  };
  const updateField = (
    embedIndex: number,
    fieldIndex: number,
    patch: Partial<ManagedMessageEmbedField>,
  ) => {
    setDraft({
      ...draft,
      embeds: draft.embeds.map((embed, i) =>
        i === embedIndex
          ? {
              ...embed,
              fields: embed.fields.map((field, j) =>
                j === fieldIndex ? { ...field, ...patch } : field,
              ),
            }
          : embed,
      ),
    });
  };
  function moveEmbed(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.embeds.length) return;
    const embeds = [...draft.embeds];
    const [embed] = embeds.splice(index, 1);
    embeds.splice(nextIndex, 0, embed!);
    setDraft({ ...draft, embeds });
  }

  function moveField(embedIndex: number, fieldIndex: number, direction: -1 | 1) {
    const fields = [...draft.embeds[embedIndex]!.fields];
    const nextIndex = fieldIndex + direction;
    if (nextIndex < 0 || nextIndex >= fields.length) return;
    const [field] = fields.splice(fieldIndex, 1);
    fields.splice(nextIndex, 0, field!);
    updateEmbed(embedIndex, { fields });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
      <div className="space-y-5">
        <fieldset disabled={readOnly} className="space-y-5">
          <SettingsBlock>
            <SectionHeader
              title={
                mode === "template"
                  ? draft.id
                    ? `Edit ${draft.internalName || "Message Template"}`
                    : "New Message Template"
                  : draft.id
                    ? `Edit ${draft.internalName || "Managed Message"}`
                    : "New Managed Message"
              }
              description={
                mode === "template"
                  ? "Save reusable embed content without publishing a Discord message."
                  : selectedMessage?.status === "unpublished"
                    ? "Publish restores this message without repeating notifications."
                    : selectedMessage?.status === "missing"
                      ? "Save to recreate the missing canonical message in its original channel."
                      : selectedMessage
                        ? "Save updates the live Discord message immediately."
                        : "Save a draft, publish immediately, or choose one future Scheduled Publish."
              }
            />
            <div className={`grid gap-4 ${mode === "managed-message" ? "md:grid-cols-2" : ""}`}>
              <FormField
                label="Internal name"
                htmlFor="managed-message-name"
                required
                hint="Unique within this Guild; members do not see it."
              >
                <Input
                  id="managed-message-name"
                  value={draft.internalName}
                  onChange={(event) =>
                    setDraft({ ...draft, internalName: event.currentTarget.value })
                  }
                />
              </FormField>
              {mode === "managed-message" ? (
                <FormField
                  label="Destination channel"
                  htmlFor="managed-message-channel"
                  required
                  hint={
                    selectedMessage ? "The destination is immutable after publication." : undefined
                  }
                >
                  <ChannelSelect
                    id="managed-message-channel"
                    value={draft.channelId}
                    onChange={(channelId) => setDraft({ ...draft, channelId })}
                    channels={textChannels}
                    disabled={Boolean(selectedMessage)}
                    placeholder="Choose a text channel"
                  />
                </FormField>
              ) : null}
            </div>
            {mode === "template" ? (
              <div className="mt-4">
                <CheckLabel
                  checked={draft.availableForTicketReplies}
                  label="Available for Ticket Replies"
                  onChange={(availableForTicketReplies) =>
                    setDraft({ ...draft, availableForTicketReplies })
                  }
                />
              </div>
            ) : null}
          </SettingsBlock>

          {draft.embeds.map((embed, index) => (
            <SettingsBlock key={index}>
              <SectionHeader
                title={`Embed ${index + 1}`}
                actions={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Move embed ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => moveEmbed(index, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Move embed ${index + 1} down`}
                      disabled={index === draft.embeds.length - 1}
                      onClick={() => moveEmbed(index, 1)}
                    >
                      Move down
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Duplicate embed ${index + 1}`}
                      disabled={draft.embeds.length >= 10}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          embeds: [
                            ...draft.embeds.slice(0, index + 1),
                            { ...embed, fields: embed.fields.map((field) => ({ ...field })) },
                            ...draft.embeds.slice(index + 1),
                          ],
                        })
                      }
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label={`Remove embed ${index + 1}`}
                      disabled={draft.embeds.length === 1}
                      onClick={() =>
                        setDraft({ ...draft, embeds: draft.embeds.filter((_, i) => i !== index) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                }
              />
              <div className="space-y-4">
                <FormField
                  label="Title"
                  htmlFor={`managed-embed-title-${index}`}
                  hint="Optional; up to 256 characters."
                >
                  <Input
                    id={`managed-embed-title-${index}`}
                    value={embed.title ?? ""}
                    maxLength={256}
                    onChange={(event) =>
                      updateEmbed(index, { title: event.currentTarget.value || undefined })
                    }
                  />
                </FormField>
                <FormField
                  label="Description"
                  htmlFor={`managed-embed-description-${index}`}
                  required
                  hint="Static Discord Markdown; up to 4,096 characters."
                >
                  <MarkdownEditor
                    id={`managed-embed-description-${index}`}
                    flavor="full"
                    rows={6}
                    value={embed.description}
                    maxLength={4096}
                    onChange={(description) => updateEmbed(index, { description })}
                    placeholder="Write the information members should see in this embed."
                    helpText="Supports Discord markdown: headings, lists, quotes, links, spoilers, code, and more."
                  />
                </FormField>
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField label="Colour" htmlFor={`managed-embed-color-${index}`}>
                    <div className="flex gap-2">
                      <Input
                        id={`managed-embed-color-${index}`}
                        type="color"
                        className="w-14 p-1"
                        value={colorToHex(embed.color)}
                        onChange={(event) =>
                          updateEmbed(index, {
                            color: Number.parseInt(event.currentTarget.value.slice(1), 16),
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => updateEmbed(index, { color: undefined })}
                      >
                        Clear
                      </Button>
                    </div>
                  </FormField>
                  <FormField label="Footer" htmlFor={`managed-embed-footer-${index}`}>
                    <Input
                      id={`managed-embed-footer-${index}`}
                      value={embed.footer ?? ""}
                      maxLength={2048}
                      onChange={(event) =>
                        updateEmbed(index, { footer: event.currentTarget.value || undefined })
                      }
                    />
                  </FormField>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField label="Image URL" htmlFor={`managed-embed-image-${index}`}>
                    <ManagedMediaUpload
                      id={`managed-embed-image-${index}`}
                      label={`image for embed ${index + 1}`}
                      guildId={selectedGuildId}
                      workspaceId={selectedWorkspaceId || undefined}
                      value={embed.imageUrl ?? ""}
                      disabled={readOnly}
                      onChange={(imageUrl) =>
                        updateEmbed(index, { imageUrl: imageUrl || undefined })
                      }
                    />
                  </FormField>
                  <FormField label="Thumbnail URL" htmlFor={`managed-embed-thumbnail-${index}`}>
                    <ManagedMediaUpload
                      id={`managed-embed-thumbnail-${index}`}
                      label={`thumbnail for embed ${index + 1}`}
                      guildId={selectedGuildId}
                      workspaceId={selectedWorkspaceId || undefined}
                      value={embed.thumbnailUrl ?? ""}
                      disabled={readOnly}
                      onChange={(thumbnailUrl) =>
                        updateEmbed(index, { thumbnailUrl: thumbnailUrl || undefined })
                      }
                    />
                  </FormField>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <SectionHeader title={`Fields (${embed.fields.length}/25)`} />
                  {embed.fields.map((field, fieldIndex) => (
                    <div
                      key={fieldIndex}
                      className="grid gap-2 rounded-[4px] border bg-muted/10 p-3 md:grid-cols-[1fr_1.5fr_auto]"
                    >
                      <Input
                        aria-label={`Embed ${index + 1} field ${fieldIndex + 1} name`}
                        placeholder="Field name"
                        maxLength={256}
                        value={field.name}
                        onChange={(event) =>
                          updateField(index, fieldIndex, { name: event.currentTarget.value })
                        }
                      />
                      <Input
                        aria-label={`Embed ${index + 1} field ${fieldIndex + 1} value`}
                        placeholder="Field value"
                        maxLength={1024}
                        value={field.value}
                        onChange={(event) =>
                          updateField(index, fieldIndex, { value: event.currentTarget.value })
                        }
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Move field ${fieldIndex + 1} up in embed ${index + 1}`}
                          disabled={fieldIndex === 0}
                          onClick={() => moveField(index, fieldIndex, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Move field ${fieldIndex + 1} down in embed ${index + 1}`}
                          disabled={fieldIndex === embed.fields.length - 1}
                          onClick={() => moveField(index, fieldIndex, 1)}
                        >
                          Move down
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Duplicate field ${fieldIndex + 1} in embed ${index + 1}`}
                          disabled={embed.fields.length >= 25}
                          onClick={() =>
                            updateEmbed(index, {
                              fields: [
                                ...embed.fields.slice(0, fieldIndex + 1),
                                { ...field },
                                ...embed.fields.slice(fieldIndex + 1),
                              ],
                            })
                          }
                        >
                          Duplicate
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          aria-label={`Remove field ${fieldIndex + 1} from embed ${index + 1}`}
                          onClick={() =>
                            updateEmbed(index, {
                              fields: embed.fields.filter((_, i) => i !== fieldIndex),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={embed.fields.length >= 25}
                    onClick={() =>
                      updateEmbed(index, {
                        fields: [...embed.fields, { name: "", value: "", inline: false }],
                      })
                    }
                  >
                    Add field
                  </Button>
                </div>
              </div>
            </SettingsBlock>
          ))}

          <Button
            variant="outline"
            disabled={draft.embeds.length >= 10}
            onClick={() => setDraft({ ...draft, embeds: [...draft.embeds, blankEmbed()] })}
          >
            Add embed
          </Button>

          {mode === "managed-message" ? (
            <Suspense fallback={null}>
              <ManagedMessageLinkButtonEditor
                buttons={draft.buttons}
                onChange={(buttons) => setDraft({ ...draft, buttons })}
              />
            </Suspense>
          ) : null}

          {mode === "managed-message" ? (
            <SettingsBlock>
              <SectionHeader
                title="Announcement targets"
                description="The generated mention line stays visible after edits; only the initial Save can notify its targets."
              />
              <div className="space-y-4">
                <FormField label="Roles" hint="Selected roles are the only role targets permitted.">
                  <MultiRoleSelect
                    value={draft.announcement.roleIds}
                    onChange={(roleIds) =>
                      setDraft({ ...draft, announcement: { ...draft.announcement, roleIds } })
                    }
                    roles={roles}
                  />
                </FormField>
                <div className="flex flex-wrap gap-5 text-sm">
                  <CheckLabel
                    checked={draft.announcement.everyone}
                    label="@everyone"
                    onChange={(everyone) =>
                      setDraft({ ...draft, announcement: { ...draft.announcement, everyone } })
                    }
                  />
                  <CheckLabel
                    checked={draft.announcement.here}
                    label="@here"
                    onChange={(here) =>
                      setDraft({ ...draft, announcement: { ...draft.announcement, here } })
                    }
                  />
                  <CheckLabel
                    checked={draft.announcement.notifyOnCreate}
                    label="Notify on initial Save"
                    onChange={(notifyOnCreate) =>
                      setDraft({
                        ...draft,
                        announcement: { ...draft.announcement, notifyOnCreate },
                      })
                    }
                    disabled={Boolean(selectedMessage)}
                  />
                </div>
              </div>
            </SettingsBlock>
          ) : null}
          {!readOnly ? (
            mode === "template" ? (
              <div className="flex justify-end border-t pt-4">
                <Button variant="outline" onClick={onDiscard} disabled={saving} className="mr-2">
                  Discard changes
                </Button>
                <Button onClick={onSaveTemplate} loading={saving} loadingLabel="Saving…">
                  Save Template
                </Button>
              </div>
            ) : selectedMessage ? (
              <div className="flex justify-end border-t pt-4">
                <Button variant="outline" onClick={onDiscard} disabled={saving} className="mr-2">
                  Discard changes
                </Button>
                <Button onClick={onSave} loading={saving} loadingLabel="Saving…">
                  {selectedMessage?.status === "unpublished" ? "Publish" : "Save"}
                </Button>
              </div>
            ) : (
              <div className="space-y-3 border-t pt-4">
                <FormField
                  label="Scheduled Publish"
                  htmlFor="managed-message-scheduled-at"
                  hint={`Times use your local timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`}
                >
                  <Input
                    id="managed-message-scheduled-at"
                    type="datetime-local"
                    value={scheduledLocal}
                    onChange={(event) => setScheduledLocal(event.currentTarget.value)}
                  />
                </FormField>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={onDiscard} disabled={saving}>
                    Discard changes
                  </Button>
                  <Button variant="outline" onClick={onSaveDraft} loading={saving}>
                    Save Draft
                  </Button>
                  <Button variant="outline" onClick={onSchedule} loading={saving}>
                    {selectedDraft?.status === "scheduled" ? "Reschedule" : "Schedule"}
                  </Button>
                  <Button onClick={onPublish} loading={saving}>
                    Publish Now
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </fieldset>
      </div>

      <SettingsBlock className="h-fit xl:sticky xl:top-5">
        <SectionHeader
          title="Preview"
          description="Review every embed before the live message changes."
        />
        <div className="space-y-4">
          {draft.embeds.map((embed, index) => (
            <DiscordMessagePreview
              key={index}
              content={index === 0 ? buildPreviewAnnouncement(draft.announcement) : undefined}
              embedTitle={embed.title}
              embedDescription={embed.description}
              embedColor={colorToHex(embed.color)}
              embedImage={embed.imageUrl}
              embedThumbnail={embed.thumbnailUrl}
              embedFooter={embed.footer ? { text: embed.footer } : undefined}
              embedFields={embed.fields}
              buttons={
                index === draft.embeds.length - 1
                  ? draft.buttons.map((button) => ({
                      label: button.label || "Link",
                      emoji: button.emoji,
                      variant: "secondary" as const,
                    }))
                  : undefined
              }
            />
          ))}
        </div>
      </SettingsBlock>
    </div>
  );
}

function Destination({
  channelId,
  textChannels,
}: {
  channelId: string;
  textChannels: Array<{ id: string; name: string }>;
}) {
  const channel = textChannels.find((entry) => entry.id === channelId);
  return channel ? (
    <span>#{channel.name}</span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <span>Unknown channel</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-auto px-1 py-0 text-[11px]"
        onClick={() => void copyToClipboard(channelId)}
      >
        Copy ID
      </Button>
    </span>
  );
}

async function copyToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  }
}

function ScheduleSummary({ timestampMs }: { timestampMs: number }) {
  const delta = timestampMs - Date.now();
  const relative = formatRelativeTime(delta);
  return (
    <span title={new Date(timestampMs).toLocaleString()}>
      {new Date(timestampMs).toLocaleString()} ({relative};{" "}
      {Intl.DateTimeFormat().resolvedOptions().timeZone})
    </span>
  );
}

function formatRelativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return deltaMs < 0 ? `${minutes} minutes overdue` : `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return deltaMs < 0 ? `${hours} hours overdue` : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return deltaMs < 0 ? `${days} days overdue` : `in ${days} days`;
}

function publishSummary(
  draft: ManagedMessageEditorDraft,
  textChannels: Array<{ id: string; name: string }>,
  roles: Array<{ id: string; name: string }>,
  selectedMessage?: ManagedMessage | null,
): string {
  const channel = textChannels.find((entry) => entry.id === draft.channelId);
  const roleNames = draft.announcement.roleIds
    .map((id) => roles.find((role) => role.id === id)?.name ?? `role ${id}`)
    .join(", ");
  const target = channel ? `#${channel.name}` : `unknown channel (${draft.channelId})`;
  const notification = [
    ...(roleNames ? [roleNames] : []),
    ...(draft.announcement.everyone ? ["@everyone"] : []),
    ...(draft.announcement.here ? ["@here"] : []),
  ].join(", ");
  return `${selectedMessage ? "Update" : "Create"} in ${target}. ${draft.embeds.length} embed${draft.embeds.length === 1 ? "" : "s"}, ${draft.embeds.reduce((sum, embed) => sum + embed.fields.length, 0)} field${draft.embeds.reduce((sum, embed) => sum + embed.fields.length, 0) === 1 ? "" : "s"}, ${draft.buttons.length} link button${draft.buttons.length === 1 ? "" : "s"}.${notification ? ` Notify: ${notification}.` : ""}`;
}

function createEditorSnapshot(
  draft: ManagedMessageEditorDraft,
  mode: "managed-message" | "template",
  scheduledLocal: string,
): EditorSnapshot {
  return { draft: cloneDraft(draft), mode, scheduledLocal };
}

function cloneDraft(draft: ManagedMessageEditorDraft): ManagedMessageEditorDraft {
  return JSON.parse(JSON.stringify(draft)) as ManagedMessageEditorDraft;
}

function snapshotsEqual(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class NavigationGuardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ProductDialog({
  request,
  returnFocus,
  loading,
  onClose,
  onConfirm,
  onUnsavedSave,
  onNameChange,
}: {
  request: ProductDialogRequest | null;
  returnFocus: HTMLButtonElement | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onUnsavedSave: () => Promise<void>;
  onNameChange: (name: string) => void;
}) {
  if (!request) return null;
  const unsaved = request.kind === "unsaved";
  const duplicate = request.kind === "duplicate";
  const title = unsaved
    ? "Unsaved changes"
    : duplicate
      ? "Duplicate Message Template"
      : request.title;
  const actionLabel = unsaved
    ? "Discard and continue"
    : duplicate
      ? "Duplicate"
      : request.confirmLabel;
  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (returnFocus?.isConnected && !returnFocus.disabled) {
              event.preventDefault();
              returnFocus.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {unsaved
                ? "Your editor contains unsaved changes. Choose how to continue."
                : duplicate
                  ? "Choose a unique name for the copied template."
                  : request.description}
            </DialogDescription>
          </DialogHeader>
          {duplicate ? (
            <FormField label="Template name" htmlFor="duplicate-template-name" required>
              <Input
                id="duplicate-template-name"
                value={request.name}
                maxLength={100}
                onChange={(event) => onNameChange(event.currentTarget.value)}
                autoFocus
              />
              {request.error ? (
                <p className="mt-1 text-xs text-destructive">{request.error}</p>
              ) : null}
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={loading} onClick={onClose}>
              {unsaved ? "Keep editing" : "Cancel"}
            </Button>
            {unsaved ? (
              <Button
                type="button"
                variant="outline"
                loading={loading}
                onClick={() => void onUnsavedSave()}
              >
                Save and continue
              </Button>
            ) : null}
            <Button
              type="button"
              variant={
                unsaved ||
                (request.kind === "confirm" &&
                  request.confirmLabel.toLowerCase().includes("delete"))
                  ? "destructive"
                  : "default"
              }
              loading={loading}
              onClick={onConfirm}
            >
              {actionLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="sr-only" aria-hidden="true">
        <span>{title}</span>
        <button type="button" onClick={onConfirm}>
          {actionLabel}
        </button>
      </div>
    </>
  );
}

function CheckLabel({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span className={disabled ? "text-muted-foreground" : undefined}>{label}</span>
    </label>
  );
}

function createDraft(message?: ManagedMessage): ManagedMessageEditorDraft {
  return message
    ? draftFromMessage(message)
    : {
        id: null,
        internalName: "",
        channelId: "",
        embeds: [blankEmbed()],
        buttons: [],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
        availableForTicketReplies: false,
      };
}

function draftFromMessage(message: ManagedMessage): ManagedMessageEditorDraft {
  return {
    id: message.id,
    internalName: message.internalName,
    channelId: message.channelId,
    embeds: message.embeds.map((embed) => ({
      ...embed,
      fields: embed.fields.map((field) => ({ ...field })),
    })),
    buttons: (message.buttons ?? []).map((button) => ({ ...button })),
    announcement: {
      ...message.announcement,
      roleIds: [...message.announcement.roleIds],
      notifyOnCreate: false,
    },
    availableForTicketReplies: false,
  };
}

function draftFromPersistedDraft(draft: PersistedManagedMessageDraft): ManagedMessageEditorDraft {
  return {
    id: draft.id,
    internalName: draft.internalName,
    channelId: draft.channelId,
    embeds: draft.embeds.map((embed) => ({
      ...embed,
      fields: embed.fields.map((field) => ({ ...field })),
    })),
    buttons: (draft.buttons ?? []).map((button) => ({ ...button })),
    announcement: {
      ...draft.announcement,
      roleIds: [...draft.announcement.roleIds],
    },
    availableForTicketReplies: false,
  };
}

function draftFromTemplate(template: MessageTemplate): ManagedMessageEditorDraft {
  return {
    id: template.id,
    internalName: template.internalName,
    channelId: "",
    embeds: template.embeds.map((embed) => ({
      ...embed,
      fields: embed.fields.map((field) => ({ ...field })),
    })),
    buttons: [],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    availableForTicketReplies: template.availableForTicketReplies,
  };
}

function localDateTimeValue(timestampMs: number): string {
  const date = new Date(timestampMs);
  return new Date(timestampMs - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function blankEmbed(): ManagedMessageEmbed {
  return { description: "", fields: [] };
}

function colorToHex(color: number | undefined): string {
  return `#${(color ?? 0x5865f2).toString(16).padStart(6, "0")}`;
}

function validateLinkButtons(buttons: ManagedMessageLinkButton[]): string | null {
  for (const [index, button] of buttons.entries()) {
    if (!button.label.trim()) return `Link button ${index + 1} needs a label.`;
    const value = button.url.trim();
    if (!value) return `Link button ${index + 1} needs a URL.`;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    } catch {
      return `Link button ${index + 1} needs a valid HTTP or HTTPS URL.`;
    }
  }
  return null;
}

function buildPreviewAnnouncement(announcement: ManagedMessageAnnouncement): string | undefined {
  const targets = [
    ...announcement.roleIds.map((roleId) => `<@&${roleId}>`),
    ...(announcement.everyone ? ["@everyone"] : []),
    ...(announcement.here ? ["@here"] : []),
  ];
  return targets.length > 0 ? `📣 ${targets.join(" ")}` : undefined;
}
