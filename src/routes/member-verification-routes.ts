import { verificationAttemptState } from "../services/member-verification-state";
import type { CustomerAuth } from "../runtime/auth/customer-auth";
import { readCustomerSession } from "../runtime/auth/customer-session";
import type { MemberVerificationService } from "../services/member-verification-service";
import { safeTextResponse } from "../http/safe-text-response";
import { verifyTurnstileToken } from "../services/member-verification-turnstile";
import { verifyAttemptToken } from "../services/member-verification-token";
import type { RouteHandler } from "./public-routes";

export interface MemberVerificationRouteOptions {
  memberVerificationService: MemberVerificationService;
  customerAuth?: CustomerAuth;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  verifyTurnstileToken?: (token: string, secretKey: string) => Promise<boolean>;
}

const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMemberVerificationRoutes(
  options: MemberVerificationRouteOptions,
): RouteHandler {
  const verifyTurnstile = options.verifyTurnstileToken ?? verifyTurnstileToken;

  const handler = async function (request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = /^\/verify\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      return null;
    }

    const attemptId = decodeURIComponent(match[1] ?? "");
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return renderErrorPage("Invalid verification link.");
    }

    if (request.method === "GET") {
      return handleGet(request, attemptId, options);
    }

    if (request.method === "POST") {
      return handlePost(request, attemptId, options, verifyTurnstile);
    }

    return safeTextResponse("Method not allowed", 405, { allow: "GET, POST" });
  };

  return handler;
}

async function verifyAttemptSignature(
  request: Request,
  attempt: { id: string; guildId: string; userId: string; expiresAtMs: number },
  secretKey: string | undefined,
): Promise<boolean> {
  if (!secretKey) {
    return false;
  }
  const url = new URL(request.url);
  const signature = url.searchParams.get("sig") ?? "";
  return verifyAttemptToken(attempt, signature, secretKey);
}

function signedVerifyUrl(request: Request, attemptId: string): string {
  const url = new URL(`/verify/${encodeURIComponent(attemptId)}`, new URL(request.url).origin);
  const sig = new URL(request.url).searchParams.get("sig");
  if (sig) {
    url.searchParams.set("sig", sig);
  }
  return url.toString();
}

async function handleGet(
  request: Request,
  attemptId: string,
  options: MemberVerificationRouteOptions,
): Promise<Response> {
  const { memberVerificationService, customerAuth, turnstileSiteKey, turnstileSecretKey } = options;

  const attempt = await memberVerificationService.readVerificationAttempt(attemptId);
  if (!attempt) {
    return renderErrorPage("This verification link is invalid.");
  }

  if (!(await verifyAttemptSignature(request, attempt, turnstileSecretKey))) {
    return renderErrorPage("This verification link signature is invalid.");
  }

  const attemptState = verificationAttemptState(attempt, Date.now());
  if (attemptState === "consumed") {
    await memberVerificationService.audit("member-verification.attempt-reused", {
      guildId: attempt.guildId,
      user: { id: attempt.userId },
      context: { attemptId },
    });
    return renderErrorPage("This verification link has already been used.");
  }
  if (attemptState === "expired") {
    await memberVerificationService.audit("member-verification.attempt-expired", {
      guildId: attempt.guildId,
      user: { id: attempt.userId },
      context: { attemptId },
    });
    return renderErrorPage(
      "This verification link has expired. Please click Verify again in Discord.",
    );
  }

  const session = await readCustomerSession(request, customerAuth);
  if (!session) {
    const signInUrl = new URL("/api/auth/sign-in/social", new URL(request.url).origin);
    signInUrl.searchParams.set("provider", "discord");
    signInUrl.searchParams.set("callbackURL", signedVerifyUrl(request, attemptId));
    return Response.redirect(signInUrl.toString(), 302);
  }

  if (session.user.discordUserId !== attempt.userId) {
    await memberVerificationService.audit("member-verification.discord-mismatch", {
      guildId: attempt.guildId,
      user: { id: session.user.discordUserId },
      context: { attemptId, expectedUserId: attempt.userId },
    });
    return renderErrorPage(
      "This verification link was created for a different Discord account. Please return to Discord and click Verify with your own account.",
    );
  }

  const config = await memberVerificationService.getConfig(attempt.guildId);
  if (!config?.enabled || !config.verifiedRoleId) {
    return renderErrorPage("Member verification is not configured for this server.");
  }

  if (!turnstileSiteKey) {
    return renderErrorPage("Verification is currently unavailable for this server.");
  }

  return renderChallengePage({
    attemptId,
    signedUrl: signedVerifyUrl(request, attemptId),
    siteKey: turnstileSiteKey,
    title: config.title,
    description: config.description,
  });
}

async function handlePost(
  request: Request,
  attemptId: string,
  options: MemberVerificationRouteOptions,
  verifyTurnstile: (token: string, secretKey: string) => Promise<boolean>,
): Promise<Response> {
  const { memberVerificationService, customerAuth, turnstileSecretKey } = options;

  const attempt = await memberVerificationService.readVerificationAttempt(attemptId);
  if (!attempt) {
    return renderErrorPage("This verification link is invalid.");
  }

  if (!(await verifyAttemptSignature(request, attempt, turnstileSecretKey))) {
    return renderErrorPage("This verification link signature is invalid.");
  }

  const attemptState = verificationAttemptState(attempt, Date.now());
  if (attemptState === "consumed") {
    await memberVerificationService.audit("member-verification.attempt-reused", {
      guildId: attempt.guildId,
      user: { id: attempt.userId },
      context: { attemptId },
    });
    return renderErrorPage("This verification link has already been used.");
  }
  if (attemptState === "expired") {
    await memberVerificationService.audit("member-verification.attempt-expired", {
      guildId: attempt.guildId,
      user: { id: attempt.userId },
      context: { attemptId },
    });
    return renderErrorPage(
      "This verification link has expired. Please click Verify again in Discord.",
    );
  }

  const session = await readCustomerSession(request, customerAuth);
  if (!session) {
    return renderErrorPage(
      "Your Discord session has expired. Please return to Discord and click Verify again.",
    );
  }
  if (session.user.discordUserId !== attempt.userId) {
    await memberVerificationService.audit("member-verification.discord-mismatch", {
      guildId: attempt.guildId,
      user: { id: session.user.discordUserId },
      context: { attemptId, expectedUserId: attempt.userId },
    });
    return renderErrorPage(
      "This verification link was created for a different Discord account. Please return to Discord and click Verify with your own account.",
    );
  }

  const formData = await request.formData().catch(() => null);
  const token =
    typeof formData?.get("cf-turnstile-response") === "string"
      ? (formData.get("cf-turnstile-response") as string)
      : "";

  if (!turnstileSecretKey) {
    return renderErrorPage("Verification is currently unavailable for this server.");
  }

  const success = await verifyTurnstile(token, turnstileSecretKey);
  if (!success) {
    await memberVerificationService.audit("member-verification.turnstile-failed", {
      guildId: attempt.guildId,
      user: { id: attempt.userId },
      context: { attemptId },
    });
    return renderErrorPage(
      "The bot challenge failed. You can retry until the link expires.",
      signedVerifyUrl(request, attemptId),
    );
  }

  const claimed = await memberVerificationService.markVerificationAttemptUsed(attempt);
  if (!claimed) {
    const current = await memberVerificationService.readVerificationAttempt(attemptId);
    const expired = current && verificationAttemptState(current, Date.now()) === "expired";
    await memberVerificationService.audit(
      expired ? "member-verification.attempt-expired" : "member-verification.attempt-reused",
      {
        guildId: attempt.guildId,
        user: { id: attempt.userId },
        context: { attemptId },
      },
    );
    return renderErrorPage(
      expired
        ? "This verification link has expired. Please click Verify again in Discord."
        : "This verification link has already been used.",
    );
  }

  await memberVerificationService.audit("member-verification.turnstile-pass", {
    guildId: attempt.guildId,
    user: { id: attempt.userId },
    context: { attemptId },
  });

  const result = await memberVerificationService.completeVerification({
    guildId: attempt.guildId,
    userId: attempt.userId,
    user: { id: attempt.userId },
    messageId: attempt.messageId ?? undefined,
    channelId: attempt.channelId ?? undefined,
    method: "turnstile",
  });

  if (result.outcome === "failed") {
    return renderErrorPage(
      `${result.message} This verification link has been used. Return to Discord and click Verify again to start a new attempt. If verification remains unavailable, ask server staff for help.`,
    );
  }
  return renderSuccessPage(result.message);
}

function renderChallengePage(options: {
  attemptId: string;
  signedUrl: string;
  siteKey: string;
  title: string;
  description: string;
}): Response {
  const { signedUrl, siteKey, title, description } = options;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - HAF Bot Verification</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #36393f; color: #dcddde; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #2f3136; border-radius: 8px; padding: 32px; max-width: 480px; width: 90%; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    h1 { margin: 0 0 12px; font-size: 22px; color: #fff; }
    p { line-height: 1.5; margin: 0 0 24px; }
    .turnstile { margin-bottom: 16px; }
    button { background: #5865f2; color: #fff; border: none; border-radius: 4px; padding: 12px 20px; font-size: 16px; cursor: pointer; }
    button:hover { background: #4752c4; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    <form action="${escapeHtml(signedUrl)}" method="POST">
      <div class="cf-turnstile turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="member-verification-turnstile"></div>
      <button type="submit">Complete Verification</button>
    </form>
  </div>
</body>
</html>`;
  return htmlResponse({ profile: "member-verification", html });
}

function renderSuccessPage(message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verification Complete - HAF Bot</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #36393f; color: #dcddde; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #2f3136; border-radius: 8px; padding: 32px; max-width: 480px; width: 90%; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-align: center; }
    h1 { margin: 0 0 12px; font-size: 22px; color: #57f287; }
    p { line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Verification Complete</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  return htmlResponse({ profile: "member-verification", html });
}

function renderErrorPage(message: string, retryUrl?: string): Response {
  const retryButton = retryUrl
    ? `<p style="margin-top: 16px;"><a href="${escapeHtml(retryUrl)}" style="display: inline-block; background: #5865f2; color: #fff; text-decoration: none; border-radius: 4px; padding: 12px 20px;">Try Again</a></p>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verification Failed - HAF Bot</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #36393f; color: #dcddde; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #2f3136; border-radius: 8px; padding: 32px; max-width: 480px; width: 90%; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-align: center; }
    h1 { margin: 0 0 12px; font-size: 22px; color: #ed4245; }
    p { line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Verification Failed</h1>
    <p>${escapeHtml(message)}</p>
    ${retryButton}
  </div>
</body>
</html>`;
  return htmlResponse({ profile: "member-verification", html, status: 400 });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
import { htmlResponse } from "../http/html-response";
