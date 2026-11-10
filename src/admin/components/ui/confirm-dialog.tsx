import * as React from "react";

import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  loading?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  variant = "default",
  loading = false,
  disabled = false,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <div className="text-sm text-foreground">{children}</div> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              onCancel?.();
              onOpenChange?.(false);
            }}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant}
            loading={loading}
            disabled={disabled}
            onClick={() => onConfirm?.()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface UseConfirmDialogResult {
  dialog: React.ReactNode;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
}

export interface ConfirmDialogOptions extends Omit<
  ConfirmDialogProps,
  "open" | "onOpenChange" | "onCancel" | "onConfirm"
> {
  onCancel?: () => void;
  onConfirm?: () => void;
}

export function useConfirmDialog(): UseConfirmDialogResult {
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<ConfirmDialogOptions>({ title: "" });
  const resolveRef = React.useRef<((value: boolean) => void) | null>(null);

  const confirm = React.useCallback((nextOptions: ConfirmDialogOptions) => {
    setOptions(nextOptions);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleCancel = React.useCallback(() => {
    options.onCancel?.();
    resolveRef.current?.(false);
    resolveRef.current = null;
    setOpen(false);
  }, [options]);

  const handleConfirm = React.useCallback(() => {
    options.onConfirm?.();
    resolveRef.current?.(true);
    resolveRef.current = null;
    setOpen(false);
  }, [options]);

  const dialog = React.useMemo(
    () => (
      <ConfirmDialog
        {...options}
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleCancel();
          }
          setOpen(nextOpen);
        }}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
    ),
    [options, open, handleCancel, handleConfirm],
  );

  return { dialog, confirm };
}
