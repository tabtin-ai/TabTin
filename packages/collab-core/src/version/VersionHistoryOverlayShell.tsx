import React from "react"

export interface VersionHistoryOverlayShellProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  onClose: () => void
  contentHeader?: React.ReactNode
  left: React.ReactNode
  right: React.ReactNode
  footer?: React.ReactNode
  className?: string
  leftClassName?: string
  rightClassName?: string
}

export function VersionHistoryOverlayShell({
  title,
  subtitle,
  onClose,
  contentHeader,
  left,
  right,
  footer,
  className = "",
  leftClassName = "flex flex-1 flex-col border-r bg-muted/20 overflow-auto",
  rightClassName = "flex w-[280px] shrink-0 flex-col overflow-hidden",
}: VersionHistoryOverlayShellProps) {
  return (
    <div className={`absolute inset-0 z-modal flex flex-col bg-background ${className}`}>
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-subtitle font-semibold">{title}</h2>
          {subtitle ? (
            <div className="truncate text-body text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded p-1 hover:bg-muted"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {contentHeader}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={leftClassName}>{left}</div>
        <div className={rightClassName}>{right}</div>
      </div>

      {footer ? (
        <div className="flex shrink-0 items-center justify-end border-t px-6 py-3">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
