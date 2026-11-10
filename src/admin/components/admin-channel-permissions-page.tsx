import { useAdminApi } from "../hooks/use-admin-api";
import { useEffect, useRef, useState } from "react";

import {
  applyChannelPermissionCopy,
  getChannelPermissionCopyResources,
  previewChannelPermissionCopy,
  type ChannelPermissionCopyChannel,
  type ChannelPermissionCopyMode,
  type ChannelPermissionCopyPreview,
  type ChannelPermissionCopyResources,
} from "../lib/channel-permission-copy";
import { describeError } from "../lib/api";
import { initialAdminRequest, transitionAdminRequest } from "../lib/request-workflow";
import {
  permissionCopyNeedsRefresh,
  transitionPermissionCopy,
  type PermissionCopyWorkflow,
  type PermissionCopyEvent,
} from "../lib/permission-copy-workflow";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { NoGuildSelected } from "./no-guild-selected";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const CHANNEL_PERMISSION_PREVIEW_SECTION_ORDER = [
  "blockers",
  "warnings",
  "changes",
] as const;

export function AdminChannelPermissionsPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ChannelPermissionCopyResources | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resources, setResources] = useState(initialData ?? null);
  const resourceRequest = useRef(initialAdminRequest);
  const [resourceState, setResourceState] = useState(initialAdminRequest);
  function cancelResourceRead() {
    resourceRequest.current = transitionAdminRequest(resourceRequest.current, {
      type: "cancelled",
      requestId: resourceRequest.current.requestId + 1,
    });
  }
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState<ChannelPermissionCopyMode>("roles_only");
  const [preview, setPreview] = useState<ChannelPermissionCopyPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const { run: runPreview, cancel: cancelPreview, loading: previewing } = useAdminApi();
  const [commitState, setCommitState] = useState<PermissionCopyWorkflow>("idle");
  const commitStateRef = useRef<PermissionCopyWorkflow>("idle");
  function transitionCommit(event: PermissionCopyEvent) {
    const next = transitionPermissionCopy(commitStateRef.current, event);
    const changed = next !== commitStateRef.current;
    commitStateRef.current = next;
    setCommitState(next);
    return changed;
  }
  const applying = commitState === "applying" || commitState === "refreshing";
  const committed =
    commitState === "committed" || commitState === "refresh-failed" || commitState === "refreshing";
  const reconciliationPending = permissionCopyNeedsRefresh(commitState);
  const refreshError = commitState === "refresh-failed";
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  async function loadResources() {
    if (!selectedGuildId) return;
    const requestId = resourceRequest.current.requestId + 1;
    resourceRequest.current = transitionAdminRequest(resourceRequest.current, {
      type: "started",
      requestId,
    });
    setResourceState(resourceRequest.current);
    try {
      const next = await getChannelPermissionCopyResources(selectedWorkspaceId, selectedGuildId);
      const completed = transitionAdminRequest(resourceRequest.current, {
        type: "succeeded",
        requestId,
      });
      if (completed === resourceRequest.current) return;
      resourceRequest.current = completed;
      setResources(next);
      setResourceState(completed);
    } catch (cause) {
      const failed = transitionAdminRequest(resourceRequest.current, {
        type: "failed",
        requestId,
        error: describeError(cause),
      });
      if (failed === resourceRequest.current) return;
      resourceRequest.current = failed;
      setResourceState(failed);
      throw cause;
    }
  }

  useEffect(() => {
    if (!initialData && selectedGuildId) void loadResources().catch(() => undefined);
    return cancelResourceRead;
    // Loading is keyed by the Guild route; selection changes remount this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGuildId]);

  function invalidatePreview() {
    cancelPreview();
    setPreview(null);
    setConfirmation("");
    setError("");
  }

  async function generatePreview() {
    if (
      !sourceId ||
      !targetId ||
      sourceId === targetId ||
      previewing ||
      commitStateRef.current === "applying" ||
      permissionCopyNeedsRefresh(commitStateRef.current)
    )
      return;
    transitionCommit("preview-started");
    setError("");
    await runPreview(
      () =>
        previewChannelPermissionCopy(selectedWorkspaceId, selectedGuildId, {
          sourceChannelId: sourceId,
          targetChannelId: targetId,
          mode,
        }),
      (next) => {
        setPreview(next);
        setConfirmation("");
        requestAnimationFrame(() => previewHeadingRef.current?.focus());
      },
      (message) => setError(describeError(new Error(message))),
    );
  }

  async function apply() {
    if (!preview || preview.blockers.length || confirmation !== preview.target.name || applying)
      return;
    if (!transitionCommit("apply-started")) return;
    cancelPreview();
    cancelResourceRead();
    setResourceState(resourceRequest.current);
    setError("");
    try {
      await applyChannelPermissionCopy(selectedWorkspaceId, selectedGuildId, {
        previewToken: preview.previewToken,
        confirmationTargetName: confirmation,
      });
      transitionCommit("apply-committed");
      setPreview(null);
      setConfirmation("");
      try {
        await loadResources();
        await onRouteDataRefresh?.();
        transitionCommit("refresh-completed");
      } catch {
        setError("");
        transitionCommit("refresh-failed");
      }
    } catch (cause) {
      transitionCommit("apply-failed");
      setError(describeError(cause));
      setPreview(null);
      setConfirmation("");
    }
  }

  async function retryRefresh() {
    if (!transitionCommit("refresh-started")) return;
    try {
      await loadResources();
      await onRouteDataRefresh?.();
      transitionCommit("refresh-completed");
    } catch {
      setError("");
      transitionCommit("refresh-failed");
    }
  }

  if (!selectedGuildId.trim()) {
    return (
      <NoGuildSelected
        feature="channel permissions"
        description="Pick a server to copy channel permission overwrites."
      />
    );
  }

  const channels = resources?.channels ?? [];
  const target = channels.find((channel) => channel.id === targetId);
  const canApply = Boolean(
    preview && !preview.blockers.length && confirmation === preview.target.name,
  );

  return (
    <section className="admin-feature-page admin-page-system space-y-6">
      <AdminPageHeader title="Channel permissions" />
      <SettingsBlock>
        <SectionHeader
          title="Copy channel permissions"
          description="Copy only Discord channel permission overwrites. HAF Bot adds minimal recovery access for itself when needed; channel content and other settings are not changed."
        />
        {resourceState.kind === "running" ? (
          <p role="status">Loading supported channels...</p>
        ) : null}
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {resourceState.kind === "failed" && !reconciliationPending ? (
          <>
            <Alert variant="destructive" role="alert">
              <AlertDescription>{resourceState.error}</AlertDescription>
            </Alert>
            <Button
              variant="outline"
              onClick={() => {
                if (resourceRequest.current.kind === "running") return;
                void loadResources().catch(() => undefined);
              }}
            >
              Retry loading channels
            </Button>
          </>
        ) : null}
        {committed ? (
          <Alert role="status">
            <AlertDescription>
              <strong>Permissions copied.</strong> The target channel permission overwrites were
              updated.
            </AlertDescription>
          </Alert>
        ) : null}
        {refreshError ? (
          <Alert role="status">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              Permissions were copied, but the page could not refresh.
              <Button type="button" size="sm" variant="outline" onClick={() => void retryRefresh()}>
                Retry refresh
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Source channel" htmlFor="permission-source">
            <ChannelSelect
              id="permission-source"
              value={sourceId}
              channels={channels}
              placeholder="Select a source"
              onChange={(value) => {
                setSourceId(value);
                if (targetId === value) setTargetId("");
                invalidatePreview();
              }}
            />
          </FormField>
          <FormField label="Target channel" htmlFor="permission-target">
            <ChannelSelect
              id="permission-target"
              value={targetId}
              channels={channels.filter((channel) => channel.id !== sourceId)}
              placeholder="Select a target"
              onChange={(value) => {
                setTargetId(value);
                invalidatePreview();
              }}
            />
          </FormField>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Copy mode</legend>
          <ModeCard
            mode="roles_only"
            selected={mode === "roles_only"}
            title="Role permissions only"
            detail="Recommended. Replaces role overwrites, retains target member overwrites, and preserves HAF Bot recovery access."
            onSelect={() => {
              setMode("roles_only");
              invalidatePreview();
            }}
          />
          <ModeCard
            mode="exact"
            selected={mode === "exact"}
            title="Exact copy"
            detail="Replaces every source role and member overwrite, then adds HAF Bot recovery access if needed. This may remove individual member access."
            onSelect={() => {
              setMode("exact");
              invalidatePreview();
            }}
          />
        </fieldset>

        <Button
          onClick={() => void generatePreview()}
          disabled={
            !sourceId ||
            !targetId ||
            sourceId === targetId ||
            previewing ||
            applying ||
            reconciliationPending
          }
        >
          {previewing ? "Generating preview..." : "Preview changes"}
        </Button>
      </SettingsBlock>

      {preview ? (
        <SettingsBlock aria-live="polite">
          <h2 ref={previewHeadingRef} tabIndex={-1} className="font-display text-lg font-semibold">
            Permission preview for #{preview.target.name}
          </h2>
          <PreviewSection
            title="Blockers"
            tone="danger"
            items={preview.blockers}
            empty="No blockers found."
          />
          <PreviewSection
            title="Warnings"
            tone="warning"
            items={preview.warnings}
            empty="No warnings found."
          />
          <section aria-labelledby="permission-changes-heading" className="space-y-3">
            <h3 id="permission-changes-heading" className="font-medium">
              Changes
            </h3>
            {preview.summary?.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {preview.summary.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {preview.changes.length ? (
              preview.changes.map((change) => (
                <article
                  key={`${change.targetType}:${change.targetId}`}
                  className="rounded border bg-muted/10 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{change.targetName}</strong>
                    <Badge>{change.targetType}</Badge>
                    <Badge>{change.change}</Badge>
                  </div>
                  <PermissionList label="Allow" permissions={change.allow} />
                  <PermissionList label="Deny" permissions={change.deny} />
                  <PermissionList label="Inherit" permissions={change.inherit} />
                </article>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No permission changes.</p>
            )}
          </section>

          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">Confirm copy</h3>
            <p className="text-sm text-muted-foreground">
              {mode === "exact" ? "Exact copy can remove member access. " : ""}Type{" "}
              <strong>{preview.target.name}</strong> to confirm the target.
            </p>
            <FormField label="Target channel name" htmlFor="target-confirmation">
              <Input
                id="target-confirmation"
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </FormField>
            <Button
              variant="destructive"
              disabled={!canApply || applying}
              onClick={() => void apply()}
            >
              {applying
                ? "Copying permissions..."
                : `Copy permissions to #${target?.name ?? preview.target.name}`}
            </Button>
          </div>
        </SettingsBlock>
      ) : null}
    </section>
  );
}

function ChannelSelect({
  id,
  value,
  channels,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  channels: ChannelPermissionCopyChannel[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const groups = channels.reduce<Map<string, ChannelPermissionCopyChannel[]>>((result, channel) => {
    const category = channel.categoryName ?? "No category";
    result.set(category, [...(result.get(category) ?? []), channel]);
    return result;
  }, new Map());
  return (
    <select
      id={id}
      className="h-10 w-full rounded-[3px] border bg-background px-3 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {[...groups].map(([category, entries]) => (
        <optgroup key={category} label={category}>
          {entries.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.type}: {channel.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ModeCard({
  mode,
  selected,
  title,
  detail,
  onSelect,
}: {
  mode: ChannelPermissionCopyMode;
  selected: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded border bg-muted/10 p-3">
      <input type="radio" name="copy-mode" value={mode} checked={selected} onChange={onSelect} />
      <span>
        <strong className="block">{title}</strong>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

function PreviewSection({
  title,
  tone,
  items,
  empty,
}: {
  title: string;
  tone: "danger" | "warning";
  items: Array<{ code: string; message: string }>;
  empty: string;
}) {
  return (
    <section aria-labelledby={`preview-${title.toLowerCase()}`} className="space-y-2">
      <h3 id={`preview-${title.toLowerCase()}`} className="font-medium">
        {title}
      </h3>
      {items.length ? (
        items.map((item) => (
          <Alert key={item.code} variant={tone === "danger" ? "destructive" : "default"}>
            <AlertDescription>
              <strong>{item.code}</strong>: {item.message}
            </AlertDescription>
          </Alert>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function PermissionList({ label, permissions }: { label: string; permissions: string[] }) {
  return permissions.length ? (
    <p className="mt-2 text-sm">
      <strong>{label}:</strong> {permissions.join(", ")}
    </p>
  ) : null;
}
