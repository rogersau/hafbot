import type { CommerceLoaderData } from "../lib/admin-route-loaders";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export interface CommerceSupportForm {
  enabled: boolean;
  explanation: string;
  currency: "AUD" | "USD";
  suggestedAmounts: string;
  supportContact: string;
}

export default function AdminCommerceSupportSettings({
  support,
  supportReport,
  busyAction,
  onChange,
  onSave,
}: {
  support: CommerceSupportForm;
  supportReport: CommerceLoaderData["supportReport"];
  busyAction: string | null;
  onChange: (next: CommerceSupportForm) => void;
  onSave: () => void;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="One-time community support"
        description="Offer voluntary, non-recurring payments for community operations. Support payments never create a Discord role, subscription, prize, or guaranteed benefit."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Availability" htmlFor="commerce-support-enabled">
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              id="commerce-support-enabled"
              type="checkbox"
              checked={support.enabled}
              onChange={(event) => onChange({ ...support, enabled: event.target.checked })}
            />
            Enable “Support this server”
          </label>
        </FormField>
        <FormField label="Currency" htmlFor="commerce-support-currency" required>
          <select
            id="commerce-support-currency"
            className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
            value={support.currency}
            onChange={(event) =>
              onChange({
                ...support,
                currency: event.target.value === "USD" ? "USD" : "AUD",
              })
            }
          >
            <option value="AUD">AUD</option>
            <option value="USD">USD</option>
          </select>
        </FormField>
        <FormField
          label="Community operations explanation"
          htmlFor="commerce-support-explanation"
          hint="Describe ordinary community operating costs. Charity, fundraising, crowdfunding, political, raffle, investment, and project-delivery claims are blocked."
          required
        >
          <Textarea
            id="commerce-support-explanation"
            value={support.explanation}
            maxLength={500}
            onChange={(event) => onChange({ ...support, explanation: event.target.value })}
          />
        </FormField>
        <div className="grid gap-4">
          <FormField
            label="Suggested amounts"
            htmlFor="commerce-support-amounts"
            hint="One to three comma-separated amounts, 2.00–500.00. Exact 0.20 increments preserve the 5% fee."
            required
          >
            <Input
              id="commerce-support-amounts"
              value={support.suggestedAmounts}
              onChange={(event) => onChange({ ...support, suggestedAmounts: event.target.value })}
            />
          </FormField>
          <FormField label="Support contact" htmlFor="commerce-support-contact" required>
            <Input
              id="commerce-support-contact"
              value={support.supportContact}
              maxLength={200}
              onChange={(event) => onChange({ ...support, supportContact: event.target.value })}
            />
          </FormField>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        HAF’s 5% application fee is separate from Stripe processing fees. The public page identifies
        your guild as seller and states that payments are not charitable, tax-deductible,
        fundraising, or crowdfunding.
      </p>
      {supportReport.length > 0 ? (
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {supportReport.map((report) => (
            <Metric
              key={report.currency}
              label={`${report.currency} support`}
              value={`${formatMoney(report.grossMinor, report.currency)} gross · ${formatMoney(report.hafFeeMinor, report.currency)} HAF fee · ${formatMoney(report.refundedMinor, report.currency)} refunded · ${formatMoney(report.disputedMinor, report.currency)} disputed (${report.openDisputeCount} open)`}
            />
          ))}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onSave}
          disabled={
            Boolean(busyAction) ||
            support.explanation.trim().length < 10 ||
            support.supportContact.trim().length < 3
          }
        >
          {busyAction === "support" ? "Saving…" : "Save support settings"}
        </Button>
      </div>
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
