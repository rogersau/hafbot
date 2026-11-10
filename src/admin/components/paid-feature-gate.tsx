import { useEffect, useState, type ReactNode } from "react";

import { encodeGuildIdForSearch } from "../lib/dashboard-urls";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { LockIcon } from "./ui/icons";

type BillingSummary = {
  subscription: {
    plan: "free" | "premium" | "premium_plus";
  } | null;
  prices: Array<{
    plan: "premium" | "premium_plus";
    frequency: "monthly" | "yearly";
    formattedAmount: string;
  }>;
};

type AssignmentSummary = {
  assignments: Array<{ guildId: string }>;
  capacity: number;
};

type AccessContext = {
  billing: BillingSummary;
  assignments: AssignmentSummary | null;
};

export function PaidFeatureGate({
  feature,
  guildId,
  children,
}: {
  feature: string;
  guildId: string;
  children: ReactNode;
}) {
  const [context, setContext] = useState<AccessContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("../generated/admin-client/billing")
      .then(({ billingClient }) => billingClient.get({}))
      .then(async (billing) => {
        const paid = billing.subscription && billing.subscription.plan !== "free";
        const assignments = paid
          ? await import("../generated/admin-client/billing")
              .then(({ billingClient }) => billingClient.assignments({}))
              .catch(() => null)
          : null;
        if (!cancelled) setContext({ billing, assignments });
      })
      .catch(() => {
        if (!cancelled) {
          setContext({ billing: { subscription: null, prices: [] }, assignments: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const action = resolveGateAction(context, guildId);

  return (
    <section className="admin-paid-feature-gate relative min-h-[34rem] overflow-hidden rounded-xl border bg-card/30">
      <div
        className="pointer-events-none max-h-[40rem] select-none overflow-hidden opacity-35 blur-[5px]"
        aria-hidden="true"
      >
        {children}
      </div>
      <div className="absolute inset-0 flex items-start justify-center bg-background/55 px-4 py-8 backdrop-blur-[1px] sm:items-center sm:p-8">
        <Card className="admin-paid-feature-card w-full max-w-2xl border-primary/35 shadow-2xl">
          <CardContent className="p-6 sm:p-8">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <LockIcon className="h-5 w-5" />
            </div>
            <div className="mt-4 text-center">
              <Badge>Paid feature</Badge>
              <h2 className="mt-3 font-display text-2xl font-semibold">Unlock {feature}</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                {action.description}
              </p>
            </div>

            {action.kind === "loading" ? (
              <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Checking your subscription and guild assignments…
              </div>
            ) : action.kind === "choose-plan" ? (
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {(["premium", "premium_plus"] as const).map((plan) => {
                  const price = context?.billing.prices.find(
                    (candidate) => candidate.plan === plan && candidate.frequency === "yearly",
                  );
                  const label = plan === "premium_plus" ? "Premium Plus" : "Premium";
                  return (
                    <a
                      key={plan}
                      href={billingHref(guildId, { plan, frequency: "yearly" })}
                      className="rounded-lg border bg-background/80 p-4 transition-colors hover:border-primary/60 hover:bg-background"
                    >
                      <p className="font-display text-lg font-semibold">{label}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {price ? `${price.formattedAmount} / year` : "View current price"}
                      </p>
                      <p className="mt-3 text-sm font-semibold text-primary">Choose {label} →</p>
                    </a>
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 flex justify-center">
                <Button asChild size="lg">
                  <a href={action.href}>{action.label}</a>
                </Button>
              </div>
            )}

            <p className="mt-5 text-center text-xs text-muted-foreground">
              Your existing settings stay in place while this guild uses the Free plan.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function resolveGateAction(context: AccessContext | null, guildId: string) {
  if (!context) {
    return {
      kind: "loading" as const,
      description: "Checking the best way to unlock this feature for your guild.",
    };
  }
  const plan = context?.billing.subscription?.plan ?? "free";
  if (plan === "free") {
    return {
      kind: "choose-plan" as const,
      description: "Choose a plan to activate paid features for this Discord server.",
    };
  }

  const assignments = context?.assignments;
  const assignedHere = assignments?.assignments.some((row) => row.guildId === guildId);
  if (assignedHere) {
    return {
      kind: "manage" as const,
      label: "Refresh guild access",
      href: billingHref(guildId, { section: "assignments" }),
      description:
        "This guild is assigned paid access, but its entitlement has not refreshed yet. Review the assignment and try again.",
    };
  }

  const hasCapacity = assignments ? assignments.assignments.length < assignments.capacity : false;
  if (hasCapacity) {
    return {
      kind: "assign" as const,
      label: "Assign paid access to this guild",
      href: billingHref(guildId, { section: "assignments" }),
      description:
        "Your subscription has an available guild slot. Assign it here to unlock this page.",
    };
  }

  if (!assignments) {
    return {
      kind: "manage" as const,
      label: "Review guild assignments",
      href: billingHref(guildId, { section: "assignments" }),
      description:
        "This guild is not currently receiving paid access. Review your subscription’s guild assignments to unlock the page.",
    };
  }

  if (plan === "premium") {
    return {
      kind: "upgrade" as const,
      label: "Upgrade to Premium Plus",
      href: billingHref(guildId, {
        plan: "premium_plus",
        frequency: "yearly",
      }),
      description:
        "Your Premium access is assigned to another guild. Upgrade for up to three guild slots, or move the existing assignment.",
    };
  }

  return {
    kind: "manage" as const,
    label: "Manage guild assignments",
    href: billingHref(guildId, { section: "assignments" }),
    description:
      "All paid guild slots are currently in use. Move an assignment to this guild to unlock the page.",
  };
}

function billingHref(
  guildId: string,
  options: {
    plan?: "premium" | "premium_plus";
    frequency?: "monthly" | "yearly";
    section?: string;
  },
) {
  const params = new URLSearchParams();
  if (guildId) params.set("guildId", encodeGuildIdForSearch(guildId));
  if (options.plan) params.set("plan", options.plan);
  if (options.frequency) params.set("frequency", options.frequency);
  const query = params.toString();
  return `/admin/billing${query ? `?${query}` : ""}${options.section ? `#${options.section}` : ""}`;
}
