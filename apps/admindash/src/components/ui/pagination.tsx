import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { Button } from './button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

export const ADMIN_PAGE_SIZE_OPTIONS = [20, 30, 50, 100]

interface PageSizeSelectProps {
  value: number
  onChange: (pageSize: number) => void
  options?: number[]
  className?: string
}

export function PageSizeSelect({
  value,
  onChange,
  options = ADMIN_PAGE_SIZE_OPTIONS,
  className,
}: PageSizeSelectProps) {
  return (
    <div className={cn('flex items-center gap-1.5 text-body text-muted-foreground', className)}>
      <span>每页</span>
      <Select value={String(value)} onValueChange={(nextValue) => onChange(Number(nextValue))}>
        <SelectTrigger className="h-7 w-[88px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option} 条
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface PaginationProps {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
  pageSizeOptions?: number[]
  onPageSizeChange?: (pageSize: number) => void
  className?: string
}

export function Pagination({
  page,
  total,
  pageSize,
  onChange,
  pageSizeOptions = ADMIN_PAGE_SIZE_OPTIONS,
  onPageSizeChange,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const [inputValue, setInputValue] = useState(String(page))

  useEffect(() => {
    setInputValue(String(page))
  }, [page])

  if (total <= pageSize && !onPageSizeChange) return null

  const commitPage = () => {
    const v = Number(inputValue)
    if (v >= 1 && v <= totalPages && v !== page) {
      onChange(v)
    } else {
      setInputValue(String(page))
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commitPage()
  }

  return (
    <div
      className={cn('flex items-center justify-between text-body text-muted-foreground', className)}
    >
      <span>共 {total.toLocaleString()} 条</span>
      <div className="flex items-center gap-1.5">
        {onPageSizeChange ? (
          <PageSizeSelect
            value={pageSize}
            onChange={onPageSizeChange}
            options={pageSizeOptions}
            className="mr-2"
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="flex items-center gap-1 px-2 text-body">
          <input
            type="number"
            min={1}
            max={totalPages}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={commitPage}
            onKeyDown={handleKeyDown}
            className="h-7 w-10 rounded border bg-background text-center text-body outline-none focus:ring-1 focus:ring-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span>/ {totalPages}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
