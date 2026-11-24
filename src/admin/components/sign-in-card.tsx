import { Card, CardContent, CardFooter, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { CheckIcon, ShieldIcon } from "./ui/icons";
import {
  formatCheckoutAssignment,
  formatCheckoutOffer,
  readCheckoutIntent,
} from "../lib/checkout-offer";
import type { PublicLandingPrice } from "../../landing/landing-prices";
import { MAIN_CONTENT_ID, SkipLink } from "../../accessibility/skip-link";

export function SignInCard({
  initialSearch = "",
  prices = [],
  onSignIn,
}: {
  initialSearch?: string;
  prices?: readonly PublicLandingPrice[];
  onSignIn: () => void;
}) {
  const checkoutIntent = readCheckoutIntent(new URLSearchParams(initialSearch).get("next"));
  const offer = checkoutIntent
    ? prices.find(
        (price) =>
          price.plan === checkoutIntent.plan && price.frequency === checkoutIntent.frequency,
      )
    : undefined;

  return (
    <>
      <SkipLink />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6"
      >
        <div className="grid w-full max-w-4xl overflow-hidden rounded-xl border bg-card shadow-2xl md:grid-cols-[1.05fr_0.95fr]">
          <section className="hidden border-r bg-muted/25 p-10 md:flex md:flex-col md:justify-between">
            <div>
              <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                <ShieldIcon className="h-5 w-5" />
              </span>
              <p className="mt-8 font-display text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                HAF Bot community operations
              </p>
              <p className="mt-3 font-display text-3xl font-semibold leading-tight">
                Manage your Discord communities with confidence.
              </p>
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
              <h1 className="font-display text-lg font-semibold leading-tight tracking-tight">
                {offer
                  ? "Sign in to continue to checkout"
                  : checkoutIntent
                    ? "Checkout price unavailable"
                    : "Continue with Discord"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {checkoutIntent && offer
                  ? `We’ll bring you back to your ${checkoutIntent.planLabel} selection after Discord sign-in.`
                  : "Sign in to manage HAF Bot for your Discord servers."}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {checkoutIntent ? (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="font-medium">
                    {offer ? formatCheckoutOffer(offer) : "Current price is unavailable"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatCheckoutAssignment(checkoutIntent.plan)}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {offer
                      ? "Review the price again after sign-in before continuing to Stripe. You will not be charged on this screen."
                      : "Try again when the current price is available or sign in without a plan selection."}
                  </p>
                </div>
              ) : null}
              {checkoutIntent && !offer ? (
                <Button asChild className="w-full">
                  <a href="/admin/login">Sign in without a plan selection</a>
                </Button>
              ) : (
                <Button className="w-full" onClick={onSignIn}>
                  Continue with Discord
                </Button>
              )}
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
    </>
  );
}
