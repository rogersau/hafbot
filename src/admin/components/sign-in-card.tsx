import { useEffect } from "react";

import { buildAdminDocumentTitle } from "../lib/admin-document-title";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { CheckIcon, ShieldIcon } from "./ui/icons";

export function SignInCard({
  initialSearch = "",
  onSignIn,
}: {
  initialSearch?: string;
  onSignIn: () => void;
}) {
  const checkoutIntent = readCheckoutIntent(initialSearch);

  // The browser title is external document state owned by the sign-in surface.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = buildAdminDocumentTitle({
      authenticated: false,
      currentPath: "/admin",
      selectedGuildId: "",
      guildDirectory: null,
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-xl border bg-card shadow-2xl md:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden border-r bg-muted/25 p-10 md:flex md:flex-col md:justify-between">
          <div>
            <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <ShieldIcon className="h-5 w-5" />
            </span>
            <p className="mt-8 font-display text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              HAF Bot community operations
            </p>
            <h1 className="mt-3 font-display text-3xl font-semibold leading-tight">
              Manage your Discord communities with confidence.
            </h1>
          </div>
          <ul className="mt-10 space-y-3 text-sm text-muted-foreground">
            {[
              "Use your existing Discord identity",
              "Only see servers you are allowed to manage",
              "Payments stay securely handled by Stripe",
            ].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <CheckIcon className="h-4 w-4 text-primary" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
        <Card className="w-full rounded-none border-0 bg-transparent shadow-none">
          <CardHeader>
            <p className="font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
              {checkoutIntent
                ? `Checkout · ${checkoutIntent.planLabel} ${checkoutIntent.frequency}`
                : "HAF Bot admin"}
            </p>
            <CardTitle>
              {checkoutIntent ? "Sign in to continue to checkout" : "Continue with Discord"}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {checkoutIntent
                ? `We’ll bring you back to your ${checkoutIntent.planLabel} selection after Discord sign-in.`
                : "Sign in to manage HAF Bot for your Discord servers."}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {checkoutIntent ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <p className="font-medium">Your selection is saved</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review your plan, then continue to Stripe’s secure checkout. You will not be
                  charged on this screen.
                </p>
              </div>
            ) : null}
            <Button className="w-full" onClick={onSignIn}>
              Continue with Discord
            </Button>
            <p className="text-center text-xs leading-5 text-muted-foreground">
              New to HAF Bot? Continuing creates your account automatically. No separate sign-up
              form is needed.
            </p>
          </CardContent>
          <CardFooter className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <a href="/terms" className="hover:underline">
              Terms of Service
            </a>
            <a href="/privacy" className="hover:underline">
              Privacy Policy
            </a>
            <a
              href="https://docs.hafbot.xyz/getting-started"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              Documentation
            </a>
            <a
              href="https://discord.gg/HpRPkdm6dv"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              Support
            </a>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}

export function readCheckoutIntent(initialSearch: string): {
  plan: "premium" | "premium_plus";
  planLabel: "Premium" | "Premium Plus";
  frequency: "monthly" | "yearly";
} | null {
  const next = new URLSearchParams(initialSearch).get("next");
  if (!next) return null;
  const url = new URL(next, "https://admin.hafbot.invalid");
  if (url.origin !== "https://admin.hafbot.invalid" || url.pathname !== "/admin/billing") {
    return null;
  }
  const plan = url.searchParams.get("plan");
  if (plan !== "premium" && plan !== "premium_plus") return null;
  const frequency = url.searchParams.get("frequency") === "monthly" ? "monthly" : "yearly";
  return {
    plan,
    planLabel: plan === "premium_plus" ? "Premium Plus" : "Premium",
    frequency,
  };
}
