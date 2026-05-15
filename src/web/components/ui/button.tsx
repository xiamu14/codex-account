// AlignUI Button v0.0.0
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn, type ClassValue } from "../../utils/cn.ts";
import { recursiveCloneChildren } from "../../utils/recursive-clone-children.tsx";
import { tv, type VariantProps } from "../../utils/tv.ts";

const BUTTON_ROOT_NAME = "ButtonRoot";
const BUTTON_ICON_NAME = "ButtonIcon";

export const buttonVariants = tv({
  slots: {
    root: [
      "group/button inline-flex items-center justify-center whitespace-nowrap rounded-10 outline-none",
      "transition duration-200 ease-out",
      "focus:outline-none",
      "disabled:pointer-events-none disabled:bg-bg-weak-50 disabled:text-text-disabled-300 disabled:shadow-none",
    ],
    icon: "shrink-0 text-inherit",
  },
  variants: {
    variant: {
      primary: {},
      neutral: {},
      error: {},
    },
    mode: {
      filled: {},
      stroke: {
        root: "bg-bg-white-0 shadow-regular-xs ring-1 ring-inset",
      },
      lighter: {},
      ghost: {
        root: "bg-transparent shadow-none",
      },
    },
    size: {
      xsmall: {
        root: "h-8 gap-1.5 px-2.5 text-label-sm",
        icon: "size-4",
      },
      small: {
        root: "h-9 gap-2 px-3 text-label-sm",
        icon: "size-5",
      },
      medium: {
        root: "h-10 gap-2.5 px-3.5 text-label-sm",
        icon: "size-5",
      },
    },
  },
  compoundVariants: [
    {
      variant: "neutral",
      mode: "stroke",
      className: {
        root: [
          "text-text-strong-950 ring-stroke-soft-200",
          "hover:bg-bg-weak-50",
          "focus-visible:ring-2 focus-visible:ring-primary-alpha-24",
        ],
      },
    },
    {
      variant: "primary",
      mode: "filled",
      className: {
        root: [
          "bg-primary-base text-static-white",
          "hover:bg-primary-darker",
          "focus-visible:ring-2 focus-visible:ring-primary-alpha-24",
        ],
      },
    },
    {
      variant: "error",
      mode: "filled",
      className: {
        root: [
          "bg-error-base text-static-white",
          "hover:bg-error-dark",
          "focus-visible:ring-2 focus-visible:ring-error-alpha-24",
        ],
      },
    },
  ],
  defaultVariants: {
    variant: "primary",
    mode: "filled",
    size: "small",
  },
});

type ButtonSharedProps = VariantProps<typeof buttonVariants> & {
  className?: ClassValue;
};

type ButtonRootProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  ButtonSharedProps;

const ButtonRoot = React.forwardRef<HTMLButtonElement, ButtonRootProps>(
  ({ children, className, mode, size, type = "button", variant, ...rest }, forwardedRef) => {
    const uniqueId = React.useId();
    const { root, icon } = buttonVariants({ mode, size, variant });
    const sharedProps = {
      className: icon(),
    };

    return (
      <button
        ref={forwardedRef}
        className={root({ class: cn(className) })}
        type={type}
        {...rest}
      >
        {recursiveCloneChildren(
          children,
          sharedProps,
          [BUTTON_ICON_NAME],
          uniqueId,
        )}
      </button>
    );
  },
);
ButtonRoot.displayName = BUTTON_ROOT_NAME;

type ButtonIconProps = React.HTMLAttributes<HTMLDivElement> & {
  asChild?: boolean;
};

const ButtonIcon = React.forwardRef<HTMLDivElement, ButtonIconProps>(
  ({ asChild, children, className, ...rest }, forwardedRef) => {
    const Component = asChild ? Slot : "div";

    return (
      <Component ref={forwardedRef} className={cn(className)} {...rest}>
        {children}
      </Component>
    );
  },
);
ButtonIcon.displayName = BUTTON_ICON_NAME;

export { ButtonIcon as Icon, ButtonRoot as Root };
