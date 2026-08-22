/**
 * LabelFilterBar — TC-37 左栏顶部的 label 筛选条
 *
 * 横向 chip 列：系统 @me 首位 + 自定义 label + 「管理」入口。
 * 点 chip 切换筛选（AND 语义），点「全部」清空。
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2, X } from 'lucide-react'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { LabelManagerDialog } from './LabelManagerDialog'

export const LabelFilterBar: React.FC = () => {
  const { t } = useTranslation('tabchat')
  const labels = useIMStore((s) => s.labels)
  const activeLabelFilters = useIMStore((s) => s.activeLabelFilters)
  const labelsLoadedOrganizationId = useIMStore((s) => s.labelsLoadedOrganizationId)
  const toggleLabelFilter = useIMStore((s) => s.toggleLabelFilter)
  const clearLabelFilters = useIMStore((s) => s.clearLabelFilters)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)

  const [isManagerOpen, setIsManagerOpen] = useState(false)

  // selectedOrganization 已乐观切换而异步标签快照尚未刷新时，不能显示旧组织 chip。
  if (labels.length === 0 || labelsLoadedOrganizationId !== organizationId) return null

  const hasActive = activeLabelFilters.length > 0

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/20 overflow-x-auto scrollbar-none">
        {/* 全部 / 清空筛选 */}
        {hasActive && (
          <button
            type="button"
            onClick={clearLabelFilters}
            className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-caption text-muted-foreground hover:text-foreground hover:bg-muted/40 flex-shrink-0"
          >
            <X className="h-3 w-3" />
            {t('labelFilterAll')}
          </button>
        )}

        {/* label chips */}
        {labels.map((label) => {
          const isActive = activeLabelFilters.includes(label.id)
          return (
            <button
              key={label.id}
              type="button"
              onClick={() => toggleLabelFilter(label.id)}
              title={t('labelFilterHint')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-caption flex-shrink-0 transition-colors ${
                isActive
                  ? 'text-white'
                  : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              style={
                isActive
                  ? { backgroundColor: label.color }
                  : undefined
              }
            >
              {!isActive && (
                <span
                  className="h-2 w-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: label.color }}
                />
              )}
              <span className="truncate max-w-[80px]">{label.name}</span>
            </button>
          )
        })}

        {/* 管理入口 */}
        <button
          type="button"
          onClick={() => setIsManagerOpen(true)}
          title={t('labelManage')}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 flex-shrink-0"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <LabelManagerDialog
        isOpen={isManagerOpen}
        onClose={() => setIsManagerOpen(false)}
      />
    </>
  )
}
