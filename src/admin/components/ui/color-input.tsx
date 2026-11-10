import { useState } from "react";

import { Input } from "./input";

export function ColorInput({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(formatHexColor(value));

  function updateDraft(nextDraft: string) {
    setDraft(nextDraft);
    const normalized = nextDraft.trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(normalized)) onChange(Number.parseInt(normalized, 16));
  }

  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="color"
        value={formatHexColor(value)}
        onChange={(event) => updateDraft(event.target.value)}
        disabled={disabled}
        className="h-10 w-10 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Input
        aria-label="Color hex value"
        value={draft}
        onChange={(event) => updateDraft(event.target.value)}
        disabled={disabled}
        placeholder="#3498db"
      />
    </div>
  );
}

export function formatHexColor(color: number): string {
  return `#${Math.min(Math.max(color, 0), 0xffffff).toString(16).padStart(6, "0")}`;
}
