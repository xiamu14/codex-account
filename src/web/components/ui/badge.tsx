// AlignUI Badge v0.0.0
import * as React from "react";
import { cn } from "../../utils/cn.ts";

type BadgeColor =
  | "gray"
  | "blue"
  | "orange"
  | "red"
  | "green"
  | "yellow"
  | "purple"
  | "sky"
  | "pink"
  | "teal";
type BadgeVariant = "filled" | "light" | "lighter" | "stroke";
type BadgeSize = "small" | "medium";

type BadgeRootProps = React.HTMLAttributes<HTMLDivElement> & {
  color?: BadgeColor;
  disabled?: boolean;
  size?: BadgeSize;
  square?: boolean;
  variant?: BadgeVariant;
};

const baseClass =
  "inline-flex items-center justify-center rounded-full leading-none transition duration-200 ease-out";

const sizeClass: Record<BadgeSize, string> = {
  small: "h-4 gap-1.5 px-2 text-subheading-2xs uppercase has-[>.dot]:gap-2",
  medium: "h-5 gap-1.5 px-2 text-label-xs",
};

const squareClass: Record<BadgeSize, string> = {
  small: "min-w-4 px-1",
  medium: "min-w-5 px-1",
};

const colorClass: Record<BadgeVariant, Record<BadgeColor, string>> = {
  filled: {
    gray: "bg-faded-base text-static-white",
    blue: "bg-information-base text-static-white",
    orange: "bg-warning-base text-static-white",
    red: "bg-error-base text-static-white",
    green: "bg-success-base text-static-white",
    yellow: "bg-away-base text-static-white",
    purple: "bg-feature-base text-static-white",
    sky: "bg-verified-base text-static-white",
    pink: "bg-highlighted-base text-static-white",
    teal: "bg-stable-base text-static-white",
  },
  light: {
    gray: "bg-faded-light text-faded-dark",
    blue: "bg-information-light text-information-dark",
    orange: "bg-warning-light text-warning-dark",
    red: "bg-error-light text-error-dark",
    green: "bg-success-light text-success-dark",
    yellow: "bg-away-light text-away-dark",
    purple: "bg-feature-light text-feature-dark",
    sky: "bg-verified-light text-verified-dark",
    pink: "bg-highlighted-light text-highlighted-dark",
    teal: "bg-stable-light text-stable-dark",
  },
  lighter: {
    gray: "bg-faded-lighter text-faded-base",
    blue: "bg-information-lighter text-information-base",
    orange: "bg-warning-lighter text-warning-base",
    red: "bg-error-lighter text-error-base",
    green: "bg-success-lighter text-success-base",
    yellow: "bg-away-lighter text-away-base",
    purple: "bg-feature-lighter text-feature-base",
    sky: "bg-verified-lighter text-verified-base",
    pink: "bg-highlighted-lighter text-highlighted-base",
    teal: "bg-stable-lighter text-stable-base",
  },
  stroke: {
    gray: "text-faded-base ring-1 ring-inset ring-current",
    blue: "text-information-base ring-1 ring-inset ring-current",
    orange: "text-warning-base ring-1 ring-inset ring-current",
    red: "text-error-base ring-1 ring-inset ring-current",
    green: "text-success-base ring-1 ring-inset ring-current",
    yellow: "text-away-base ring-1 ring-inset ring-current",
    purple: "text-feature-base ring-1 ring-inset ring-current",
    sky: "text-verified-base ring-1 ring-inset ring-current",
    pink: "text-highlighted-base ring-1 ring-inset ring-current",
    teal: "text-stable-base ring-1 ring-inset ring-current",
  },
};

const Root = React.forwardRef<HTMLDivElement, BadgeRootProps>(
  (
    {
      className,
      color = "gray",
      disabled = false,
      size = "small",
      square = false,
      variant = "filled",
      ...rest
    },
    forwardedRef,
  ) => {
    return (
      <div
        ref={forwardedRef}
        className={cn(
          baseClass,
          sizeClass[size],
          colorClass[variant][color],
          square && squareClass[size],
          disabled &&
            "pointer-events-none bg-transparent text-text-disabled-300 ring-1 ring-inset ring-stroke-soft-200",
          className,
        )}
        {...rest}
      />
    );
  },
);
Root.displayName = "BadgeRoot";

type BadgeDotProps = Omit<React.HTMLAttributes<HTMLDivElement>, "color">;

function Dot({ className, ...rest }: BadgeDotProps) {
  return (
    <div
      className={cn(
        "dot -mx-1.5 flex size-4 items-center justify-center before:size-1 before:rounded-full before:bg-current",
        className,
      )}
      {...rest}
    />
  );
}
Dot.displayName = "BadgeDot";

export { Dot, Root };
