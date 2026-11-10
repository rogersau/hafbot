export type SetupRunStatus = "planned" | "running" | "incomplete" | "completed" | "cancelled";
export type SetupResourceKind =
  | "text_channel"
  | "voice_channel"
  | "forum_channel"
  | "category"
  | "role";
export type ResourceRelationship = "referenced" | "haf_configured" | "haf_managed";
export type FeatureReadiness =
  | "not_setup"
  | "setup_incomplete"
  | "ready_disabled"
  | "enabled"
  | "needs_attention"
  | "dormant";

export type SetupResourceChoice =
  | { action: "reuse"; resourceId: string }
  | { action: "create"; name: string };

export interface SetupResource {
  id: string;
  name: string;
  kind: SetupResourceKind;
}

export interface SetupDependencyPreview {
  key: string;
  label: string;
  kind: SetupResourceKind;
  choice: SetupResourceChoice;
  relationship: ResourceRelationship;
  permissionSummary: string;
  resource: SetupResource | null;
}

export interface SetupPreview {
  confirmationId?: string;
  guildId: string;
  featureKey: string;
  definitionVersion: number;
  dependencies: SetupDependencyPreview[];
}

export interface SetupResolution {
  runId: string;
  dependencyKey: string;
  resource: SetupResource;
  relationship: ResourceRelationship;
  templateVersion: number;
  validationStatus: "valid" | "needs_attention";
  validationDetail: string | null;
  appliedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SetupRun {
  id: string;
  guildId: string;
  featureKey: string;
  definitionVersion: number;
  status: SetupRunStatus;
  actorUserId: string;
  choices: Record<string, SetupResourceChoice>;
  failureDependencyKey: string | null;
  failureMessage: string | null;
  pendingCreationDependencyKey: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  resolutions: SetupResolution[];
}

export interface FeatureSetupState {
  readiness: FeatureReadiness;
  run: SetupRun | null;
}

export interface SetupDependencyDefinition {
  key: string;
  label: string;
  kind: SetupResourceKind;
  recommendedName: string;
  createdRelationship: ResourceRelationship;
  templateVersion: number;
  permissionSummary: string;
  validateReuse(resourceId: string): Promise<SetupResource>;
  create(name: string): Promise<SetupResource>;
  apply(resource: SetupResource): Promise<void>;
}

export interface FeatureSetupDefinition {
  guildId: string;
  featureKey: string;
  version: number;
  dependencies: SetupDependencyDefinition[];
  preflight(choices: Record<string, SetupResourceChoice>): Promise<void>;
  readConfiguration(): Promise<{
    enabled: boolean;
    dormant: boolean;
    resourceIds: Record<string, string | null>;
  }>;
  record?(event: "started" | "resumed" | "failed" | "completed", run: SetupRun): Promise<void>;
}
