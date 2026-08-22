/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 956-1109）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：widget 右键菜单 actions hook —— 计算 canSavePng / canCopyCode /
 *       canOpenInNewWindow 判定位 + 生成 handleSavePng / handleCopyCode /
 *       handleOpenInNewWindow 三个 async 回调 + copyLabel。全部是 UI 层纯粹
 *       交互逻辑（剪贴板 / object URL / window.open），与业务模型解耦。
 *
 *       **与原实现的等价性**（ 起）：
 *         - handleSavePng: 与 Lightbox 对齐——有 image_url 走 downloadPreviewResource
 *           （主进程 net，避免打包态裸 fetch CSP/CORS 失败）；无 URL 有 code 时走
 *           downloadWidgetPreview（svgCodeToPngBlob + saveExportBlob）
 *         - handleCopyCode / handleOpenInNewWindow：行为与拆分前一致
 *         - useCallback 依赖数组字面等价，避免 referenced toast/t 函数闭包失稳
 *         - copyLabel 在 HTML / SVG 两分支切换（与原 inline 等价）
 * 业务逻辑版本：下载落盘与 Lightbox 统一；复制 / 新窗口保持原行为
 */

import { useCallback } from 'react'
import type { TFunction } from 'i18next'
import { toast } from '@tabtin/smartsheet-ui'
import type { RichContentBlock } from '@tabtin/chat-client'
import {
  downloadPreviewResource,
  downloadWidgetPreview,
} from '../../preview/downloadPreviewResource'
import type { PreviewResource } from '../../preview/types'

export interface UseWidgetContextActionsInput {
  block: RichContentBlock
  renderCode: string
  srcdoc: string
  finalCode: string
  imageUrl: string
  streamingCode: string | null
  effectiveFormat: 'svg' | 'html' | 'mermaid'
  isDarkMode: boolean
  /**
   * i18n translate 函数。由 RichWidget 容器通过父层 `useTranslation('chat')` 取到后
   * 显式传入——**不要**在本 hook 内独立 useTranslation('chat')，否则 RichWidget 的
   * hook 调用链会比 HEAD 版本多出 1 个 hook（React.memo 再 subscribe 一次 i18next
   * context），破坏"拆分前后 hook 数字面等价"硬约束（三视角 Review P0-1）。
   */
  t: TFunction
}

export interface WidgetContextActions {
  canSavePng: boolean
  canCopyCode: boolean
  canOpenInNewWindow: boolean
  copyLabel: string
  handleSavePng: () => void | Promise<void>
  handleCopyCode: () => void | Promise<void>
  handleOpenInNewWindow: () => void
}

/**
 * Widget Wave 4.10（widget RFC §五 4.10）右键菜单 actions —— 从 RichWidget 容器
 * 抽出的 hook，负责根据当前 widget 状态（流式 / 持久化 / 烤图就位 / 失败）计算：
 *   - 三项 action 可用性（canSavePng / canCopyCode / canOpenInNewWindow）
 *   - copy 按钮文案（HTML vs SVG）
 *   - 三个 async 回调（handleSavePng / handleCopyCode / handleOpenInNewWindow）
 *
 * **状态判断**（与原 RichWidget 内逻辑完全一致）：
 *   - canSavePng：image_url 存在（最快）或 finalCode 存在（renderer 端转）。
 *     effectiveFormat === 'html' 且 finalCode 在时仍然 **disable** PNG（html2canvas
 *     不走本路径，避免"本地导出 HTML"失真）
 *   - canCopyCode：finalCode 存在（不复制 partial / streaming——避免给用户
 *     不完整的源码）
 *   - canOpenInNewWindow：有任何可渲染内容（finalCode / streamingCode /
 *     image_url 任一）
 */
export function useWidgetContextActions(input: UseWidgetContextActionsInput): WidgetContextActions {
  const { block, renderCode, srcdoc, finalCode, imageUrl, streamingCode, effectiveFormat, t } = input

  const canSavePng = !!imageUrl || (!!finalCode && effectiveFormat !== 'html')
  const canCopyCode = !!finalCode
  const canOpenInNewWindow = !!finalCode || !!streamingCode || !!imageUrl
  const copyLabel =
    effectiveFormat === 'html'
      ? t('richContent.widgetMenuCopyHtml', '复制 HTML 源码')
      : t('richContent.widgetMenuCopySvg', '复制 SVG 源码')

  const handleSavePng = useCallback(async () => {
    // ：与 Lightbox 统一——远程 URL 走主进程 downloadResource，禁止裸 fetch
    // + `<a download>`（打包态 tabtin-file://app 下 CSP/CORS 会失败或伪成功）。
    const base = (block.summary || block.title || 'widget')
      .replace(/[\s\\/:*?"<>|]+/g, '-')
      .slice(0, 40)

    if (imageUrl) {
      await downloadPreviewResource({
        url: imageUrl,
        fileName: `${base}.png`,
        t: t as TFunction<'chat'>,
      })
      return
    }

    if (!finalCode) {
      toast.error(t('richContent.widgetMenuNoCode', '当前没有可保存的内容'))
      return
    }

    const resource: PreviewResource = {
      id: `widget-ctx-save:${block.widget_id ?? block.tool_call_id ?? 'anon'}`,
      kind: 'widget',
      url: '',
      name: base,
      widgetId: typeof block.widget_id === 'string' ? block.widget_id : undefined,
      format: effectiveFormat,
      code: finalCode,
    }
    await downloadWidgetPreview({
      resource,
      t: t as TFunction<'chat'>,
    })
  }, [imageUrl, finalCode, block.summary, block.title, block.widget_id, block.tool_call_id, effectiveFormat, t])

  const handleCopyCode = useCallback(async () => {
    if (!finalCode) {
      toast.error(t('richContent.widgetMenuNoCode', '当前没有可复制的源码'))
      return
    }
    try {
      // navigator.clipboard 是 promise——失败时（document 没 focus / 权限缺失）
      // 抛 NotAllowedError，捕获后给 toast 错误。
      await navigator.clipboard.writeText(finalCode)
      toast.success(
        effectiveFormat === 'html'
          ? t('richContent.widgetMenuCopyHtmlDone', '已复制 HTML 源码')
          : t('richContent.widgetMenuCopySvgDone', '已复制 SVG 源码'),
      )
    } catch (err) {
      // 区分两种常见失败：NotAllowedError（document 没 focus / 权限不足）
      // vs 其他（剪贴板 API 不可用，老 webview）。NotAllowedError 给用户
      // 可操作建议（点击窗口先获得焦点）。
      const isNotAllowed = err instanceof Error && /NotAllowed|denied/i.test(err.message)
      if (isNotAllowed) {
        toast.error(t('richContent.widgetMenuCopySvgPermDenied', '复制失败（请先点击对话窗口获得焦点）'))
      } else {
        toast.error(t('richContent.widgetMenuCopySvgFailed', '复制失败'))
      }
    }
  }, [finalCode, effectiveFormat, t])

  const handleOpenInNewWindow = useCallback(() => {
    // 优先 srcdoc（renderCode 已就位）：用 srcdoc 能让用户看到 design tokens
    // 完整渲染的 widget；没 renderCode 就用 image_url
    if (renderCode) {
      try {
        // about:blank 先开窗 → document.write 写入 srcdoc——绕过 Electron 对
        // data: URL 默认拒打开的限制
        const w = window.open('about:blank', '_blank', 'noopener,noreferrer')
        if (!w) {
          toast.error(t('richContent.widgetMenuOpenFailed', '打开新窗口失败'))
          return
        }
        w.document.open()
        w.document.write(srcdoc)
        w.document.close()
      } catch {
        toast.error(t('richContent.widgetMenuOpenFailed', '打开新窗口失败'))
      }
      return
    }
    if (imageUrl) {
      try {
        window.open(imageUrl, '_blank', 'noopener,noreferrer')
      } catch {
        toast.error(t('richContent.widgetMenuOpenFailed', '打开新窗口失败'))
      }
      return
    }
    toast.error(t('richContent.widgetMenuNoCode', '当前没有可显示的内容'))
  }, [renderCode, srcdoc, imageUrl, t])

  return {
    canSavePng,
    canCopyCode,
    canOpenInNewWindow,
    copyLabel,
    handleSavePng,
    handleCopyCode,
    handleOpenInNewWindow,
  }
}
