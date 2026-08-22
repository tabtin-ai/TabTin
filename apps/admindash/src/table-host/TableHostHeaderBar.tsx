import { Button } from '@/components/ui/button'
import { RefreshCw, Table2 } from 'lucide-react'

export interface TableHostHeaderBarProps {
  hasAccessToken: boolean
  isBusy: boolean
  onRefresh: () => void
}

export function TableHostHeaderBar({ hasAccessToken, isBusy, onRefresh }: TableHostHeaderBarProps) {
  return (
    <div className="flex h-12 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-2">
        <Table2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="font-semibold">TabData Host Web (PoC)</h1>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onRefresh}
        disabled={isBusy || !hasAccessToken}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        刷新
      </Button>
    </div>
  )
}
