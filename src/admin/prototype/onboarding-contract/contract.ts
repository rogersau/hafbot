// PROTOTYPE — throwaway review data for the Feature Onboarding Contract.

import { ONBOARDING_GOALS, type OnboardingGoalKey } from "../../../onboarding-goals";

export { ONBOARDING_GOALS };
export type { OnboardingGoalKey };

export type OnboardingAvailability = "all_plans" | "mixed" | "paid_only";
export type SetupExperience = "guided" | "focused" | "expert";
export type DefaultsPosture = "none" | "suggested" | "template";
export type ResourceSetupPosture = "none" | "optional" | "required";

export interface FeatureOnboardingContract {
  featureKey: string;
  label: string;
  summary: string;
  goals: Array<{
    key: OnboardingGoalKey;
    relevance: "primary" | "secondary";
    recommendationPriority: number;
    reason: string;
  }>;
  availability: OnboardingAvailability;
  setup: {
    entryPath: string;
    experience: SetupExperience;
    estimatedMinutes: [minimum: number, maximum: number];
    defaults: DefaultsPosture;
    resourceSetup: ResourceSetupPosture;
  };
  readinessKey: string;
  verification: null | {
    kind: "safe_test" | "published_artifact" | "observed_event" | "diagnostic";
    label: string;
    successEvidence: string;
  };
  openQuestions: string[];
}

export const FEATURE_ONBOARDING_CONTRACTS: FeatureOnboardingContract[] = [
  {
    featureKey: "reaction-rules",
    label: "Reaction Rules",
    summary: "Block unwanted emoji reactions and optionally enforce reaction limits.",
    goals: [
      primary("protect_community", 1, "Fastest safe Moderation win with an observable removal."),
    ],
    availability: "all_plans",
    setup: setup("/admin/blocklist?tab=blocklist&wizard=1", "guided", 2, 5, "suggested", "none"),
    readinessKey: "reaction-rules",
    verification: verify(
      "observed_event",
      "Try a blocked reaction",
      "The controlled reaction is removed and the optional log receives an enforcement entry.",
    ),
    openQuestions: [
      "Should the first success include Reaction Limits or keep the Blocklist-only path?",
    ],
  },
  {
    featureKey: "tickets",
    label: "Tickets",
    summary: "Publish private member-support panels with staff access and transcripts.",
    goals: [
      primary(
        "run_staff_operations",
        1,
        "A familiar support workflow with a concrete private test ticket.",
      ),
      secondary("help_members_participate", 5, "Gives members a structured way to request help."),
    ],
    availability: "mixed",
    setup: setup("/admin/tickets?tab=panel&wizard=1", "guided", 10, 20, "template", "optional"),
    readinessKey: "tickets",
    verification: verify(
      "published_artifact",
      "Publish and open a private test ticket",
      "The panel exists, the test ticket is private, staff can access it, and closing produces a transcript.",
    ),
    openQuestions: [
      "Should the first success stop after publishing or include the full close/transcript cycle?",
    ],
  },
  {
    featureKey: "timed-roles",
    label: "Timed Roles",
    summary: "Assign Discord roles that expire automatically.",
    goals: [
      primary(
        "manage_access_and_communications",
        1,
        "A small controlled assignment proves access automation quickly.",
      ),
    ],
    availability: "all_plans",
    setup: setup("/admin/timed-roles", "focused", 3, 8, "suggested", "none"),
    readinessKey: "timed-roles",
    verification: verify(
      "safe_test",
      "Assign a short-lived test role",
      "The selected test member receives the role and the expiry is scheduled.",
    ),
    openQuestions: ["What minimum expiry is safe and useful for a first-run test?"],
  },
  {
    featureKey: "managed-messages",
    label: "Managed Messages",
    summary: "Draft, schedule, publish, and repair durable Discord messages.",
    goals: [
      primary(
        "manage_access_and_communications",
        2,
        "Publishing one managed message creates an immediate visible result.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/managed-messages", "focused", 5, 10, "template", "none"),
    readinessKey: "managed-messages",
    verification: verify(
      "published_artifact",
      "Publish a starter managed message",
      "The message is visible in the selected Discord channel and can be opened from the dashboard.",
    ),
    openQuestions: [],
  },
  {
    featureKey: "marketplace",
    label: "Marketplace",
    summary: "Publish a member-facing board for structured trade listings.",
    goals: [
      primary(
        "help_members_participate",
        3,
        "A published board gives trading communities an immediate member surface.",
      ),
    ],
    availability: "all_plans",
    setup: setup("/admin/marketplace", "focused", 7, 12, "template", "optional"),
    readinessKey: "marketplace",
    verification: verify(
      "published_artifact",
      "Publish the Marketplace board",
      "The board is visible and its create-listing action opens for a test member.",
    ),
    openQuestions: [],
  },
  {
    featureKey: "lfg",
    label: "LFG",
    summary: "Publish member-created looking-for-group posts with optional voice coordination.",
    goals: [
      primary(
        "help_members_participate",
        1,
        "A broadly useful gaming-community flow with a visible noticeboard.",
      ),
    ],
    availability: "all_plans",
    setup: setup("/admin/lfg", "focused", 7, 12, "template", "optional"),
    readinessKey: "lfg",
    verification: verify(
      "published_artifact",
      "Publish and try the LFG noticeboard",
      "The noticeboard is visible and a controlled LFG post can be created.",
    ),
    openQuestions: [
      "Should LFG become the medium-complexity guided-flow reference implementation?",
    ],
  },
  {
    featureKey: "clans",
    label: "Clan Management",
    summary: "Run persistent member teams with managed roles, channels, and request review.",
    goals: [
      primary(
        "help_members_participate",
        4,
        "High-value for established communities but consequential as a first setup.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/clans", "guided", 15, 25, "template", "required"),
    readinessKey: "clans",
    verification: verify(
      "published_artifact",
      "Publish and submit a test Clan Request",
      "The creation panel is visible and a test request reaches the Clan Request Mod Queue.",
    ),
    openQuestions: [
      "Should this be hidden from first recommendations unless the admin explicitly chooses Clans?",
    ],
  },
  {
    featureKey: "events",
    label: "Events",
    summary: "Publish scheduled rosters with signup groups, capacity, waitlists, and reminders.",
    goals: [
      primary(
        "help_members_participate",
        2,
        "A test event demonstrates a rich member-facing outcome.",
      ),
      secondary("run_staff_operations", 6, "Helps staff organize scheduled community activity."),
    ],
    availability: "paid_only",
    setup: setup("/admin/events", "focused", 7, 15, "template", "none"),
    readinessKey: "events",
    verification: verify(
      "published_artifact",
      "Publish a test event",
      "The event embed is visible and a test member can join a Signup Group.",
    ),
    openQuestions: [
      "Should a paid-only feature ever rank above an available all-plan recommendation?",
    ],
  },
  {
    featureKey: "player-count",
    label: "Player Count",
    summary: "Keep Discord channel names synchronized with live game-server population.",
    goals: [
      primary(
        "connect_players_and_systems",
        2,
        "A reachability check gives immediate integration feedback.",
      ),
    ],
    availability: "paid_only",
    setup: setup("/admin/playercount", "expert", 8, 15, "suggested", "optional"),
    readinessKey: "player-count",
    verification: verify(
      "safe_test",
      "Test server reachability",
      "HAF reads a live player snapshot and can update the selected status channel.",
    ),
    openQuestions: ["Is 'expert' too discouraging for common supported game servers?"],
  },
  {
    featureKey: "player-link",
    label: "Player Link",
    summary: "Connect Discord members to Steam, Xbox, and PlayStation identities.",
    goals: [
      primary(
        "connect_players_and_systems",
        1,
        "Identity linking unlocks several downstream community workflows.",
      ),
      secondary(
        "help_members_participate",
        6,
        "Linked identity can improve member trust and discovery.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/player-link?platform=steam", "focused", 8, 15, "template", "optional"),
    readinessKey: "player-link",
    verification: verify(
      "published_artifact",
      "Publish the link panel and link a test account",
      "The test member completes provider linking and receives configured linked roles.",
    ),
    openQuestions: [
      "Should the goal ask for the primary platform before recommending Player Link?",
    ],
  },
  {
    featureKey: "evidence-vault",
    label: "Evidence Vault",
    summary: "Store staff-only evidence records with controlled access and auditing.",
    goals: [
      primary("run_staff_operations", 3, "Creates a repeatable staff evidence workflow."),
      secondary("protect_community", 6, "Supports staff handling after Moderation events."),
    ],
    availability: "mixed",
    setup: setup("/admin/evidence-vault", "focused", 8, 15, "suggested", "optional"),
    readinessKey: "evidence-vault",
    verification: verify(
      "diagnostic",
      "Check Evidence Vault access",
      "The setup diagnostic confirms the configured roles and audit channel are usable.",
    ),
    openQuestions: [
      "Does a diagnostic qualify as Onboarding Verification without creating a test record?",
    ],
  },
  {
    featureKey: "image-rules",
    label: "Image Rules",
    summary: "Classify image attachments against a Guild topic with dry-run and review controls.",
    goals: [
      primary(
        "protect_community",
        3,
        "Dry-run mode offers a safer path into automated image enforcement.",
      ),
    ],
    availability: "paid_only",
    setup: setup("/admin/image-rules", "focused", 10, 20, "suggested", "optional"),
    readinessKey: "image-rules",
    verification: verify(
      "safe_test",
      "Run a dry-run image check",
      "A controlled image receives an Image Rule Verdict without destructive enforcement.",
    ),
    openQuestions: [],
  },
  {
    featureKey: "bot-defense",
    label: "Bot Defense",
    summary: "Detect automated accounts with Honeypot and repeated-message signals.",
    goals: [
      primary(
        "protect_community",
        2,
        "The free Honeypot offers a concrete low-false-positive first defense.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/bot-defense", "focused", 7, 15, "suggested", "optional"),
    readinessKey: "bot-defense",
    verification: verify(
      "observed_event",
      "Send a controlled Honeypot message",
      "The message raises a Bot Flag in the configured Bot Defense Mod Queue.",
    ),
    openQuestions: [
      "Should a controlled Honeypot event require an explicit warning about the test member?",
    ],
  },
  {
    featureKey: "mention-protection",
    label: "Mention Protection",
    summary: "Protect administrators and members from mention abuse and escalation patterns.",
    goals: [
      primary(
        "protect_community",
        4,
        "Useful protection, but a destructive live test needs careful design.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/mention-protection", "focused", 7, 15, "suggested", "none"),
    readinessKey: "mention-protection",
    verification: verify(
      "diagnostic",
      "Check Mention Protection readiness",
      "The setup diagnostic confirms protected roles, channel scope, and response prerequisites.",
    ),
    openQuestions: [
      "Define a non-destructive Onboarding Verification before presenting this as a first success.",
    ],
  },
  {
    featureKey: "member-verification",
    label: "Member Verification",
    summary: "Publish a Verify flow that grants a configured Discord role.",
    goals: [
      primary(
        "help_members_participate",
        5,
        "A visible Verify panel and role assignment are easy to understand.",
      ),
      secondary(
        "manage_access_and_communications",
        3,
        "Controls the role that unlocks normal Guild participation.",
      ),
    ],
    availability: "mixed",
    setup: setup("/admin/member-verification", "focused", 6, 12, "template", "optional"),
    readinessKey: "member-verification",
    verification: verify(
      "published_artifact",
      "Publish and try the Verify panel",
      "A test member can verify and receives the configured Verified Role.",
    ),
    openQuestions: [],
  },
  {
    featureKey: "guild-audit-log",
    label: "Guild Audit Log",
    summary: "Send HAF workflow and Discord event history to predictable audit destinations.",
    goals: [
      primary(
        "run_staff_operations",
        2,
        "A shared audit destination improves every later staff workflow.",
      ),
      secondary("protect_community", 5, "Makes automated enforcement more observable to staff."),
    ],
    availability: "all_plans",
    setup: setup("/admin/audit-log", "focused", 3, 8, "suggested", "optional"),
    readinessKey: "guild-audit-log",
    verification: verify(
      "safe_test",
      "Send a test audit event",
      "A labelled test entry appears in the configured Guild Audit Log channel.",
    ),
    openQuestions: ["Does a safe test-audit endpoint exist, or is this new feature work?"],
  },
  {
    featureKey: "webhooks",
    label: "Webhooks",
    summary: "Receive, transform, and route external webhook payloads into Discord.",
    goals: [
      primary(
        "connect_players_and_systems",
        3,
        "Powerful integration path for admins who already have a source payload.",
      ),
    ],
    availability: "paid_only",
    setup: setup("/admin/webhooks", "expert", 15, 30, "none", "none"),
    readinessKey: "webhooks",
    verification: verify(
      "safe_test",
      "Evaluate and deliver a test payload",
      "The evaluator shows the selected destinations and a controlled payload reaches Discord.",
    ),
    openQuestions: [
      "Should Webhooks be discoverable only after the admin selects an integration-oriented goal?",
    ],
  },
  {
    featureKey: "ban-cases",
    label: "Ban Cases",
    summary: "Turn game-server ban webhooks into structured staff review threads.",
    goals: [
      primary(
        "run_staff_operations",
        4,
        "Useful specialist workflow for communities operating game servers.",
      ),
      secondary(
        "connect_players_and_systems",
        4,
        "Connects external ban sources to Discord review.",
      ),
    ],
    availability: "paid_only",
    setup: setup("/admin/ban-cases", "expert", 15, 30, "none", "optional"),
    readinessKey: "ban-cases",
    verification: verify(
      "safe_test",
      "Send a controlled Ban Case webhook",
      "A labelled test case opens in the configured private Forum with the expected mod access.",
    ),
    openQuestions: ["Should a synthetic test case be deleted automatically after verification?"],
  },
];

function primary(key: OnboardingGoalKey, recommendationPriority: number, reason: string) {
  return { key, relevance: "primary" as const, recommendationPriority, reason };
}

function secondary(key: OnboardingGoalKey, recommendationPriority: number, reason: string) {
  return { key, relevance: "secondary" as const, recommendationPriority, reason };
}

function setup(
  entryPath: string,
  experience: SetupExperience,
  minimum: number,
  maximum: number,
  defaults: DefaultsPosture,
  resourceSetup: ResourceSetupPosture,
) {
  return {
    entryPath,
    experience,
    estimatedMinutes: [minimum, maximum] as [number, number],
    defaults,
    resourceSetup,
  };
}

function verify(
  kind: NonNullable<FeatureOnboardingContract["verification"]>["kind"],
  label: string,
  successEvidence: string,
) {
  return { kind, label, successEvidence };
}

export function contractsForGoal(goalKey: OnboardingGoalKey) {
  return FEATURE_ONBOARDING_CONTRACTS.filter((contract) =>
    contract.goals.some((goal) => goal.key === goalKey),
  ).toSorted((left, right) => {
    const leftGoal = left.goals.find((goal) => goal.key === goalKey)!;
    const rightGoal = right.goals.find((goal) => goal.key === goalKey)!;
    if (leftGoal.relevance !== rightGoal.relevance)
      return leftGoal.relevance === "primary" ? -1 : 1;
    return leftGoal.recommendationPriority - rightGoal.recommendationPriority;
  });
}

export function goalMeta(goalKey: OnboardingGoalKey) {
  return ONBOARDING_GOALS.find((goal) => goal.key === goalKey)!;
}
