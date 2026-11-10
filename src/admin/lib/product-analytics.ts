export type DashboardMilestoneAction =
  | "guild_selected"
  | "onboarding_goal_selected"
  | "upgrade_viewed"
  | "upgrade_started"
  | "help_opened";

export type DashboardAnalyticsFeature =
  | "reaction_rules"
  | "tickets"
  | "lfg"
  | "member_verification"
  | "player_link"
  | "server_levels";

export async function reportDashboardMilestone(input: {
  guildId: string;
  workspaceId?: string;
  action: DashboardMilestoneAction;
  feature?: DashboardAnalyticsFeature;
}): Promise<void> {
  if (!input.guildId) return;
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
  await crossCuttingClient.createProductAnalyticsEvent({
    event: "milestone",
    guildId: input.guildId,
    workspaceId: input.workspaceId || undefined,
    action: input.action,
    feature: input.feature,
  });
}
