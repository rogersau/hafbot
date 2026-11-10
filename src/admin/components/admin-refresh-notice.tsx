import { useState } from "react";
import { adminRefreshWarning, retryAdminRefresh } from "../lib/mutation-reconciliation";
import { AdminApiError } from "../lib/api";
import { AdminErrorNotice } from "./admin-error-notice";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

/** Inline reconciliation warning with a refresh-only retry. */
export function AdminRefreshNotice({
  action,
  error,
  refresh,
}: {
  action: string;
  error: unknown;
  refresh?: (() => Promise<void>) | null;
}) {
  const [state, setState] = useState<"pending" | "refreshing" | "resolved">("pending");
  const retrying = state === "refreshing";
  if (!error || state === "resolved") return null;

  async function retry() {
    if (state !== "pending") return;
    setState("refreshing");
    const result = await retryAdminRefresh(refresh);
    setState(result.ok ? "resolved" : "pending");
  }

  return (
    <div className="space-y-2">
      <Alert role="status">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{adminRefreshWarning(action, error)} Your changes are saved.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void retry()}
            disabled={retrying}
          >
            {retrying ? "Refreshing…" : "Retry refresh"}
          </Button>
        </AlertDescription>
      </Alert>
      {error instanceof AdminApiError ? <AdminErrorNotice error={error} /> : null}
    </div>
  );
}
