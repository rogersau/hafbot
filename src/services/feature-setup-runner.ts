import {
  readSetupDependencyWorkflow,
  transitionSetupDependency,
} from "./setup-dependency-workflow";
import type {
  FeatureReadiness,
  FeatureSetupDefinition,
  FeatureSetupState,
  SetupDependencyPreview,
  SetupPreview,
  SetupResolution,
  SetupResourceChoice,
  SetupRun,
} from "../feature-setup";
import {
  DISCORD_RESOURCE_NAME_MAX_LENGTH,
  discordResourceNameLength,
} from "../discord/resource-name";
import type { FeatureSetupStore } from "../runtime/contracts/feature-setup-store";

const RUN_LEASE_MS = 30_000;

export class FeatureSetupError extends Error {
  constructor(
    public readonly code: "invalid_choice" | "active_run_conflict" | "preflight_failed",
    message: string,
  ) {
    super(message);
  }
}

export class FeatureSetupRunner {
  constructor(
    private readonly store: FeatureSetupStore,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async preview(
    definition: FeatureSetupDefinition,
    choices: Record<string, SetupResourceChoice>,
  ): Promise<SetupPreview> {
    try {
      await definition.preflight(choices);
    } catch (cause) {
      throw new FeatureSetupError("preflight_failed", errorMessage(cause));
    }

    const knownKeys = new Set(definition.dependencies.map((dependency) => dependency.key));
    const unknownKey = Object.keys(choices).find((key) => !knownKeys.has(key));
    if (unknownKey) {
      throw new FeatureSetupError("invalid_choice", `Unknown setup dependency: ${unknownKey}.`);
    }

    const dependencies: SetupDependencyPreview[] = [];
    for (const dependency of definition.dependencies) {
      const choice = choices[dependency.key];
      if (!choice) {
        throw new FeatureSetupError(
          "invalid_choice",
          `Choose whether to create or reuse ${dependency.label}.`,
        );
      }
      if (choice.action === "create") {
        const name = choice.name.trim();
        if (!name || discordResourceNameLength(name) > DISCORD_RESOURCE_NAME_MAX_LENGTH) {
          throw new FeatureSetupError(
            "invalid_choice",
            `${dependency.label} must have a name between 1 and ${DISCORD_RESOURCE_NAME_MAX_LENGTH} characters.`,
          );
        }
        dependencies.push({
          key: dependency.key,
          label: dependency.label,
          kind: dependency.kind,
          choice: { action: "create", name },
          relationship: dependency.createdRelationship,
          permissionSummary: dependency.permissionSummary,
          resource: null,
        });
        continue;
      }
      if (!choice.resourceId.trim()) {
        throw new FeatureSetupError("invalid_choice", `Select ${dependency.label} to reuse.`);
      }
      const resource = await dependency.validateReuse(choice.resourceId);
      const previousResolution = await this.store.readLatestResolution(
        definition.guildId,
        definition.featureKey,
        dependency.key,
        resource.id,
      );
      dependencies.push({
        key: dependency.key,
        label: dependency.label,
        kind: dependency.kind,
        choice: { action: "reuse", resourceId: resource.id },
        relationship: previousResolution?.relationship ?? "referenced",
        permissionSummary: dependency.permissionSummary,
        resource,
      });
    }
    return {
      guildId: definition.guildId,
      featureKey: definition.featureKey,
      definitionVersion: definition.version,
      dependencies,
    };
  }

  async execute(
    definition: FeatureSetupDefinition,
    actorUserId: string,
    choices: Record<string, SetupResourceChoice>,
    confirmationId?: string,
  ): Promise<SetupRun> {
    let run = confirmationId ? await this.store.readRun(confirmationId) : null;
    if (run) {
      if (run.guildId !== definition.guildId || run.featureKey !== definition.featureKey) {
        throw new FeatureSetupError(
          "active_run_conflict",
          "This setup confirmation belongs to a different Guild or feature.",
        );
      }
      if (run.status === "completed" || run.status === "cancelled") {
        return run;
      }
      if (run.status === "running" && this.now() - run.updatedAtMs < RUN_LEASE_MS) return run;
    }
    const preview = await this.preview(definition, choices);
    const normalizedChoices = Object.fromEntries(
      preview.dependencies.map((dependency) => [dependency.key, dependency.choice]),
    );
    if (!run) {
      run = await this.store.readActiveRun(definition.guildId, definition.featureKey);
    }
    if (run?.status === "running" && this.now() - run.updatedAtMs < RUN_LEASE_MS) {
      throw new FeatureSetupError(
        "active_run_conflict",
        "Another administrator is currently running setup for this feature.",
      );
    }
    const isResume = Boolean(run);
    if (run) {
      this.assertResolvedChoicesUnchanged(run, normalizedChoices);
      run = {
        ...run,
        actorUserId,
        choices: normalizedChoices,
        definitionVersion: definition.version,
        status: "running",
        failureDependencyKey: null,
        failureMessage: null,
        pendingCreationDependencyKey: run.pendingCreationDependencyKey,
        updatedAtMs: this.now(),
      };
      await this.store.updateRun(run);
    } else {
      const nowMs = this.now();
      run = {
        id: confirmationId ?? this.createId(),
        guildId: definition.guildId,
        featureKey: definition.featureKey,
        definitionVersion: definition.version,
        status: "running",
        actorUserId,
        choices: normalizedChoices,
        failureDependencyKey: null,
        failureMessage: null,
        pendingCreationDependencyKey: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        completedAtMs: null,
        resolutions: [],
      };
      try {
        await this.store.createRun(run);
      } catch (cause) {
        const concurrent = await this.store.readActiveRun(
          definition.guildId,
          definition.featureKey,
        );
        if (!concurrent) throw cause;
        throw new FeatureSetupError(
          "active_run_conflict",
          "Another administrator already started setup for this feature. Refresh to view it.",
        );
      }
    }
    await this.record(definition, isResume ? "resumed" : "started", run);

    for (const dependency of definition.dependencies) {
      try {
        let workflow = readSetupDependencyWorkflow(run, dependency.key);
        let resolution: SetupResolution | undefined =
          "resolution" in workflow ? workflow.resolution : undefined;
        if (workflow.kind === "unresolved" || workflow.kind === "creation-unconfirmed") {
          const dependencyPreview = preview.dependencies.find(
            (candidate) => candidate.key === dependency.key,
          )!;
          if (dependencyPreview.choice.action === "reuse") {
            if (workflow.kind === "creation-unconfirmed") {
              run = {
                ...run,
                pendingCreationDependencyKey: null,
                updatedAtMs: this.now(),
              };
              await this.store.updateRun(run);
            }
            const nowMs = this.now();
            resolution = {
              runId: run.id,
              dependencyKey: dependency.key,
              resource: dependencyPreview.resource!,
              relationship: dependencyPreview.relationship,
              templateVersion: dependency.templateVersion,
              validationStatus: "valid",
              validationDetail: null,
              appliedAtMs: null,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            };
            workflow = transitionSetupDependency(workflow, {
              type: "resource-resolved",
              resolution,
            });
            await this.store.upsertResolution(resolution);
            workflow = transitionSetupDependency(workflow, { type: "resolution-saved" });
          } else {
            if (workflow.kind === "creation-unconfirmed") {
              throw new Error(
                `${dependency.label} creation was interrupted after it may have reached Discord. Select the created resource with Reuse, then resume setup.`,
              );
            }
            run = {
              ...run,
              pendingCreationDependencyKey: dependency.key,
              updatedAtMs: this.now(),
            };
            await this.store.updateRun(run);
            workflow = transitionSetupDependency(workflow, { type: "creation-started" });
            try {
              const resource = await dependency.create(dependencyPreview.choice.name);
              const nowMs = this.now();
              resolution = {
                runId: run.id,
                dependencyKey: dependency.key,
                resource,
                relationship: dependencyPreview.relationship,
                templateVersion: dependency.templateVersion,
                validationStatus: "valid",
                validationDetail: null,
                appliedAtMs: null,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
              };
              workflow = transitionSetupDependency(workflow, {
                type: "resource-resolved",
                resolution,
              });
              await this.store.upsertResolution(resolution);
              workflow = transitionSetupDependency(workflow, { type: "resolution-saved" });
            } catch (cause) {
              if (workflow.kind === "creation-unconfirmed") {
                run = {
                  ...run,
                  pendingCreationDependencyKey: null,
                  updatedAtMs: this.now(),
                };
              }
              throw cause;
            }
            run = {
              ...run,
              pendingCreationDependencyKey: null,
              updatedAtMs: this.now(),
            };
            await this.store.updateRun(run);
          }
          if (!("resolution" in workflow)) throw new Error("Setup resolution was not saved.");
          resolution = workflow.resolution;
          run = { ...run, resolutions: [...run.resolutions, resolution] };
        }
        if (workflow.kind === "application-pending") {
          await dependency.apply(workflow.resolution.resource);
          workflow = transitionSetupDependency(workflow, {
            type: "application-saved",
            nowMs: this.now(),
          });
          if (workflow.kind !== "completed") throw new Error("Setup application did not complete.");
          resolution = workflow.resolution;
          await this.store.upsertResolution(resolution);
          run = {
            ...run,
            resolutions: run.resolutions.map((candidate) =>
              candidate.dependencyKey === dependency.key ? resolution! : candidate,
            ),
          };
        }
      } catch (cause) {
        run = {
          ...run,
          status: "incomplete",
          failureDependencyKey: dependency.key,
          failureMessage: errorMessage(cause),
          updatedAtMs: this.now(),
        };
        await this.store.updateRun(run);
        await this.record(definition, "failed", run);
        return run;
      }
    }

    run = {
      ...run,
      status: "completed",
      failureDependencyKey: null,
      failureMessage: null,
      pendingCreationDependencyKey: null,
      updatedAtMs: this.now(),
      completedAtMs: this.now(),
    };
    await this.store.updateRun(run);
    await this.record(definition, "completed", run);
    return run;
  }

  async readState(definition: FeatureSetupDefinition): Promise<FeatureSetupState> {
    const [configuration, activeRun, latestRun] = await Promise.all([
      definition.readConfiguration(),
      this.store.readActiveRun(definition.guildId, definition.featureKey),
      this.store.readLatestRun(definition.guildId, definition.featureKey),
    ]);
    const allReady = definition.dependencies.every((dependency) =>
      Boolean(configuration.resourceIds[dependency.key]),
    );
    let readiness: FeatureReadiness;
    if (configuration.dormant) readiness = "dormant";
    else if (activeRun) readiness = "setup_incomplete";
    else if (!allReady)
      readiness = latestRun?.status === "completed" ? "needs_attention" : "not_setup";
    else if (
      await this.hasInvalidConfiguredResource(definition, configuration.resourceIds, latestRun)
    )
      readiness = "needs_attention";
    else readiness = configuration.enabled ? "enabled" : "ready_disabled";
    return { readiness, run: activeRun ?? latestRun };
  }

  private async hasInvalidConfiguredResource(
    definition: FeatureSetupDefinition,
    resourceIds: Record<string, string | null>,
    latestRun: SetupRun | null,
  ): Promise<boolean> {
    let invalid = false;
    for (const dependency of definition.dependencies) {
      const resourceId = resourceIds[dependency.key]!;
      const resolution = latestRun?.resolutions.find(
        (candidate) =>
          candidate.dependencyKey === dependency.key && candidate.resource.id === resourceId,
      );
      try {
        const resource = await dependency.validateReuse(resourceId);
        if (
          resolution &&
          (resolution.validationStatus !== "valid" ||
            resolution.validationDetail !== null ||
            resolution.resource.name !== resource.name)
        ) {
          const validated = {
            ...resolution,
            resource,
            validationStatus: "valid",
            validationDetail: null,
            updatedAtMs: this.now(),
          } as const;
          await this.store.upsertResolution(validated);
          Object.assign(resolution, validated);
        }
      } catch (cause) {
        invalid = true;
        if (resolution) {
          const failed = {
            ...resolution,
            validationStatus: "needs_attention",
            validationDetail: errorMessage(cause),
            updatedAtMs: this.now(),
          } as const;
          await this.store.upsertResolution(failed);
          Object.assign(resolution, failed);
        }
      }
    }
    return invalid;
  }

  private assertResolvedChoicesUnchanged(
    run: SetupRun,
    nextChoices: Record<string, SetupResourceChoice>,
  ): void {
    for (const resolution of run.resolutions) {
      const previous = run.choices[resolution.dependencyKey];
      const next = nextChoices[resolution.dependencyKey];
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        throw new FeatureSetupError(
          "active_run_conflict",
          `${resolution.dependencyKey} has already been resolved and cannot be changed in this Setup Run.`,
        );
      }
    }
  }

  private async record(
    definition: FeatureSetupDefinition,
    event: "started" | "resumed" | "failed" | "completed",
    run: SetupRun,
  ): Promise<void> {
    try {
      await definition.record?.(event, run);
    } catch (cause) {
      console.error("Failed to record Feature Resource Setup audit event", cause);
    }
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
