import { useCallback, useRef } from "react";
import { useBlocker, useRouter } from "@tanstack/react-router";

import { ConfirmDialog } from "./ui/confirm-dialog";

export function NavigationGuard({
  hasChanges,
  onDiscardChanges,
  allowNavigation,
}: {
  hasChanges: boolean;
  onDiscardChanges?: () => void;
  allowNavigation?: (args: { current: unknown; next: unknown }) => boolean;
}) {
  const router = useRouter({ warn: false });
  if (typeof window === "undefined") {
    return null;
  }
  // Standalone component tests and embedded previews do not mount a RouterProvider.
  if (!router) return null;

  return (
    <ClientNavigationGuard
      hasChanges={hasChanges}
      onDiscardChanges={onDiscardChanges}
      allowNavigation={allowNavigation}
    />
  );
}

function ClientNavigationGuard({
  hasChanges,
  onDiscardChanges,
  allowNavigation,
}: {
  hasChanges: boolean;
  onDiscardChanges?: () => void;
  allowNavigation?: (args: { current: unknown; next: unknown }) => boolean;
}) {
  const tabReturnFocus = useRef<HTMLButtonElement | null>(null);
  const shouldBlockFn = useCallback(
    ({ current, next }: { current: unknown; next: unknown }) => {
      const blocked = hasChanges && !(allowNavigation?.({ current, next }) ?? false);
      if (blocked) {
        const focused = document.activeElement;
        tabReturnFocus.current =
          focused?.getAttribute("role") === "tab" ? (focused as HTMLButtonElement) : null;
      }
      return blocked;
    },
    [allowNavigation, hasChanges],
  );
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: hasChanges,
    withResolver: true,
  });

  if (blocker.status !== "blocked") {
    return null;
  }

  return (
    <ConfirmDialog
      open
      title="Leave page?"
      description="You have unsaved changes. If you leave this page, your changes will be lost."
      cancelLabel="Stay"
      confirmLabel="Leave"
      variant="destructive"
      onCloseAutoFocus={(event) => {
        if (tabReturnFocus.current?.isConnected && !tabReturnFocus.current.disabled) {
          event.preventDefault();
          tabReturnFocus.current.focus();
        }
      }}
      onCancel={() => blocker.reset()}
      onConfirm={() => {
        onDiscardChanges?.();
        blocker.proceed();
      }}
    />
  );
}
