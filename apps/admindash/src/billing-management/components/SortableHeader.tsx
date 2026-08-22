import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

export type SortDirection = 'asc' | 'desc' | null

interface SortableHeaderProps {
  label: string
  field: string
  currentSort: string
  onSort: (field: string) => void
}

export function SortableHeader({ label, field, currentSort, onSort }: SortableHeaderProps) {
  const isActive = currentSort === field || currentSort === `-${field}`
  const isDesc = currentSort === `-${field}`

  return (
    <button
      type="button"
      className="flex items-center gap-1 font-medium hover:text-foreground transition-colors"
      onClick={() => onSort(field)}
      aria-label={`按${label}排序`}
    >
      {label}
      {isActive ? (
        isDesc ? (
          <ArrowDown className="h-3.5 w-3.5" />
        ) : (
          <ArrowUp className="h-3.5 w-3.5" />
        )
      ) : (
        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
      )}
    </button>
  )
}

export function toggleSort(currentSort: string, field: string): string {
  if (currentSort === field) return `-${field}`
  if (currentSort === `-${field}`) return ''
  return field
}
