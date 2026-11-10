import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openFeedback = useCallback(
    (input: FeedbackOpenInput = {}) => {
      const { returnFocus, ...snapshotInput } = input;
      triggerRef.current = resolveFeedbackReturnFocus(returnFocus, document.activeElement);
      setSnapshot({ ...context, ...snapshotInput });
      setOpen(true);
    },
    [context],
  );

  return (
    <FeedbackOpenContext.Provider value={openFeedback}>
      {children}
      <Suspense fallback={null}>
        <FeedbackDialog
          open={open}
          snapshot={snapshot}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) queueMicrotask(() => triggerRef.current?.focus());
          }}
        />
      </Suspense>
    </FeedbackOpenContext.Provider>
  );
}
