import type React from 'react'
import { Pencil, Search } from 'lucide-react'
import { Input } from '@tabtin/smartsheet-ui'

export interface GridToolbarLeftSectionTableMeta {
  name: string
  icon?: string | null
}

export interface GridToolbarLeftSectionProps {
  selectedTable: GridToolbarLeftSectionTableMeta
  selectedRowsCount: number
  totalRowsText: string
  totalColumnsText: string
  selectedRowsText?: string
  isEditingTableName: boolean
  editingTableName: string
  searchQuery: string
  tableNameInputRef: React.RefObject<HTMLInputElement | null>
  emojiButtonRef: React.RefObject<HTMLDivElement | null>
  tableNamePlaceholder: string
  iconTitle: string
  tableNameTitle: string
  searchPlaceholder: string
  setEditingTableName: (value: string) => void
  onTableNameClick: () => void
  onTableNameSubmit: () => void | Promise<void>
  onTableNameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onEmojiClick: (event: React.MouseEvent) => void
  onSearch: (query: string) => void
}

export const GridToolbarLeftSection: React.FC<GridToolbarLeftSectionProps> = ({
  selectedTable,
  selectedRowsCount,
  totalRowsText,
  totalColumnsText,
  selectedRowsText,
  isEditingTableName,
  editingTableName,
  searchQuery,
  tableNameInputRef,
  emojiButtonRef,
  tableNamePlaceholder,
  iconTitle,
  tableNameTitle,
  searchPlaceholder,
  setEditingTableName,
  onTableNameClick,
  onTableNameSubmit,
  onTableNameKeyDown,
  onEmojiClick,
  onSearch,
}) => {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <div className="space-y-0.5">
        {isEditingTableName ? (
          <div className="flex items-center gap-2">
            <Input
              ref={tableNameInputRef}
              value={editingTableName}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setEditingTableName(event.target.value)
              }
              onKeyDown={onTableNameKeyDown}
              onBlur={() => {
                void onTableNameSubmit()
              }}
              className="h-7 px-2 py-1 text-body font-semibold"
              placeholder={tableNamePlaceholder}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div
              ref={emojiButtonRef}
              onClick={onEmojiClick}
              className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-title transition-colors hover:bg-accent"
              title={iconTitle}
            >
              {selectedTable.icon || '📄'}
            </div>

            <h2
              className="group flex cursor-pointer items-center gap-2 truncate text-body font-semibold text-foreground transition-colors hover:text-primary"
              onClick={onTableNameClick}
              title={tableNameTitle}
            >
              {selectedTable.name}
              <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-50" />
            </h2>
          </div>
        )}

        <div className="flex items-center gap-3 text-body text-muted-foreground">
          <span>{totalRowsText}</span>
          <span>·</span>
          <span>{totalColumnsText}</span>
          {selectedRowsCount > 0 && selectedRowsText && (
            <>
              <span>·</span>
              <span className="font-medium text-primary">{selectedRowsText}</span>
            </>
          )}
        </div>
      </div>

      <div className="relative w-64">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transform text-muted-foreground" />
        <Input
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onSearch(event.target.value)}
          className="h-8 pl-8 text-body"
        />
      </div>
    </div>
  )
}
