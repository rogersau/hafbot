import { createFileRoute, useLocation } from "@tanstack/react-router";

import { SignInCard } from "../../../admin/components/sign-in-card";
import { getDiscordSignInCallbackUrl } from "../../../admin/lib/dashboard-urls";
import { adminDocumentMiddleware } from "../../../admin/routes/document-middleware";

export const Route = createFileRoute("/admin/login")({
  server: { middleware: [adminDocumentMiddleware("login")] },
  head: () => ({ meta: [{ title: "Sign in with Discord" }] }),
  component: AdminLogin,
});

function AdminLogin() {
  const search = useLocation({ select: (location) => location.searchStr });

  return (
    <SignInCard
      initialSearch={search}
      onSignIn={async () => {
        const { authClient } = await import("../../../runtime/auth/auth-client");
        await authClient.signIn.social({
          provider: "discord",
          callbackURL: getDiscordSignInCallbackUrl(search),
        });
      }}
    />
  );
}
