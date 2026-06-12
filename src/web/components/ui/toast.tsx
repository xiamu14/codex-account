// AlignUI Toast v0.0.0
import * as React from "react";
import {
  toast as sonnerToast,
  Toaster,
  type ExternalToast,
} from "sonner";

const singleToastId = "cxa-single-toast";

const defaultOptions: ExternalToast = {
  className: "group/toast z-50",
  position: "bottom-right",
};

const customToast = (
  renderFunc: (t: string | number) => React.ReactElement,
  options: ExternalToast = {},
) => {
  const mergedOptions = { ...defaultOptions, ...options, id: singleToastId };
  return sonnerToast.custom(renderFunc, mergedOptions);
};

const toast = {
  ...sonnerToast,
  custom: customToast,
};

export { toast, Toaster };
