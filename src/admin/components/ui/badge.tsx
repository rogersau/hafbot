import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/40 text-foreground",
        success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
        warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
        danger: "border-destructive/40 bg-destructive/15 text-red-200",
        info: "border-sky-500/30 bg-sky-500/10 text-sky-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cn("admin-badge", badgeVariants({ variant, className }))}
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export function StatusDot({
  variant = "default",
  pulse = false,
  className,
}: {
  variant?: "success" | "warning" | "danger" | "default";
  pulse?: boolean;
  className?: string;
}) {
  const tone =
    variant === "success"
      ? "bg-emerald-400"
      : variant === "warning"
        ? "bg-amber-400"
        : variant === "danger"
          ? "bg-red-400"
          : "bg-muted-foreground";
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)} aria-hidden="true">
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            tone,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", tone)} />
    </span>
  );
}

export { badgeVariants };
