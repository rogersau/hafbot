import { Switch } from "./switch";
import { cn } from "../../lib/utils";

export interface TogglePrefProps {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function TogglePref({
  title,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  className,
}: TogglePrefProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-t border-border/40 py-3 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium leading-none text-foreground">{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={title}
      />
    </div>
  );
}
