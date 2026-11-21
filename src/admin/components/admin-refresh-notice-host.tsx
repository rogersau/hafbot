import { useAdminSession, useAdminSessionState } from "../lib/admin-session";
import { AdminRefreshNotice } from "./admin-refresh-notice";

export function AdminRefreshNoticeHost() {
  const session = useAdminSession();
  const failure = useAdminSessionState((state) => state.refreshFailure);
  return failure ? (
    <div className="fixed inset-x-4 top-20 z-[75] mx-auto max-w-2xl">
      <AdminRefreshNotice
        key={failure.sequence}
        action="Admin changes"
        error={failure.error}
        refresh={failure.refresh}
        onResolved={() =>
          session.update((state) =>
            state.refreshFailure === failure ? { refreshFailure: null } : {},
          )
        }
      />
    </div>
  ) : null;
}
