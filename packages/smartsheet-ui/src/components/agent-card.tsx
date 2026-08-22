import * as React from "react"
import { cn } from "../utils/cn"
import { Button } from "./button"
import { getSmartsheetUiLocale, t } from "../i18n"
import { formatSmartTime } from "../utils/time"

export interface AgentCardProps {
  id: string
  name: string
  affiliationLabel?: string
  description?: string
  createdAt: string
  tableCount: number
  className?: string
  onSelect?: (id: string) => void
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
  isSelected?: boolean
}

export const AgentCard = React.forwardRef<HTMLDivElement, AgentCardProps>(
  ({
    id,
    name,
    affiliationLabel,
    description,
    createdAt,
    tableCount,
    className,
    onSelect,
    onEdit,
    onDelete,
    isSelected = false,
    ...props
  }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "border rounded-lg p-4 transition-colors cursor-pointer",
          "bg-card text-card-foreground",
          isSelected && "ring-2 ring-primary ring-offset-2",
          className
        )}
        onClick={() => onSelect?.(id)}
        {...props}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-title truncate">{name}</h3>
            {affiliationLabel && (
              <p className="text-caption text-muted-foreground mt-1 truncate">
                {affiliationLabel}
              </p>
            )}
            {description && (
              <p className="text-body text-muted-foreground mt-1 line-clamp-2">
                {description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 ml-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onEdit?.(id)
              }}
              className="h-8 w-8 p-0"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onDelete?.(id)
              }}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between text-body text-muted-foreground">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 10h18M3 14h18m-9-4v8m-7 0V8a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                />
              </svg>
              {t('agentCard.tableCount', { count: tableCount })}
            </span>
          </div>
          <span>{t('agentCard.createdAt', { date: formatSmartTime(createdAt, getSmartsheetUiLocale()) })}</span>
        </div>
      </div>
    )
  }
)

AgentCard.displayName = "AgentCard"
