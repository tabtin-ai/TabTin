import { Button } from '@/components/ui/button'
import { TableDetailContent } from '@/table-management/components/TableDetailContent'
import { ArrowLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

export function TableManagementDetailPage() {
  const navigate = useNavigate()
  const { tableId = '' } = useParams<{ tableId: string }>()

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">表格详情</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => navigate('/tables')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回列表
        </Button>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {tableId ? (
          <TableDetailContent tableId={tableId} />
        ) : (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            缺少 tableId 参数
          </div>
        )}
      </div>
    </div>
  )
}
