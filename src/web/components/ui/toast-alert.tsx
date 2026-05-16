import * as React from "react";
import {
  RiAlertFill,
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiInformationFill,
  RiMagicFill,
} from "@remixicon/react";
import * as Alert from "./alert.tsx";
import { toast } from "./toast.tsx";

type AlertToastProps = {
  dismissable?: boolean;
  icon?: React.ElementType;
  message: string;
  status?: React.ComponentPropsWithoutRef<typeof Alert.Root>["status"];
  t: string | number;
  variant?: React.ComponentPropsWithoutRef<typeof Alert.Root>["variant"];
};

function Root({
  dismissable = true,
  icon,
  message,
  status = "feature",
  t,
  variant = "stroke",
}: AlertToastProps) {
  let Icon: React.ElementType;
  if (icon) {
    Icon = icon;
  } else {
    switch (status) {
      case "success":
        Icon = RiCheckboxCircleFill;
        break;
      case "warning":
        Icon = RiAlertFill;
        break;
      case "error":
        Icon = RiErrorWarningFill;
        break;
      case "information":
        Icon = RiInformationFill;
        break;
      case "feature":
      default:
        Icon = RiMagicFill;
        break;
    }
  }

  return (
    <Alert.Root
      className="w-[360px] bg-bg-white-0 shadow-regular-lg ring-1 ring-stroke-soft-200"
      size="small"
      status={status}
      variant={variant}
    >
      <Alert.Icon as={Icon} />
      <span className="min-w-0 leading-5">{message}</span>
      {dismissable && (
        <button
          className="shrink-0"
          onClick={() => toast.dismiss(t)}
          type="button"
        >
          <Alert.CloseIcon />
        </button>
      )}
    </Alert.Root>
  );
}
Root.displayName = "AlertToast";

export { Root };
