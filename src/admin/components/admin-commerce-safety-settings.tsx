import type { CommerceControlType } from "../../commerce/safeguards";
import type { CommerceLoaderData } from "../lib/admin-route-loaders";
import { SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";

export default function AdminCommerceSafetySettings({
  safeguards,
  busyAction,
  onSetSafeguard,
}: {
  safeguards: CommerceLoaderData["safeguards"];
  busyAction: string | null;
  onSetSafeguard: (controlType: CommerceControlType, enabled: boolean) => void;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="Pilot safeguards"
        description="Limits and emergency controls stop new financial activity without disabling refunds, Stripe portal access, reconciliation, role maintenance, or dashboard visibility."
      />
      {safeguards ? (
        <>
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Active subscribers"
              value={`${safeguards.usage.activeSubscribers} / ${safeguards.limits.activeSubscribers}`}
            />
            <Metric
              label="Published offerings"
              value={`${safeguards.usage.activeOfferings} / ${safeguards.limits.activeOfferings}`}
            />
            {(["AUD", "USD"] as const).map((currency) => (
              <Metric
                key={currency}
                label={`${currency} monthly gross`}
                value={`${formatMoney(safeguards.usage.monthlyGrossMinor[currency], currency)} / ${formatMoney(safeguards.limits.monthlyGrossMinor, currency)}`}
              />
            ))}
          </div>
          {safeguards.blockReasons.length > 0 ? (
            <p className="text-sm text-destructive">
              New sales blocked: {safeguards.blockReasons.join(", ")}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {(["new_checkout", "support_shutdown"] as const).map((controlType) => {
              const enabled = safeguards.controls.some(
                (control) => control.controlType === controlType && control.enabled,
              );
              return (
                <Button
                  key={controlType}
                  type="button"
                  variant={enabled ? "secondary" : "outline"}
                  disabled={Boolean(busyAction)}
                  onClick={() => onSetSafeguard(controlType, !enabled)}
                >
                  {enabled ? "Resume" : "Stop"}{" "}
                  {controlType === "new_checkout" ? "new checkouts" : "support payments"}
                </Button>
              );
            })}
            <Button
              type="button"
              variant="destructive"
              disabled={
                Boolean(busyAction) ||
                safeguards.controls.some(
                  (control) => control.controlType === "renewal_shutdown" && control.enabled,
                )
              }
              onClick={() => onSetSafeguard("renewal_shutdown", true)}
            >
              Stop renewals
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Safeguard metrics are unavailable.</p>
      )}
    </SettingsBlock>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function formatMoney(valueMinor: number, currency: "AUD" | "USD"): string {
  const amount = new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valueMinor / 100);
  return `${currency} $${amount}`;
}
