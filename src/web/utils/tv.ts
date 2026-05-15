import { tv as tvBase, type TV, type VariantProps } from "tailwind-variants";
import { twMergeConfig } from "./cn.ts";

export { type VariantProps };

export const tv: TV = (options, config) =>
  tvBase(options, {
    twMergeConfig,
    ...config,
  });
