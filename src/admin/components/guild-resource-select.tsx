import { transitionResourceCreation } from "../lib/resource-creation-workflow";
import type { ReactNode } from "react";
import { lazy, Suspense, useId, useReducer, useState } from "react";
import type { SetupPreview, SetupResource, SetupRun } from "../../feature-setup";
import {
  DISCORD_RESOURCE_NAME_MAX_LENGTH,
  discordResourceNameLength,
} from "../../discord/resource-name";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { useMediaQuery } from "../hooks/use-media-query";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { ChevronDownIcon, PlusIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const ResourceSelectCommand = lazy(() => import("./resource-select-command"));

const ResourceNameEmojiPicker = lazy(() =>
  import("./emoji-picker").then((module) => ({ default: module.EmojiPicker })),
);

interface ResourceOption {
  id: string;
  name: string;
}

type ResourceKind = "channel" | "role";

export function formatDiscordResourceOption(
  kind: ResourceKind,
  option: ResourceOption,
  unavailable = false,
): string {
  if (unavailable) return `Unavailable ${kind} · ${option.id}`;
  return `${kind === "channel" ? "#" : "@"}${option.name}`;
}

export function getMissingDiscordResourceWarning(
  kind: ResourceKind,
  count: number,
  multiple: boolean,
): string | null {
  if (count <= 0) return null;
  if (!multiple) {
    return `The selected ${kind} no longer exists in Discord. Choose another ${kind} and save your changes.`;
  }
  if (count === 1) {
    return `1 selected ${kind} no longer exists in Discord. Remove or replace it before saving.`;
  }
  return `${count} selected ${kind}s no longer exist in Discord. Remove or replace them before saving.`;
}

export interface ResourceCreationProps {
  guildId: string;
  workspaceId?: string;
  surfaceKey: string;
  dependencyKey: string;
  label: string;
  recommendedName: string;
  accessRoleIds?: string[];
  accessChannelIds?: string[];
}

interface MultiChannelSelectProps {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  channels: ResourceOption[];
  disabled?: boolean;
  allowSelectAll?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  creation?: ResourceCreationProps;
}

interface MultiRoleSelectProps {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  roles: ResourceOption[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  creation?: ResourceCreationProps;
}

export interface RoleSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  roles: ResourceOption[];
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  creation?: ResourceCreationProps;
}

export function RoleSelect({
  roles,
  id,
  value,
  onChange,
  placeholder,
  allowClear = false,
  disabled,
  className,
  creation,
  "aria-describedby": ariaDescribedBy,
  ...accessibleNameProps
}: RoleSelectProps) {
  const warningId = useId();
  const creationScope = resourceCreationScope(creation);
  const [createdState, setCreatedState] = useState<CreatedResourceState | null>(null);
  const created = createdState?.scope === creationScope ? createdState.resource : null;
  const options =
    created && !roles.some((role) => role.id === created.id) ? [...roles, created] : roles;
  const selected = options.find((option) => option.id === value);
  const unavailable = Boolean(value && !selected);
  const selectedLabel = value
    ? formatDiscordResourceOption("role", selected ?? { id: value, name: value }, unavailable)
    : undefined;

  return (
    <ResourceSelectWithCreation
      creation={creation}
      disabled={disabled}
      onResolved={(resource) => {
        setCreatedState({ scope: creationScope, resource });
        onChange(resource.id);
      }}
    >
      <div className="space-y-1.5">
        <Select
          value={value}
          onValueChange={(next) => onChange(next === "none" && allowClear ? "" : next)}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            className={className}
            aria-describedby={joinDescriptionIds(
              ariaDescribedBy,
              unavailable ? warningId : undefined,
            )}
            {...accessibleNameProps}
          >
            <SelectValue placeholder={placeholder ?? "Select a role"}>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {allowClear ? <SelectItem value="none">None</SelectItem> : null}
            {unavailable ? (
              <SelectItem value={value}>
                {formatDiscordResourceOption("role", { id: value, name: value }, true)}
              </SelectItem>
            ) : null}
            {options.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                {formatDiscordResourceOption("role", role)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MissingResourceWarning id={warningId} kind="role" count={unavailable ? 1 : 0} />
      </div>
    </ResourceSelectWithCreation>
  );
}

export interface ChannelSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  channels: ResourceOption[];
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  creation?: ResourceCreationProps;
}

export function ChannelSelect({
  channels,
  id,
  value,
  onChange,
  placeholder,
  allowClear = false,
  disabled,
  className,
  creation,
  "aria-describedby": ariaDescribedBy,
  ...accessibleNameProps
}: ChannelSelectProps) {
  const warningId = useId();
  const creationScope = resourceCreationScope(creation);
  const [createdState, setCreatedState] = useState<CreatedResourceState | null>(null);
  const created = createdState?.scope === creationScope ? createdState.resource : null;
  const options =
    created && !channels.some((channel) => channel.id === created.id)
      ? [...channels, created]
      : channels;
  const selected = options.find((option) => option.id === value);
  const unavailable = Boolean(value && !selected);
  const selectedLabel = value
    ? formatDiscordResourceOption("channel", selected ?? { id: value, name: value }, unavailable)
    : undefined;

  return (
    <ResourceSelectWithCreation
      creation={creation}
      disabled={disabled}
      onResolved={(resource) => {
        setCreatedState({ scope: creationScope, resource });
        onChange(resource.id);
      }}
    >
      <div className="space-y-1.5">
        <Select
          value={value}
          onValueChange={(next) => onChange(next === "none" && allowClear ? "" : next)}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            className={className}
            aria-describedby={joinDescriptionIds(
              ariaDescribedBy,
              unavailable ? warningId : undefined,
            )}
            {...accessibleNameProps}
          >
            <SelectValue placeholder={placeholder ?? "Select a channel"}>
              {selectedLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {allowClear ? <SelectItem value="none">None</SelectItem> : null}
            {unavailable ? (
              <SelectItem value={value}>
                {formatDiscordResourceOption("channel", { id: value, name: value }, true)}
              </SelectItem>
            ) : null}
            {options.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {formatDiscordResourceOption("channel", channel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MissingResourceWarning id={warningId} kind="channel" count={unavailable ? 1 : 0} />
      </div>
    </ResourceSelectWithCreation>
  );
}

export function MultiChannelSelect({
  id,
  value,
  onChange,
  channels,
  disabled,
  allowSelectAll = true,
  className,
  creation,
  "aria-describedby": ariaDescribedBy,
  ...accessibleNameProps
}: MultiChannelSelectProps) {
  const warningId = useId();
  const creationScope = resourceCreationScope(creation);
  const [createdState, setCreatedState] = useState<CreatedResourceState | null>(null);
  const created = createdState?.scope === creationScope ? createdState.resource : null;
  const availableOptions =
    created && !channels.some((channel) => channel.id === created.id)
      ? [...channels, created]
      : channels;
  const unavailableValues = value.filter(
    (channelId) => !availableOptions.some((channel) => channel.id === channelId),
  );
  const unavailableIds = new Set(unavailableValues);
  const options = [
    ...unavailableValues.map((channelId) => ({ id: channelId, name: channelId })),
    ...availableOptions,
  ];

  return (
    <ResourceSelectWithCreation
      creation={creation}
      disabled={disabled}
      onResolved={(resource) => {
        setCreatedState({ scope: creationScope, resource });
        if (!value.includes(resource.id)) onChange([...value, resource.id]);
      }}
    >
      <div className={cn("space-y-1.5", className)}>
        <MultiResourceCombobox
          id={id}
          value={value}
          onChange={onChange}
          options={options}
          disabled={disabled}
          allowSelectAll={allowSelectAll}
          placeholder="Select channels"
          searchPlaceholder="Search channels..."
          emptyMessage="No text channels found."
          formatOptionLabel={(channel) =>
            formatDiscordResourceOption("channel", channel, unavailableIds.has(channel.id))
          }
          aria-describedby={joinDescriptionIds(
            ariaDescribedBy,
            unavailableValues.length > 0 ? warningId : undefined,
          )}
          {...accessibleNameProps}
        />
        <MissingResourceWarning
          id={warningId}
          kind="channel"
          count={unavailableValues.length}
          multiple
        />
      </div>
    </ResourceSelectWithCreation>
  );
}

export function MultiRoleSelect({
  id,
  value,
  onChange,
  roles,
  disabled,
  className,
  creation,
  "aria-describedby": ariaDescribedBy,
  ...accessibleNameProps
}: MultiRoleSelectProps) {
  const warningId = useId();
  const creationScope = resourceCreationScope(creation);
  const [createdState, setCreatedState] = useState<CreatedResourceState | null>(null);
  const created = createdState?.scope === creationScope ? createdState.resource : null;
  const availableOptions =
    created && !roles.some((role) => role.id === created.id) ? [...roles, created] : roles;
  const unavailableValues = value.filter(
    (roleId) => !availableOptions.some((role) => role.id === roleId),
  );
  const unavailableIds = new Set(unavailableValues);
  const options = [
    ...unavailableValues.map((roleId) => ({ id: roleId, name: roleId })),
    ...availableOptions,
  ];

  return (
    <ResourceSelectWithCreation
      creation={creation}
      disabled={disabled}
      onResolved={(resource) => {
        setCreatedState({ scope: creationScope, resource });
        if (!value.includes(resource.id)) onChange([...value, resource.id]);
      }}
    >
      <div className={cn("space-y-1.5", className)}>
        <MultiResourceCombobox
          id={id}
          value={value}
          onChange={onChange}
          options={options}
          disabled={disabled}
          placeholder="Select roles"
          searchPlaceholder="Search roles..."
          emptyMessage="No roles found."
          formatOptionLabel={(role) =>
            formatDiscordResourceOption("role", role, unavailableIds.has(role.id))
          }
          aria-describedby={joinDescriptionIds(
            ariaDescribedBy,
            unavailableValues.length > 0 ? warningId : undefined,
          )}
          {...accessibleNameProps}
        />
        <MissingResourceWarning
          id={warningId}
          kind="role"
          count={unavailableValues.length}
          multiple
        />
      </div>
    </ResourceSelectWithCreation>
  );
}

function MissingResourceWarning({
  id,
  kind,
  count,
  multiple = false,
}: {
  id: string;
  kind: ResourceKind;
  count: number;
  multiple?: boolean;
}) {
  const warning = getMissingDiscordResourceWarning(kind, count, multiple);
  return warning ? (
    <p id={id} className="px-2 py-1 text-xs text-destructive">
      {warning}
    </p>
  ) : null;
}

function joinDescriptionIds(...ids: Array<string | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

function ResourceSelectWithCreation({
  creation,
  disabled,
  onResolved,
  children,
}: {
  creation?: ResourceCreationProps;
  disabled?: boolean;
  onResolved: (resource: SetupResource) => void;
  children: ReactNode;
}) {
  if (!creation) return children;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <ResourceCreationDialog
        key={resourceCreationScope(creation)}
        creation={creation}
        disabled={disabled}
        onResolved={onResolved}
      />
    </div>
  );
}

interface CreatedResourceState {
  scope: string;
  resource: ResourceOption;
}

function resourceCreationScope(creation: ResourceCreationProps | undefined): string {
  return creation
    ? `${creation.workspaceId ?? ""}:${creation.guildId}:${creation.surfaceKey}:${creation.dependencyKey}`
    : "";
}

function ResourceCreationDialog({
  creation,
  disabled,
  onResolved,
}: {
  creation: ResourceCreationProps;
  disabled?: boolean;
  onResolved: (resource: SetupResource) => void;
}) {
  const inputId = useId();
  const [workflow, send] = useReducer(transitionResourceCreation, {
    kind: "closed",
  });
  const open = workflow.kind !== "closed";
  const preview = "preview" in workflow ? workflow.preview : null;
  const busy = workflow.kind === "previewing" || workflow.kind === "creating";
  const error = "error" in workflow ? workflow.error : null;
  const [name, setName] = useState(creation.recommendedName);

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    send({ type: nextOpen ? "opened" : "closed" });
  }

  async function review() {
    const reviewedName = name.trim();
    const validationError = validateResourceName(reviewedName);
    if (validationError) {
      send({ type: "error-set", error: validationError });
      return;
    }
    if (workflow.kind !== "editing") return;
    send({ type: "preview-started" });
    try {
      const result = await createAdminLoaderClient().postJson<{ preview: SetupPreview }>(
        "/admin/api/feature-resource-setup/preview",
        {
          guildId: creation.guildId,
          surfaceKey: creation.surfaceKey,
          dependencyKey: creation.dependencyKey,
          choice: { action: "create", name: reviewedName },
          accessRoleIds: creation.accessRoleIds ?? [],
          accessChannelIds: creation.accessChannelIds ?? [],
        },
        { workspaceId: creation.workspaceId },
      );
      send({
        type: "preview-created",
        preview: result.preview,
        accessRoleIds: [...(creation.accessRoleIds ?? [])],
        accessChannelIds: [...(creation.accessChannelIds ?? [])],
      });
    } catch (cause) {
      send({
        type: "failed",
        error: formatResourceCreationError(cause, "Could not preview resource creation."),
      });
    }
  }

  async function execute() {
    if (workflow.kind !== "reviewed" || !preview) return;
    const reviewedChoice = preview.dependencies[0]?.choice;
    if (!reviewedChoice || reviewedChoice.action !== "create") return;
    send({ type: "create-started" });
    try {
      const result = await createAdminLoaderClient().postJson<{
        run: SetupRun;
        resource: SetupResource | null;
      }>(
        "/admin/api/feature-resource-setup/execute",
        {
          guildId: creation.guildId,
          surfaceKey: creation.surfaceKey,
          dependencyKey: creation.dependencyKey,
          choice: reviewedChoice,
          confirmationId: preview.confirmationId,
          accessRoleIds: workflow.accessRoleIds,
          accessChannelIds: workflow.accessChannelIds,
        },
        { workspaceId: creation.workspaceId },
      );
      if (result.run.status !== "completed" || !result.resource) {
        throw new Error(result.run.failureMessage ?? "Discord resource creation did not complete.");
      }
      onResolved(result.resource);
      send({ type: "created" });
    } catch (cause) {
      send({
        type: "failed",
        error: formatResourceCreationError(cause, "Could not create the Discord resource."),
      });
    }
  }

  const dependency = preview?.dependencies[0];
  const reviewedName = dependency?.choice.action === "create" ? dependency.choice.name : name;
  const trimmedName = name.trim();
  const nameLength = discordResourceNameLength(trimmedName);
  const nameValidationError = validateResourceName(trimmedName);
  const nameFeedbackId = `${inputId}-feedback`;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="shrink-0"
          disabled={disabled}
          aria-label={`Create ${creation.label}`}
          title={`Create ${creation.label}`}
          data-resource-create-trigger={creation.dependencyKey}
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {preview
              ? `Create ${dependency?.label ?? creation.label}?`
              : `Create ${creation.label}`}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? dependency?.permissionSummary
              : "HAF Bot will create this in Discord and select it here automatically."}
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">Name</span>
            <p className="mt-1 font-medium">{reviewedName}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor={inputId}>
              Name
            </label>
            <div className="flex items-start gap-2">
              <Input
                id={inputId}
                value={name}
                disabled={disabled || busy}
                autoFocus
                aria-describedby={nameFeedbackId}
                aria-invalid={nameLength > DISCORD_RESOURCE_NAME_MAX_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  send({ type: "error-set", error: null });
                }}
              />
              <div className="w-44 shrink-0">
                <Suspense fallback={<span role="status">Loading emoji picker…</span>}>
                  <ResourceNameEmojiPicker
                    emojis={[]}
                    unicodeOnly
                    selectedValue={null}
                    disabled={disabled || busy}
                    onSelect={(selection) => {
                      if (selection.type === "unicode") {
                        setName((current) => `${current}${selection.value}`);
                      }
                    }}
                  />
                </Suspense>
              </div>
            </div>
            <p
              id={nameFeedbackId}
              className={cn(
                "text-xs text-muted-foreground",
                nameLength > DISCORD_RESOURCE_NAME_MAX_LENGTH && "text-destructive",
              )}
            >
              {nameLength} / {DISCORD_RESOURCE_NAME_MAX_LENGTH} characters
              {nameLength > DISCORD_RESOURCE_NAME_MAX_LENGTH && nameValidationError
                ? ` — ${nameValidationError}`
                : ""}
            </p>
          </div>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          {preview ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  send({ type: "back" });
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={busy || disabled}
                loading={busy}
                loadingLabel="Creating…"
                onClick={() => void execute()}
              >
                Confirm and create
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={disabled || busy || Boolean(nameValidationError)}
                loading={busy}
                loadingLabel="Checking…"
                onClick={() => void review()}
              >
                Review creation
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function validateResourceName(name: string): string | null {
  if (!name) return "Enter a name.";
  if (discordResourceNameLength(name) > DISCORD_RESOURCE_NAME_MAX_LENGTH) {
    return `Name must be ${DISCORD_RESOURCE_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

function formatResourceCreationError(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : "";
  if (!message) return fallback;
  if (message.startsWith("Discord API error:")) {
    const details = message.slice("Discord API error:".length).trim();
    try {
      const parsed = JSON.parse(details.slice(details.indexOf("{"))) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // Keep API payloads out of the dialog when Discord returns an unexpected body.
    }
    return "Discord rejected that resource name. Check the name and try again.";
  }
  return message;
}

interface MultiResourceComboboxProps {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  options: ResourceOption[];
  disabled?: boolean;
  allowSelectAll?: boolean;
  className?: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  formatOptionLabel?: (option: ResourceOption) => string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

function MultiResourceCombobox({
  id,
  value,
  onChange,
  options,
  disabled,
  allowSelectAll = true,
  className,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  formatOptionLabel = (option) => option.name,
  ...accessibleNameProps
}: MultiResourceComboboxProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const selected = new Set(value);
  const selectedOptions = value
    .map((selectedId) => options.find((option) => option.id === selectedId))
    .filter((option): option is ResourceOption => Boolean(option));
  const summary = getSelectionSummary(
    selectedOptions,
    value.length,
    placeholder,
    formatOptionLabel,
  );

  function toggle(optionId: string) {
    const next = selected.has(optionId)
      ? value.filter((current) => current !== optionId)
      : [...value, optionId];
    onChange(next);
  }

  function selectAll() {
    onChange(options.map((option) => option.id));
  }

  function clearAll() {
    onChange([]);
  }

  const commandBody = (
    <Suspense fallback={<p role="status">Loading options…</p>}>
      <ResourceSelectCommand
        options={options}
        selected={selected}
        onToggle={toggle}
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        formatOptionLabel={formatOptionLabel}
      >
        <MultiResourceActions
          optionsCount={options.length}
          selectedCount={value.length}
          onSelectAll={selectAll}
          onClearAll={clearAll}
          allowSelectAll={allowSelectAll}
        />
      </ResourceSelectCommand>
    </Suspense>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          {...accessibleNameProps}
          disabled={disabled}
          className={cn("h-auto min-h-10 w-full justify-between px-3 py-2", className)}
        >
          <span className={cn("truncate text-left", value.length === 0 && "text-muted-foreground")}>
            {summary}
          </span>
          <ChevronDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      {isDesktop ? (
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
          {commandBody}
        </PopoverContent>
      ) : (
        <MobileComboboxSheet open={open} onClose={() => setOpen(false)}>
          {commandBody}
        </MobileComboboxSheet>
      )}
    </Popover>
  );
}

export function MultiResourceActions({
  optionsCount,
  selectedCount,
  onSelectAll,
  onClearAll,
  allowSelectAll = true,
}: {
  optionsCount: number;
  selectedCount: number;
  onSelectAll: () => void;
  onClearAll: () => void;
  allowSelectAll?: boolean;
}) {
  if (optionsCount === 0) return null;

  return (
    <div
      className="flex items-center justify-between gap-2 border-b px-2 py-1.5 text-xs"
      data-multi-resource-actions="true"
    >
      <span className="px-1 text-muted-foreground">
        {selectedCount}/{optionsCount} selected
      </span>
      <span className="flex gap-1">
        {allowSelectAll ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={selectedCount === optionsCount}
            onClick={onSelectAll}
          >
            Select all
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={selectedCount === 0}
          onClick={onClearAll}
        >
          Clear all
        </Button>
      </span>
    </div>
  );
}

function MobileComboboxSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center md:hidden"
      data-mobile-combobox-sheet="true"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close options"
        tabIndex={-1}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 max-h-[80vh] w-full overflow-hidden rounded-t-[5px] border bg-popover p-0 text-popover-foreground shadow-lg pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
        <div className="flex items-center justify-center pt-2">
          <span className="h-1.5 w-10 rounded-full bg-muted" aria-hidden="true" />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function getSelectionSummary(
  selectedOptions: ResourceOption[],
  selectedCount: number,
  placeholder: string,
  formatOptionLabel: (option: ResourceOption) => string,
) {
  if (selectedCount === 0) return placeholder;
  if (selectedOptions.length <= 2 && selectedOptions.length === selectedCount) {
    return selectedOptions.map(formatOptionLabel).join(", ");
  }
  return `${selectedCount} selected`;
}
