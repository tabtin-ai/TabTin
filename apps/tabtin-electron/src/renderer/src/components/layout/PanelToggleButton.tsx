import React from 'react'
import { Button } from '@tabtin/smartsheet-ui'

interface PanelToggleButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  title: string
  children: React.ReactNode
}

const baseClass =
  'h-8 w-8 rounded-lg border border-border/40 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors'

export const PanelToggleButton: React.FC<PanelToggleButtonProps> = ({
  title,
  onClick,
  disabled,
  className,
  children,
  ...rest
}) => {
  const classes = className ? `${baseClass} ${className}` : baseClass

  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={classes}
      {...rest}
    >
      {children}
    </Button>
  )
}
