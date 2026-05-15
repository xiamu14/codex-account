// AlignUI Select v0.0.0
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";

import { cn } from "../../utils/cn.ts";

const SELECT_TRIGGER_NAME = "SelectTrigger";

type SelectTriggerProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
>;

const Trigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ children, className, ...rest }, forwardedRef) => {
  return (
    <SelectPrimitive.Trigger
      ref={forwardedRef}
      className={cn(
        "group/trigger inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-10 border border-stroke-soft-200 bg-bg-white-0 px-3 text-left text-label-sm text-text-strong-950 shadow-regular-xs outline-none transition duration-200 ease-out",
        "hover:bg-bg-weak-50",
        "focus:ring-0",
        "disabled:cursor-not-allowed disabled:text-text-disabled-300 disabled:shadow-none",
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <RiArrowDownSLine className="size-5 shrink-0 text-text-sub-600 transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
Trigger.displayName = SELECT_TRIGGER_NAME;

type SelectValueProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Value
>;

const Value = SelectPrimitive.Value;
Value.displayName = SelectPrimitive.Value.displayName;

type SelectContentProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Content
>;

const Content = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(({ children, className, position = "popper", ...rest }, forwardedRef) => {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={forwardedRef}
        className={cn(
          "z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-10 border border-stroke-soft-200 bg-bg-white-0 p-1 shadow-regular-md",
          "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...rest}
      >
        <ScrollAreaPrimitive.Root type="auto">
          <SelectPrimitive.Viewport asChild>
            <ScrollAreaPrimitive.Viewport className="max-h-72">
              {children}
            </ScrollAreaPrimitive.Viewport>
          </SelectPrimitive.Viewport>
          <ScrollAreaPrimitive.Scrollbar
            className="flex w-2 p-0.5"
            orientation="vertical"
          >
            <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-bg-soft-200" />
          </ScrollAreaPrimitive.Scrollbar>
        </ScrollAreaPrimitive.Root>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
Content.displayName = SelectPrimitive.Content.displayName;

type SelectItemProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Item
>;

const Item = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(({ children, className, ...rest }, forwardedRef) => {
  return (
    <SelectPrimitive.Item
      ref={forwardedRef}
      className={cn(
        "relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 pl-8 text-label-sm text-text-strong-950 outline-none transition-colors",
        "data-[highlighted]:bg-bg-weak-50",
        "data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled-300",
        className,
      )}
      {...rest}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <RiCheckLine className="size-4 text-primary-base" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});
Item.displayName = SelectPrimitive.Item.displayName;

const Root = SelectPrimitive.Root;

export { Content, Item, Root, Trigger, Value };
export type { SelectTriggerProps, SelectValueProps };
