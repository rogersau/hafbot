import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useRef, useState } from "react";
import type { TicketPanelConfig, TicketQuestion, TicketTypeConfig } from "../../types";
import {
  DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_MODAL_LABEL_MAX_LENGTH,
} from "../../discord/constants";
import { buildTicketOpenCustomId } from "../../tickets";
import { ticketTypeOpenCustomIdMaxLength } from "../../tickets/validation";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ColorInput } from "./ui/color-input";
import { PresetNumberInput } from "./ui/preset-number-input";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { MarkdownEditor } from "./markdown-editor";
import { EditorPanel, FormField, SectionHeader, AdvancedSection } from "./admin-form-layout";
import { EmojiPicker } from "./emoji-picker";
import { MultiRoleSelect } from "./guild-resource-select";
import { TicketPanelPreview } from "./ticket-panel-preview";
export { TicketPanelPreview } from "./ticket-panel-preview";
import {
  buildInitialTicketPanelUiState,
  createEmptyTicketType,
  moveArrayItem,
  type TicketPanelEditorUiState,
} from "./ticket-panel-form-state";
export { createEmptyTicketType } from "./ticket-panel-form-state";
import { TicketResponseRuleEditor } from "./ticket-response-rules";
import { createEmptyTicketQuestion, TicketQuestionList } from "./ticket-questions";

export interface GuildResources {
  guildId: string;
  roles: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  textChannels: Array<{ id: string; name: string }>;
  emojis?: Array<{ id: string; name: string; animated: boolean; available: boolean }>;
  configuredTicketLinkPlatforms?: Array<"steam" | "xbox" | "playstation">;
}

interface TicketPanelEditorProps {
  guildResources: GuildResources;
  value: TicketPanelConfig;
  onChange: (next: TicketPanelConfig) => void;
  tab?: "panel" | "types" | "rules";
  ticketCreationLimitError?: string | null;
  saveAttempted?: boolean;
  paidAutomationAvailable?: boolean;
  ticketTypeLimitReached?: boolean;
  autoSaveToggleStatus?: {
    savingKey: "enableTicketClaiming" | "aiTranscriptSummariesEnabled" | null;
    savedKey: "enableTicketClaiming" | "aiTranscriptSummariesEnabled" | null;
  };
  onAutoSaveToggle?: (
    key: "enableTicketClaiming" | "aiTranscriptSummariesEnabled",
    nextValue: boolean,
  ) => void;
}

function resolveName(
  list: Array<{ id: string; name: string }>,
  id: string | null | undefined,
): string {
  if (!id) return "";
  return list.find((item) => item.id === id)?.name ?? id;
}

function formatTicketLinkPlatform(platform: "steam" | "xbox" | "playstation"): string {
  if (platform === "steam") return "Steam";
  if (platform === "xbox") return "Xbox";
  return "PlayStation";
}

export function TicketPanelEditor({
  guildResources,
  value,
  onChange,
  tab = "panel",
  ticketCreationLimitError,
  saveAttempted = false,
  paidAutomationAvailable = true,
  ticketTypeLimitReached = false,
  autoSaveToggleStatus,
  onAutoSaveToggle,
}: TicketPanelEditorProps) {
  const nextUiKeyRef = useRef(0);

  function createUiKey(prefix: string): string {
    const key = `${prefix}-${nextUiKeyRef.current}`;
    nextUiKeyRef.current += 1;
    return key;
  }

  const [uiState, setUiState] = useState<TicketPanelEditorUiState>(() =>
    buildInitialTicketPanelUiState(value, createUiKey),
  );

  const panelChannelName = resolveName(guildResources.textChannels, value.panelChannelId);
  const categoryName = resolveName(guildResources.categories, value.categoryChannelId);
  const transcriptName = resolveName(guildResources.textChannels, value.transcriptChannelId);
  const configuredTicketLinkPlatforms = guildResources.configuredTicketLinkPlatforms ?? [
    "steam",
    "xbox",
    "playstation",
  ];

  function updateTicketType(
    ticketTypeIndex: number,
    updater: (ticketType: TicketTypeConfig) => TicketTypeConfig,
  ) {
    onChange({
      ...value,
      ticketTypes: value.ticketTypes.map((ticketType, index) =>
        index === ticketTypeIndex ? updater(ticketType) : ticketType,
      ),
    });
  }

  function updateQuestion(
    ticketTypeIndex: number,
    questionIndex: number,
    updater: (question: TicketQuestion) => TicketQuestion,
  ) {
    updateTicketType(ticketTypeIndex, (ticketType) => ({
      ...ticketType,
      questions: ticketType.questions.map((question, index) =>
        index === questionIndex ? updater(question) : question,
      ),
    }));
  }

  function getTicketTypeUiKey(ticketTypeIndex: number): string {
    return uiState.ticketTypeKeys[ticketTypeIndex] ?? `ticket-type-fallback-${ticketTypeIndex}`;
  }

  function addTicketType() {
    const nextTicketType = createEmptyTicketType(value.ticketTypes.length);
    const nextKey = createUiKey("ticket-type");
    onChange({
      ...value,
      ticketTypes: [...value.ticketTypes, nextTicketType],
    });
    setUiState((current) => ({
      ...current,
      ticketTypeKeys: [...current.ticketTypeKeys, nextKey],
      questionKeys: [...current.questionKeys, []],
      openTicketTypes: new Set(current.openTicketTypes).add(nextKey),
    }));
  }

  function addQuestion(ticketTypeIndex: number) {
    const currentTicketType = value.ticketTypes[ticketTypeIndex];
    const nextQuestion = createEmptyTicketQuestion(currentTicketType.questions.length);
    const nextQuestionKey = createUiKey("ticket-question");
    updateTicketType(ticketTypeIndex, (current) => ({
      ...current,
      questions: [...current.questions, nextQuestion],
    }));
    setUiState((current) => ({
      ...current,
      questionKeys: current.questionKeys.map((questionKeys, index) =>
        index === ticketTypeIndex ? [...questionKeys, nextQuestionKey] : questionKeys,
      ),
      openQuestions: new Set(current.openQuestions).add(nextQuestionKey),
    }));
  }

  function moveTicketType(ticketTypeIndex: number, direction: -1 | 1) {
    const nextTicketTypes = moveArrayItem(value.ticketTypes, ticketTypeIndex, direction);
    setUiState((current) => ({
      ...current,
      ticketTypeKeys: moveArrayItem(current.ticketTypeKeys, ticketTypeIndex, direction),
      questionKeys: moveArrayItem(current.questionKeys, ticketTypeIndex, direction),
    }));
    onChange({ ...value, ticketTypes: nextTicketTypes });
  }

  function moveQuestion(ticketTypeIndex: number, questionIndex: number, direction: -1 | 1) {
    setUiState((current) => ({
      ...current,
      questionKeys: current.questionKeys.map((questionKeys, index) =>
        index === ticketTypeIndex
          ? moveArrayItem(questionKeys, questionIndex, direction)
          : questionKeys,
      ),
    }));
    updateTicketType(ticketTypeIndex, (current) => ({
      ...current,
      questions: moveArrayItem(current.questions, questionIndex, direction),
    }));
  }

  function setTicketTypeOpen(key: string, open: boolean) {
    setUiState((current) => {
      const next = new Set(current.openTicketTypes);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return { ...current, openTicketTypes: next };
    });
  }

  function setQuestionOpen(key: string, open: boolean) {
    setUiState((current) => {
      const next = new Set(current.openQuestions);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return { ...current, openQuestions: next };
    });
  }

  return (
    <div className="space-y-6">
      {tab === "panel" && (
        <>
          <EditorPanel>
            <SectionHeader
              title="Panel Settings"
              description="Configure where the panel is posted and how it looks."
            />
            <div className="grid gap-3 md:grid-cols-3">
              <FormField
                label="Panel channel"
                htmlFor="tp-panel-channel"
                required
                hint="Channel where members see the ticket panel and click buttons to open tickets."
                error={
                  saveAttempted && !value.panelChannelId.trim()
                    ? "Select the channel where the ticket panel should be posted."
                    : undefined
                }
              >
                <Select
                  value={value.panelChannelId}
                  onValueChange={(v) => onChange({ ...value, panelChannelId: v })}
                >
                  <SelectTrigger id="tp-panel-channel" size="sm">
                    <SelectValue placeholder="Select a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {value.panelChannelId &&
                      !guildResources.textChannels.find((c) => c.id === value.panelChannelId) && (
                        <SelectItem value={value.panelChannelId}>{value.panelChannelId}</SelectItem>
                      )}
                    {guildResources.textChannels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {panelChannelName && panelChannelName !== value.panelChannelId && (
                  <p className="truncate text-xs text-muted-foreground">#{panelChannelName}</p>
                )}
              </FormField>

              <FormField
                label="Ticket category"
                htmlFor="tp-category"
                required
                hint="Discord category where new private ticket channels are created."
                error={
                  saveAttempted && !value.categoryChannelId.trim()
                    ? "Select the category where ticket channels should be created."
                    : undefined
                }
              >
                <Select
                  value={value.categoryChannelId}
                  onValueChange={(v) => onChange({ ...value, categoryChannelId: v })}
                >
                  <SelectTrigger id="tp-category" size="sm">
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {value.categoryChannelId &&
                      !guildResources.categories.find((c) => c.id === value.categoryChannelId) && (
                        <SelectItem value={value.categoryChannelId}>
                          {value.categoryChannelId}
                        </SelectItem>
                      )}
                    {guildResources.categories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {categoryName && categoryName !== value.categoryChannelId && (
                  <p className="truncate text-xs text-muted-foreground">{categoryName}</p>
                )}
              </FormField>

              <FormField
                label="Transcript channel"
                htmlFor="tp-transcript"
                required
                hint="Channel where closed ticket transcripts are posted for staff review."
                error={
                  saveAttempted && !value.transcriptChannelId.trim()
                    ? "Select the channel where ticket transcripts should be posted."
                    : undefined
                }
              >
                <Select
                  value={value.transcriptChannelId}
                  onValueChange={(v) => onChange({ ...value, transcriptChannelId: v })}
                >
                  <SelectTrigger id="tp-transcript" size="sm">
                    <SelectValue placeholder="Select a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {value.transcriptChannelId &&
                      !guildResources.textChannels.find(
                        (c) => c.id === value.transcriptChannelId,
                      ) && (
                        <SelectItem value={value.transcriptChannelId}>
                          {value.transcriptChannelId}
                        </SelectItem>
                      )}
                    {guildResources.textChannels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {transcriptName && transcriptName !== value.transcriptChannelId && (
                  <p className="truncate text-xs text-muted-foreground">#{transcriptName}</p>
                )}
              </FormField>
            </div>
          </EditorPanel>

          <EditorPanel>
            <SectionHeader
              title="Panel Content"
              description="Customize the message members see before they open a ticket."
            />
            <div className="grid gap-3 md:grid-cols-3">
              <FormField label="Embed emoji" htmlFor="tp-panel-emoji">
                <EmojiPicker
                  emojis={guildResources.emojis ?? []}
                  selectedValue={value.panelEmoji}
                  onSelect={(selection) =>
                    onChange({
                      ...value,
                      panelEmoji: selection.value,
                    })
                  }
                />
              </FormField>

              <div className="md:col-span-2">
                <FormField label="Panel title" htmlFor="tp-panel-title">
                  <Input
                    id="tp-panel-title"
                    value={value.panelTitle ?? ""}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        panelTitle:
                          event.target.value.trim().length > 0 ? event.target.value : null,
                      })
                    }
                    placeholder="Support tickets"
                  />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="Panel description" htmlFor="tp-panel-description">
                  <MarkdownEditor
                    id="tp-panel-description"
                    flavor="full"
                    rows={6}
                    value={value.panelDescription ?? ""}
                    onChange={(next) =>
                      onChange({
                        ...value,
                        panelDescription: next.trim().length > 0 ? next : null,
                      })
                    }
                    placeholder="Tell members when to use this panel and what happens after they open a ticket."
                    helpText="Supports Discord markdown: headings, lists, quotes, links, spoilers, code, and more."
                  />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="Panel footer" htmlFor="tp-panel-footer">
                  <Input
                    id="tp-panel-footer"
                    className="h-9"
                    value={value.panelFooter ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        panelFooter: e.target.value.trim().length > 0 ? e.target.value : null,
                      })
                    }
                    placeholder="Optional footer text shown under the panel embed"
                  />
                </FormField>
                <p className="text-[11px] text-muted-foreground">
                  Discord renders the embed footer as plain text.
                </p>
              </div>
              <div className="md:col-span-3">
                <FormField label="Embed colour" htmlFor="tp-panel-color">
                  <ColorInput
                    id="tp-panel-color"
                    value={value.panelColor ?? 0x57f287}
                    onChange={(panelColor) => onChange({ ...value, panelColor })}
                  />
                </FormField>
              </div>
            </div>
          </EditorPanel>

          <TicketPanelPreview value={value} />
        </>
      )}

      {tab === "rules" && (
        <EditorPanel>
          <SectionHeader
            title="Ticket Rules"
            description="Limit open tickets per member and decide whether support staff can claim tickets."
          />
          <AdvancedSection
            title="Advanced ticket rules"
            description="Ticket claiming, AI transcript summaries, and per-member ticket creation limits."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border bg-background p-3">
                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
                  <span>Enable ticket claiming</span>
                  <Switch
                    checked={value.enableTicketClaiming}
                    loading={autoSaveToggleStatus?.savingKey === "enableTicketClaiming"}
                    success={autoSaveToggleStatus?.savedKey === "enableTicketClaiming"}
                    onCheckedChange={(checked) =>
                      onAutoSaveToggle
                        ? onAutoSaveToggle("enableTicketClaiming", checked === true)
                        : onChange({ ...value, enableTicketClaiming: checked === true })
                    }
                  />
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  Adds claim controls to ticket channels for members with the support role.
                </p>
              </div>
              <div className="rounded-md border bg-background p-3">
                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
                  <span>AI transcript summaries</span>
                  <Switch
                    checked={value.aiTranscriptSummariesEnabled ?? false}
                    disabled={!paidAutomationAvailable}
                    loading={autoSaveToggleStatus?.savingKey === "aiTranscriptSummariesEnabled"}
                    success={autoSaveToggleStatus?.savedKey === "aiTranscriptSummariesEnabled"}
                    onCheckedChange={(checked) =>
                      onAutoSaveToggle
                        ? onAutoSaveToggle("aiTranscriptSummariesEnabled", checked === true)
                        : onChange({ ...value, aiTranscriptSummariesEnabled: checked === true })
                    }
                  />
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  {paidAutomationAvailable
                    ? "When enabled, closed ticket content is sent to HAF's configured AI provider to generate a summary and searchable keywords for the transcript embed. Failures omit the summary."
                    : "AI Transcript Summary requires a paid plan. Retained settings resume after upgrading."}
                </p>
              </div>
              {paidAutomationAvailable ? (
                <>
                  <FormField
                    label="Ticket creation limit"
                    htmlFor="tp-ticket-creation-limit"
                    error={ticketCreationLimitError ?? undefined}
                  >
                    <PresetNumberInput
                      id="tp-ticket-creation-limit"
                      min={1}
                      max={50}
                      value={
                        value.ticketCreationLimit === null ? "" : String(value.ticketCreationLimit)
                      }
                      presets={[
                        { label: "1", value: "1" },
                        { label: "3", value: "3" },
                        { label: "5", value: "5" },
                        { label: "Unlimited", value: "" },
                      ]}
                      onChange={(nextValue) => {
                        const next = nextValue.trim();
                        onChange({
                          ...value,
                          ticketCreationLimit: next.length === 0 ? null : Number(next),
                        });
                      }}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave empty for unlimited. Max 50.
                    </p>
                  </FormField>
                  {value.ticketCreationLimit !== null ? (
                    <div className="md:col-span-2">
                      <FormField label="Limit rejection message" htmlFor="tp-ticket-limit-message">
                        <MarkdownEditor
                          id="tp-ticket-limit-message"
                          flavor="full"
                          rows={3}
                          value={value.ticketLimitRejectionMessage ?? ""}
                          onChange={(next) =>
                            onChange({
                              ...value,
                              ticketLimitRejectionMessage: next.trim().length > 0 ? next : null,
                            })
                          }
                          placeholder="You already have too many open tickets. Please close an existing ticket first."
                          helpText="Shown ephemerally when a member hits the ticket creation limit."
                        />
                      </FormField>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-md border bg-background p-3 text-sm md:col-span-2">
                  <p className="font-medium">One open ticket per member</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Free uses a fixed limit and standard rejection message. Custom limits and
                    messages require a paid plan.
                  </p>
                </div>
              )}
            </div>
          </AdvancedSection>
        </EditorPanel>
      )}

      {tab === "types" && (
        <EditorPanel>
          <SectionHeader
            title="Ticket Types"
            description={`${value.ticketTypes.length} configured. Open one type at a time when you need the details.`}
          />
          <div className="flex flex-wrap gap-2">
            {value.ticketTypes.length > 0 ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setUiState((current) => ({
                      ...current,
                      openTicketTypes: new Set(current.ticketTypeKeys),
                    }))
                  }
                >
                  Expand all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setUiState((current) => ({ ...current, openTicketTypes: new Set() }))
                  }
                >
                  Collapse all
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="grow sm:grow-0"
              disabled={ticketTypeLimitReached}
              title={
                ticketTypeLimitReached ? "Free supports one Ticket Type per panel." : undefined
              }
              onClick={addTicketType}
            >
              Add ticket type
            </Button>
          </div>

          {value.ticketTypes.length === 0 ? (
            <p className="rounded-md border border-dashed bg-background px-3 py-4 text-sm text-muted-foreground">
              Add at least one ticket type so members can open tickets from the dashboard.
            </p>
          ) : (
            <div className="space-y-2">
              {value.ticketTypes.map((ticketType, ticketTypeIndex) => {
                const supportRoleName = resolveName(guildResources.roles, ticketType.supportRoleId);
                const ticketTypeKey = getTicketTypeUiKey(ticketTypeIndex);
                const ticketTypeOpen = uiState.openTicketTypes.has(ticketTypeKey);
                const openCustomId = buildTicketOpenCustomId(
                  ticketType.id,
                  value.panelId ?? "main",
                );
                const ticketTypeIdMaxLength = ticketTypeOpenCustomIdMaxLength(value.panelId);

                return (
                  <details
                    key={ticketTypeKey}
                    className="group rounded-md border bg-background"
                    open={ticketTypeOpen}
                    onToggle={(event) => setTicketTypeOpen(ticketTypeKey, event.currentTarget.open)}
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:hidden">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {ticketType.label || `Ticket Type ${ticketTypeIndex + 1}`}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {supportRoleName ? `Role: ${supportRoleName}` : "No support role"} ·{" "}
                          {ticketType.questions.length} question
                          {ticketType.questions.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs font-medium text-muted-foreground group-open:hidden">
                        Open
                      </span>
                      <span className="hidden shrink-0 text-xs font-medium text-muted-foreground group-open:inline">
                        Close
                      </span>
                    </summary>

                    <div className="space-y-3 border-t p-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Move ${ticketType.label || `Ticket Type ${ticketTypeIndex + 1}`} up`}
                          disabled={ticketTypeIndex === 0}
                          onClick={() => moveTicketType(ticketTypeIndex, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Move ${ticketType.label || `Ticket Type ${ticketTypeIndex + 1}`} down`}
                          disabled={ticketTypeIndex === value.ticketTypes.length - 1}
                          onClick={() => moveTicketType(ticketTypeIndex, 1)}
                        >
                          Move down
                        </Button>
                        <ConfigurationAvailabilityActions
                          label={ticketType.label || `Ticket Type ${ticketTypeIndex + 1}`}
                          enabled={ticketType.enabled !== false}
                          description="Save to stop new tickets. Existing tickets and settings are kept."
                          onEnabledChange={(enabled) =>
                            onChange({
                              ...value,
                              ticketTypes: value.ticketTypes.map((type, index) =>
                                index === ticketTypeIndex ? { ...type, enabled } : type,
                              ),
                            })
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setUiState((current) => {
                              const openTicketTypes = new Set(current.openTicketTypes);
                              openTicketTypes.delete(ticketTypeKey);

                              const openQuestions = new Set(current.openQuestions);
                              for (const questionKey of current.questionKeys[ticketTypeIndex] ??
                                []) {
                                openQuestions.delete(questionKey);
                              }

                              return {
                                ...current,
                                ticketTypeKeys: current.ticketTypeKeys.filter(
                                  (_, index) => index !== ticketTypeIndex,
                                ),
                                questionKeys: current.questionKeys.filter(
                                  (_, index) => index !== ticketTypeIndex,
                                ),
                                openTicketTypes,
                                openQuestions,
                              };
                            });

                            onChange({
                              ...value,
                              ticketTypes: value.ticketTypes.filter(
                                (_, index) => index !== ticketTypeIndex,
                              ),
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        <FormField
                          label="Ticket type label"
                          htmlFor={`tp-ticket-label-${ticketTypeIndex}`}
                          required
                          hint="Button label members click, such as Appeal, Bug report, or General support."
                          error={
                            ticketType.label.length > DISCORD_MODAL_LABEL_MAX_LENGTH
                              ? `Ticket Type label must be ${DISCORD_MODAL_LABEL_MAX_LENGTH} characters or fewer.`
                              : saveAttempted && !ticketType.label.trim()
                                ? "Enter the label members should see for this ticket type."
                                : undefined
                          }
                        >
                          <div className="space-y-1">
                            <Input
                              id={`tp-ticket-label-${ticketTypeIndex}`}
                              className="h-9"
                              value={ticketType.label}
                              maxLength={DISCORD_MODAL_LABEL_MAX_LENGTH}
                              onChange={(e) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  label: e.target.value,
                                }))
                              }
                              placeholder="Appeal"
                            />
                            <p className="text-right text-xs text-muted-foreground">
                              {ticketType.label.length} / {DISCORD_MODAL_LABEL_MAX_LENGTH}{" "}
                              characters
                            </p>
                          </div>
                        </FormField>
                        <FormField
                          label="Internal ID"
                          htmlFor={`tp-ticket-id-${ticketTypeIndex}`}
                          hint="Stable internal key for this ticket type. Members do not see this."
                          error={
                            openCustomId.length > DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH
                              ? `Ticket Type open custom ID must be ${DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH} characters or fewer.`
                              : undefined
                          }
                        >
                          <div className="space-y-1">
                            <Input
                              id={`tp-ticket-id-${ticketTypeIndex}`}
                              className="h-9"
                              value={ticketType.id}
                              maxLength={ticketTypeIdMaxLength}
                              onChange={(e) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  id: e.target.value,
                                }))
                              }
                              placeholder="appeals"
                            />
                            <p className="text-right text-xs text-muted-foreground">
                              {openCustomId.length} / {DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH}{" "}
                              characters
                            </p>
                          </div>
                        </FormField>
                        <FormField
                          label="Channel prefix"
                          htmlFor={`tp-ticket-prefix-${ticketTypeIndex}`}
                          required
                          hint="Prefix used when naming new ticket channels, for example appeal-username."
                          error={
                            saveAttempted && !ticketType.channelNamePrefix.trim()
                              ? "Enter the prefix used for channels created from this ticket type."
                              : undefined
                          }
                        >
                          <Input
                            id={`tp-ticket-prefix-${ticketTypeIndex}`}
                            className="h-9"
                            value={ticketType.channelNamePrefix}
                            onChange={(e) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                channelNamePrefix: e.target.value,
                              }))
                            }
                            placeholder="appeal"
                          />
                        </FormField>
                        <FormField label="Emoji" htmlFor={`tp-ticket-emoji-${ticketTypeIndex}`}>
                          <EmojiPicker
                            emojis={guildResources.emojis ?? []}
                            selectedValue={ticketType.emoji}
                            onSelect={(selection) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                emoji: selection.value,
                              }))
                            }
                          />
                        </FormField>
                        <FormField
                          label="Button style"
                          htmlFor={`tp-ticket-style-${ticketTypeIndex}`}
                        >
                          <Select
                            value={ticketType.buttonStyle}
                            onValueChange={(v) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                buttonStyle: v as TicketTypeConfig["buttonStyle"],
                              }))
                            }
                          >
                            <SelectTrigger id={`tp-ticket-style-${ticketTypeIndex}`} size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="primary">Primary</SelectItem>
                              <SelectItem value="secondary">Secondary</SelectItem>
                              <SelectItem value="success">Success</SelectItem>
                              <SelectItem value="danger">Danger</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormField>
                        <FormField
                          label="Support role"
                          htmlFor={`tp-ticket-support-role-${ticketTypeIndex}`}
                          required
                          hint="Staff role that can see and manage tickets of this type."
                          error={
                            saveAttempted && !ticketType.supportRoleId.trim()
                              ? "Select the support role for this ticket type."
                              : undefined
                          }
                        >
                          <Select
                            value={ticketType.supportRoleId}
                            onValueChange={(v) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                supportRoleId: v,
                              }))
                            }
                          >
                            <SelectTrigger
                              id={`tp-ticket-support-role-${ticketTypeIndex}`}
                              size="sm"
                            >
                              <SelectValue placeholder="Select a role" />
                            </SelectTrigger>
                            <SelectContent>
                              {ticketType.supportRoleId &&
                                !guildResources.roles.find(
                                  (role) => role.id === ticketType.supportRoleId,
                                ) && (
                                  <SelectItem value={ticketType.supportRoleId}>
                                    {ticketType.supportRoleId}
                                  </SelectItem>
                                )}
                              {guildResources.roles.map((role) => (
                                <SelectItem key={role.id} value={role.id}>
                                  {role.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormField>
                        {!paidAutomationAvailable ? (
                          <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground md:col-span-3">
                            Creator role restrictions and Ticket Response Rules require a paid plan.
                            Retained settings are visible but dormant on Free.
                          </p>
                        ) : null}
                        <FormField
                          label="Default link reminder platform"
                          htmlFor={`tp-ticket-default-link-platform-${ticketTypeIndex}`}
                        >
                          <Select
                            value={ticketType.defaultTicketLinkPlatform ?? "none"}
                            disabled={!paidAutomationAvailable}
                            onValueChange={(v) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                defaultTicketLinkPlatform:
                                  v === "none"
                                    ? null
                                    : (v as NonNullable<
                                        TicketTypeConfig["defaultTicketLinkPlatform"]
                                      >),
                              }))
                            }
                          >
                            <SelectTrigger
                              id={`tp-ticket-default-link-platform-${ticketTypeIndex}`}
                              size="sm"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No default</SelectItem>
                              {configuredTicketLinkPlatforms.map((platform) => (
                                <SelectItem key={platform} value={platform}>
                                  {formatTicketLinkPlatform(platform)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormField>
                        <FormField
                          label="Allowed creator roles"
                          htmlFor={`tp-ticket-allowed-creator-roles-${ticketTypeIndex}`}
                          hint="Optional. If selected, only members with one of these roles can create this ticket type."
                        >
                          <MultiRoleSelect
                            id={`tp-ticket-allowed-creator-roles-${ticketTypeIndex}`}
                            roles={guildResources.roles}
                            value={ticketType.allowedCreatorRoleIds ?? []}
                            disabled={!paidAutomationAvailable}
                            onChange={(roleIds) =>
                              updateTicketType(ticketTypeIndex, (current) => ({
                                ...current,
                                allowedCreatorRoleIds: roleIds,
                              }))
                            }
                          />
                        </FormField>
                        <TicketResponseRuleEditor
                          ticketTypeIndex={ticketTypeIndex}
                          ticketType={ticketType}
                          roles={guildResources.roles}
                          configuredPlatforms={configuredTicketLinkPlatforms}
                          disabled={!paidAutomationAvailable}
                          onChange={(next) => updateTicketType(ticketTypeIndex, () => next)}
                        />
                        <div className="space-y-2 md:col-span-3">
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                            <Checkbox
                              checked={ticketType.mentionSupportRole === true}
                              onCheckedChange={(checked) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  mentionSupportRole: checked === true,
                                }))
                              }
                            />
                            Mention support role on ticket creation
                          </label>
                          <p className="text-xs text-muted-foreground">
                            Ping the configured support role in the new ticket's opening message.
                          </p>
                        </div>
                        <div className="space-y-2 md:col-span-3">
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                            <Checkbox
                              checked={ticketType.participantManagementEnabled === true}
                              onCheckedChange={(checked) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  participantManagementEnabled: checked === true,
                                }))
                              }
                            />
                            Allow staff to add participants
                          </label>
                          <p className="text-xs text-muted-foreground">
                            Invited participants can see the Ticket opener, existing Ticket history,
                            attachments, and future participant messages. HAF does not identify the
                            staff member who initiated the invitation.
                          </p>
                        </div>
                        <div className="space-y-2 md:col-span-3">
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                            <Checkbox
                              checked={ticketType.anonymousSupportEnabled ?? false}
                              disabled={!paidAutomationAvailable}
                              onCheckedChange={(checked) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  anonymousSupportEnabled: checked === true,
                                }))
                              }
                            />
                            Anonymous support
                          </label>
                          <p className="text-xs text-muted-foreground">
                            {paidAutomationAvailable
                              ? "Hide support staff identities from the ticket opener. Staff messages are proxied through the bot."
                              : "Anonymous tickets require a paid plan."}
                          </p>
                        </div>
                        <div className="space-y-2 md:col-span-3">
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                            <Checkbox
                              checked={ticketType.staffDiscussionThreadEnabled ?? false}
                              disabled={!paidAutomationAvailable}
                              onCheckedChange={(checked) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  staffDiscussionThreadEnabled: checked === true,
                                  ticketHistoryPromptVisibility:
                                    checked === true
                                      ? (current.ticketHistoryPromptVisibility ?? "off")
                                      : "off",
                                }))
                              }
                            />
                            Staff Discussion Thread
                          </label>
                          <p className="text-xs text-muted-foreground">
                            Create a private staff coordination thread. Normal messages remain
                            internal; Anonymous Support uses explicit publishing.
                          </p>
                        </div>
                        <div className="md:col-span-3">
                          <FormField
                            label="Ticket History Prompt"
                            htmlFor={`tp-ticket-history-prompt-${ticketTypeIndex}`}
                          >
                            <Select
                              value={ticketType.ticketHistoryPromptVisibility ?? "off"}
                              disabled={
                                !paidAutomationAvailable ||
                                !(ticketType.staffDiscussionThreadEnabled ?? false)
                              }
                              onValueChange={(value) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  ticketHistoryPromptVisibility: value as "off" | "staff-thread",
                                }))
                              }
                            >
                              <SelectTrigger
                                id={`tp-ticket-history-prompt-${ticketTypeIndex}`}
                                size="sm"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="off">Off</SelectItem>
                                <SelectItem value="staff-thread">Staff thread</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormField>
                        </div>
                        <div className="space-y-2 md:col-span-3">
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                            <Checkbox
                              checked={ticketType.limitExclusion}
                              disabled={!paidAutomationAvailable}
                              onCheckedChange={(checked) =>
                                updateTicketType(ticketTypeIndex, (current) => ({
                                  ...current,
                                  limitExclusion: checked === true,
                                }))
                              }
                            />
                            Exclude from ticket creation limit
                          </label>
                          <p className="text-xs text-muted-foreground">
                            {paidAutomationAvailable
                              ? "Use for workflows that should never be blocked by the per-member limit."
                              : "Ticket Type Limit Exclusion requires a paid plan."}
                          </p>
                        </div>
                      </div>

                      <TicketQuestionList
                        ticketTypeIndex={ticketTypeIndex}
                        questions={ticketType.questions}
                        questionKeys={uiState.questionKeys[ticketTypeIndex] ?? []}
                        openQuestions={uiState.openQuestions}
                        onAdd={() => addQuestion(ticketTypeIndex)}
                        onOpenChange={setQuestionOpen}
                        onMove={(questionIndex, direction) =>
                          moveQuestion(ticketTypeIndex, questionIndex, direction)
                        }
                        onUpdate={(questionIndex, updater) =>
                          updateQuestion(ticketTypeIndex, questionIndex, updater)
                        }
                        onRemove={(questionIndex, questionKey) => {
                          setUiState((current) => {
                            const openQuestions = new Set(current.openQuestions);
                            openQuestions.delete(questionKey);
                            return {
                              ...current,
                              questionKeys: current.questionKeys.map((keys, index) =>
                                index === ticketTypeIndex
                                  ? keys.filter((_, index) => index !== questionIndex)
                                  : keys,
                              ),
                              openQuestions,
                            };
                          });
                          updateTicketType(ticketTypeIndex, (current) => ({
                            ...current,
                            questions: current.questions.filter(
                              (_, index) => index !== questionIndex,
                            ),
                          }));
                        }}
                      />
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </EditorPanel>
      )}
    </div>
  );
}
