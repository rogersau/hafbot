import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import { AdminSessionProvider, useAdminSession, useAdminSessionState } from "../lib/admin-session";

export type FeedbackSnapshot = {
  route: string;
  pageLabel?: string;
  guildId?: string;
  workspaceId?: string;
  correlationId?: string;
  errorCode?: string;
  workerVersion?: string;
  summary?: string;
  category?: "problem" | "suggestion" | "other";
};

export type FeedbackOpenInput = Partial<FeedbackSnapshot> & {
  returnFocus?: HTMLElement | null;
};

const FeedbackDialog = lazy(() => import("./admin-feedback-dialog-view"));
const FeedbackOpenContext = createContext<((input?: FeedbackOpenInput) => void) | null>(null);

export function useAdminFeedback() {
  return useContext(FeedbackOpenContext);
}

export function resolveFeedbackReturnFocus(
  explicit: HTMLElement | null | undefined,
  active: Element | null,
): HTMLElement | null {
  if (explicit) return explicit;
  return active && typeof (active as HTMLElement).focus === "function"
    ? (active as HTMLElement)
    : null;
}

export function resolveFeedbackScope(
  guildId: string | null | undefined,
  workspaceId: string | null | undefined,
): Pick<FeedbackSnapshot, "guildId" | "workspaceId"> {
  if (guildId) return { guildId };
  return workspaceId ? { workspaceId } : {};
}

export function AdminFeedbackProvider({
  context,
  children,
}: {
  context: FeedbackSnapshot;
  children: ReactNode;
}) {
  return (
    <AdminSessionProvider>
      <AdminFeedbackHost context={context}>{children}</AdminFeedbackHost>
    </AdminSessionProvider>
  );
}

function AdminFeedbackHost({
  context,
  children,
}: {
  context: FeedbackSnapshot;
  children: ReactNode;
}) {
  const session = useAdminSession();
  const feedback = useAdminSessionState((state) => state.feedback);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openFeedback = useCallback(
    (input: FeedbackOpenInput = {}) => {
      const { returnFocus, ...snapshotInput } = input;
      triggerRef.current = resolveFeedbackReturnFocus(returnFocus, document.activeElement);
      session.update(({ feedback }) => ({
        feedback: { snapshot: feedback?.snapshot ?? { ...context, ...snapshotInput }, open: true },
      }));
    },
    [context, session],
  );

  return (
    <FeedbackOpenContext.Provider value={openFeedback}>
      {children}
      {feedback ? (
        <Suspense fallback={null}>
          <FeedbackDialog
            open={feedback.open}
            snapshot={feedback.snapshot}
            onClose={(discard) => {
              const trigger = triggerRef.current;
              session.update({ feedback: discard ? null : { ...feedback, open: false } });
              queueMicrotask(() => trigger?.focus());
            }}
          />
        </Suspense>
      ) : null}
    </FeedbackOpenContext.Provider>
  );
}
