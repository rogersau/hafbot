import { transitionFeedback } from "../lib/feedback-workflow";
import { useEffect, useReducer, useRef, useState } from "react";
import { feedbackClient } from "../generated/admin-client/feedback";
import { AdminApiError } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import type { FeedbackSnapshot } from "./admin-feedback-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Category = "problem" | "suggestion" | "other";
type SubmitFeedback = typeof feedbackClient.create;

export function createFeedbackPayload(
  snapshot: FeedbackSnapshot,
  category: Category,
  summary: string,
  description: string,
  diagnostics: { browser: string; os: string } | null,
) {
  return {
    version: 1 as const,
    category,
    summary: summary.trim(),
    description: description.trim(),
    route: snapshot.route,
    pageLabel: snapshot.pageLabel,
    guildId: snapshot.guildId,
    workspaceId: snapshot.workspaceId,
    correlationId: snapshot.correlationId,
    errorCode: snapshot.errorCode,
    workerVersion: snapshot.workerVersion,
    diagnostics: diagnostics ? { included: true as const, ...diagnostics } : undefined,
  };
}

export function validateFeedback(summary: string, description: string): string | null {
  return !summary.trim() || summary.length > 200 || !description.trim() || description.length > 4000
    ? "Enter a summary (1–200 characters) and description (1–4,000 characters)."
    : null;
}

export function createFeedbackSubmitGuard() {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    finish() {
      active = false;
    },
  };
}

export function formatFeedbackFailure(cause: unknown): string {
  const apiError = cause instanceof AdminApiError ? cause : null;
  return apiError?.retryAfterSeconds
    ? `${apiError.message} Try again in ${apiError.retryAfterSeconds} seconds.`
    : (apiError?.message ?? "Feedback could not be sent. Please try again.");
}

export async function copyFeedbackReceipt(
  copyReceipt: (value: string) => Promise<void>,
  receipt: string,
) {
  await copyReceipt(receipt);
}

export function parseFeedbackUserAgent(userAgent: string): { browser: string; os: string } {
  return {
    browser: /Edg/.test(userAgent)
      ? "Edge"
      : /Chrome/.test(userAgent)
        ? "Chrome"
        : /Firefox/.test(userAgent)
          ? "Firefox"
          : /Safari/.test(userAgent)
            ? "Safari"
            : "Other",
    os: /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Mac OS/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Android/.test(userAgent)
            ? "Android"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "Other",
  };
}

export default function AdminFeedbackDialog({
  open,
  snapshot,
  onOpenChange,
  submitFeedback = feedbackClient.create,
  copyReceipt = copyTextToClipboard,
}: {
  open: boolean;
  snapshot: FeedbackSnapshot | null;
  onOpenChange: (open: boolean) => void;
  submitFeedback?: SubmitFeedback;
  copyReceipt?: (value: string) => Promise<void>;
}) {
  const [category, setCategory] = useState<Category>("other");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [submission, sendSubmission] = useReducer(transitionFeedback, {
    kind: "editing",
    error: null,
  });
  const pending = submission.kind === "submitting";
  const error = submission.kind === "editing" ? submission.error : null;
  const receipt = submission.kind === "received" ? submission.reference : null;
  const [draftSnapshot, setDraftSnapshot] = useState<FeedbackSnapshot | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const submitGuard = useRef(createFeedbackSubmitGuard()).current;

  useEffect(() => {
    if (!open || !snapshot || draftSnapshot || receipt) return;
    setDraftSnapshot({ ...snapshot });
    setCategory(snapshot.category ?? "other");
    setSummary(snapshot.summary ?? "");
    setDescription("");
    setIncludeDiagnostics(false);
    sendSubmission({ type: "reset" });
    setCopyStatus(null);
  }, [open, snapshot, draftSnapshot, receipt]);

  const close = () => {
    if (pending) return;
    onOpenChange(false);
    if (submission.kind === "received") sendSubmission({ type: "reset" });
    setCopyStatus(null);
  };

  const resetDraft = () => {
    setDraftSnapshot(null);
    setCategory("other");
    setSummary("");
    setDescription("");
    setIncludeDiagnostics(false);
    sendSubmission({ type: "reset" });
  };

  const discardDraft = () => {
    if (pending) return;
    resetDraft();
    close();
  };

  const copy = async () => {
    if (!receipt) return;
    setCopyStatus(null);
    try {
      await copyFeedbackReceipt(copyReceipt, receipt);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const diagnostics = includeDiagnostics ? parseFeedbackUserAgent(userAgent) : null;

  const submit = async () => {
    if (!draftSnapshot) return;
    if (pending || !submitGuard.tryStart()) return;
    const validationError = validateFeedback(summary, description);
    if (validationError) {
      sendSubmission({ type: "failed", error: validationError });
      submitGuard.finish();
      return;
    }
    sendSubmission({ type: "submitted" });
    try {
      const result = await submitFeedback(
        createFeedbackPayload(draftSnapshot, category, summary, description, diagnostics),
      );
      setDraftSnapshot(null);
      setCategory("other");
      setSummary("");
      setDescription("");
      setIncludeDiagnostics(false);
      sendSubmission({ type: "received", reference: result.reference });
    } catch (cause) {
      sendSubmission({ type: "failed", error: formatFeedbackFailure(cause) });
    } finally {
      submitGuard.finish();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent aria-describedby="admin-feedback-description">
        <DialogHeader>
          <DialogTitle>{receipt ? "Feedback received" : "Send feedback"}</DialogTitle>
          <DialogDescription id="admin-feedback-description">
            {receipt
              ? "Your feedback was recorded. Keep this receipt for support follow-up."
              : "Diagnostic details are optional and include only browser, OS, and captured context; never form contents, credentials, or Discord content."}
          </DialogDescription>
        </DialogHeader>
        {receipt ? (
          <div className="grid gap-3">
            <p className="text-sm">
              Receipt: <code>{receipt}</code>
            </p>
            <Button type="button" onClick={() => void copy()}>
              Copy receipt
            </Button>
            {copyStatus ? (
              <p
                role={copyStatus === "failed" ? "alert" : "status"}
                aria-live={copyStatus === "failed" ? "assertive" : "polite"}
                className="text-sm"
              >
                {copyStatus === "copied"
                  ? "Receipt copied."
                  : "Could not copy the receipt. Select and copy it manually."}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              Category
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as Category)}
                disabled={pending}
              >
                <option value="problem">Problem</option>
                <option value="suggestion">Suggestion</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Summary
              <input
                value={summary}
                maxLength={200}
                onChange={(event) => setSummary(event.target.value)}
                disabled={pending}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Description
              <textarea
                value={description}
                maxLength={4000}
                onChange={(event) => setDescription(event.target.value)}
                disabled={pending}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                disabled={pending}
              />
              Include diagnostic details
            </label>
            <div
              className="rounded border bg-muted/30 p-3 text-xs"
              aria-label="Feedback context preview"
            >
              <p className="font-medium">Context that will be sent</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>Route</dt>
                <dd>{draftSnapshot?.route ?? "Not available"}</dd>
                <dt>Page</dt>
                <dd>{draftSnapshot?.pageLabel ?? "Not available"}</dd>
                <dt>Guild</dt>
                <dd>{draftSnapshot?.guildId ?? "Not available"}</dd>
                <dt>Correlation</dt>
                <dd>{draftSnapshot?.correlationId ?? "Not available"}</dd>
                <dt>Error code</dt>
                <dd>{draftSnapshot?.errorCode ?? "Not available"}</dd>
                <dt>Worker</dt>
                <dd>{draftSnapshot?.workerVersion ?? "Not available"}</dd>
              </dl>
            </div>
            {diagnostics ? (
              <p className="text-xs text-muted-foreground">
                Optional diagnostics payload: browser {diagnostics.browser}, OS {diagnostics.os}.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Closing keeps your draft in this session. Discard draft clears it.
            </p>
          </div>
        )}
        <DialogFooter>
          {receipt ? (
            <Button type="button" onClick={close}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={discardDraft} disabled={pending}>
                Discard draft
              </Button>
              <Button type="button" variant="outline" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={pending}>
                {pending ? "Sending…" : "Send feedback"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
