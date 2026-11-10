import { Input } from "./input";

type DurationUnit = "minutes" | "hours" | "days" | "permanent";

const UNIT_MS: Record<Exclude<DurationUnit, "permanent">, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function msToDurationInput(value: string | number | null | undefined): {
  amount: string;
  unit: DurationUnit;
} {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!numeric || !Number.isFinite(numeric) || numeric <= 0)
    return { amount: "", unit: "permanent" };
  if (numeric % UNIT_MS.days === 0) return { amount: String(numeric / UNIT_MS.days), unit: "days" };
  if (numeric % UNIT_MS.hours === 0)
    return { amount: String(numeric / UNIT_MS.hours), unit: "hours" };
  return { amount: String(Math.round(numeric / UNIT_MS.minutes)), unit: "minutes" };
}

export function durationInputToMs(amount: string, unit: DurationUnit): string {
  if (unit === "permanent") return "";
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return String(Math.round(numeric * UNIT_MS[unit]));
}

export function DurationInput({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (nextValueMs: string) => void;
}) {
  const display = msToDurationInput(value);

  function handleAmountChange(amount: string) {
    onChange(durationInputToMs(amount, display.unit));
  }

  function handleUnitChange(unit: DurationUnit) {
    onChange(durationInputToMs(display.amount || "1", unit));
  }

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
      <Input
        id={id}
        inputMode="numeric"
        value={display.unit === "permanent" ? "" : display.amount}
        disabled={display.unit === "permanent"}
        onChange={(event) => handleAmountChange(event.currentTarget.value)}
        placeholder="Permanent"
      />
      <select
        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={display.unit}
        onChange={(event) => handleUnitChange(event.currentTarget.value as DurationUnit)}
      >
        <option value="minutes">Minutes</option>
        <option value="hours">Hours</option>
        <option value="days">Days</option>
        <option value="permanent">Permanent</option>
      </select>
    </div>
  );
}
