import {
  transitionAutoSave,
  type AutoSaveWorkflow,
  type AutoSaveEvent,
} from "../lib/auto-save-workflow";
import { useRef, useState } from "react";

import { useToast } from "../components/toast";

export function useAutoSaveToggle<T extends string>({
  onSave,
}: {
  onSave: (key: T, nextValue: boolean, previousValue: boolean) => Promise<void>;
}) {
  const toast = useToast();
  const workflow = useRef<AutoSaveWorkflow<T>>({ kind: "idle", generation: 0 });
  const [state, setState] = useState(workflow.current);
  function send(event: AutoSaveEvent<T>) {
    workflow.current = transitionAutoSave(workflow.current, event);
    setState(workflow.current);
  }
  const savingKey = state.kind === "saving" ? state.key : null;
  const savedKey = state.kind === "saved" ? state.key : null;

  async function saveToggle({
    key,
    nextValue,
    previousValue,
    applyValue,
    successMessage,
    hasUnrelatedChanges = false,
    draftMessage = "Changed this setting in your draft. Use Save to apply all changes.",
  }: {
    key: T;
    nextValue: boolean;
    previousValue: boolean;
    applyValue: (value: boolean) => void;
    successMessage: string;
    /** Whether another field is already dirty. The switch remains a draft in this case. */
    hasUnrelatedChanges?: boolean;
    draftMessage?: string;
  }) {
    if (workflow.current.kind === "saving") return;
    applyValue(nextValue);
    if (hasUnrelatedChanges) {
      toast.info(draftMessage);
      return;
    }
    send({ type: "started", key });
    const generation = workflow.current.generation;
    try {
      await onSave(key, nextValue, previousValue);
      toast.success(successMessage);
      send({ type: "succeeded", generation });
      if (typeof window !== "undefined") {
        window.setTimeout(() => send({ type: "acknowledgement-expired", generation }), 1200);
      }
    } catch (err) {
      send({ type: "failed", generation });
      applyValue(previousValue);
      toast.error(err instanceof Error ? err.message : "Failed to save setting.");
    }
  }

  return { saveToggle, savingKey, savedKey };
}
