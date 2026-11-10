import { useEffect, useRef, useState } from "react";
import { adminRefreshWarning } from "../lib/mutation-reconciliation";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { useToast } from "./toast";

type RefreshFailureDetail = {
  error: unknown;
  refresh?: (() => Promise<void>) | null;
  sequence: number;
};

/** Keeps refresh failures visible even on editors that only need a fire-and-forget refresh. */
export function AdminRefreshNoticeHost() {
  const [failure, setFailure] = useState<RefreshFailureDetail | null>(null);
  const nextSequence = useRef(0);
  const toast = useToast();

  // eslint-disable-next-line custom/no-use-effect -- subscribes to the shared refresh-failure seam.
  useEffect(() => {
    const handleFailure = (event: Event) => {
      const detail = (event as CustomEvent<RefreshFailureDetail>).detail;
      if (detail?.error) {
        setFailure({ ...detail, sequence: ++nextSequence.current });
        toast.info(adminRefreshWarning("Admin changes", detail.error));
      }
    };
    window.addEventListener("admin-refresh-failed", handleFailure);
    return () => window.removeEventListener("admin-refresh-failed", handleFailure);
  }, [toast]);

  return failure ? (
    <div className="fixed inset-x-4 top-20 z-[75] mx-auto max-w-2xl">
      <AdminRefreshNotice
        key={failure.sequence}
        action="Admin changes"
        error={failure.error}
        refresh={failure.refresh}
      />
    </div>
  ) : null;
}
