import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import { CheckIcon } from "./icons";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        accent: "bg-accent text-accent-foreground shadow-xs hover:bg-accent/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background/50 hover:bg-secondary hover:text-foreground",
        secondary:
          "border border-border bg-secondary/60 text-secondary-foreground hover:bg-secondary",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
        lg: "h-10 px-7",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  success?: boolean;
  successLabel?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      children,
      loading = false,
      loadingLabel,
      success = false,
      successLabel,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const content = loading
      ? (loadingLabel ?? children)
      : success
        ? (successLabel ?? children)
        : children;
    return (
      <Comp
        className={cn("admin-button", buttonVariants({ variant, size, className }))}
        data-variant={variant ?? "default"}
        ref={ref}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <ButtonContent loading={loading} success={success}>
            {content}
          </ButtonContent>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

function ButtonContent({
  loading,
  success,
  children,
}: {
  loading: boolean;
  success: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2" aria-live="polite">
      {loading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : null}
      {!loading && success ? <CheckIcon className="h-3.5 w-3.5" /> : null}
      {alignButtonText(children)}
    </span>
  );
}

function alignButtonText(children: React.ReactNode) {
  return React.Children.map(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      return <span className="inline-block translate-y-px">{child}</span>;
    }

    return child;
  });
}

export { Button, buttonVariants };
