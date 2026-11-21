import { useState } from "react";
import type { MessageTemplate } from "../../types";
import { FormField } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export type ProductDialogRequest =
  | { kind: "unsaved"; continueAction: () => void }
  | {
      kind: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      action: () => void;
    }
  | { kind: "duplicate"; template: MessageTemplate; name: string };

export default function ManagedMessageDialog({
  request,
  templates,
  returnFocus,
  loading,
  onClose,
  onConfirm,
  onUnsavedSave,
}: {
  request: ProductDialogRequest;
  templates: MessageTemplate[];
  returnFocus: HTMLButtonElement | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: (request: ProductDialogRequest) => void;
  onUnsavedSave: () => Promise<void>;
}) {
  const unsaved = request.kind === "unsaved";
  const duplicate = request.kind === "duplicate";
  const [name, setName] = useState(duplicate ? request.name : "");
  const [nameError, setNameError] = useState<string>();
  const title = unsaved
    ? "Unsaved changes"
    : duplicate
      ? "Duplicate Message Template"
      : request.title;
  const actionLabel = unsaved
    ? "Discard and continue"
    : duplicate
      ? "Duplicate"
      : request.confirmLabel;

  function confirm() {
    if (request.kind !== "duplicate") {
      onConfirm(request);
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Enter a template name.");
      return;
    }
    if (trimmedName.length > 100) {
      setNameError("Template names must be 100 characters or fewer.");
      return;
    }
    if (
      templates.some(
        (template) => template.internalName.toLowerCase() === trimmedName.toLowerCase(),
      )
    ) {
      setNameError("A template with this name already exists.");
      return;
    }
    onConfirm({ ...request, name: trimmedName });
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (returnFocus?.isConnected && !returnFocus.disabled) {
              event.preventDefault();
              returnFocus.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {unsaved
                ? "Your editor contains unsaved changes. Choose how to continue."
                : duplicate
                  ? "Choose a unique name for the copied template."
                  : request.description}
            </DialogDescription>
          </DialogHeader>
          {duplicate ? (
            <FormField label="Template name" htmlFor="duplicate-template-name" required>
              <Input
                id="duplicate-template-name"
                value={name}
                maxLength={100}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setNameError(undefined);
                }}
                autoFocus
              />
              {nameError ? <p className="mt-1 text-xs text-destructive">{nameError}</p> : null}
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={loading} onClick={onClose}>
              {unsaved ? "Keep editing" : "Cancel"}
            </Button>
            {unsaved ? (
              <Button
                type="button"
                variant="outline"
                loading={loading}
                onClick={() => void onUnsavedSave()}
              >
                Save and continue
              </Button>
            ) : null}
            <Button
              type="button"
              variant={
                unsaved ||
                (request.kind === "confirm" &&
                  request.confirmLabel.toLowerCase().includes("delete"))
                  ? "destructive"
                  : "default"
              }
              loading={loading}
              onClick={confirm}
            >
              {actionLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="sr-only" aria-hidden="true">
        <span>{title}</span>
        <button type="button" onClick={confirm}>
          {actionLabel}
        </button>
      </div>
    </>
  );
}
