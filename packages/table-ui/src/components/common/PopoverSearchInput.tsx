import React from 'react'
import { Search } from 'lucide-react'
import { cn } from '@tabtin/smartsheet-ui'

interface PopoverSearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onValueChange: (value: string) => void
  containerClassName?: string
  iconClassName?: string
  inputClassName?: string
}

export const PopoverSearchInput = React.forwardRef<HTMLInputElement, PopoverSearchInputProps>(
  (
    { value, onValueChange, containerClassName, iconClassName, inputClassName, ...restProps },
    ref
  ) => {
    return (
      <div className={cn('flex items-center gap-2 border-b px-3 py-2', containerClassName)}>
        <Search className={cn('h-4 w-4 shrink-0 text-muted-foreground', iconClassName)} />
        <input
          ref={ref}
          value={value}
          onChange={event => onValueChange(event.target.value)}
          className={cn(
            'h-7 w-full bg-transparent text-body outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
            inputClassName
          )}
          {...restProps}
        />
      </div>
    )
  }
)

PopoverSearchInput.displayName = 'PopoverSearchInput'
