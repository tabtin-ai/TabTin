/**
 * 表格列表项组件（标准版本 - 用于主视图）
 *
 * ⚠️ 注意：侧边栏使用的是 TableListItemCompact，不是这个组件！
 *
 * 设计理念：
 * - 用于主内容区域的表格列表展示
 * - 不用于侧边栏层级结构
 *
 * 视觉规范：
 * - 内边距：8-10px
 * - 图标容器：32×32px
 * - 圆角：6px
 * - 悬停/选中过渡：120ms
 */

import React from 'react'
import { Archive, MoreVertical } from 'lucide-react'
import type { TableListItemProps } from './types'
import { t } from "../../i18n"

export const TableListItem: React.FC<TableListItemProps> = ({
  table,
  isSelected,
  onClick,
}) => {
  const handleClick = () => {
    onClick(table)
  }

  return (
    <div
      onClick={handleClick}
      className={`group relative flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer transition-all duration-120 ${
        isSelected
          ? 'bg-primary/15 text-foreground'
          : 'hover:bg-accent/8 text-foreground'
      }`}
    >
      {/* 图标容器 - 标准尺寸（非侧边栏用） */}
      <div className={`flex items-center justify-center h-8 w-8 rounded-md shrink-0 transition-colors duration-120 ${
        isSelected ? 'bg-primary/25' : 'bg-muted/50'
      }`}>
        {table.icon ? (
          <span className="text-subtitle leading-none">{table.icon}</span>
        ) : (
          <div className="h-4 w-4 text-muted-foreground">📄</div>
        )}
      </div>

      {/* 表格信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-body truncate ${
            isSelected ? 'font-semibold text-foreground' : 'font-normal text-foreground'
          }`}>
            {table.name}
          </span>

          {table.is_archived && (
            <div title={t('tableListItem.archived')}>
              <Archive className="h-3 w-3 text-muted-foreground shrink-0" />
            </div>
          )}
        </div>

        {table.description && (
          <p className="text-body text-muted-foreground truncate mt-0.5">
            {table.description}
          </p>
        )}
      </div>

      {/* 更多操作按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation()
        }}
        className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded-sm flex items-center justify-center hover:bg-accent/15 transition-all duration-150"
        title={t('tableListItem.moreActions')}
      >
        <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {/* 选中指示器 - 左侧 3px 条 */}
      {isSelected && (
        <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
      )}
    </div>
  )
}
