import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { RecordFormMode } from '@/table-host/record-draft-utils'
import type { Table } from '@tabtin/table-core'
import {
  isAttachmentFieldType,
  type TableField,
  type TableRecord,
} from '@tabtin/table-ui'
import { Pencil, Plus, Save, Trash2 } from 'lucide-react'

export interface TableHostRecordCrudCardProps {
  hasAccessToken: boolean
  isBusy: boolean
  selectedTable: Table | null
  selectedTableId: string
  selectedRecordId: string | null
  selectedRecord: TableRecord | null
  formMode: RecordFormMode
  actionLoading: boolean
  deleteLoading: boolean
  actionError: string | null
  actionMessage: string | null
  recordDraft: Record<string, string>
  orderedFields: TableField[]
  onSetFormMode: (mode: RecordFormMode) => void
  onDraftChange: (fieldName: string, value: string) => void
  onCreateRecord: () => void
  onUpdateRecord: () => void
  onDeleteRecord: () => void
  onResetDraft: () => void
  getFieldChoices: (field: TableField) => string[]
}

export function TableHostRecordCrudCard({
  hasAccessToken,
  isBusy,
  selectedTable,
  selectedTableId,
  selectedRecordId,
  selectedRecord,
  formMode,
  actionLoading,
  deleteLoading,
  actionError,
  actionMessage,
  recordDraft,
  orderedFields,
  onSetFormMode,
  onDraftChange,
  onCreateRecord,
  onUpdateRecord,
  onDeleteRecord,
  onResetDraft,
  getFieldChoices,
}: TableHostRecordCrudCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-subtitle">记录操作（CRUD）</CardTitle>
        <CardDescription>基于 `table-core/record-api` 的 Web 宿主写操作 PoC。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={formMode === 'create' ? 'default' : 'outline'}
            className="gap-1.5"
            onClick={() => onSetFormMode('create')}
          >
            <Plus className="h-3.5 w-3.5" />
            新建
          </Button>
          <Button
            size="sm"
            variant={formMode === 'edit' ? 'default' : 'outline'}
            className="gap-1.5"
            onClick={() => onSetFormMode('edit')}
            disabled={!hasAccessToken || !selectedRecordId}
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </Button>
        </div>

        <div className="rounded-md border bg-background px-3 py-2 text-body text-muted-foreground">
          table: {selectedTable?.name ?? '-'}
          <br />
          selected record: {selectedRecordId ?? '-'}
          <br />
          mode: {formMode === 'create' ? 'create' : 'edit'}
        </div>

        {actionError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {actionError}
          </div>
        )}

        {actionMessage && (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {actionMessage}
          </div>
        )}

        {formMode === 'edit' && !selectedRecord && (
          <div className="rounded-md border bg-background px-3 py-3 text-body text-muted-foreground">
            请先在左侧表格中选择一条记录后再编辑。
          </div>
        )}

        {orderedFields.length > 0 && (
          <div className="max-h-[380px] space-y-2 overflow-auto pr-1">
            {orderedFields.map((field) => {
              const fieldValue = recordDraft[field.name] ?? ''
              const choices = getFieldChoices(field)
              const isSelectField = field.field_type === 'select' && choices.length > 0
              const isAttachmentField = isAttachmentFieldType(field.field_type)

              return (
                <div key={field.id} className="space-y-1">
                  <div className="flex items-center gap-1 text-body text-muted-foreground">
                    <span>{field.name}</span>
                    <span className="text-caption opacity-70">({field.field_type})</span>
                  </div>

                  {field.field_type === 'checkbox' ? (
                    <select
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-body"
                      value={fieldValue}
                      onChange={(event) => onDraftChange(field.name, event.target.value)}
                      disabled={!hasAccessToken || (formMode === 'edit' && !selectedRecord)}
                    >
                      <option value="">(空)</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : isSelectField ? (
                    <select
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-body"
                      value={fieldValue}
                      onChange={(event) => onDraftChange(field.name, event.target.value)}
                      disabled={!hasAccessToken || (formMode === 'edit' && !selectedRecord)}
                    >
                      <option value="">(空)</option>
                      {choices.map((choice) => (
                        <option key={`${field.id}-${choice}`} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  ) : field.field_type === 'number' ? (
                    <Input
                      type="number"
                      value={fieldValue}
                      onChange={(event) => onDraftChange(field.name, event.target.value)}
                      disabled={!hasAccessToken || (formMode === 'edit' && !selectedRecord)}
                    />
                  ) : isAttachmentField ? (
                    <Input
                      value={fieldValue}
                      onChange={(event) => onDraftChange(field.name, event.target.value)}
                      placeholder="附件字段暂不支持在 PoC 中直接编辑"
                      disabled
                    />
                  ) : (
                    <Input
                      value={fieldValue}
                      onChange={(event) => onDraftChange(field.name, event.target.value)}
                      placeholder={
                        field.field_type === 'multi_select'
                          ? '多选值请用英文逗号分隔'
                          : '输入字段值'
                      }
                      disabled={!hasAccessToken || (formMode === 'edit' && !selectedRecord)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          {formMode === 'create' ? (
            <Button
              className="gap-1.5"
              onClick={onCreateRecord}
              disabled={
                !hasAccessToken || !selectedTableId || actionLoading || deleteLoading || isBusy
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {actionLoading ? '创建中...' : '创建记录'}
            </Button>
          ) : (
            <>
              <Button
                className="gap-1.5"
                onClick={onUpdateRecord}
                disabled={
                  !hasAccessToken || !selectedRecordId || actionLoading || deleteLoading || isBusy
                }
              >
                <Save className="h-3.5 w-3.5" />
                {actionLoading ? '保存中...' : '保存修改'}
              </Button>
              <Button
                variant="destructive"
                className="gap-1.5"
                onClick={onDeleteRecord}
                disabled={
                  !hasAccessToken || !selectedRecordId || actionLoading || deleteLoading || isBusy
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleteLoading ? '删除中...' : '删除记录'}
              </Button>
            </>
          )}

          <Button
            variant="outline"
            onClick={onResetDraft}
            disabled={!hasAccessToken || actionLoading || deleteLoading}
          >
            重置
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
