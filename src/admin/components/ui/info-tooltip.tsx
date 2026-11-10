import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../../lib/utils";
import { InfoIcon } from "./icons";

export function InfoTooltip({
  content,
  learnMoreHref,
  className,
  side = "top",
}: {
  content: string;
  learnMoreHref?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const tooltipId = React.useId();
  return (
    <TooltipPrimitive.Provider delayDuration={200} disableHoverableContent>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={content}
            aria-describedby={tooltipId}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              className,
            )}
          >
            <InfoIcon className="h-3.5 w-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            id={tooltipId}
            role="tooltip"
            side={side}
            sideOffset={4}
            className={cn(
              "z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md",
              "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0",
            )}
          >
            <p className="text-xs leading-relaxed">{content}</p>
            {learnMoreHref ? (
              <a
                href={learnMoreHref}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs font-medium text-accent-foreground underline underline-offset-2 hover:no-underline"
              >
                Learn more
              </a>
            ) : null}
            <TooltipPrimitive.Arrow className="fill-popover" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
