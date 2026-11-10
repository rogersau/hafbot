import { defineConfig, type HeadConfig } from "vitepress";

export default defineConfig({
  title: "HAF Bot Docs",
  description:
    "Set up HAF Bot for your gaming Discord: tickets, player links, moderation and community workflows, with current plan limits and troubleshooting.",
  lang: "en-AU",
  cleanUrls: true,

  appearance: "dark",
  lastUpdated: true,
  sitemap: {
    hostname: "https://docs.hafbot.xyz",
    transformItems: (items) =>
      items.filter((item) => !/(^|\/)(404|features\/steam-link)(\.html)?$/.test(item.url)),
  },
  transformPageData(pageData) {
    const head: HeadConfig[] = (pageData.frontmatter.head ??= []);
    if (pageData.relativePath === "404.md") {
      head.push(["meta", { name: "robots", content: "noindex" }]);
      return;
    }
    // Preserve the canonical/noindex on legacy pages. Page data also updates on client navigation.
    const existingCanonical = head.find(
      ([tag, attrs]) => tag === "link" && attrs.rel === "canonical",
    );
    const canonical =
      existingCanonical?.[1].href ??
      `https://docs.hafbot.xyz/${pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
    if (!existingCanonical) head.push(["link", { rel: "canonical", href: canonical }]);
    const title =
      pageData.relativePath === "index.md" ? "HAF Bot Docs" : `${pageData.title} | HAF Bot Docs`;
    const metadata = [
      ["property", "og:type", "website"],
      ["property", "og:site_name", "HAF Bot Docs"],
      ["property", "og:title", title],
      ["property", "og:description", pageData.description],
      ["property", "og:url", canonical],
      ["property", "og:image", "https://hafbot.xyz/banner.png"],
      ["property", "og:image:alt", "HAF Bot — Helpful as F**K"],
      ["name", "twitter:card", "summary_large_image"],
      ["name", "twitter:title", title],
      ["name", "twitter:description", pageData.description],
      ["name", "twitter:image", "https://hafbot.xyz/banner.png"],
    ];
    for (const [attribute, key, content] of metadata) {
      if (!head.some(([tag, attrs]) => tag === "meta" && attrs[attribute] === key)) {
        head.push(["meta", { [attribute]: key, content }]);
      }
    }
  },

  head: [
    ["link", { rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Oxanium:wght@400;500;600;700;800&display=swap",
        rel: "stylesheet",
      },
    ],
  ],

  themeConfig: {
    logo: "/logo.png",
    siteTitle: "HAF Bot Docs",
    search: {
      provider: "local",
    },
    lastUpdated: {
      text: "Last updated",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },

    nav: [
      {
        text: "Guides",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Self-host with Docker", link: "/self-hosting" },
          { text: "Deploy with Cloudflare", link: "/deploy-cloudflare" },
          { text: "WARDOGS Community", link: "/guides/wardogs-discord-community" },
          { text: "Admin Dashboard", link: "/admin-dashboard" },
          { text: "Features", link: "/features/player-link" },
          { text: "Commands", link: "/commands" },
        ],
      },
      { text: "Plans", link: "/plans" },
      { text: "Open Dashboard", link: "https://hafbot.xyz/admin" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Getting Started", link: "/getting-started" },
          { text: "Self-host with Docker", link: "/self-hosting" },
          { text: "Deploy with Cloudflare", link: "/deploy-cloudflare" },
          { text: "Admin Dashboard", link: "/admin-dashboard" },
          { text: "Configuration", link: "/configuration" },
          { text: "Discord Commands", link: "/commands" },
        ],
      },
      {
        text: "Community Guides",
        items: [
          { text: "WARDOGS Community", link: "/guides/wardogs-discord-community" },
          { text: "Discord Ticket Bot", link: "/guides/discord-ticket-bot" },
          { text: "DayZ Community", link: "/guides/dayz-discord-bot" },
        ],
      },
      {
        text: "Identity & Community",
        items: [
          { text: "Player Link", link: "/features/player-link" },
          { text: "Member Verification", link: "/features/member-verification" },
          { text: "Clan Management", link: "/features/clan-management" },
          { text: "Suggestions", link: "/features/suggestions" },
          { text: "Events", link: "/features/events" },
          { text: "Reputation", link: "/features/reputation" },
          { text: "Custom Replies and Schedules", link: "/features/automation" },
          { text: "Content Feeds", link: "/features/content-feeds" },
          { text: "Chat Moderation", link: "/features/chat-moderation" },
          { text: "Ban Appeals", link: "/features/ban-appeals" },
          { text: "LFG", link: "/features/lfg" },
          { text: "Commerce", link: "/features/commerce" },
          { text: "Marketplace", link: "/features/marketplace" },
          { text: "Tickets", link: "/features/tickets" },
        ],
      },
      {
        text: "Moderation & Cases",
        items: [
          { text: "Reaction Rules", link: "/features/reaction-rules" },
          { text: "Blocklist", link: "/features/blocklist" },
          { text: "Reaction Limits", link: "/features/reaction-limits" },
          { text: "Mention Protection", link: "/features/mention-protection" },
          { text: "Image Rules", link: "/features/image-rules" },
          { text: "Bot Defense", link: "/features/bot-defense" },
          { text: "Ban Cases", link: "/features/ban-cases" },
          { text: "Evidence Vault", link: "/features/evidence-vault" },
          { text: "Guild Audit Log", link: "/features/guild-audit-log" },
          { text: "Channel Permissions", link: "/features/channel-permissions" },
        ],
      },
      {
        text: "Automation",
        items: [
          { text: "Reaction Roles", link: "/features/reaction-roles" },
          { text: "Timed Roles", link: "/features/timed-roles" },
          { text: "Managed Messages", link: "/features/managed-messages" },
          { text: "Player Count", link: "/features/player-count" },
          { text: "Server Levels (Beta)", link: "/features/server-levels" },
          { text: "Webhooks", link: "/features/webhook-proxy" },
        ],
      },
      {
        text: "Plans",
        items: [
          { text: "Guild Commerce Pilot", link: "/features/commerce" },
          { text: "Compare Plans", link: "/plans" },
          { text: "Billing & Entitlements", link: "/features/premium-entitlements" },
        ],
      },
    ],
  },
});
