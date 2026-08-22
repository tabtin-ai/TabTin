/**
 * 表格UI组件类型定义
 */

export interface Table {
  id: string
  organization_id: string
  name: string
  description?: string
  icon?: string
  created_by_id: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface TableListItemProps {
  table: Table
  isSelected: boolean
  onClick: (table: Table) => void
  onEdit?: (tableId: string) => void
  onDelete?: (tableId: string) => void
  onArchive?: (tableId: string) => void
  onRestore?: (tableId: string) => void
}

export interface CreateTableDialogProps {
  isOpen: boolean
  onClose: () => void
  isLoading: boolean
  error?: string | null
  onSubmit: (data: { organization_id: string; name: string; description?: string; icon?: string }) => Promise<void>
  organizationId: string
}
