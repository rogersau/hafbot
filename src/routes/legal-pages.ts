import type { SelfHostedSite } from "../runtime/self-hosted-site";

const DISCORD_INVITE = "https://discord.gg/HpRPkdm6dv";

const LEGAL_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  color-scheme: dark;
  --background: 220 70% 3%;
  --foreground: 230 100% 98%;
  --card: 220 60% 8%;
  --card-foreground: 230 100% 98%;
  --primary: 230 100% 98%;
  --primary-foreground: 220 60% 8%;
  --secondary: 220 40% 13%;
  --secondary-foreground: 230 100% 98%;
  --muted: 220 40% 13%;
  --muted-foreground: 220 20% 70%;
  --accent: 230 100% 70%;
  --accent-foreground: 230 100% 98%;
  --border: 220 40% 18%;
  --ring: 230 100% 70%;
  --radius: 0.5rem;
}
html, body { min-height: 100%; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background:
    radial-gradient(circle at 72% -18%, hsl(var(--accent) / 0.16), transparent 34rem),
    linear-gradient(180deg, #050b17 0%, hsl(var(--background)) 100%);
  background-attachment: fixed;
  color: hsl(var(--muted-foreground));
  line-height: 1.7;
  margin: 0;
}
a { color: hsl(var(--accent)); text-decoration: none; }
a:hover { color: hsl(var(--accent-foreground)); text-decoration: underline; }
header { background: hsl(var(--card) / 0.7); border-bottom: 1px solid hsl(var(--border) / 0.6); backdrop-filter: blur(8px); }
.header-inner { max-width: 72rem; margin: 0 auto; padding: 1rem 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.brand-wrap { display: flex; align-items: center; gap: 0.75rem; text-decoration: none; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; border-radius: 9999px; border: 2px solid hsl(var(--accent)); background: hsl(var(--secondary)); color: hsl(var(--foreground)); font-family: "Oxanium", sans-serif; font-size: 0.75rem; font-weight: 900; box-shadow: inset 0 0 0 4px hsl(var(--accent) / 0.12), 0 0 24px hsl(var(--accent) / 0.24); }
.brand-text { display: flex; flex-direction: column; line-height: 1.1; }
.brand-eyebrow { font-family: "Oxanium", sans-serif; font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; color: hsl(var(--muted-foreground)); }
.brand-name { font-family: "Oxanium", sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: -0.02em; color: hsl(var(--foreground)); }
nav { display: flex; align-items: center; gap: 1.5rem; font-family: "Oxanium", sans-serif; font-size: 0.875rem; font-weight: 600; }
nav a { color: hsl(var(--muted-foreground)); }
nav a:hover { color: hsl(var(--foreground)); text-decoration: none; }
main { max-width: 65ch; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
h1 { font-family: "Oxanium", sans-serif; font-size: 1.875rem; font-weight: 800; color: hsl(var(--foreground)); margin: 0 0 0.5rem; letter-spacing: -0.025em; }
.subtitle { font-family: "Oxanium", sans-serif; color: hsl(var(--muted-foreground)); margin-bottom: 2rem; font-size: 0.875rem; font-weight: 500; }
h2 { font-family: "Oxanium", sans-serif; font-size: 1.25rem; font-weight: 700; margin-top: 2.5rem; margin-bottom: 0.75rem; color: hsl(var(--foreground)); letter-spacing: -0.01em; }
p { margin: 0.75rem 0; }
ul { margin: 0.5rem 0; padding-left: 1.25rem; color: hsl(var(--muted-foreground)); }
li { margin: 0.35rem 0; }
strong { color: hsl(var(--foreground)); }
hr { border: 0; border-top: 1px solid hsl(var(--border) / 0.6); margin: 2.5rem 0; }
.callout { background: hsl(var(--card) / 0.6); border: 1px solid hsl(var(--border)); border-left: 3px solid hsl(var(--accent) / 0.6); border-radius: var(--radius); padding: 1rem 1.25rem; margin: 1.5rem 0; }
footer { border-top: 1px solid hsl(var(--border) / 0.6); padding: 2rem 1.5rem; }
.footer-inner { max-width: 72rem; margin: 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 1rem; font-size: 0.875rem; color: hsl(var(--muted-foreground)); }
.footer-links { display: flex; align-items: center; gap: 1.5rem; }
.footer-links a { color: hsl(var(--muted-foreground)); }
.footer-links a:hover { color: hsl(var(--foreground)); text-decoration: none; }
@media (min-width: 640px) { .footer-inner { flex-direction: row; } }
`;

function legalHead(
  title: "Terms of Service" | "Privacy Policy",
  publicUrl = "https://hafbot.xyz",
  descriptionOverride?: string,
): string {
  const privacy = title === "Privacy Policy";
  const url = new URL(privacy ? "/privacy" : "/terms", publicUrl).href;
  const description =
    descriptionOverride ??
    (privacy
      ? "How HAF Bot handles Discord and platform-link data, support transcripts, evidence, analytics and privacy requests."
      : "HAF Bot service terms for Discord community administrators, including paid features, responsibilities, limitations and support.");
  return `<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - HAF Bot</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title} - HAF Bot">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${new URL("/banner.png", publicUrl).href}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<style>${LEGAL_STYLES}</style>
</head>`;
}

function legalHeader(crossLink: { href: string; label: string }): string {
  return `<header>
  <div class="header-inner">
    <a href="/" class="brand-wrap">
      <span class="brand-mark">HAF</span>
      <span class="brand-text">
        <span class="brand-eyebrow">HAF Bot</span>
        <span class="brand-name">Helpful as F**K</span>
      </span>
    </a>
    <nav>
      <a href="/">Home</a>
      <a href="/admin">Dashboard</a>
      <a href="${crossLink.href}">${crossLink.label}</a>
    </nav>
  </div>
</header>`;
}

const LEGAL_FOOTER = `<footer>
  <div class="footer-inner">
    <span>HAF Bot</span>
    <div class="footer-links">
      <a href="/terms">Terms of Service</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/admin">Admin Dashboard</a>
    </div>
  </div>
</footer>`;

export const TERMS_OF_SERVICE_HTML = `<!DOCTYPE html>
<html lang="en">
${legalHead("Terms of Service")}
<body>
${legalHeader({ href: "/privacy", label: "Privacy Policy" })}
<main>
<h1>Terms of Service</h1>
<p class="subtitle">Last updated: July 30, 2026</p>

<h2>1. Acceptance of Terms</h2>
<p>By inviting or using HAF Bot ("Helpful as F**K", the "Bot"), you agree to be bound by these Terms of Service. If you do not agree, you may not use the Bot.</p>

<h2>2. Description of Service</h2>
<p>The Bot is a community Discord management system that provides the following features, configurable per server (guild):</p>
<ul>
  <li><strong>Reaction Rules</strong> — blocklist of forbidden emoji and per-user reaction limits, enforced automatically.</li>
  <li><strong>Image Rules</strong> — classification of image attachments against a guild-defined topic, with auto-deletion, a staff review queue, and dry-run tuning.</li>
  <li><strong>LFG</strong> — a looking-for-group noticeboard with auto-expiring posts, renewals, notification roles, and optional private voice channels.</li>
  <li><strong>Marketplace</strong> — a member-authored trade offer board with have/want listings.</li>
  <li><strong>Tickets</strong> — private support channels with ticket panels, transcripts, and AI transcript summaries.</li>
  <li><strong>Suggestions</strong> — a member-driven suggestion board backed by a Discord forum, with votes, discussion, and staff-adjudicated outcomes.</li>
  <li><strong>Timed Roles</strong> — time-limited role assignments that expire automatically.</li>
  <li><strong>Evidence Vault</strong> — auditable storage for sensitive staff evidence with restricted access.</li>
  <li><strong>Player Link</strong> — linking of Discord accounts to Steam, Xbox, and PlayStation identities, with optional Steam game-ownership checks.</li>
  <li><strong>Player Count</strong> — live game server player counts mirrored into Discord voice channel names via the Steam Web API.</li>
  <li><strong>Webhooks</strong> — inbound webhook proxying with routing and payload rules.</li>
  <li><strong>Guild Audit Log</strong> — a guild-wide audit destination for HAF workflows and Discord events.</li>
</ul>
<p>The Bot also provides an admin dashboard for guild configuration. Platform operator actions are restricted to the configured private Admin Discord guild.</p>

<h2>3. User Obligations</h2>
<p>You must comply with the Discord Terms of Service and Community Guidelines. You must have the necessary permissions (Administrator or Manage Guild, unless otherwise indicated) in any Discord server where you add or configure the Bot. You are responsible for the content your members post and for configuring the Bot's features in accordance with applicable law and your community's rules.</p>

<h2>4. Prohibited Uses</h2>
<p>You may not use the Bot to harass, abuse, or violate the rights of others. You may not attempt to exploit, reverse-engineer, or interfere with the Bot's operation. The Evidence Vault and other moderation features must not be used to store or distribute unlawful content.</p>

<h2>5. Paid Features and Billing</h2>
<p>Some features are gated behind paid plans. Payments are processed by Stripe; HAF does not store complete payment-card details. Billing projects each assigned Guild's effective Free, Premium, or Premium Plus plan. Access may enter a time-limited Grace state after a payment failure and can be restricted or ended under the subscription terms shown in Billing.</p>

<h2>6. Intellectual Property</h2>
<p>The Bot's source code is provided under the MIT open-source license. All rights not expressly granted are reserved. Discord and Steam are trademarks of their respective owners and are not affiliated with this project.</p>

<h2>7. Termination</h2>
<p>We reserve the right to disable or restrict access to the Bot for any server or user at our sole discretion, without prior notice. You may stop using the Bot and remove it from your server at any time.</p>

<h2>8. Disclaimer of Warranties</h2>
<p>The Bot is provided "as is" without warranties of any kind. We do not guarantee uninterrupted or error-free service. Automated moderation (including Image Rules classification) may produce false positives or false negatives and is an aid to, not a replacement for, human judgment.</p>

<h2>9. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, we shall not be liable for any indirect, incidental, or consequential damages arising from the use of the Bot.</p>

<h2>10. Changes to Terms</h2>
<p>We may update these Terms at any time. Continued use of the Bot after changes constitutes acceptance of the revised Terms.</p>

<h2>11. Contact</h2>
<p>For questions about these Terms, please join our <a href="${DISCORD_INVITE}">support server</a>.</p>
</main>
${LEGAL_FOOTER}
</body>
</html>`;

export const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="en">
${legalHead("Privacy Policy")}
<body>
${legalHeader({ href: "/terms", label: "Terms of Service" })}
<main>
<h1>Privacy Policy</h1>
<p class="subtitle">Last updated: November 10, 2026</p>

<h2>1. Introduction</h2>
<p>This Privacy Policy explains how HAF Bot ("Helpful as F**K", the "Bot", "we", "us", "our") collects, uses, and protects information. "We" and "us" refer to the HAF Bot operator, who is the data controller for information processed by the Bot.</p>

<h2>2. Information We Collect</h2>
<p>We collect and process the following categories of data, which are necessary to operate the Bot:</p>
<ul>
  <li><strong>Discord identifiers</strong> — user IDs, guild IDs, channel IDs, role IDs, and message IDs, used to apply configuration and enforce rules.</li>
  <li><strong>Discord profile data</strong> — when you sign in to the admin dashboard with Discord, we receive your display name, email address, and avatar URL (via Discord OAuth with the <code>identify</code>, <code>email</code>, and <code>guilds</code> scopes).</li>
  <li><strong>Authentication and session data</strong> — OAuth access and refresh tokens, session tokens, IP address, and user agent, stored to keep you signed in.</li>
  <li><strong>User-generated content</strong> — LFG posts, marketplace listings, suggestion submissions, and the answers and messages your members post in tickets.</li>
  <li><strong>Ticket transcripts</strong> — the full message content and attachments from a ticket channel, rendered as an HTML transcript and archived (including attachments) in Cloudflare R2 object storage when a ticket is closed.</li>
  <li><strong>Evidence Vault records</strong> — when staff hide a message, the Bot stores the source message text, extracted links, attached images (archived in R2), author and hider identifiers, and any inferred subject identifiers (Discord, Steam, Xbox, PlayStation, or CfTools IDs).</li>
  <li><strong>Platform link data</strong> — SteamID64 (via Steam OpenID), Xbox gamertag/XUID (via Microsoft OAuth), and self-reported PSN Online ID. For Steam links, optional game ownership data (game names and playtime) may also be stored.</li>
  <li><strong>Image Rules metadata</strong> — confidence scores and the Discord CDN URL for classified images. Image files themselves are not stored by Image Rules; only the Discord-hosted URL is retained.</li>
  <li><strong>Chat Moderation records</strong> — staff and member identifiers, action times, rule violations, staff reasons and member reports. Ordinary message text is evaluated for enabled rules; moderation history records the action and reason. Message-rate observations expire after two days.</li>
  <li><strong>Discord ban appeals</strong> — the appellant's Discord identity and display name, appeal text, original ban reason, private reviewer notes, decisions and unban operation records. Appellants can see their own latest submission and outcome; staff review data remains private.</li>
  <li><strong>Reputation records</strong> — giver and recipient identifiers, optional thanks reasons, award times, scores, cooldowns and role-reward delivery records. Public profiles and leaderboards show aggregate scores and display names.</li>
  <li><strong>Configuration data</strong> — the settings you submit through the admin dashboard for each feature.</li>
  <li><strong>Product analytics</strong> — cookieless public page views and pseudonymous Guild-level setup and feature outcomes. Public events may include a canonical page path, referrer domain, allowlisted campaign values, coarse device and browser family, and country. Guild events use an HMAC-derived identifier and never include Discord content or raw Discord identifiers.</li>
</ul>

<h2>3. How We Use Your Information</h2>
<p>We use this information to operate and provide the Bot's features, authenticate administrators, enforce guild rules, generate transcripts, link external platform identities, display live game server stats, and understand aggregate product adoption and friction. We do not use your information for advertising.</p>

<h2>4. Data Sharing and Sub-Processors</h2>
<p>We do not sell your data. To provide the Bot's features, information is shared with the following third parties:</p>
<ul>
  <li><strong>Discord</strong> — via the Discord API and Gateway, as required for all bot functionality.</li>
  <li><strong>Steam / Valve</strong> — via Steam OpenID (to verify SteamID64 ownership) and the Steam Web API (for player counts, optional game ownership checks, and ban lookups).</li>
  <li><strong>Microsoft / Xbox Live</strong> — via OAuth and Xbox Live APIs, to verify and resolve Xbox identities when a member links an Xbox account.</li>
  <li><strong>AI classifier service</strong> — when Image Rules is enabled, the Discord CDN URL of an image is sent to the operator-configured classifier endpoint. The image file itself is not uploaded by the Bot; the CDN URL is sent for classification.</li>
  <li><strong>AI transcript summarizer</strong> — when AI Transcript Summary is enabled, the text of a closed ticket's transcript is sent to the operator-configured summarizer endpoint to produce a short summary.</li>
  <li><strong>Sentry</strong> — if the operator has enabled error tracking, error reports may include request metadata such as IP addresses or user identifiers.</li>
  <li><strong>PostHog</strong> — managed product analytics receives only the bounded cookieless and pseudonymous events described above. Autocapture, session replay, surveys, and person profiles are disabled. Processing occurs in the explicitly selected PostHog region.</li>
  <li><strong>Google Fonts</strong> — the admin dashboard and landing page load the Oxanium font in your browser, which sends your IP address and user agent to Google. This is a browser-side request and no Bot data is transmitted.</li>
</ul>
<p>Steam, Xbox, and PlayStation are third-party services with their own privacy policies; linking an account is subject to those services' terms.</p>

<h2>5. Data Retention</h2>
<p>Feature configuration and platform link records are retained until you delete them through the admin dashboard or remove the Bot from your guild. Pending (uncompleted) platform links expire automatically. Timed role assignments expire on schedule.</p>
<div class="callout">
  <p>Ticket transcript links expire automatically after <strong>30 days</strong>. The archived transcript and its attachments are automatically deleted from R2 after <strong>365 days</strong>. Evidence Vault records are not automatically deleted and must be removed manually by an administrator or via a request to our support server.</p>
</div>
<p>Disabling Chat Moderation, Discord Ban Appeals or Reputation preserves existing records. Moderation history and appeal decisions have no automatic expiry. Verified Reputation erasure requests remove the member's score, cooldown and pending rewards and anonymize their identities and reasons in award records; anonymous interaction receipts remain to prevent replay. Requests concerning these records can be made through the support server.</p>
<p>We do not currently offer an automated account-wide data export or erasure endpoint. To request access, correction, or deletion of your data, please contact us through the support server (see Contact below).</p>
<p>Product analytics events expire after <strong>13 months</strong>. A Guild administrator may disable future Guild product analytics using the <strong>Share anonymous product usage</strong> setting. Earlier analytics deletion may be requested through the same support privacy-request process.</p>

<h2>6. Security</h2>
<p>We take reasonable measures to protect your data, including signed session cookies and restricted access controls for the Evidence Vault. However, no internet transmission or storage is entirely secure, and we cannot guarantee absolute security. Discord bot tokens are stored in Cloudflare Secrets Store rather than the database.</p>

<h2>7. Your Rights</h2>
<p>Depending on your jurisdiction, you may have the right to access, rectify, or request deletion of your personal data. Because the Bot does not provide a self-service erasure endpoint, please exercise these rights by joining our <a href="${DISCORD_INVITE}">support server</a> and contacting staff. We will respond within a reasonable timeframe.</p>

<h2>8. Cookies</h2>
<p>The admin dashboard uses essential session cookies to maintain your login state: an HMAC-signed operator session cookie and Better Auth session cookies. These cookies are HTTP-only and used solely for authentication. Product analytics sets no cookies, uses no browser storage or fingerprinting, and honors Global Privacy Control and Do Not Track for browser-originated events. No advertising or tracking cookies are set by the Bot. The Google Fonts request made by your browser may set its own cache headers, but the Bot does not control these.</p>

<h2>9. International Data Transfers</h2>
<p>The Bot runs on Cloudflare's global edge network and PostHog analytics is processed in the region selected by the operator. Data may be processed and stored in countries other than your own. By using the Bot, you consent to these transfers in accordance with this Privacy Policy.</p>

<h2>10. Children's Privacy</h2>
<p>Discord requires users to be at least 13 years old (or the minimum age required in their country). The Bot is not directed at children and does not knowingly collect data from anyone under that age.</p>

<h2>11. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We encourage you to review it periodically. Continued use of the Bot after changes constitutes acceptance of the revised policy.</p>

<h2>12. Contact</h2>
<p>If you have any questions about this Privacy Policy, please join our <a href="${DISCORD_INVITE}">support server</a>.</p>
</main>
${LEGAL_FOOTER}
</body>
</html>`;

export function renderSelfHostedPolicyUnavailable(
  site: SelfHostedSite,
  policy: "terms" | "privacy",
  requestOrigin: string,
): string {
  const title = policy === "privacy" ? "Privacy Policy" : "Terms of Service";
  const operator = escapeSelfHostedText(site.operatorName);
  const support = site.supportUrl
    ? `<p><a href="${escapeSelfHostedText(site.supportUrl)}">Contact this installation's operator</a></p>`
    : "<p>Contact this installation's operator or your server administrator for its policies.</p>";
  return `<!DOCTYPE html><html lang="en">
${legalHead(title, site.publicUrl ?? requestOrigin, "This independent installation's operator has not configured this policy.")}
<body>${legalHeader({ href: "/admin", label: "Dashboard" })}
<main><h1>${title} unavailable</h1>
<p>This self-hosted HAF Bot installation is managed by <strong>${operator}</strong>.</p>
<p>Its operator has not configured this policy. The hosted HAF service's policies do not describe this installation.</p>
${support}</main>${LEGAL_FOOTER}</body></html>`;
}

function escapeSelfHostedText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
