import { useEffect, useRef, useState } from "react";
import {
  banAppealSettingsSchema,
  type BanAppeal,
  type BanAppealConfig,
  type BanAppealOperation,
  type BanAppealSettings,
} from "../../moderation-appeals/types";
import { useAdminApi } from "../hooks/use-admin-api";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useConfirmDialog } from "./ui/confirm-dialog";

interface BanAppealsData {
  guildId: string;
  config: BanAppealConfig;
  appeals: BanAppeal[];
}
interface AppealDetail {
  appeal: BanAppeal;
  operations: BanAppealOperation[];
}

export function AdminBanAppealsPanel(props: {
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  if (!props.selectedGuildId) return null;
  return (
    <BanAppealsEditor key={`${props.selectedWorkspaceId}:${props.selectedGuildId}`} {...props} />
  );
}

function BanAppealsEditor({
  selectedGuildId,
  selectedWorkspaceId,
}: {
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  const [data, setData] = useState<BanAppealsData | null>(null);
  const [settings, setSettings] = useState<BanAppealSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<BanAppealSettings | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [detail, setDetail] = useState<AppealDetail | null>(null);
  const [reason, setReason] = useState("");
  const [initialError, setInitialError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const api = useAdminApi();
  const { confirm, dialog } = useConfirmDialog();
  const dirty = settings !== null && JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const query = { guildId: selectedGuildId, workspaceId: selectedWorkspaceId };
  useEffect(() => {
    const next = new AbortController();
    controller.current = next;
    void createAdminLoaderClient(next.signal)
      .getJson<BanAppealsData>("/admin/api/ban-appeals", {
        guildId: selectedGuildId,
        workspaceId: selectedWorkspaceId,
      })
      .then((response) => {
        if (next.signal.aborted) return;
        setData(response);
        setSettings(toSettings(response.config));
        setSavedSettings(toSettings(response.config));
        setConfigRevision(response.config.revision);
      })
      .catch((error: unknown) => {
        if (!next.signal.aborted)
          setInitialError(
            error instanceof Error ? error.message : "Ban appeals could not be loaded.",
          );
      });
    return () => next.abort();
  }, [selectedGuildId, selectedWorkspaceId]);

  const client = () => createAdminLoaderClient(controller.current?.signal);
  async function refreshAppeals() {
    const response = await client().getJson<BanAppealsData>("/admin/api/ban-appeals", query);
    setData(response);
  }
  async function selectAppeal(id: string) {
    await api.run(async () => {
      const response = await client().getJson<AppealDetail>("/admin/api/ban-appeals/detail", {
        ...query,
        search: { appealId: id },
      });
      setDetail(response);
      setReason("");
      setNotice(null);
    });
  }
  async function saveSettings() {
    if (!settings || busy.current) return;
    const parsed = banAppealSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      api.setError(parsed.error.issues[0]?.message ?? "Check the ban appeal settings.");
      return;
    }
    busy.current = true;
    await api.run(async () => {
      const response = await client().postJson<{ config: BanAppealConfig }>(
        "/admin/api/ban-appeals/config",
        { settings: parsed.data, expectedRevision: configRevision },
        query,
      );
      setSettings(toSettings(response.config));
      setSavedSettings(toSettings(response.config));
      setConfigRevision(response.config.revision);
      setNotice("Ban appeal settings saved.");
    });
    busy.current = false;
  }
  async function review(action: "reject" | "unban") {
    if (!detail || busy.current) return;
    const appeal = detail.appeal;
    const checking = action === "unban" && appeal.status === "unban_pending";
    const note = checking ? reason.trim() || "Check the recorded unban outcome" : reason.trim();
    if (note.length < 3 || note.length > 500) {
      api.setError("Add a private staff reason of 3–500 characters.");
      return;
    }
    busy.current = true;
    if (
      !checking &&
      !(await confirm({
        title: action === "unban" ? "Approve appeal and unban?" : "Reject this appeal?",
        description:
          action === "unban"
            ? "This removes the Discord ban. The member will still need an invitation to rejoin. Your staff note remains private."
            : "This keeps the current ban and closes the appeal. Your staff note remains private.",
        confirmLabel: action === "unban" ? "Unban member" : "Reject appeal",
        variant: action === "unban" ? "default" : "destructive",
      }))
    ) {
      busy.current = false;
      return;
    }
    await api.run(async () => {
      try {
        const result = await client().postJson<{ appeal: BanAppeal }>(
          "/admin/api/ban-appeals/review",
          { appealId: appeal.id, expectedRevision: appeal.revision, action, reason: note },
          query,
        );
        setDetail((current) => (current ? { ...current, appeal: result.appeal } : null));
        setNotice(
          result.appeal.status === "unbanned"
            ? "Discord ban removal confirmed."
            : "Appeal rejected.",
        );
      } finally {
        await client()
          .getJson<AppealDetail>("/admin/api/ban-appeals/detail", {
            ...query,
            search: { appealId: appeal.id },
          })
          .then(setDetail)
          .catch(() => undefined);
        await refreshAppeals().catch(() => undefined);
      }
    });
    busy.current = false;
  }
  function update<K extends keyof BanAppealSettings>(key: K, value: BanAppealSettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
    setNotice(null);
  }

  return (
    <>
      {dialog}
      <NavigationGuard hasChanges={dirty} />
      <SettingsBlock>
        <SectionHeader
          title="Discord ban appeals"
          description="Let banned members sign in with Discord and request a private staff review."
          actions={<UnsavedChangesIndicator hasChanges={dirty} />}
        />
        <PageFeedback error={initialError ?? api.error} message={notice} />
        {!settings ? (
          <p className="text-sm text-muted-foreground">
            {initialError ? "Reload this page to try again." : "Loading ban appeal settings…"}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Switch
                id="ban-appeals-enabled"
                checked={settings.enabled}
                onCheckedChange={(value) => update("enabled", value)}
                disabled={api.loading}
              />
              <label htmlFor="ban-appeals-enabled">Accept new ban appeals</label>
            </div>
            <FormField label="Appeal page title" htmlFor="ban-appeals-title">
              <Input
                id="ban-appeals-title"
                value={settings.title}
                maxLength={120}
                disabled={api.loading}
                onChange={(event) => update("title", event.target.value)}
              />
            </FormField>
            <FormField label="Instructions for appellants" htmlFor="ban-appeals-instructions">
              <Textarea
                id="ban-appeals-instructions"
                value={settings.instructions}
                maxLength={1000}
                disabled={api.loading}
                onChange={(event) => update("instructions", event.target.value)}
              />
            </FormField>
            <FormField
              label="Submission cooldown (hours)"
              htmlFor="ban-appeals-cooldown"
              hint="Wait between submitted appeals, including appeals that staff rejected. One appeal can remain open at a time."
            >
              <Input
                id="ban-appeals-cooldown"
                type="number"
                min={1}
                max={720}
                value={settings.cooldownHours}
                disabled={api.loading}
                onChange={(event) => update("cooldownHours", Number(event.target.value))}
              />
            </FormField>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => void saveSettings()}
                disabled={!dirty || api.loading}
                loading={api.loading}
              >
                Save appeal settings
              </Button>
              <a
                className="text-sm underline"
                href={`/ban-appeals/${selectedGuildId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open public appeal page
              </a>
            </div>
          </>
        )}
      </SettingsBlock>
      {data ? (
        <SettingsBlock>
          <SectionHeader
            title="Appeal review queue"
            description="Only authorised staff can view submissions and decision notes. Unbanning also requires your Discord Ban Members permission."
            actions={
              <Button
                type="button"
                variant="secondary"
                disabled={api.loading}
                onClick={() => void api.run(refreshAppeals)}
              >
                Refresh appeals
              </Button>
            }
          />
          {data.appeals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ban appeals have been submitted.</p>
          ) : (
            <ul className="space-y-2">
              {data.appeals.map((appeal) => (
                <li key={appeal.id}>
                  <Button
                    type="button"
                    variant={detail?.appeal.id === appeal.id ? "secondary" : "ghost"}
                    disabled={api.loading}
                    onClick={() => void selectAppeal(appeal.id)}
                  >
                    {appeal.displayName} · {statusLabel(appeal.status)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {detail ? (
            <section className="space-y-4" aria-label="Selected ban appeal">
              <h3 className="font-medium">
                {detail.appeal.displayName} — {statusLabel(detail.appeal.status)}
              </h3>
              <p className="text-sm text-muted-foreground">
                Discord user ID: {detail.appeal.userId}
              </p>
              {detail.appeal.banReason ? (
                <div>
                  <h4 className="text-sm font-medium">Ban reason recorded at submission</h4>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {detail.appeal.banReason}
                  </p>
                </div>
              ) : null}
              <div>
                <h4 className="text-sm font-medium">Member appeal</h4>
                <p className="whitespace-pre-wrap break-words">{detail.appeal.text}</p>
              </div>
              {detail.appeal.decisionReason ? (
                <div>
                  <h4 className="text-sm font-medium">Private staff decision note</h4>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {detail.appeal.decisionReason}
                  </p>
                </div>
              ) : null}
              {detail.operations.length ? (
                <details>
                  <summary>Recorded unban attempts</summary>
                  <ul className="space-y-2">
                    {detail.operations.map((operation) => (
                      <li key={operation.id} className="text-sm">
                        {new Date(operation.createdAtMs).toLocaleString()} · {operation.outcome}
                        <p className="whitespace-pre-wrap break-words">{operation.reason}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {detail.appeal.status === "unban_pending" ? (
                <p className="text-sm" role="status">
                  An unban attempt is awaiting confirmation. Check its result to reconcile the
                  recorded action. HAF does not repeat an uncertain removal.
                </p>
              ) : null}
              {detail.appeal.status === "pending" || detail.appeal.status === "unban_pending" ? (
                <>
                  <FormField label="Private staff reason" htmlFor="ban-appeals-review-reason">
                    <Textarea
                      id="ban-appeals-review-reason"
                      value={reason}
                      maxLength={500}
                      disabled={api.loading}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </FormField>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      disabled={api.loading}
                      onClick={() => void review("unban")}
                    >
                      {detail.appeal.status === "unban_pending"
                        ? "Check unban result"
                        : "Approve and unban"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={api.loading}
                      onClick={() => void review("reject")}
                    >
                      Keep ban and reject
                    </Button>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}
        </SettingsBlock>
      ) : null}
    </>
  );
}

function toSettings(config: BanAppealConfig): BanAppealSettings {
  return {
    enabled: config.enabled,
    title: config.title,
    instructions: config.instructions,
    cooldownHours: config.cooldownHours,
  };
}
function statusLabel(status: BanAppeal["status"]) {
  return {
    pending: "Awaiting review",
    unban_pending: "Confirming unban",
    unbanned: "Unbanned",
    rejected: "Rejected",
  }[status];
}
