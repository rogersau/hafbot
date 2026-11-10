import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "../../lib/utils";

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  loading?: boolean;
  success?: boolean;
};

const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, loading, success, disabled, ...props }, ref) => (
    <span className="relative inline-flex items-center">
      <SwitchPrimitive.Root
        className={cn(
          "admin-switch peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
          success && "ring-2 ring-green-500/70 ring-offset-2 ring-offset-background",
          className,
        )}
        disabled={disabled || loading}
        {...props}
        ref={ref}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
          )}
        />
      </SwitchPrimitive.Root>
      {loading ? (
        <span className="absolute -right-5 h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      ) : null}
    </span>
  ),
);
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
