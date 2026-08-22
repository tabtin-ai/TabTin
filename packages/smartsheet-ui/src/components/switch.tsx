/**
 * Switch 组件
 * React 19 下 @radix-ui/react-switch 的 Root 会通过 ref callback setState，
 * 在 Electron/Vite HMR 场景容易触发 Maximum update depth。这里保留公开 API，
 * 用原生 button 实现无内部 ref state 的 switch。
 */

import * as React from 'react'
import { cn } from '../utils/cn'

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'checked' | 'defaultChecked' | 'onChange'> {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** 默认 h-5 w-9；sm 用于 Skill 卡片等紧凑场景 */
  size?: 'default' | 'sm'
}

const SWITCH_SIZE_STYLES = {
  default: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    thumbOn: 'translate-x-4',
  },
  sm: {
    track: 'h-4 w-7',
    thumb: 'h-3 w-3',
    thumbOn: 'translate-x-3',
  },
} as const

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(({
  className,
  checked,
  defaultChecked = false,
  disabled,
  onClick,
  onCheckedChange,
  size = 'default',
  ...props
}, ref) => {
  const isControlled = checked !== undefined
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked)
  const currentChecked = isControlled ? Boolean(checked) : uncontrolledChecked
  const sizeStyle = SWITCH_SIZE_STYLES[size]

  const handleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || disabled) return
    const nextChecked = !currentChecked
    if (!isControlled) setUncontrolledChecked(nextChecked)
    onCheckedChange?.(nextChecked)
  }, [currentChecked, disabled, isControlled, onCheckedChange, onClick])

  return (
    <button
      type="button"
      role="switch"
      aria-checked={currentChecked}
      data-state={currentChecked ? 'checked' : 'unchecked'}
      data-disabled={disabled ? '' : undefined}
      disabled={disabled}
      className={cn(
        'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        sizeStyle.track,
        currentChecked ? 'bg-primary' : 'bg-input',
        className
      )}
      {...props}
      ref={ref}
      onClick={handleClick}
    >
      <span
        className={cn(
          'pointer-events-none block rounded-full bg-background shadow-lg ring-0 transition-transform',
          sizeStyle.thumb,
          currentChecked ? sizeStyle.thumbOn : 'translate-x-0'
        )}
      />
    </button>
  )
})
Switch.displayName = 'Switch'

export { Switch }
