// AlignUI Divider v0.0.0
import * as React from "react";
import { cn } from "../../utils/cn.ts";

type DividerVariant =
  | "content"
  | "line"
  | "line-spacing"
  | "line-text"
  | "solid-text"
  | "text";

type DividerRootProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: DividerVariant;
};

const variantClass: Record<DividerVariant, string> = {
  line:
    "h-0 before:absolute before:left-0 before:top-1/2 before:h-px before:w-full before:-translate-y-1/2 before:bg-stroke-soft-200",
  "line-spacing":
    "h-1 before:absolute before:left-0 before:top-1/2 before:h-px before:w-full before:-translate-y-1/2 before:bg-stroke-soft-200",
  "line-text":
    "gap-2.5 text-subheading-2xs text-text-soft-400 before:h-px before:w-full before:flex-1 before:bg-stroke-soft-200 after:h-px after:w-full after:flex-1 after:bg-stroke-soft-200",
  content:
    "gap-2.5 before:h-px before:w-full before:flex-1 before:bg-stroke-soft-200 after:h-px after:w-full after:flex-1 after:bg-stroke-soft-200",
  text: "px-2 py-1 text-subheading-xs text-text-soft-400",
  "solid-text": "bg-bg-weak-50 px-5 py-1.5 text-subheading-xs text-text-soft-400 uppercase",
};

function Root({
  className,
  variant = "line",
  ...rest
}: DividerRootProps) {
  return (
    <div
      role="separator"
      className={cn("relative flex w-full items-center", variantClass[variant], className)}
      {...rest}
    />
  );
}
Root.displayName = "DividerRoot";

export { Root };
