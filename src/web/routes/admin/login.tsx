import { createFileRoute, useLocation } from "@tanstack/react-router";

import { SignInCard } from "../../../admin/components/sign-in-card";
import { readCheckoutIntent } from "../../../admin/lib/checkout-offer";
import { getDiscordSignInCallbackUrl } from "../../../admin/lib/dashboard-urls";
import { adminDocumentMiddleware } from "../../../admin/routes/document-middleware";
import { getLandingPrices } from "../../../landing/landing-prices";

export const Route = createFileRoute("/admin/login")({
  server: { middleware: [adminDocumentMiddleware("login")] },
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  loaderDeps: ({ search }) => ({ next: search.next }),
  loader: ({ deps }) => (readCheckoutIntent(deps.next) ? getLandingPrices() : []),
  head: () => ({ meta: [{ title: "Sign in with Discord" }] }),
  component: AdminLogin,
});

function AdminLogin() {
  const search = useLocation({ select: (location) => location.searchStr });

  return (
    <SignInCard
      initialSearch={search}
      prices={Route.useLoaderData()}
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
