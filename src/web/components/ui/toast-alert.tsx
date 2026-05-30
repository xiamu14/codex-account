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
      className="w-auto max-w-[calc(100vw-2rem)] min-w-50 px-4 shadow-regular-md"
      size="large"
      status={status}
      variant={variant}
      wrapperClassName="!flex items-start gap-3"
    >
      <Alert.Icon as={Icon} className="mt-0.5 shrink-0" size="large" />
      <span className="min-w-0 max-w-96 break-words leading-5">
        {message}
      </span>
      {/*{dismissable && (
        <button
          className="shrink-0"
          onClick={() => toast.dismiss(t)}
          type="button"
        >
          <Alert.CloseIcon />
        </button>
      )}*/}
    </Alert.Root>
  );
}
Root.displayName = "AlertToast";

export { Root };
