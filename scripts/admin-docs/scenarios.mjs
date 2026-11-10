import { commonResponses, entitlement } from "./fixtures.mjs";

const cards = [
  configured("reaction-rules", "Reaction Rules", "/admin/blocklist", "6 blocked emoji"),
  {
    ...configured("tickets", "Tickets", "/admin/tickets", "Panel configured but not published"),
    readiness: "ready_disabled",
  },
  configured("lfg", "LFG", "/admin/lfg", "Noticeboard published"),
  configured("marketplace", "Marketplace", "/admin/marketplace", "3 categories"),
  configured("evidence-vault", "Evidence Vault", "/admin/evidence-vault", "Audit channel set"),
  {
    ...configured("image-rules", "Image Rules", "/admin/image-rules", "Setup needs attention"),
    readiness: "needs_attention",
  },
  available("mention-protection", "Mention Protection", "/admin/mention-protection"),
  available("member-verification", "Member Verification", "/admin/member-verification"),
  available("bot-defense", "Bot Defense", "/admin/bot-defense"),
  available("player-count", "Player Count", "/admin/playercount"),
  available("ban-cases", "Ban Cases", "/admin/ban-cases"),
  locked("white-label-bot", "White-Label Bot", ""),
];

const overview = {
  name: "admin-overview",
  route: route(""),
  heading: "What needs your attention",
  annotations: [
    annotation(1, { selector: "#sidebar-guild" }, "Current Guild"),
    annotation(2, { selector: ".admin-attention-section" }, "Action queue"),
  ],
  responses: {
    "/admin/api/guild-overview": {
      guildId: "docs-guild",
      tier: "premium",
      cards,
      recommendedNextStep: {
        featureId: "mention-protection",
        title: "Set up Mention Protection",
        description: "Protect administrators and configure responses to unwanted mentions.",
        ctaHref: "/admin/docs-guild/mention-protection",
      },
    },
  },
};

export const scenarios = [
  overview,
  {
    ...overview,
    name: "admin-overview-mobile",
    viewport: { width: 390, height: 844 },
    annotations: [],
  },
  {
    ...overview,
    name: "admin-command-palette",
    openCommandPalette: true,
    annotations: [],
  },
  {
    ...overview,
    name: "admin-guild-switcher",
    openContextSwitcher: true,
    annotations: [],
  },
  {
    ...overview,
    name: "admin-mobile-navigation",
    viewport: { width: 390, height: 844 },
    openMobileNavigation: true,
    annotations: [],
  },
  feature("reaction-rules", "blocklist?tab=blocklist", "Reaction Rules", [
    textAnnotation(1, "Blocklist"),
    textAnnotation(2, "Emoji"),
    textAnnotation(3, "Moderation log channel"),
    annotation(4, { selector: '[data-feature-readiness="blocklist"]' }, "Setup check"),
  ]),
  feature("timed-roles", "timed-roles", "Timed Roles", [
    textAnnotation(1, "Manual assignment"),
    textAnnotation(2, "New member temporary role"),
    textAnnotation(3, "Active timed roles"),
  ]),
  feature("tickets", "tickets?tab=panel", "Tickets", [
    annotation(1, { selector: '[role="tablist"]' }, "Ticket settings tabs"),
    textAnnotation(2, "Panel Settings"),
    textAnnotation(3, "Publish Panel"),
  ]),
  feature("managed-messages", "managed-messages", "Managed Messages", [
    annotation(1, { selector: '[role="tablist"]' }, "Message views"),
    textAnnotation(2, "Existing Messages"),
    textAnnotation(3, "New Managed Message"),
  ]),
  feature("commerce", "commerce?tab=offerings", "Commerce", [
    textAnnotation(1, "Commerce status"),
    annotation(
      2,
      { selector: '[role="tablist"][aria-label="Commerce settings"]' },
      "Commerce settings tabs",
    ),
    textAnnotation(3, "New offering"),
    textAnnotation(4, "Offerings and subscribers"),
  ]),
  {
    ...feature("commerce", "commerce?tab=offerings", "Commerce", []),
    name: "admin-commerce-mobile",
    viewport: { width: 390, height: 844 },
  },
  feature("marketplace", "marketplace", "Marketplace", [
    textAnnotation(1, "Marketplace configuration"),
    textAnnotation(2, "Noticeboard channel"),
    textAnnotation(3, "Log channel"),
  ]),
  feature("lfg", "lfg", "LFG", [
    textAnnotation(1, "LFG configuration"),
    textAnnotation(2, "Noticeboard channel"),
    textAnnotation(3, "Post expiry time"),
  ]),
  feature("events", "events", "Events", [
    textAnnotation(1, "Create an event"),
    textAnnotation(2, "Event title"),
    textAnnotation(3, "Schedule and signups"),
    textAnnotation(4, "Create event"),
  ]),
  feature("player-count", "playercount", "Player Count", [
    textAnnotation(1, "Add server"),
    textAnnotation(2, "Northstar Survival"),
    textAnnotation(3, "Configured servers"),
  ]),
  feature("player-link", "player-link?platform=steam", "Player Link", [
    annotation(1, { selector: ".admin-feature-page h2" }, "Steam Link configuration"),
    textAnnotation(2, "Linked members"),
    textAnnotation(3, "Log channel"),
  ]),
  feature("evidence-vault", "evidence-vault", "Evidence Vault", [
    textAnnotation(1, "Evidence Vault configuration"),
    textAnnotation(2, "Access roles"),
    textAnnotation(3, "Evidence Fields"),
  ]),
  feature("image-rules", "image-rules", "Image Rules", [
    textAnnotation(1, "Image Rules configuration"),
    textAnnotation(2, "Topic description"),
    textAnnotation(3, "Mod queue channel"),
  ]),
  feature("bot-defense", "bot-defense", "Bot Defense", [
    textAnnotation(1, "1. Choose detection signals"),
    textAnnotation(2, "Honeypot channels"),
    textAnnotation(3, "2. Route flags for review"),
  ]),
  feature("mention-protection", "mention-protection", "Mention Protection", [
    textAnnotation(1, "Shared scope and eligibility"),
    textAnnotation(2, "Protected Admin Role(s)"),
    textAnnotation(3, "Mass Mention users"),
  ]),
  feature("member-verification", "member-verification", "Member Verification", [
    textAnnotation(1, "Delivery mode"),
    textAnnotation(2, "Verification method"),
    textAnnotation(3, "Verified Role"),
  ]),
  feature("guild-audit-log", "audit-log", "Guild Audit Log", [
    textAnnotation(1, "Guild Audit Log configuration"),
    textAnnotation(2, "Default audit channel"),
    textAnnotation(3, "Audit Exclusion Policy"),
  ]),
  feature("webhooks", "webhooks", "Webhooks", [
    textAnnotation(1, "Webhook proxy"),
    textAnnotation(2, "Configured webhooks"),
    textAnnotation(3, "Create webhook"),
  ]),
  feature("ban-cases", "ban-cases", "Ban Cases", [
    textAnnotation(1, "Ban Case Sources"),
    textAnnotation(2, "Source Editor"),
    textAnnotation(3, "Forum Channel"),
  ]),
  feature("troubleshooting", "troubleshooting", "Troubleshooting", [
    textAnnotation(1, "Discord diagnostics"),
    textAnnotation(2, "Tickets"),
    textAnnotation(3, "Image Rules Mod Queue"),
  ]),
  feature("guild-settings", "guild-settings", "Guild Settings", [
    textAnnotation(1, "HAF admin role"),
    textAnnotation(2, "Discord role"),
    textAnnotation(3, "Save"),
  ]),
  standalone("profile", "/admin/profile?guildId=docs-guild", "Profile", [
    textAnnotation(1, "Identity"),
    textAnnotation(2, "Guilds"),
    textAnnotation(3, "Appearance"),
  ]),
  {
    name: "admin-global-profile",
    route: "/admin/profile",
    heading: "Profile",
    annotations: [],
    responses: {},
  },
  {
    name: "admin-locked-entitlement",
    route: route("events"),
    heading: "Unlock Events",
    annotations: [],
    responses: {
      "/admin/api/entitlement": {
        ...entitlement,
        tier: "free",
        limits: { ...entitlement.limits, paidFeatures: false },
      },
    },
  },
  standalone("billing", "/admin/billing?guildId=docs-guild", "Billing", [
    textAnnotation(1, "Current plan"),
    textAnnotation(2, "Choose the plan that fits your community"),
    annotation(3, { targetText: "yearly", exact: false }, "Yearly billing"),
  ]),
  focusedFeature("webhooks-test", "webhooks", "Webhooks", "Test configuration", [
    textAnnotation(1, "Test configuration"),
    textAnnotation(2, "Sample payload"),
    textAnnotation(3, "Run test"),
  ]),
  focusedFeature("ban-cases-test", "ban-cases", "Ban Cases", "Test configuration", [
    textAnnotation(1, "Test configuration"),
    textAnnotation(2, "Sample webhook body"),
    textAnnotation(3, "Run test"),
  ]),
  focusedFeature(
    "player-link-test",
    "player-link?platform=steam",
    "Player Link",
    "Test configuration",
    [
      textAnnotation(1, "Test configuration"),
      textAnnotation(2, "Sample SteamID64"),
      textAnnotation(3, "Run test"),
    ],
  ),
];

function feature(name, path, heading, annotations) {
  return { name: `admin-${name}`, route: route(path), heading, annotations, responses: {} };
}

function standalone(name, standaloneRoute, heading, annotations) {
  return {
    name: `admin-${name}`,
    route: standaloneRoute,
    heading,
    annotations,
    responses: {},
  };
}

function focusedFeature(name, path, heading, focusTargetText, annotations) {
  return {
    name: `admin-${name}`,
    route: route(path),
    heading,
    focusTargetText,
    annotations,
    responses: {},
  };
}

function route(path) {
  const [pathname, search] = path.split("?");
  const suffix = pathname ? `/${pathname}` : "";
  return `/admin/docs-guild${suffix}${search ? `?${search}` : ""}`;
}

function annotation(number, target, label) {
  return { number, ...target, label };
}

function textAnnotation(number, targetText) {
  return annotation(number, { targetText }, targetText);
}

function configured(id, label, path, detail) {
  return { id, label, path, status: "configured", detail, locked: false };
}

function available(id, label, path) {
  return { id, label, path, status: "not-set-up", detail: null, locked: false };
}

function locked(id, label, path) {
  return { id, label, path, status: "requires-paid-plan", detail: null, locked: true };
}

export { commonResponses };
