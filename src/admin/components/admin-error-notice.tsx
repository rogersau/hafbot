import { AdminApiError, describeError } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import { useToast } from "./toast";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { useAdminFeedback } from "./admin-feedback-dialog";

/** Shared, safe presentation of the versioned admin API error contract. */
export function AdminErrorNotice({ error }: { error: unknown }) {
  const message = describeError(error);
  const apiError = error instanceof AdminApiError ? error : null;
  const recovery = recoveryLabel(apiError?.action, apiError?.retryAfterSeconds);
  const toast = useToast();
  const openFeedback = useAdminFeedback();
  const correlationId =
    apiError?.correlationId && apiError.correlationId !== "unknown" ? apiError.correlationId : null;
  const canSendReport = Boolean(
    openFeedback && (correlationId || apiError?.action === "contact_support"),
  );

  async function copyReference() {
    if (!correlationId) return;
    try {
      await copyTextToClipboard(correlationId);
      toast.success("Reference copied.");
    } catch {
      toast.error("Could not copy the reference.");
    }
  }

  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p>{message}</p>
        {recovery ? <p className="mt-1 text-xs opacity-80">{recovery}</p> : null}
        {correlationId || canSendReport ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs opacity-70">
            {correlationId ? <span>Reference: {correlationId}</span> : null}
            {correlationId ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void copyReference()}
              >
                Copy reference
              </Button>
            ) : null}
            {canSendReport ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  openFeedback?.(buildFeedbackReportInput(apiError, message, correlationId))
                }
              >
                Send report
              </Button>
            ) : null}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function buildFeedbackReportInput(
  error: AdminApiError | null,
  message: string,
  correlationId?: string | null,
) {
  return {
    category: "problem" as const,
    summary: `${error?.code ? `Error ${error.code}: ` : ""}${message}`.slice(0, 200),
    correlationId: correlationId ?? undefined,
    errorCode: error?.code,
  };
}

function recoveryLabel(action: AdminApiError["action"], retryAfterSeconds?: number): string | null {
  if (action === "sign_in") return "Sign in again, then retry.";
  if (action === "upgrade") return "Upgrade your plan to continue.";
  if (action === "fix_fields") return "Review the highlighted fields and try again.";
  if (action === "wait")
    return retryAfterSeconds ? `Try again in ${retryAfterSeconds} seconds.` : "Try again shortly.";
  if (action === "retry") return "Try again shortly.";
  if (action === "contact_support")
    return "If this continues, contact support with the reference above.";
  return null;
}
