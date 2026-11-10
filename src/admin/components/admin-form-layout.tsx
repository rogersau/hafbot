import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/utils";
import { InfoTooltip } from "./ui/info-tooltip";
import { Label } from "./ui/label";

export function EditorPanel({ children }: { children: ReactNode }) {
  return <SettingsBlock>{children}</SettingsBlock>;
}

export function SettingsPanel({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("admin-settings-panel space-y-5", className)} {...props}>
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "admin-section-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SettingsBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "admin-settings-block space-y-4 rounded-[4px] border bg-card/80 p-4 md:p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="admin-form-field min-w-0 space-y-2">
      <div className="flex min-h-4 items-center gap-1.5">
        <Label htmlFor={htmlFor} className="text-sm font-medium leading-none">
          {label}
        </Label>
        {hint ? <InfoTooltip content={hint} /> : null}
        {required ? (
          <span className="text-xs leading-none text-destructive">(required)</span>
        ) : null}
      </div>
      <div className={cn("rounded-[3px]", error ? "ring-1 ring-destructive/60" : null)}>
        {children}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function EditorActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:justify-end">{children}</div>
  );
}

export function AdvancedSection({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-[4px] border border-dashed border-border/70 bg-muted/20 p-4 md:p-5"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 marker:hidden">
        <div className="space-y-1">
          <h3 className="font-display text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          {description ? (
            <p className="max-w-3xl text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <span
          className="shrink-0 text-xs font-medium text-muted-foreground group-open:hidden"
          aria-hidden="true"
        >
          Show
        </span>
        <span
          className="hidden shrink-0 text-xs font-medium text-muted-foreground group-open:inline"
          aria-hidden="true"
        >
          Hide
        </span>
      </summary>
      <div className="mt-4 space-y-4">{children}</div>
    </details>
  );
}
