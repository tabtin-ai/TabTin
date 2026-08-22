/**
 * VaultEmpty —— 通用空状态。
 *
 * 数据为零时整体替换面板，给一个清晰的 CTA。每个 panel 提供自己的标题 / 描述 /
 * 主按钮内容（CTA 内容因 tab 不同：浏览器是"同步 Chrome"，AI 是"添加首个 API Key"
 * ……）。
 */

import React from 'react'
import { SETTINGS_TEXT_META } from '../../settingsUi'
import { cn } from '@utils/cn'

interface VaultEmptyProps {
  icon: React.ReactNode
  title: string
  subtitle?: string
  cta: React.ReactNode
}

export const VaultEmpty: React.FC<VaultEmptyProps> = ({ icon, title, subtitle, cta }) => (
  <div className="rounded-xl border border-dashed border-border/60 px-6 py-12">
    <div className="mx-auto max-w-md text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/60">
        {icon}
      </span>
      <h3 className="mt-4 text-subtitle font-semibold text-foreground">{title}</h3>
      {subtitle && (
        <p className={cn(SETTINGS_TEXT_META, 'mt-1 leading-relaxed')}>{subtitle}</p>
      )}
      <div className="mt-5 flex items-center justify-center">{cta}</div>
    </div>
  </div>
)
