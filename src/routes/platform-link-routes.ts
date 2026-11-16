import type { PlatformAuthConfig } from "../services/platform-auth-config";
import {
  PlatformLinkFinalizationError,
  type PlatformLinkService,
} from "../services/platform-link-service";
import { QuantityLimitError } from "../runtime/entitlement-checks";
import { htmlResponse } from "../http/html-response";

export interface PlatformLinkRouteOptions {
  platformLinkService: PlatformLinkService;
  platformConfig: PlatformAuthConfig;
}

const PENDING_LINK_TTL_MS = 15 * 60 * 1000;

export function createPlatformLinkRoutes(options: PlatformLinkRouteOptions) {
  const { platformConfig } = options;
  const platform = platformConfig.platformName;
  const displayName = platformConfig.displayName;

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const publicUrl = url.origin;
    let trustedGuildId: string | undefined;
    let savedLink = false;
    let verifying = false;
    const failure = (status: number, title: string, message: string, recovery: string) =>
      htmlResponse({
        profile: "platform-link-result",
        status,
        requestUrl: url,
        html: buildFailureHtml(title, message, recovery, trustedGuildId),
      });
    const followUpFailure = () =>
      failure(
        500,
        "Account linked; follow-up needed",
        `Your ${displayName} account was saved, but we could not finish the follow-up steps.`,
        "Return to Discord and check /playlink. If a linked role or Server Levels is missing, ask a server administrator to check it.",
      );

    try {
      const isStartRoute = url.pathname === `/auth/${platform}/start`;
      if (request.method === "GET" && isStartRoute) {
        const state = String(url.searchParams.get("state") || "");
        if (!state) {
          return failure(
            400,
            "Link request missing",
            "Missing state parameter.",
            `Open Discord and click the ${displayName} link button to start a new request.`,
          );
        }

        const pending = await options.platformLinkService.readPendingLink(state);
        if (!pending || pending.platform !== platform) {
          return failure(
            400,
            "Link request unavailable",
            `Invalid or expired link request. Go back to Discord and click the ${displayName} link button again.`,
            "Use the newest link from the server where you want to link your account.",
          );
        }
        trustedGuildId = pending.guildId;

        if (Date.now() - pending.createdAtMs > PENDING_LINK_TTL_MS) {
          await options.platformLinkService.deletePendingLink(state);
          return failure(
            400,
            "Link request expired",
            `This ${displayName} login link has expired. Go back to Discord and click the ${displayName} link button again.`,
            "Login links last 15 minutes. Start a new request and finish signing in promptly.",
          );
        }

        const config = await options.platformLinkService.readConfig(pending.guildId, platform);
        if (config?.enabled === false)
          return failure(
            400,
            "Account linking disabled",
            "Account linking is disabled in this server.",
            "Ask a server administrator before trying again.",
          );
        const authUrl = platformConfig.buildAuthUrl({ state, publicUrl });
        return Response.redirect(authUrl.toString(), 302);
      }

      if (request.method === "GET" && url.pathname === `/auth/${platform}/callback`) {
        const state = String(url.searchParams.get("state") || "");
        if (!state) {
          return failure(
            400,
            "Link request missing",
            "Missing state parameter.",
            `Open Discord and click the ${displayName} link button to start a new request.`,
          );
        }

        const pending = await options.platformLinkService.readPendingLink(state);
        if (!pending || pending.platform !== platform) {
          return failure(
            400,
            "Link request unavailable",
            `Invalid or expired ${displayName} login. Go back to Discord and click the ${displayName} link button again.`,
            "Use the newest link from the server where you want to link your account.",
          );
        }
        trustedGuildId = pending.guildId;

        if (Date.now() - pending.createdAtMs > PENDING_LINK_TTL_MS) {
          await options.platformLinkService.deletePendingLink(state);
          return failure(
            400,
            "Link request expired",
            `This ${displayName} login link has expired. Go back to Discord and click the ${displayName} link button again.`,
            "Login links last 15 minutes. Start a new request and finish signing in promptly.",
          );
        }

        try {
          verifying = true;
          const platformId = await platformConfig.verifyAssertion(request);
          verifying = false;
          if (!platformId) {
            return failure(
              401,
              `${displayName} login incomplete`,
              `${displayName} login failed or was cancelled.`,
              `Start a new request in Discord, sign in to the intended ${displayName} account, and approve the login.`,
            );
          }

          const config = await options.platformLinkService.readConfig(pending.guildId, platform);
          if (!config || config.enabled === false) {
            return failure(
              400,
              "Server setup needed",
              `This server has not been configured for ${displayName} linking.`,
              "Ask a server administrator to finish Play Link setup, then start a new request.",
            );
          }

          const existingLinks = await options.platformLinkService.getLinksByUser(
            pending.guildId,
            pending.userId,
          );
          const existingPlatformLinks = existingLinks.filter((l) => l.platform === platform);
          const existingMatch = existingPlatformLinks.find((l) => l.platformId === platformId);

          if (existingMatch?.active) {
            return failure(
              409,
              "Account already linked",
              `That ${displayName} account is already linked to your Discord account.`,
              "Return to Discord to view your linked accounts with /playlink. You can close this window.",
            );
          }

          const duplicate = await options.platformLinkService.getLinkByPlatformId(
            pending.guildId,
            platform,
            platformId,
          );
          if (duplicate && duplicate.userId !== pending.userId) {
            return failure(
              409,
              "Account linked to someone else",
              `This ${displayName} account is already linked to another Discord account in this server.`,
              `Sign out of ${displayName} and start a new request with your own account. If this is your account, ask a server administrator to review the existing link.`,
            );
          }

          if (!existingMatch && !config.allowMultipleLinks && existingPlatformLinks.length > 0) {
            if (!config.allowRelink) {
              return failure(
                409,
                "Account replacement disabled",
                `Your Discord account is already linked and relinking is disabled.`,
                "Your current link is unchanged. Ask a server administrator if you need to replace it.",
              );
            }
          }

          let needsFollowUp = false;
          try {
            await options.platformLinkService.saveLink(
              {
                guildId: pending.guildId,
                userId: pending.userId,
                platform,
                platformId,
                linkedAtMs: Date.now(),
                manual: false,
                actionedByUserId: null,
                metadataJson: null,
                active: true,
              },
              !existingMatch && !config.allowMultipleLinks && existingPlatformLinks.length > 0,
            );
            savedLink = true;
          } catch (error) {
            if (error instanceof PlatformLinkFinalizationError) {
              savedLink = true;
              needsFollowUp = true;
            } else if (error instanceof QuantityLimitError) {
              return failure(
                409,
                "Server link limit reached",
                error.message,
                "Ask a server administrator to remove unused links or upgrade the server plan, then start a new request.",
              );
            } else throw error;
          }

          try {
            await options.platformLinkService.assignLinkedRole(
              pending.guildId,
              pending.userId,
              platform,
            );
          } catch {
            needsFollowUp = true;
          }
          try {
            await options.platformLinkService.sendLogEmbed(pending.guildId, "linked", {
              discordId: pending.userId,
              platform,
              platformId,
            });
          } catch {
            needsFollowUp = true;
          }

          if (needsFollowUp) return followUpFailure();

          return htmlResponse({
            profile: "platform-link-result",
            html: buildSuccessHtml(platformConfig, platformId),
            requestUrl: url,
          });
        } finally {
          await options.platformLinkService.deletePendingLink(state);
        }
      }

      return null;
    } catch (error) {
      if (savedLink || error instanceof PlatformLinkFinalizationError) {
        return followUpFailure();
      }
      return failure(
        500,
        verifying ? `${displayName} unavailable` : "Could not finish linking",
        verifying
          ? `We could not complete the ${displayName} login.`
          : "We could not save or load this link request.",
        `Return to Discord and check /playlink, then click the ${displayName} link button to start a new request. If this keeps happening, ask a server administrator for help.`,
      );
    }
  };
}

function buildFailureHtml(
  title: string,
  message: string,
  recovery: string,
  guildId?: string,
): string {
  const returnLink =
    guildId && /^\d{17,20}$/.test(guildId)
      ? `<a href="https://discord.com/channels/${escapeHtml(guildId)}">Return to Discord</a>`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} | Play Link</title>
<style>
body{margin:0;padding:24px;min-height:100vh;box-sizing:border-box;display:grid;place-items:center;background:#1f1f1f;color:#f5f5f5;font-family:Arial,sans-serif;line-height:1.6;}
main{width:100%;max-width:560px;box-sizing:border-box;padding:32px;background:#2b2b2b;border-radius:16px;overflow-wrap:anywhere;}
h1{line-height:1.25;margin-top:0;}p{color:#e0e0e0;}a{display:inline-block;padding:12px 18px;border-radius:8px;background:#5865f2;color:white;font-weight:bold;}
a:focus-visible{outline:3px solid #fff;outline-offset:4px;}
</style>
</head>
<body><main aria-labelledby="result-title">
<h1 id="result-title">${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<h2>What to do next</h2>
<p>${escapeHtml(recovery)}</p>
${returnLink}
</main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function buildSuccessHtml(config: PlatformAuthConfig, platformId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(config.displayName)} Account Linked</title>
<style>
body{background:#1f1f1f;color:#f5f5f5;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;}
.card{background:#2b2b2b;padding:36px;border-radius:16px;max-width:520px;box-shadow:0 12px 40px rgba(0,0,0,.35);}
img{width:90px;height:90px;border-radius:18px;margin-bottom:18px;object-fit:cover;}
h1{margin:0 0 12px 0;}
p{color:#cfcfcf;margin-bottom:22px;}
.id-box{background:#1a1a1a;padding:14px;border-radius:10px;margin-bottom:18px;}
.id-box .label{font-size:13px;color:#999;}
.id-box .value{margin-top:6px;font-size:16px;}
a{display:inline-block;background:#5865F2;color:white;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold;}
.footer{margin-top:22px;color:#888;font-size:13px;}
</style>
</head>
<body>
<div class="card">
<img src="${escapeHtml(config.iconUrl)}" alt="${escapeHtml(config.displayName)}" />
<h1>${escapeHtml(config.displayName)} Account Linked</h1>
<p>Your ${escapeHtml(config.displayName)} account has been successfully verified with Discord.</p>
<div class="id-box">
<div class="label">${escapeHtml(config.displayName)} ID</div>
<div class="value">${escapeHtml(platformId)}</div>
</div>
<a href="${escapeHtml(config.profileUrl(platformId))}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(config.displayName)} Profile</a>
<p class="footer">You may now close this window and return to Discord.</p>
</div>
</body>
</html>`;
}
