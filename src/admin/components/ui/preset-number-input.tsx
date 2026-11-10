import { Button } from "./button";
import { Input } from "./input";

export interface NumberPreset {
  label: string;
  value: string;
}

export function PresetNumberInput({
  id,
  value,
  presets,
  placeholder,
  min,
  max,
  onChange,
}: {
  id?: string;
  value: string;
  presets: NumberPreset[];
  placeholder?: string;
  min?: number;
  max?: number;
  onChange: (nextValue: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Button
            key={`${preset.label}:${preset.value}`}
            type="button"
            size="sm"
            variant={value === preset.value ? "default" : "outline"}
            onClick={() => onChange(preset.value)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <Input
        id={id}
        inputMode="numeric"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
