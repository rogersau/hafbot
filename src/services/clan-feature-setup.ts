import { defaultClanManagementConfig, type ClanHistoryEvent } from "../clans";
import type {
  FeatureSetupDefinition,
  FeatureSetupState,
  SetupPreview,
  SetupResource,
  SetupResourceChoice,
  SetupResourceKind,
  SetupRun,
} from "../feature-setup";
import type { ClanStore } from "../runtime/contracts";
import { FeatureSetupRunner } from "./feature-setup-runner";

const FEATURE_KEY = "clan_management";
const DEFINITION_VERSION = 1;

export interface ClanFeatureSetupDiscord {
  preflight(input: {
    guildId: string;
    needsManageChannels: boolean;
    needsManageRoles: boolean;
  }): Promise<void>;
  readResource(
    guildId: string,
    resourceId: string,
    kind: SetupResourceKind,
  ): Promise<SetupResource>;
  createCategory(input: {
    guildId: string;
    name: string;
    private: boolean;
  }): Promise<SetupResource>;
  createTextChannel(input: { guildId: string; name: string }): Promise<SetupResource>;
  createRole(input: { guildId: string; name: string }): Promise<SetupResource>;
}

export class ClanFeatureSetupService {
  constructor(
    private readonly clans: ClanStore,
    private readonly runner: FeatureSetupRunner,
    private readonly discord: ClanFeatureSetupDiscord,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly postAudit?: (event: ClanHistoryEvent) => Promise<void>,
  ) {}

  preview(guildId: string, choices: Record<string, SetupResourceChoice>): Promise<SetupPreview> {
    return this.runner.preview(this.definition(guildId), choices);
  }

  execute(
    guildId: string,
    actorUserId: string,
    choices: Record<string, SetupResourceChoice>,
    confirmationId?: string,
  ): Promise<SetupRun> {
    return this.runner.execute(this.definition(guildId), actorUserId, choices, confirmationId);
  }

  readState(guildId: string): Promise<FeatureSetupState> {
    return this.runner.readState(this.definition(guildId));
  }

  recommendedChoices(): Record<string, SetupResourceChoice> {
    return {
      managed_category: { action: "create", name: "HAF Clans" },
      panel_channel: { action: "create", name: "clan-requests" },
      review_category: { action: "create", name: "Clan Reviews" },
      reviewer_role: { action: "create", name: "Clan Reviewer" },
    };
  }

  private definition(guildId: string): FeatureSetupDefinition {
    const discord = this.discord;
    const applyConfig = async (values: {
      categoryId?: string;
      requestPanelChannelId?: string;
      requestReviewCategoryId?: string;
      reviewerRoleId?: string;
    }) => {
      const current =
        (await this.clans.readConfig(guildId)) ?? defaultClanManagementConfig(guildId, this.now());
      await this.clans.upsertConfig({
        ...current,
        ...(values.categoryId ? { categoryId: values.categoryId } : {}),
        ...(values.requestPanelChannelId
          ? { requestPanelChannelId: values.requestPanelChannelId }
          : {}),
        ...(values.requestReviewCategoryId
          ? { requestReviewCategoryId: values.requestReviewCategoryId }
          : {}),
        ...(values.reviewerRoleId
          ? { reviewerRoleIds: [...new Set([...current.reviewerRoleIds, values.reviewerRoleId])] }
          : {}),
        updatedAtMs: this.now(),
      });
    };
    const dependency = (input: {
      key: string;
      label: string;
      kind: SetupResourceKind;
      recommendedName: string;
      createdRelationship: "haf_configured" | "haf_managed";
      permissionSummary: string;
      create(name: string): Promise<SetupResource>;
      apply(resourceId: string): Promise<void>;
    }) => ({
      ...input,
      templateVersion: 1,
      validateReuse: (resourceId: string) =>
        this.discord.readResource(guildId, resourceId, input.kind),
      create: input.create,
      apply: (resource: SetupResource) => input.apply(resource.id),
    });
    return {
      guildId,
      featureKey: FEATURE_KEY,
      version: DEFINITION_VERSION,
      async preflight(_choices) {
        await discord.preflight({
          guildId,
          needsManageChannels: true,
          needsManageRoles: true,
        });
      },
      dependencies: [
        dependency({
          key: "managed_category",
          label: "Managed Clan category",
          kind: "category",
          recommendedName: "HAF Clans",
          createdRelationship: "haf_managed",
          permissionSummary:
            "Hides the category from @everyone and grants HAF access; per-Clan channels receive their own access rules.",
          create: (name) => this.discord.createCategory({ guildId, name, private: true }),
          apply: (categoryId) => applyConfig({ categoryId }),
        }),
        dependency({
          key: "panel_channel",
          label: "Clan creation panel channel",
          kind: "text_channel",
          recommendedName: "clan-requests",
          createdRelationship: "haf_configured",
          permissionSummary:
            "Creates a normal member-visible text channel. Publishing the panel remains a separate action.",
          create: (name) => this.discord.createTextChannel({ guildId, name }),
          apply: (requestPanelChannelId) => applyConfig({ requestPanelChannelId }),
        }),
        dependency({
          key: "review_category",
          label: "Request-review category",
          kind: "category",
          recommendedName: "Clan Reviews",
          createdRelationship: "haf_configured",
          permissionSummary:
            "Hides the category from @everyone and grants HAF access. Each request ticket explicitly grants requester and reviewer access.",
          create: (name) => this.discord.createCategory({ guildId, name, private: true }),
          apply: (requestReviewCategoryId) => applyConfig({ requestReviewCategoryId }),
        }),
        dependency({
          key: "reviewer_role",
          label: "Clan Reviewer role",
          kind: "role",
          recommendedName: "Clan Reviewer",
          createdRelationship: "haf_configured",
          permissionSummary:
            "Creates a non-mentionable role with no server permissions. HAF grants it access only where Clan review requires it.",
          create: (name) => this.discord.createRole({ guildId, name }),
          apply: (reviewerRoleId) => applyConfig({ reviewerRoleId }),
        }),
      ],
      readConfiguration: async () => {
        const config =
          (await this.clans.readConfig(guildId)) ??
          defaultClanManagementConfig(guildId, this.now());
        return {
          enabled: config.enabled,
          dormant: false,
          resourceIds: {
            managed_category: config.categoryId,
            panel_channel: config.requestPanelChannelId,
            review_category: config.requestReviewCategoryId ?? null,
            reviewer_role: config.reviewerRoleIds[0] ?? null,
          },
        };
      },
      record: async (event, run) => {
        const history: ClanHistoryEvent = {
          id: this.createId(),
          guildId,
          clanId: null,
          requestId: null,
          event: `provisioning.setup-${event}`,
          actorUserId: run.actorUserId,
          reason: run.failureMessage,
          beforeJson: null,
          afterJson: JSON.stringify({
            setupRunId: run.id,
            status: run.status,
            resourceIds: run.resolutions.map((resolution) => resolution.resource.id),
          }),
          createdAtMs: this.now(),
          retentionExpiresAtMs: this.now() + 365 * 24 * 60 * 60 * 1000,
        };
        await this.clans.appendHistory(history);
        await this.postAudit?.(history);
      },
    };
  }
}
