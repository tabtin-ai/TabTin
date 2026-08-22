/**
 * ErrorBanner — shared error display for tool card renderers.
 *
 * 默认行为（2026-05-09 起，专题《工具错误改由 Agent 处置》）：
 *   - 工具 raw 错误**默认不向用户展示** —— 错误处理权完全交给 Agent，
 *     由 Agent 读 tool_result.error / hint / suggestion 后自愈或用人话求助。
 *   - 只在以下两种情况渲染：
 *       1. `DEBUG_PANELS_ENABLED`（dev 模式默认开；packaged build 需
 *          VITE_ENABLE_DEBUG_PANELS=true）开启时——
 *          给开发者排查用，与 LLMSnapshotPanel 等其它调试入口同档；
 *       2. 调用方显式 `forceShow={true}`——给非工具错误（如 ws 断连提示、widget
 *          渲染失败、UI 校验等"用户必须看到"的非 Agent 路径）留逃生口。
 *
 */

import React from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@utils/cn'
import { DEBUG_PANELS_ENABLED } from '@/utils/featureFlags'
import {
  BG,
  TEXT,
  TEXT_COLOR,
  ICON_SIZE,
  CARD_HEADER_PADDING,
} from '../../registry/chatDesignTokens'

export interface ErrorBannerProps {
  error?: string | null
  /**
   * 错误分类码（runtime tool_result.error_kind 透传）。
   * 当前实现暂不读——为将来"按错误分级展示"（如 hard_limit 类仍可见）留口子。
   */
  errorCode?: string
  /**
   * 强制展示。工具错误调用方**一律不传**，让默认隐藏行为接管；
   * 非工具场景（ws 断连、widget 渲染失败等）显式传 true 渲染。
   */
  forceShow?: boolean
}

const ErrorBanner: React.FC<ErrorBannerProps> = React.memo(({ error, forceShow }) => {
  if (!error) return null
  if (!forceShow && !DEBUG_PANELS_ENABLED) return null

  return (
    <div
      className={cn(
        'flex items-start gap-1.5',
        CARD_HEADER_PADDING.x,
        'py-1.5',
        BG.error,
      )}
    >
      <AlertCircle className={cn(ICON_SIZE.md, TEXT_COLOR.error, 'shrink-0 mt-0.5')} />
      <span className={cn(TEXT.meta, TEXT_COLOR.error, 'break-words')}>
        {error}
      </span>
    </div>
  )
})

ErrorBanner.displayName = 'ErrorBanner'

export { ErrorBanner }
export default ErrorBanner
