import * as React from "react"
import { cn } from "../utils/cn"

export interface LoadingSpinnerProps {
  /** 预设尺寸 */
  size?: "xs" | "sm" | "md" | "lg"
  /** 额外 className */
  className?: string
  /** 加载文案 */
  text?: string
  /** 文字 className */
  textClassName?: string
  /** 布局模式：block（默认居中块）或 inline（行内） */
  inline?: boolean
}

/**
 * LoadingSpinner 组件 - 用于显示加载状态
 */
export const LoadingSpinner = React.forwardRef<HTMLDivElement, LoadingSpinnerProps>(
  ({ size = "md", className, text, textClassName, inline, ...props }, ref) => {
    const sizeClasses = {
      xs: "h-3 w-3",
      sm: "h-4 w-4",
      md: "h-6 w-6",
      lg: "h-8 w-8"
    }

    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center gap-2",
          !inline && "justify-center",
          className,
        )}
        {...props}
      >
        <svg
          className={cn(
            "animate-spin text-muted-foreground",
            sizeClasses[size]
          )}
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {text && (
          <span className={cn("text-body text-muted-foreground", textClassName)}>{text}</span>
        )}
      </div>
    )
  }
)

LoadingSpinner.displayName = "LoadingSpinner"
