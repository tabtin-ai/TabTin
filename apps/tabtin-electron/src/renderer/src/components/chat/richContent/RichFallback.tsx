/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 390-398）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：未知 kind / 缺字段场景的兜底渲染 —— 其他 Rich* 组件校验失败（譬如 image 缺 url、
 *       table 缺 columns、file 缺 url）都回退到本组件。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import React from 'react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { Image as ImageIcon } from 'lucide-react'
import { KIND_ICONS } from './kindIcons'

export const RichFallback: React.FC<{ block: RichContentBlock }> = React.memo(({ block }) => {
  const Icon = KIND_ICONS[block.kind] ?? ImageIcon
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 px-3 py-2 bg-muted/10">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <p className="text-caption text-muted-foreground">{block.summary}</p>
    </div>
  )
})
