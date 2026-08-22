/**
 * VaultDetail —— 通用详情面板外壳。
 *
 * 提供：
 *  - 大 favicon + 标题 + 类型副标题（来自 row.primary / row.secondary / row.kindIcon）
 *  - 子内容由调用方填充（字段表 / 警告卡 / 行动按钮）
 *  - 未选中时显示「请选择条目」提示，由外层决定要不要替换为更友好的引导
 */

import React from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { VaultFavicon } from '../credentials/VaultFavicon'
import type { VaultRow } from './types'
import { SETTINGS_HINT } from '../../settingsUi'
import { cn } from '@utils/cn'

interface VaultDetailProps<T> {
  row: VaultRow<T> | null
  /** kind 副标题（例如「浏览器 Cookie」「OpenAI · API Key」） */
  kindLabel?: string
  /** 字段表 + 警告 + 行动按钮 */
  children?: React.ReactNode
}

export function VaultDetail<T>({ row, kindLabel, children }: VaultDetailProps<T>) {
  const { t } = useTranslation('settings')

  if (!row) {
    return (
      <div className="flex h-full items-center justify-center text-center p-6">
        <div className="max-w-xs">
          <ChevronRight className="mx-auto h-5 w-5 text-muted-foreground/30" />
          <p className="mt-2 text-body text-muted-foreground/80">
            {t('vault.detail.selectPrompt', { defaultValue: '选择左侧条目查看详情' })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-hover p-6">
      <div className="mx-auto max-w-md">
        <div className="flex flex-col items-center text-center">
          <VaultFavicon host={row.faviconKey} size="lg" />
          <h3 className="mt-3 text-subtitle font-semibold text-foreground break-all">
            {row.primary}
          </h3>
          {kindLabel && (
            <p className={cn(SETTINGS_HINT, 'mt-0.5 inline-flex items-center gap-1.5')}>
              {row.kindIcon}
              {kindLabel}
            </p>
          )}
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}

/** 详情面板里通用的字段行（label 左对齐 / value 右对齐 / 可选 action 按钮） */
export const VaultDetailField: React.FC<{
  label: string
  value: React.ReactNode
  action?: React.ReactNode
  valueClassName?: string
}> = ({ label, value, action, valueClassName }) => (
  <div className="flex items-center gap-3 px-4 py-2.5 bg-background hover:bg-muted/15 transition-colors">
    <span className={cn(SETTINGS_HINT, 'w-20 shrink-0')}>{label}</span>
    <span className={`flex-1 min-w-0 text-body text-foreground text-right truncate ${valueClassName ?? ''}`}>
      {value}
    </span>
    {action ? <span className="shrink-0">{action}</span> : null}
  </div>
)

/** 字段组容器（带边框 + 圆角 + 分隔） */
export const VaultDetailFieldGroup: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div className={`rounded-xl border border-border/60 divide-y divide-border/40 overflow-hidden ${className ?? ''}`}>
    {children}
  </div>
)
