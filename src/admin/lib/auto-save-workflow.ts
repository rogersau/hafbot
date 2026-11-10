export type AutoSaveWorkflow<Key extends string> =
  | { kind: "idle"; generation: number }
  | { kind: "saving" | "saved"; generation: number; key: Key };

export type AutoSaveEvent<Key extends string> =
  | { type: "started"; key: Key }
  | { type: "succeeded" | "failed" | "acknowledgement-expired"; generation: number };

export function transitionAutoSave<Key extends string>(
  state: AutoSaveWorkflow<Key>,
  event: AutoSaveEvent<Key>,
): AutoSaveWorkflow<Key> {
  if (event.type === "started")
    return state.kind === "saving"
      ? state
      : { kind: "saving", key: event.key, generation: state.generation + 1 };
  if (event.generation !== state.generation) return state;
  if (event.type === "succeeded" && state.kind === "saving") return { ...state, kind: "saved" };
  if (
    (event.type === "failed" && state.kind === "saving") ||
    (event.type === "acknowledgement-expired" && state.kind === "saved")
  )
    return { kind: "idle", generation: state.generation };
  return state;
}
