import * as React from "react"
import { cn } from "../utils/cn"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
  helperText?: string
}

const NATIVE_PICKER_INPUT_TYPES = new Set([
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

function isNativePickerInputType(type?: string): boolean {
  return type != null && NATIVE_PICKER_INPUT_TYPES.has(type)
}

/**
 * Input 组件 - 用于表单输入
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, helperText, onClick, ...props }, ref) => {
    const opensNativePicker = isNativePickerInputType(type)

    const handleClick = (event: React.MouseEvent<HTMLInputElement>) => {
      onClick?.(event)
      if (event.defaultPrevented || !opensNativePicker || props.disabled || props.readOnly) return
      const el = event.currentTarget
      if (typeof el.showPicker === 'function') {
        try {
          el.showPicker()
        } catch {
          // Chromium may throw if picker already open or call is blocked
        }
      }
    }

    return (
      <div className="min-w-0 w-full max-w-full">
        <input
          type={type}
        className={cn(
          "flex h-10 min-w-0 max-w-full w-full rounded-interactive bg-muted text-foreground px-3 py-2 text-body file:border-0 file:bg-transparent file:text-body file:font-medium placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50 focus-visible:bg-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          opensNativePicker && [
            'relative cursor-pointer',
            // WebKit/Chromium：把原生日历按钮铺满整行，避免只有右侧 icon 能点开。
            '[&::-webkit-calendar-picker-indicator]:absolute',
            '[&::-webkit-calendar-picker-indicator]:inset-0',
            '[&::-webkit-calendar-picker-indicator]:h-full',
            '[&::-webkit-calendar-picker-indicator]:w-full',
            '[&::-webkit-calendar-picker-indicator]:m-0',
            '[&::-webkit-calendar-picker-indicator]:cursor-pointer',
            '[&::-webkit-calendar-picker-indicator]:opacity-0',
          ],
          error && "ring-1 ring-inset ring-destructive/60 focus-visible:ring-destructive/60",
          className
        )}
          ref={ref}
          onClick={handleClick}
          {...props}
        />
        {helperText && (
          <p className={cn(
            "text-body mt-1",
            error ? "text-destructive" : "text-muted-foreground"
          )}>
            {helperText}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = "Input"
