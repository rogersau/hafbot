import { withFirstWorkflow } from "../first-workflow-intent";
import { readFirstWorkflow } from "../first-workflows";
import { escapeHtml } from "./commerce-branding";

export const DISCORD_INSTALL_CONTINUATION = "discord";

const PERMISSION_GROUPS = [
  {
    outcome: "Publish panels and messages",
    reason: "Post welcome panels, noticeboards, announcements and transcripts.",
    flags: [
      [10n, "View Channels"],
      [11n, "Send Messages"],
      [14n, "Embed Links"],
      [15n, "Attach Files"],
      [16n, "Read Message History"],
      [6n, "Add Reactions"],
    ],
  },
  {
    outcome: "Create support channels and threads",
    reason: "Create and maintain channels for Tickets, or use threads in workflows that need them.",
    flags: [
      [4n, "Manage Channels"],
      [34n, "Manage Threads"],
      [35n, "Create Public Threads"],
      [36n, "Create Private Threads"],
      [38n, "Send Messages in Threads"],
    ],
  },
  {
    outcome: "Assign member roles",
    reason:
      "Grant or remove roles for member verification, player linking and other role workflows.",
    flags: [[28n, "Manage Roles"]],
  },
  {
    outcome: "Run configured moderation",
    reason: "Take the moderation actions you enable, such as removing messages.",
    flags: [
      [13n, "Manage Messages"],
      [1n, "Kick Members"],
      [2n, "Ban Members"],
      [40n, "Timeout Members"],
    ],
  },
  {
    outcome: "Administrator",
    reason: "This permission grants all permissions and bypasses channel restrictions.",
    flags: [[3n, "Administrator"]],
  },
] as const;

function describeRequestedPermissions(value: string): string {
  if (!/^\d{1,20}$/.test(value)) {
    return "<p>Check the final list of requested permissions in Discord before authorising.</p>";
  }
  const permissions = BigInt(value);
  if (permissions === 0n) {
    return "<p>This invite requests no extra permissions for the bot role. Features may need you to grant permissions in Discord after installation.</p>";
  }

  let described = 0n;
  const groups = PERMISSION_GROUPS.flatMap(({ outcome, reason, flags }) => {
    const names = flags.flatMap(([bit, name]) => {
      const flag = 1n << bit;
      if ((permissions & flag) === 0n) return [];
      described |= flag;
      return [name];
    });
    return names.length
      ? [`<li><strong>${outcome}.</strong> ${reason} <span>${names.join(", ")}.</span></li>`]
      : [];
  });
  return `${groups.length ? `<ul class="permission-groups">${groups.join("")}</ul>` : ""}
${permissions !== described ? "<p>Discord will also list additional permissions requested by this invite.</p>" : ""}`;
}

export function renderInstallPage(permissions: string, search: string): string {
  const workflow = readFirstWorkflow(search);
  const workflowDetails = workflow
    ? `<p><strong>${escapeHtml(workflow.feature)}</strong> — ${escapeHtml(workflow.outcome)}</p>
<ul>${workflow.requirements.map((requirement) => `<li>${escapeHtml(requirement)}</li>`).join("")}</ul>`
    : `<p>Start with one workflow. <a href="/#first-workflow">Choose a workflow</a> to see its minimum requirements, or continue without choosing.</p>`;

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Review Discord permissions — HAF Bot</title>
<link rel="icon" href="/favicon.ico">
<style>
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: dark; }
body { margin: 0; color: #d8e0f1; background: #101624; font: 1rem/1.6 system-ui, sans-serif; }
a { color: #bac6ff; }
:focus-visible { outline: 3px solid #bac6ff; outline-offset: 4px; }
.skip-link:not(:focus) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip-link:focus { position: fixed; z-index: 1; inset: .75rem auto auto .75rem; padding: .75rem 1rem; background: #101624; }
header { border-bottom: 1px solid #3c4862; }
header nav, main { width: min(42rem, calc(100% - 2rem)); margin-inline: auto; }
header a, .dashboard-link { display: inline-flex; min-height: 44px; align-items: center; }
main { padding-block: 2rem 3rem; }
h1, h2, strong { color: #f4f6fb; }
h1 { margin: 0; font-size: clamp(1.75rem, 5vw, 2.5rem); line-height: 1.2; }
h2 { margin: 1.5rem 0 .25rem; font-size: 1.25rem; }
ul { padding-inline-start: 1.5rem; }
li + li { margin-top: .5rem; }
.permission-groups span { display: block; color: #bac6ff; }
.continue { display: inline-flex; min-height: 44px; align-items: center; padding: .625rem 1rem; border-radius: .5rem; background: #bac6ff; color: #101624; text-decoration: none; font-weight: 700; }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<header><nav aria-label="Main navigation"><a href="/">HAF Bot home</a></nav></header>
<main id="main-content" tabindex="-1">
<h1>Review Discord permissions</h1>
<p>This invite adds HAF Bot and its slash commands. On Discord, choose a server where you can add apps and review the requested permissions.</p>
<h2>What your first workflow needs</h2>
${workflowDetails}
<h2>What this invitation requests</h2>
<p>The invite can request more than your chosen workflow needs. These permissions support different features, and your server’s roles and channel permissions determine the bot’s actual access.</p>
${describeRequestedPermissions(permissions)}
<p>Place the HAF Bot role above any roles you want it to assign or remove. Check the final permission list in Discord before authorising.</p>
<h2>What installation does not do</h2>
<p>Adding the bot does not let HAF act as you or read your private DMs with other people. It does not configure features, publish panels, or link external accounts.</p>
<p><a class="continue" href="/install?continue=${DISCORD_INSTALL_CONTINUATION}" target="_blank" rel="noopener noreferrer">Continue to Discord (opens in a new tab)</a></p>
<p>After adding the bot, return here to <a class="dashboard-link" href="${escapeHtml(withFirstWorkflow("/admin", workflow?.id))}">open dashboard setup</a>. Then configure and test one feature.</p>
<p><a href="https://docs.hafbot.xyz/getting-started#before-you-start">HAF setup and feature guide</a> · <a href="https://docs.discord.com/developers/topics/permissions">Discord permission reference</a></p>
</main>
</body>
</html>`;
}
