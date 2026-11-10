import * as React from "react";
import { cn } from "../../lib/utils";
import { useTabNavigation } from "./tab-navigation";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string) {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error(`${component} must be used within Tabs`);
  return context;
}

interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

function Tabs({ value, defaultValue, onValueChange, children, className }: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "");
  const activeValue = value ?? uncontrolledValue;

  function handleValueChange(nextValue: string) {
    if (value === undefined) setUncontrolledValue(nextValue);
    onValueChange?.(nextValue);
  }

  return (
    <TabsContext.Provider value={{ value: activeValue, onValueChange: handleValueChange }}>
      <div className={cn("w-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onKeyDown, onFocusCapture, ...props }, ref) => {
    useTabsContext("TabsList");
    const navigation = useTabNavigation();
    React.useImperativeHandle(ref, () => navigation.ref.current!);
    return (
      <div
        ref={navigation.ref}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          navigation.onKeyDown(event);
        }}
        onFocusCapture={(event) => {
          onFocusCapture?.(event);
          navigation.onFocusCapture(event);
        }}
        role="tablist"
        className={cn(
          "admin-tabs-list inline-flex min-h-9 w-full items-end justify-start gap-1 border-b bg-transparent text-muted-foreground",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsList.displayName = "TabsList";

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, disabled, onClick, ...props }, ref) => {
    const context = useTabsContext("TabsTrigger");
    const isActive = context.value === value;

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isActive}
        data-state={isActive ? "active" : "inactive"}
        disabled={disabled}
        tabIndex={isActive && !disabled ? 0 : -1}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) context.onValueChange(value);
        }}
        className={cn(
          "admin-tabs-trigger relative inline-flex min-h-9 flex-none items-center justify-center whitespace-nowrap px-3 py-2 font-display text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          isActive &&
            "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const context = useTabsContext("TabsContent");
    if (context.value !== value) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        data-state="active"
        className={cn(
          "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
