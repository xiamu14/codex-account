// AlignUI ProgressBar v0.0.0
import * as React from "react";
import { cn } from "../../utils/cn.ts";

type ProgressBarColor = "blue" | "green" | "orange" | "red";

type ProgressBarRootProps = React.HTMLAttributes<HTMLDivElement> & {
  color?: ProgressBarColor;
  max?: number;
  value?: number;
};

const progressColorClass: Record<ProgressBarColor, string> = {
  blue: "bg-information-base",
  green: "bg-success-base",
  orange: "bg-warning-base",
  red: "bg-error-base",
};

const Root = React.forwardRef<HTMLDivElement, ProgressBarRootProps>(
  (
    {
      className,
      color = "blue",
      max = 100,
      value = 0,
      ...rest
    },
    forwardedRef,
  ) => {
    const safeValue = Math.min(max, Math.max(value, 0));

    return (
      <div
        ref={forwardedRef}
        className={cn("h-1.5 w-full rounded-full bg-bg-soft-200", className)}
        {...rest}
      >
        <div
          aria-valuemax={max}
          aria-valuenow={value}
          className={cn(
            "h-full rounded-full transition-all duration-300 ease-out",
            progressColorClass[color],
          )}
          role="progressbar"
          style={{
            width: `${(safeValue / max) * 100}%`,
          }}
        />
      </div>
    );
  },
);
Root.displayName = "ProgressBarRoot";

export { Root };
