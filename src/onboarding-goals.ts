export type OnboardingGoalKey =
  | "protect_community"
  | "run_staff_operations"
  | "help_members_participate"
  | "connect_players_and_systems"
  | "manage_access_and_communications";

export interface OnboardingGoal {
  key: OnboardingGoalKey;
  label: string;
  prompt: string;
  firstSuccess: string;
  recommendations: readonly {
    featureId: string;
    reason: string;
  }[];
}

export const ONBOARDING_GOALS: readonly OnboardingGoal[] = [
  {
    key: "protect_community",
    label: "Protect the community",
    prompt: "Reduce unwanted content, reactions, mention abuse, and automated accounts.",
    firstSuccess: "A controlled unwanted event is detected or removed.",
    recommendations: [
      {
        featureId: "reaction-rules",
        reason: "Start with a clear rule whose enforcement is easy to observe.",
      },
      {
        featureId: "bot-defense",
        reason: "Add protection against obvious automated-account behavior.",
      },
      {
        featureId: "image-rules",
        reason: "Review image content with a safe dry-run before enforcing it.",
      },
    ],
  },
  {
    key: "run_staff_operations",
    label: "Run staff operations",
    prompt: "Give staff dependable support, evidence, case-review, and audit workflows.",
    firstSuccess: "A staff-visible support or audit artifact is created.",
    recommendations: [
      {
        featureId: "tickets",
        reason: "Give members a private support path and staff a repeatable workflow.",
      },
      {
        featureId: "evidence-vault",
        reason: "Keep sensitive moderation evidence controlled and searchable.",
      },
      {
        featureId: "guild-audit-log",
        reason: "Make important bot and staff actions visible to the team.",
      },
    ],
  },
  {
    key: "help_members_participate",
    label: "Help members participate",
    prompt: "Help members form groups, trade, attend events, verify, or join Clans.",
    firstSuccess: "A member-facing panel or board is published.",
    recommendations: [
      {
        featureId: "lfg",
        reason: "Give members an immediate way to find people to play with.",
      },
      {
        featureId: "marketplace",
        reason: "Create a structured place for member trade listings.",
      },
      {
        featureId: "events",
        reason: "Organize scheduled activities with rosters and reminders.",
      },
    ],
  },
  {
    key: "connect_players_and_systems",
    label: "Connect players and systems",
    prompt: "Link player identities, game servers, and external services to Discord.",
    firstSuccess: "A player or external-system test succeeds.",
    recommendations: [
      {
        featureId: "player-link",
        reason: "Connect Discord members to the identities they use in games.",
      },
      {
        featureId: "player-count",
        reason: "Show live game-server activity inside Discord.",
      },
      {
        featureId: "webhooks",
        reason: "Bring trusted external events into HAF workflows.",
      },
    ],
  },
  {
    key: "manage_access_and_communications",
    label: "Manage access and communications",
    prompt: "Apply temporary access and publish durable Guild communications.",
    firstSuccess: "A controlled role or managed-message action succeeds.",
    recommendations: [
      {
        featureId: "timed-roles",
        reason: "Automate temporary access without manual cleanup.",
      },
      {
        featureId: "managed-messages",
        reason: "Publish Discord information that staff can update in place.",
      },
      {
        featureId: "member-verification",
        reason: "Grant normal Guild access after a member completes verification.",
      },
    ],
  },
];
