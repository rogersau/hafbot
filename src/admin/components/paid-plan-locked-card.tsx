import type { ReactNode } from "react";

import { Card, CardContent } from "./ui/card";
import { LockIcon } from "./ui/icons";
import { UpgradeBanner } from "./upgrade-banner";

export function PaidPlanLockedCard({
  feature,
  description,
  supportInvite,
}: {
  feature: string;
  description?: ReactNode;
  supportInvite: string | null;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-[4px] border border-amber-500/30 bg-amber-500/10 text-amber-200">
          <LockIcon className="h-5 w-5" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{`${feature} requires a paid plan.`}</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            {description ?? `Upgrade this Guild to unlock ${feature.toLowerCase()}.`}
          </p>
        </div>
        <div className="w-full max-w-sm pt-1 text-left">
          <UpgradeBanner
            supportInvite={supportInvite}
            message="This feature is not available on the Free plan."
          />
        </div>
      </CardContent>
    </Card>
  );
}
