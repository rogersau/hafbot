import type { SetupPreview } from "../../feature-setup";

type ReviewedCreation = {
  preview: SetupPreview;
  accessRoleIds: string[];
  accessChannelIds: string[];
};
export type ResourceCreationWorkflow =
  | { kind: "closed" }
  | { kind: "editing"; error: string | null }
  | { kind: "previewing" }
  | ({ kind: "reviewed"; error: string | null } & ReviewedCreation)
  | ({ kind: "creating" } & ReviewedCreation);

export type ResourceCreationEvent =
  | { type: "opened" | "closed" | "preview-started" | "create-started" | "back" | "created" }
  | ({ type: "preview-created" } & ReviewedCreation)
  | { type: "failed" | "error-set"; error: string | null };

export function transitionResourceCreation(
  state: ResourceCreationWorkflow,
  event: ResourceCreationEvent,
): ResourceCreationWorkflow {
  switch (event.type) {
    case "opened":
      if (state.kind === "closed") return { kind: "editing", error: null };
      break;
    case "closed":
      if (state.kind !== "previewing" && state.kind !== "creating") return { kind: "closed" };
      break;
    case "back":
      if (state.kind === "reviewed") return { kind: "editing", error: null };
      break;
    case "preview-started":
      if (state.kind === "editing") return { kind: "previewing" };
      break;
    case "preview-created":
      if (state.kind === "previewing")
        return {
          kind: "reviewed",
          preview: event.preview,
          accessRoleIds: event.accessRoleIds,
          accessChannelIds: event.accessChannelIds,
          error: null,
        };
      break;
    case "create-started":
      if (state.kind === "reviewed")
        return {
          kind: "creating",
          preview: state.preview,
          accessRoleIds: state.accessRoleIds,
          accessChannelIds: state.accessChannelIds,
        };
      break;
    case "created":
      if (state.kind === "creating") return { kind: "closed" };
      break;
    case "failed":
      if (state.kind === "creating") return { ...state, kind: "reviewed", error: event.error };
      if (state.kind === "previewing") return { kind: "editing", error: event.error };
      break;
    case "error-set":
      if (state.kind === "editing" || state.kind === "reviewed")
        return { ...state, error: event.error };
      break;
  }
  return state;
}
