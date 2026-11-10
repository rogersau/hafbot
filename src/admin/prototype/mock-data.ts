/* PROTOTYPE — throwaway. In-memory mock of the admin dashboard's domain data,
   using the real feature vocabulary from CONTEXT.md. No persistence, no API. */

export type FeatureStatus = "active" | "attention" | "setup" | "locked";

export interface Feature {
  id: string;
  name: string;
  group: "Moderation" | "Community" | "Access" | "Integrations";
  status: FeatureStatus;
  metric: string;
  metricLabel: string;
  summary: string;
  spark: number[];
}

export interface AttentionItem {
  id: string;
  featureId: string;
  feature: string;
  title: string;
  detail: string;
  action: string;
  severity: "flag" | "review" | "setup";
}

export const GUILD = {
  name: "The Wrecking Crew",
  handle: "wrecking-crew",
  members: 4812,
  plan: "Pro",
  coverage: 85,
  configuredCount: 11,
  totalCount: 13,
};

export const FEATURES: Feature[] = [
  {
    id: "bot-defense",
    name: "Bot Defense",
    group: "Moderation",
    status: "attention",
    metric: "3",
    metricLabel: "open bot flags",
    summary: "Honeypot + Rate detectors on. 3 flags need staff review.",
    spark: [2, 1, 3, 1, 0, 2, 4, 2, 1, 3, 5, 3],
  },
  {
    id: "reaction-rules",
    name: "Reaction Rules",
    group: "Moderation",
    status: "active",
    metric: "12",
    metricLabel: "blocked emoji",
    summary: "Blocklist of 12 emoji, reaction limit of 5 enforced.",
    spark: [4, 6, 3, 8, 5, 7, 4, 6, 9, 5, 7, 6],
  },
  {
    id: "image-rules",
    name: "Image Rules",
    group: "Moderation",
    status: "attention",
    metric: "1",
    metricLabel: "queued review",
    summary: "Classifying #dayz-media. 1 Uncertain verdict waiting.",
    spark: [1, 0, 2, 1, 1, 0, 1, 2, 1, 0, 1, 1],
  },
  {
    id: "mention-protection",
    name: "Mention Protection",
    group: "Moderation",
    status: "setup",
    metric: "—",
    metricLabel: "not configured",
    summary: "Protect staff from pings and stop mention spam.",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: "evidence-vault",
    name: "Evidence Vault",
    group: "Moderation",
    status: "active",
    metric: "26",
    metricLabel: "records sealed",
    summary: "Audit channel set, 2 access roles configured.",
    spark: [0, 1, 0, 2, 1, 0, 0, 1, 0, 1, 2, 1],
  },
  {
    id: "ban-cases",
    name: "Ban Cases",
    group: "Moderation",
    status: "active",
    metric: "1",
    metricLabel: "open case",
    summary: "1 appeal awaiting a second reviewer.",
    spark: [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1],
  },
  {
    id: "tickets",
    name: "Tickets",
    group: "Community",
    status: "attention",
    metric: "2",
    metricLabel: "open tickets",
    summary: "Panel published in #support. Oldest waiting 6h.",
    spark: [1, 2, 1, 0, 3, 1, 2, 1, 0, 2, 1, 2],
  },
  {
    id: "lfg",
    name: "LFG",
    group: "Community",
    status: "active",
    metric: "4",
    metricLabel: "posts live",
    summary: "Noticeboard live, voice counter channel synced.",
    spark: [3, 5, 2, 6, 4, 3, 5, 2, 4, 6, 3, 4],
  },
  {
    id: "clans",
    name: "Clan Management",
    group: "Community",
    status: "active",
    metric: "8",
    metricLabel: "active clans",
    summary: "1 clan request in the review queue.",
    spark: [1, 0, 1, 2, 1, 0, 1, 1, 2, 0, 1, 1],
  },
  {
    id: "events",
    name: "Events",
    group: "Community",
    status: "setup",
    metric: "⅔",
    metricLabel: "setup steps done",
    summary: "Setup Run paused — pick a publish channel to finish.",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: "marketplace",
    name: "Marketplace",
    group: "Community",
    status: "active",
    metric: "17",
    metricLabel: "listings this week",
    summary: "Noticeboard published, have/want matching on.",
    spark: [5, 3, 6, 4, 7, 5, 3, 6, 8, 4, 5, 7],
  },
  {
    id: "timed-roles",
    name: "Timed Roles",
    group: "Access",
    status: "active",
    metric: "14",
    metricLabel: "active assignments",
    summary: "New-member role expires after 3 days.",
    spark: [2, 3, 1, 2, 4, 2, 3, 1, 2, 3, 2, 4],
  },
  {
    id: "member-verification",
    name: "Member Verification",
    group: "Access",
    status: "active",
    metric: "96%",
    metricLabel: "verify rate",
    summary: "Welcome Panel posted in #gate, Verified Role set.",
    spark: [8, 9, 7, 9, 8, 10, 9, 8, 9, 10, 9, 10],
  },
  {
    id: "playercount",
    name: "Player Count",
    group: "Integrations",
    status: "active",
    metric: "2",
    metricLabel: "servers tracked",
    summary: "Chernarus + Livonia populations in channel names.",
    spark: [6, 7, 5, 8, 6, 7, 9, 6, 7, 8, 6, 7],
  },
];

export const ATTENTION: AttentionItem[] = [
  {
    id: "flags",
    featureId: "bot-defense",
    feature: "Bot Defense",
    title: "3 bot flags open",
    detail: "Latest: @xX_sl4y3r — same message in 6 channels in 45s.",
    action: "Review flags",
    severity: "flag",
  },
  {
    id: "image",
    featureId: "image-rules",
    feature: "Image Rules",
    title: "1 image awaiting review",
    detail: "Uncertain verdict (0.71 off-topic) in #dayz-media.",
    action: "Open mod queue",
    severity: "review",
  },
  {
    id: "tickets",
    featureId: "tickets",
    feature: "Tickets",
    title: "2 tickets waiting",
    detail: "Oldest has had no staff reply for 6 hours.",
    action: "Open tickets",
    severity: "review",
  },
  {
    id: "events",
    featureId: "events",
    feature: "Events",
    title: "Setup Run paused",
    detail: "Step 2 of 3: choose the channel events publish to.",
    action: "Resume setup",
    severity: "setup",
  },
];

export const ACTIVITY = [
  { at: "12m", text: "Bot Flag dismissed for @camper_andy (false positive)" },
  { at: "34m", text: "Timed Role “Trial Mod” expired for @Nova" },
  { at: "1h", text: "LFG post renewed — “NWAF squad, need 2”" },
  { at: "1h", text: "Blocklist reaction removed in #general" },
  { at: "2h", text: "Ticket #118 closed by @moderatr" },
  { at: "2h", text: "New member verified via the Welcome Panel" },
  { at: "3h", text: "Marketplace listing auto-expired (7 days)" },
];

export const BOT_DEFENSE = {
  honeypot: {
    enabled: true,
    channel: "#do-not-post",
    response: "Warn + delete message",
  },
  rate: {
    enabled: true,
    channels: 5,
    windowSeconds: 60,
    response: "Warn only",
  },
  excludedRoles: ["@Admin", "@Moderator", "@Bots"],
  modQueue: "#bot-defense-queue",
  modRoles: ["@Moderator"],
  flags: [
    {
      member: "@xX_sl4y3r",
      detector: "Rate Detector",
      evidence: "Same message in 6 channels in 45s",
      age: "8m ago",
    },
    {
      member: "@crypto_king99",
      detector: "Honeypot Detector",
      evidence: "Posted in #do-not-post",
      age: "26m ago",
    },
    {
      member: "@moon.farmer",
      detector: "Rate Detector",
      evidence: "Same message in 5 channels in 58s",
      age: "1h ago",
    },
  ],
};

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  active: "Configured",
  attention: "Needs you",
  setup: "Set up",
  locked: "Paid tier",
};
