import * as React from "react";
import { cn } from "../../lib/utils";

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerWidth: number | null;
  setTriggerWidth: (width: number | null) => void;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function Popover({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: {
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const [triggerWidth, setTriggerWidth] = React.useState<number | null>(null);
  const open = controlledOpen ?? uncontrolledOpen;

  function setOpen(nextOpen: boolean) {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerWidth, setTriggerWidth }}>
      <div className="relative">{children}</div>
    </PopoverContext.Provider>
  );
}

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ asChild = false, children, onClick, ...props }, ref) => {
  const context = usePopoverContext("PopoverTrigger");

  function setNode(node: HTMLButtonElement | null) {
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
    context.setTriggerWidth(node?.offsetWidth ?? null);
  }

  const triggerProps = {
    ...props,
    ref: setNode,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented) context.setOpen(!context.open);
    },
  };

  if (asChild && React.isValidElement<React.ButtonHTMLAttributes<HTMLButtonElement>>(children)) {
    return React.cloneElement(children, {
      ...triggerProps,
      ...children.props,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        children.props.onClick?.(event);
        triggerProps.onClick(event);
      },
    });
  }

  return (
    <button type="button" {...triggerProps}>
      {children}
    </button>
  );
});
PopoverTrigger.displayName = "PopoverTrigger";

const PopoverContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "center" | "end"; sideOffset?: number }
>(({ className, align = "start", sideOffset = 4, style, ...props }, ref) => {
  const context = usePopoverContext("PopoverContent");
  if (!context.open) return null;

  const alignClass =
    align === "end" ? "right-0" : align === "center" ? "left-1/2 -translate-x-1/2" : "left-0";

  return (
    <div
      ref={ref}
      className={cn(
        "admin-popover-content absolute top-full z-50 w-72 rounded-[4px] border bg-popover text-popover-foreground shadow-lg outline-none",
        alignClass,
        className,
      )}
      style={
        {
          ...style,
          marginTop: sideOffset,
          "--radix-popover-trigger-width": context.triggerWidth
            ? `${context.triggerWidth}px`
            : undefined,
        } as React.CSSProperties
      }
      {...props}
    />
  );
});
PopoverContent.displayName = "PopoverContent";

function usePopoverContext(component: string) {
  const context = React.useContext(PopoverContext);
  if (!context) throw new Error(`${component} must be used within Popover`);
  return context;
}

export { Popover, PopoverTrigger, PopoverContent };
