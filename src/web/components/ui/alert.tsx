// AlignUI Alert v0.0.0
import * as React from "react";
import { RiCloseLine } from "@remixicon/react";
import { cn } from "../../utils/cn.ts";

const ALERT_ICON_NAME = "AlertIcon";
const ALERT_CLOSE_ICON_NAME = "AlertCloseIcon";

type AlertStatus = "error" | "feature" | "information" | "success" | "warning";
type AlertVariant = "filled" | "light" | "lighter" | "stroke";
type AlertSize = "large" | "small" | "xsmall";

type AlertRootProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: AlertSize;
  status?: AlertStatus;
  variant?: AlertVariant;
  wrapperClassName?: string;
};

type AlertChildProps = {
  size?: AlertSize;
  status?: AlertStatus;
  variant?: AlertVariant;
};

type AlertIconProps = React.SVGProps<SVGSVGElement> &
  AlertChildProps & {
    as?: React.ElementType;
  };

const rootBase = "w-full";
const wrapperBase =
  "grid w-full auto-cols-auto grid-flow-col grid-cols-1 items-start has-[>svg:first-child]:grid-cols-[auto,minmax(0,1fr)] transition duration-200 ease-out group-data-[expanded=false]/toast:group-data-[front=false]/toast:opacity-0";

const sizeClass: Record<AlertSize, { root: string; wrapper: string; icon: string }> = {
  large: {
    root: "rounded-xl p-3.5 pb-4 text-paragraph-sm",
    wrapper: "items-start gap-3",
    icon: "size-5",
  },
  small: {
    root: "rounded-lg px-2.5 py-2 text-paragraph-sm",
    wrapper: "gap-2",
    icon: "size-5",
  },
  xsmall: {
    root: "rounded-lg p-2 text-paragraph-xs",
    wrapper: "gap-2",
    icon: "size-4",
  },
};

const variantRootClass: Record<AlertVariant, string> = {
  filled: "text-static-white",
  light: "text-text-strong-950",
  lighter: "text-text-strong-950",
  stroke:
    "bg-bg-white-0 text-text-strong-950 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200",
};

const statusRootClass: Record<AlertVariant, Record<AlertStatus, string>> = {
  filled: {
    error: "bg-error-base",
    feature: "bg-faded-base",
    information: "bg-information-base",
    success: "bg-success-base",
    warning: "bg-warning-base",
  },
  light: {
    error: "bg-error-light",
    feature: "bg-faded-light",
    information: "bg-information-light",
    success: "bg-success-light",
    warning: "bg-warning-light",
  },
  lighter: {
    error: "bg-error-lighter",
    feature: "bg-faded-lighter",
    information: "bg-information-lighter",
    success: "bg-success-lighter",
    warning: "bg-warning-lighter",
  },
  stroke: {
    error: "",
    feature: "",
    information: "",
    success: "",
    warning: "",
  },
};

const iconStatusClass: Record<AlertStatus, string> = {
  error: "text-error-base",
  feature: "text-faded-base",
  information: "text-information-base",
  success: "text-success-base",
  warning: "text-warning-base",
};

function Root({
  children,
  className,
  size = "small",
  status = "information",
  variant = "filled",
  wrapperClassName,
  ...rest
}: AlertRootProps) {
  const sharedProps: AlertChildProps = { size, status, variant };
  return (
    <div
      className={cn(
        rootBase,
        sizeClass[size].root,
        variantRootClass[variant],
        statusRootClass[variant][status],
        className,
      )}
      {...rest}
    >
      <div className={cn(wrapperBase, sizeClass[size].wrapper, wrapperClassName)}>
        {React.Children.map(children, (child) => {
          if (!React.isValidElement<AlertChildProps>(child)) return child;
          const displayName =
            typeof child.type === "function" || typeof child.type === "object"
              ? "displayName" in child.type
                ? child.type.displayName
                : undefined
              : undefined;
          return displayName === ALERT_ICON_NAME ||
            displayName === ALERT_CLOSE_ICON_NAME
            ? React.cloneElement(child, sharedProps)
            : child;
        })}
      </div>
    </div>
  );
}
Root.displayName = "AlertRoot";

function Icon({
  as,
  className,
  size = "small",
  status = "information",
  variant = "filled",
  ...rest
}: AlertIconProps) {
  const Component = as ?? "svg";
  return (
    <Component
      className={cn(
        sizeClass[size].icon,
        variant === "filled" ? "" : iconStatusClass[status],
        className,
      )}
      {...rest}
    />
  );
}
Icon.displayName = ALERT_ICON_NAME;

function CloseIcon({
  as,
  className,
  size = "small",
  variant = "filled",
  ...rest
}: AlertIconProps) {
  const Component = as ?? RiCloseLine;
  return (
    <Component
      className={cn(
        sizeClass[size].icon,
        variant === "filled"
          ? "text-static-white opacity-[.72]"
          : "text-text-strong-950 opacity-40",
        className,
      )}
      {...rest}
    />
  );
}
CloseIcon.displayName = ALERT_CLOSE_ICON_NAME;

export { CloseIcon, Icon, Root };
