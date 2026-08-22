import * as React from "react"
import { cn } from "../utils/cn"

const roundedClassMap = {
  none: "",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full",
} as const

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 骨架宽度 */
  width?: number | string
  /** 骨架高度 */
  height?: number | string
  /** 圆角 */
  rounded?: keyof typeof roundedClassMap
  /** 是否启用 pulse 动画 */
  animate?: boolean
}

const resolveSize = (value: number | string | undefined) => {
  if (value == null) return undefined
  return typeof value === "number" ? `${value}px` : value
}

/**
 * Skeleton 组件 - 统一的加载占位块
 */
export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  (
    {
      className,
      width = "100%",
      height = 16,
      rounded = "md",
      animate = true,
      style,
      ...props
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn(
          "shrink-0 bg-muted/60",
          roundedClassMap[rounded],
          animate && "animate-pulse",
          className,
        )}
        style={{
          width: resolveSize(width),
          height: resolveSize(height),
          ...style,
        }}
        {...props}
      />
    )
  },
)

Skeleton.displayName = "Skeleton"
