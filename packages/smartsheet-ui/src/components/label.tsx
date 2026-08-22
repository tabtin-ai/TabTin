import * as React from "react"
import { cn } from "../utils/cn"

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean
}

/**
 * Label 组件 - 用于表单标签
 */
export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn(
          "text-body font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
          className
        )}
        {...props}
      >
        {children}
        {required && (
          <span className="text-destructive ml-1">*</span>
        )}
      </label>
    )
  }
)

Label.displayName = "Label"
