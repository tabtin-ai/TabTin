/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 400-1292）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：widget kind 容器组件 —— 组合 useWidgetStreaming / useWidgetContextActions
 *       两个 hook，渲染 sandbox iframe / 流式占位 / 中断占位 / 图片 fallback / 右键菜单。
 *
 *       **与原实现的等价性**（Wave 3 cancel 保留 + a11y aria-live 行为不能退化）：
 *         - React.memo + displayName='RichWidget' 保留（稳定 key 依赖 displayName）
 *         - hook 调用顺序：useTranslation → useIsDarkMode → useRef × 2 →
 *           [useWidgetStreaming: useState × 4 + useRef × 3 + useCallback × 2 + useEffect]
 *           → useMemo(srcdoc) → useState(contextMenuPos) → useCallback × 3
 *           → useEffect(cleanup iframe unregister) → [useWidgetContextActions:
 *           useCallback × 3]（`t` 作为入参传入，避免多调一次 useTranslation 打乱链路
 *           —— 三视角 Review P0-1 自修）
 *         - iframe sandbox="allow-scripts"（不带 allow-same-origin）是硬约束
 *         - data-widget-id / data-tool-call-id / data-interrupted 不变（测试断言）
 *         - aria-live polite + sr-only span 的 liveAnnouncement 拼接逻辑字面不变
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RichContentBlock } from '@tabtin/chat-client'
import { useIsDarkMode } from '@/hooks/useIsDarkMode'
import {
  registerWidgetSendPromptIframe,
  unregisterWidgetSendPromptIframe,
} from '@/services/widgetSendPromptHandler'
import { wrapWidgetCode } from './wrapWidgetCode'
import type { WidgetMenuPosition } from './WidgetContextMenu'
import { useWidgetStreaming } from './useWidgetStreaming'
import { useWidgetContextActions } from './useWidgetContextActions'
import { buildWidgetFileRefDragArtifacts } from './widgetFileRefDrag'
import { buildWidgetAccessibility } from './buildWidgetAccessibility'
import { selectWidgetRenderMode } from './selectWidgetRenderMode'
import { RichWidgetFrame } from './RichWidgetFrame'
import { useChatImageDragSource } from '@/utils/fileRefDrag'
import { openWidgetPreview } from './openWidgetPreview'
import {
  canOpenRichWidgetPreview,
  parseRichWidgetBlockFields,
  resolveRichWidgetEffectiveFormat,
  resolveRichWidgetLoadingMessage,
  resolveRichWidgetRenderCode,
  resolveSafeStreamingCode,
} from './richWidgetPresentation'

// ─── RichWidget（Widget Wave 2，widget RFC §三 3.1 / §四 4.1 / §四 4.4）─

/**
 * Widget Wave 2 上线版本——chat 内联 sandbox iframe 流式渲染 SVG。
 *
 * 三种状态：
 *   1. **流式期间**（消费 Wave 1 `subscribeToolCallArgsDelta`）：
 *      - LLM 边吐 SVG 边在 iframe 里更新；rAF 节流避免高频重排卡 UI
 *      - 还没拿到 code 时显示 loading_message 占位（block.loading_message ||
 *        i18n 兜底"Agent 正在生成可视化…"）
 *   2. **持久化模式**（block.code 已经在 content_blocks_json）：
 *      - 直接用 code 一次性渲染 srcdoc，不流式（与 RFC §四 4.1 历史回放对齐）
 *   3. **图片 fallback**（block.image_url 存在 + code 缺失）：
 *      - Wave 4 烤图链路上线后，移动端拉到的就是这个分支；桌面端历史回放
 *        若 code 丢失也走这条
 *
 * 安全约束（widget RFC §四 4.4，硬约束）：
 *   - `sandbox="allow-scripts"`——**不带** `allow-same-origin`：iframe 内
 *     script 不能访问 parent DOM/cookie，是 sendPrompt 的安全前提
 *   - CSP 严格：`script-src 'unsafe-inline'`（允许 inline script 给 sendPrompt
 *     wrapper 用，但**禁止**外链 script）；img 限 https + data；style 允许
 *     inline；font 限 self + data
 *   - sendPrompt wrapper 在 `packages/widget-tokens/src/wrapper.ts` 的
 *     `buildSendPromptBootstrap` 里注入（trusted gesture 2s 窗口 + 1000 字符
 *     text 上限 + 4KB meta 上限）；renderer 侧 postMessage handler 见
 *     `apps/tabtin-electron/src/renderer/src/services/widgetSendPromptHandler.ts`
 *
 * 视觉差异化（与 RichImage 区分）：
 *   - 容器顶部用纯文字“图示”标识内容类型，不叠装饰性系统图标
 *   - 可点击放大（Lightbox）；iframe 用 pointer-events-none 让点击落到容器
 *     （交互式 sendPrompt 请右键「在新窗口打开」）
 *   - 流式中标题加灰色"流式中…"指示
 */
export interface RichWidgetProps {
  block: RichContentBlock
  sessionId?: string | null
  messageId?: string
}

/**
 * Widget Wave 3（RFC §五 3.6）：interrupted 视觉常量。
 *
 * 用户能区分 "在画 vs 已中断 vs 已完成" 三态。
 *   - 在画：流式中… badge 灰色（已有）
 *   - 已中断：dim overlay + 已中断 badge（本 wave 新加）
 *   - 已完成：summary 在底部（已有）
 *
 * 透明度 60% 是用户视觉测试的甜点：太低（30%）显得"已经死掉"，太高（90%）
 * 看不出区别。60% 既保留 widget 的可读性又能立刻识别"是中断的"。
 */
export const RichWidget: React.FC<RichWidgetProps> = React.memo(({ block, sessionId, messageId }) => {
  const { t } = useTranslation('chat')
  const isDarkMode = useIsDarkMode()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const registeredIframeWindowRef = useRef<Window | null>(null)

  const {
    blockToolCallId,
    blockFormat,
    finalCode,
    imageUrl,
    isPendingPlaceholder,
    exposedWidgetId,
    isInterrupted,
  } = parseRichWidgetBlockFields(block)

  const { streamingCode, streamingLoadingMessage, streamingFormat, isStreaming } =
    useWidgetStreaming({ sessionId, finalCode, blockToolCallId })

  const effectiveFormat = resolveRichWidgetEffectiveFormat(finalCode, blockFormat, streamingFormat)
  const safeStreamingCode = resolveSafeStreamingCode(streamingCode ?? '', effectiveFormat)
  const renderCode = resolveRichWidgetRenderCode(finalCode, effectiveFormat, safeStreamingCode)

  const srcdoc = useMemo(() => {
    if (!renderCode) return ''
    // Widget Wave 2.5（技术 Review A 修复——主题切换硬伤）：
    // 桌面 chat 用 `.dark` class 切换主题（useIsDarkMode 读 documentElement.classList），
    // 旧实现 wrapWidgetCode 用 `@media (prefers-color-scheme: dark)` 跟 OS 走——
    // 用户 OS=light 但 app=dark 时 widget 内显示 light，整张卡片视觉真分裂。
    // 修法：传 theme 参数让 wrapper 注入对应 light/dark 块，不再依赖 prefers-color-scheme。
    return wrapWidgetCode(renderCode, effectiveFormat, {
      theme: isDarkMode ? 'dark' : 'light',
      widgetId: exposedWidgetId || undefined,
    })
  }, [renderCode, effectiveFormat, isDarkMode, exposedWidgetId])

  // ─── Widget Wave 4.10（widget RFC §五 4.10）：右键菜单 ─────────────────
  //
  // 业务目标：用户右键 widget 卡片 → 弹自定义菜单 → 保存 PNG / 复制 SVG /
  // 在新窗口打开。三种 action 都用现成 web API（clipboard / a-tag download /
  // window.open），不依赖主进程额外能力。
  //
  // **状态判断**：
  //   - canSavePng：image_url 存在（最快）或 finalCode 存在（renderer 端转）
  //   - canCopyCode：finalCode 存在（不复制 partial / streaming——避免给用户
  //     不完整的源码）
  //   - canOpenInNewWindow：有任何可渲染内容（finalCode / streamingCode /
  //     image_url 任一）
  const IFRAME_MAX_HEIGHT = 2000

  const [iframeHeight, setIframeHeight] = useState<number | null>(null)
  // srcdoc 变化（流式 partial → final、主题切换）时先清高度，避免沿用偏高值
  // 造成矮图下方留白；等 iframe 内新的 tabtin:resize 再贴合内容。
  useEffect(() => {
    setIframeHeight(null)
  }, [srcdoc])
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || data.type !== 'tabtin:resize') return
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      const h = data.height
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return
      setIframeHeight(Math.min(Math.ceil(h), IFRAME_MAX_HEIGHT))
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const [contextMenuPos, setContextMenuPos] = useState<WidgetMenuPosition | null>(null)
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // pending placeholder 时无内容可操作——不弹菜单（避免空 dropdown 困惑用户）
      if (isPendingPlaceholder) return
      // 流式中且无 finalCode 仍然弹（"在新窗口打开"可用，让用户看 partial）
      e.preventDefault()
      setContextMenuPos({ x: e.clientX, y: e.clientY })
    },
    [isPendingPlaceholder],
  )
  const closeContextMenu = useCallback(() => setContextMenuPos(null), [])

  const registerCurrentIframe = useCallback(() => {
    const source = iframeRef.current?.contentWindow
    if (!source || !exposedWidgetId || !sessionId) return
    if (registeredIframeWindowRef.current && registeredIframeWindowRef.current !== source) {
      unregisterWidgetSendPromptIframe(registeredIframeWindowRef.current)
    }
    registerWidgetSendPromptIframe({
      source,
      widgetId: exposedWidgetId,
      sessionId,
    })
    registeredIframeWindowRef.current = source
  }, [exposedWidgetId, sessionId])

  useEffect(() => {
    return () => {
      unregisterWidgetSendPromptIframe(registeredIframeWindowRef.current)
      registeredIframeWindowRef.current = null
    }
  }, [])

  const {
    canSavePng,
    canCopyCode,
    canOpenInNewWindow,
    copyLabel,
    handleSavePng,
    handleCopyCode,
    handleOpenInNewWindow,
  } = useWidgetContextActions({
    block,
    renderCode,
    srcdoc,
    finalCode,
    imageUrl,
    streamingCode,
    effectiveFormat,
    isDarkMode,
    t,
  })

  // 对话图示 → 文档/表格：有烤图 URL 或完整 SVG 时可拖
  const widgetDragArtifacts = useMemo(
    () =>
      buildWidgetFileRefDragArtifacts({
        imageUrl,
        finalCode,
        format: effectiveFormat,
        title: block.title,
        summary: block.summary,
      }),
    [block.summary, block.title, effectiveFormat, finalCode, imageUrl],
  )
  const widgetDrag = useChatImageDragSource(widgetDragArtifacts?.input ?? {})

  const loadingMessage = resolveRichWidgetLoadingMessage(
    streamingLoadingMessage ?? '',
    block.loading_message,
    t('richContent.widgetLoadingFallback', { defaultValue: 'Agent 正在生成可视化…' }),
  )

  const showImageFallback = !finalCode && !streamingCode && !!imageUrl
  const canZoomPreview = canOpenRichWidgetPreview(isPendingPlaceholder, finalCode, renderCode, imageUrl)
  const renderMode = selectWidgetRenderMode({
    showImageFallback,
    srcdoc,
    effectiveFormat,
    streamingCode: safeStreamingCode,
    isInterrupted,
    loadingMessage,
  })

  const openPreview = useCallback(() => {
    openWidgetPreview({
      canZoomPreview,
      finalCode,
      renderCode,
      effectiveFormat,
      exposedWidgetId,
      messageId,
      sessionId,
      imageUrl,
      title: block.title,
      summary: block.summary,
    })
  }, [
    block.summary,
    block.title,
    canZoomPreview,
    effectiveFormat,
    exposedWidgetId,
    finalCode,
    imageUrl,
    messageId,
    renderCode,
    sessionId,
  ])

  // Widget Wave 3（RFC §五 3.4 + 3.8 ③）：a11y label 增强。
  //
  // 业务目的：盲人用 VoiceOver / TalkBack 能听到这是什么 widget + 当前状态：
  //   - 完成态："架构图：K8s 三层架构图"
  //   - 流式中："架构图（生成中）：K8s 三层架构图"
  //   - 已中断："架构图（已中断）：K8s 三层架构图"
  // 测试断言：role=img + aria-label 含 summary（最低）+ 状态前缀（增强）。
  //
  // 注：状态前缀的括号通过 i18n key（statePrefixStreaming/statePrefixInterrupted）
  // 渲染——en/zh locale 各自决定全角 vs 半角括号，避免硬编码全角""在英文 locale
  // 看到"图示（生成中）"中文括号包英文文字的视觉割裂。
  const widgetTypeLabel = t('richContent.widgetBadge', '图示')
  const { ariaLabel, liveAnnouncement } = buildWidgetAccessibility({
    isInterrupted,
    isStreaming,
    finalCode,
    summary: block.summary,
    title: block.title,
    widgetTypeLabel,
    t,
  })

  return (
    <RichWidgetFrame
      ariaLabel={ariaLabel}
      exposedWidgetId={exposedWidgetId}
      blockToolCallId={blockToolCallId}
      isInterrupted={isInterrupted}
      isStreaming={isStreaming}
      finalCode={finalCode}
      canZoomPreview={canZoomPreview}
      widgetTypeLabel={widgetTypeLabel}
      liveAnnouncement={liveAnnouncement}
      title={block.title}
      summary={block.summary}
      renderMode={renderMode}
      imageUrl={imageUrl}
      srcdoc={srcdoc}
      iframeRef={iframeRef}
      iframeHeight={iframeHeight}
      onIframeLoad={registerCurrentIframe}
      contextMenuPos={contextMenuPos}
      canSavePng={canSavePng}
      canCopyCode={canCopyCode}
      canOpenInNewWindow={canOpenInNewWindow}
      copyLabel={copyLabel}
      onSavePng={handleSavePng}
      onCopyCode={handleCopyCode}
      onOpenInNewWindow={handleOpenInNewWindow}
      onCloseContextMenu={closeContextMenu}
      widgetDrag={widgetDrag}
      onContextMenu={handleContextMenu}
      onOpenPreview={openPreview}
    />
  )
})
RichWidget.displayName = 'RichWidget'
