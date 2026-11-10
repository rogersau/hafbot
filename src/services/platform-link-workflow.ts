import type { ProductFailureCode } from "../product-analytics";

export type PlatformLinkSaveWorkflow =
  | { kind: "reading" }
  | { kind: "capacity-rejected" }
  | { kind: "enriching" }
  | { kind: "persisting" }
  | { kind: "committed" };

export function platformLinkFailure(
  state: PlatformLinkSaveWorkflow,
): { kind: "save-failed"; reason: ProductFailureCode } | { kind: "finalization-failed" } {
  switch (state.kind) {
    case "committed":
      return { kind: "finalization-failed" };
    case "capacity-rejected":
      return { kind: "save-failed", reason: "invalid_configuration" };
    case "enriching":
      return { kind: "save-failed", reason: "provider_unavailable" };
    case "reading":
    case "persisting":
      return { kind: "save-failed", reason: "storage_unavailable" };
  }
}
