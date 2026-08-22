/**
 * CapabilityBanners — Wave 3 模型能力降级 / 警告 banner 区域。
 *
 * 业务背景：
 * 后端 wire_adapter 在请求适配阶段发现"该模型支持图片但不支持 4K 分辨率"
 * 这类**软不匹配**时发出 `capability_downgrade` / `capability_warning` 事件。
 * 本组件读取 useChatRuntimeStore.capabilityBannersBySessionId 把它们渲染成
 * 一组可关闭的横条 banner，跨 turn 持续显示——不打断对话流，但提醒用户
 * "这个模型在某方面有限制"。
 *
 * 与 `ModeBanner` / `BudgetAlertBanner` 的关系：
 *   - 三者都是 ChatContent 顶部 banner 区，按"重要度递减"排列：
 *     ModeBanner（plan/ask/study 模式态）→ BudgetAlertBanner（钱不够了）→
 *     CapabilityBanners（能力软降级）
 *   - 设计系统对齐：text-body / text-caption / 语义化色 token，不硬编码 px
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Info, AlertTriangle } from 'lucide-react'
import { cn } from '@utils/cn'
import { useChatRuntimeStore, type CapabilityBanner } from '@/stores/useChatRuntimeStore'
import { CHAT_PAGE_GUTTER } from '../registry/chatDesignTokens'
import { resolveRuntimeProfileBannerMessage } from './runtimeProfileNotice'

interface CapabilityBannersProps {
  sessionId: string | null
  /** 嵌入式布局时左侧 paddingLeft 缩进，与 ModeBanner / BudgetAlertBanner 对齐。 */
  compactLeft?: boolean
}

const KIND_THEME: Record<CapabilityBanner['kind'], {
  bgClass: string
  textClass: string
  Icon: React.ComponentType<{ className?: string }>
}> = {
  downgrade: {
    bgClass: 'bg-info/5',
    textClass: 'text-info',
    Icon: Info,
  },
  warning: {
    bgClass: 'bg-warning/5',
    textClass: 'text-warning',
    Icon: AlertTriangle,
  },
}

/**
 * 当后端 message 缺省时按 feature + fallback_to 兜底拼一个中文提示——
 * 避免 banner 出现空气泡。已知的几个映射尽量给出"用户能立即理解"的措辞，
 * 命中不到时退化为通用文案不报红。
 */
function fallbackMessage(banner: CapabilityBanner, t: (k: string, opts?: Record<string, unknown>) => string): string {
  // W2f PR2：runtime_profile stage 优先（含服务端 message / reason 映射）
  const runtimeProfileMessage = resolveRuntimeProfileBannerMessage(banner, t)
  if (runtimeProfileMessage) return runtimeProfileMessage

  if (banner.message) return banner.message

  const feat = banner.feature
  const to = banner.fallback_to

  if (feat === 'image' && to === 'omit_images') {
    return t('capability.banner.imageOmitted', {
      defaultValue: '该模型不支持图片输入，本次请求已自动忽略附带图片',
    })
  }
  if (feat === 'image' && to === 'lower_resolution') {
    return t('capability.banner.imageDownscaled', {
      defaultValue: '该模型对图片分辨率有限制，已自动降为支持的分辨率',
    })
  }
  if (feat === 'tool') {
    if (to === 'auto_tool_choice' || to === 'omit_tool_choice') {
      return t('capability.banner.toolChoiceDowngraded', {
        defaultValue: '当前模型不支持指定的工具调用方式，本轮已自动放宽；如需完整能力请换模型',
      })
    }
    return t('capability.banner.toolDropped', {
      defaultValue: '当前模型不支持工具调用，本轮已自动移除 tools/tool_choice；如需完整能力请换模型',
    })
  }
  if (feat === 'system') {
    if (to === 'user_message_prefix') {
      return t('capability.banner.systemRewritten', {
        defaultValue: '当前模型不支持独立 system prompt，本轮已自动改写为普通提示；如需完整能力请换模型',
      })
    }
    return t('capability.banner.systemDropped', {
      defaultValue: '当前模型不支持 system prompt，本轮已自动忽略；如需完整能力请换模型',
    })
  }
  if (feat === 'json_schema') {
    return t('capability.banner.jsonSchemaDropped', {
      defaultValue: '当前模型不支持严格 JSON Schema，本轮已自动降级为提示词约束；如需完整能力请换模型',
    })
  }
  if (feat === 'json_object') {
    return t('capability.banner.jsonObjectDropped', {
      defaultValue: '当前模型不支持 JSON Object，本轮已自动降级为提示词约束；如需完整能力请换模型',
    })
  }
  // legacy wire：omit reasoning 参数（非 runtime_profile stage）
  if (feat === 'reasoning') {
    return t('capability.banner.reasoningDropped', {
      defaultValue: '当前模型不支持 reasoning/thinking 参数，本轮已自动忽略；如需完整能力请换模型',
    })
  }
  return t('capability.banner.generic', {
    defaultValue: '该模型在某项能力上有限制，已自动降级处理',
  })
}

const CapabilityBannerCard: React.FC<{
  banner: CapabilityBanner
  onDismiss: (id: string) => void
}> = React.memo(({ banner, onDismiss }) => {
  const { t } = useTranslation('chat')
  const theme = KIND_THEME[banner.kind] ?? KIND_THEME.downgrade
  const Icon = theme.Icon

  const text = fallbackMessage(banner, t)

  const handleDismiss = useCallback(() => {
    onDismiss(banner.id)
  }, [banner.id, onDismiss])

  return (
    <div
      className={cn(
        'rounded-xl px-3 py-2',
        theme.bgClass,
      )}
      role="status"
      aria-live="polite"
      data-testid="capability-banner"
      data-banner-kind={banner.kind}
      data-banner-feature={banner.feature ?? ''}
      data-banner-stage={
        typeof banner.extras?.stage === 'string' ? banner.extras.stage : ''
      }
      data-banner-reason={
        typeof banner.extras?.reason === 'string' ? banner.extras.reason : ''
      }
      data-chat-notice
    >
      <div className="flex items-start gap-2">
        <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', theme.textClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-body leading-snug', theme.textClass)}>
            {text}
          </p>
          {banner.model && (
            <p className="mt-0.5 text-caption text-muted-foreground/60">
              {t('capability.banner.modelHint', {
                defaultValue: '当前模型：{{model}}',
                model: banner.model,
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground"
          aria-label={t('capability.banner.dismiss', { defaultValue: '关闭提示' })}
          data-testid="capability-banner-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})
CapabilityBannerCard.displayName = 'CapabilityBannerCard'

const EMPTY_BANNERS: CapabilityBanner[] = []

export const CapabilityBanners: React.FC<CapabilityBannersProps> = ({ sessionId, compactLeft = false }) => {
  const banners = useChatRuntimeStore(s =>
    sessionId ? (s.capabilityBannersBySessionId[sessionId] ?? EMPTY_BANNERS) : EMPTY_BANNERS,
  )
  const dismiss = useChatRuntimeStore(s => s.dismissCapabilityBanner)

  // 稳定 onDismiss 函数引用 —— 否则 banner 列表每次渲染都生成新箭头函数，
  // CapabilityBannerCard 的 React.memo 会失效，每条 banner 都重渲染。
  // 技术 Review 必修-5：用 useCallback 把 sessionId 闭包稳定化。
  const handleDismiss = useCallback(
    (bannerId: string) => {
      if (sessionId) dismiss(sessionId, bannerId)
    },
    [sessionId, dismiss],
  )

  if (!sessionId || banners.length === 0) return null

  return (
    <div
      className={cn(
        'flex-shrink-0 space-y-1.5 mb-2',
        compactLeft ? CHAT_PAGE_GUTTER.compact.content : CHAT_PAGE_GUTTER.panel.margin,
      )}
      data-testid="capability-banners-host"
    >
      {banners.map(banner => (
        <CapabilityBannerCard
          key={banner.id}
          banner={banner}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  )
}
