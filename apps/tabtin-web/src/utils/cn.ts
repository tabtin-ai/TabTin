/**
 * cn 工具 — 与 Electron 端一致
 * @see apps/tabtin-electron/src/renderer/src/utils/cn.ts
 */
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
