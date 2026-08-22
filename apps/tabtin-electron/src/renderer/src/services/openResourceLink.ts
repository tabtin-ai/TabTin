/**
 * openResourceLink — 非-chat 上下文（IM / Memo / Site / Skills 等 11 处）
 * 接入 ResourceRouter 的统一 helper（W8 L29 / L77）。
 *
 * 背景：在 chat MarkdownRenderer 之外，仓库里有 11 处历史 `<a target=_blank>`
 * 入口（IMMessageBubble / RichFile / MemoCard / MemoDetailView / TabSitePaneHost
 * 等）—— 这些链接会触发 Electron 主窗口的 setWindowOpenHandler 兜底 IPC，
 * 流回 ResourceRouter 派发，但 IPC payload 在 W8 之前没有 disposition 字段，
 * 导致 ⌘+click（D2 第 5 层短路）在这些入口失效。
 *
 * W8 同时做两件事彻底闭环：
 *   1. main 端 setWindowOpenHandler 透传 disposition（见 main-window.ts /
 *      crawlspace/window-open-handler.ts）—— renderer 端 fallback handler
 *      按 disposition === 'foreground-tab' 还原 modifierExternal
 *   2. **本 helper**：让 11 处入口直接 onClick → ResourceRouter，不再依赖
 *      window.open() + main 兜底；renderer 端可以直接读 e.metaKey / e.ctrlKey
 *      —— 比依赖 disposition 推断更可靠 + 链路更短 + telemetry trigger_source
 *      不会被打成 window_open_fallback 而是更精确的 `chat_external_link`
 *
 * 设计原则：
 *   - 11 个调用点共享同一份 helper —— D4 / D1 同款 SSOT 收敛
 *   - 不复制 chat MarkdownRenderer 的 onClick 逻辑（D4 红线）—— helper 是
 *     提炼出的"非-chat 入口共用 onClick"，chat MarkdownRenderer 自己用
 *     更复杂的 a 组件，**不**应改去 import 本 helper（chat 是 Agent 输出
 *     主路径，需要更精细的 hover / focus / a11y / 右键菜单 wiring）
 *
 * 关于 trigger_source：
 *   - W7 已注册的 trigger_source 含 'window_open_fallback'——理论上这 11 处
 *     在 W8 之前正是走那条路径
 *   - **本 helper 用 `window_open_fallback`**——产品语义不变（"非 chat 主
 *     路径的外部链接派发"），且 PM 看 PRD §6 标准 1 时 trigger 维度统计
 *     不会因 W8 改造而出现历史断层
 */

import type { MouseEvent } from 'react'
import { parseResourcePointer, type OpenOutcome, type ResourcePointer } from '@tabtin/resource-router'
import { toast } from '@tabtin/smartsheet-ui'
import { resourceRouter } from '@/services/resourceRouter'
import { openProjectTaskDocumentPreview } from '@/services/openProjectTaskDocumentPreview'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceViewPrefsStore } from '@/stores/useSpaceViewPrefsStore'
import { showResourceLinkContextMenu } from '@/components/chat/context/ResourceLinkContextMenu'
import { tryOpenPreviewableDirectUrl } from '@/components/chat/preview/assetPreviewResolver'
import { resolveBrowserOpenTabScopeKey } from '@/components/chat/subagent/openSubagentTab'
import { createLogger } from '@/utils/logger'
import type { OpenIntentHints } from '@shared/open-intent'
import { normalizeSchemelessWebHref } from '@shared/normalize-web-href'

const PREVIEW_MODAL_OPENED: OpenOutcome = {
  outcome: 'in_space_opened',
  carrierAppId: 'chat-preview',
  resolveSource: 'manifest_default',
  durationMs: 0,
}

const log = createLogger('openResourceLink')

/**
 * 对话模式下展开指定 workspace scope 的右侧画布。
 * CollapsedCanvasRail 点标签、聊天侧打开资源/文件夹等入口共用。
 */
export function expandCanvasForScope(tabScopeKey: string | null | undefined): void {
  if (!tabScopeKey) return
  useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(tabScopeKey, false)
}

/**
 * 对话模式下从聊天侧打开 Space 内资源后，自动展开右侧画布。
 * 对齐 CollapsedCanvasRail 点「打开的标签」会先 expandCanvas 再激活的行为。
 */
export function expandCanvasAfterInSpaceOpen(
  tabScopeKey: string | null | undefined,
  outcome: OpenOutcome | null | undefined,
): void {
  if (!tabScopeKey || outcome?.outcome !== 'in_space_opened') return
  expandCanvasForScope(tabScopeKey)
}

export function resolveSpaceIdForResourceLink(
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): string {
  if (tabScopeKey?.startsWith('conversation:')) {
    const suffix = tabScopeKey.slice('conversation:'.length)
    if (suffix.startsWith('draft:')) {
      const draftSpaceId = useChatStore.getState().draftExecutionSpaceIdByWorkspaceKey[tabScopeKey]
        ?? suffix.slice('draft:'.length)
      if (draftSpaceId) return draftSpaceId
    } else if (suffix) {
      const session = useChatStore.getState().getSessionById(suffix)
      const scopeId = resolveSessionScopeId(session)
      if (scopeId) return scopeId
    }
  }
  return executionSpaceId?.trim() || useSpaceStore.getState().selectedSpace?.id || ''
}

/**
 * 点击 onClick handler —— 直接 attach 到 `<a onClick={...}>`。
 *
 * 行为契约（与 chat MarkdownRenderer `a` 组件等价，除了 trigger_source）：
 *   - 阻止默认浏览器跳转（preventDefault）
 *   - 空 href 直接 return
 *   - 无 Space 上下文 → 走 modifierExternal 让用户至少看到外部应用反馈
 *   - ⌘ / Ctrl 修饰键 → 走 D2 第 5 层「系统应用」逃生通道
 *   - 其他 → 走 D2 五层优先级
 */
export function handleResourceLinkClick(
  e: MouseEvent<HTMLAnchorElement> | MouseEvent<HTMLElement>,
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): void {
  e.preventDefault()
  if (!href) return
  const normalizedHref = normalizeSchemelessWebHref(href)
  const isExternalShortcut = e.metaKey || e.ctrlKey
  // ⌘/Ctrl 仍走系统应用逃生；普通点击对可预览直链进 Lightbox，禁止 tabweb。
  if (!isExternalShortcut && tryOpenPreviewableDirectUrl(normalizedHref)) {
    return
  }
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, executionSpaceId)
  let pointer: ResourcePointer
  try {
    pointer = parseResourcePointer(normalizedHref)
  } catch {
    log.warn('handleResourceLinkClick parse failed', { hrefLen: href.length })
    return
  }
  if (pointer.scheme === 'unknown') {
    log.warn('handleResourceLinkClick unknown scheme', {
      hrefLen: href.length,
      normalized: normalizedHref !== href,
    })
  }
  if (!spaceId) {
    void resourceRouter.open(spaceId, pointer, {
      modifierExternal: true,
      triggerSource: 'window_open_fallback',
    }).then((outcome) => {
      if (outcome.outcome === 'error') {
        log.warn('handleResourceLinkClick failed without space', {
          href: normalizedHref,
          errorMessage: outcome.errorMessage,
        })
      }
    })
    return
  }
  void resourceRouter.open(spaceId, pointer, {
    triggerSource: 'window_open_fallback',
    ...(tabScopeKey ? { tabScopeKey } : {}),
    ...(isExternalShortcut ? { modifierExternal: true } : {}),
  }).then(outcome => {
    if (outcome.outcome === 'error') {
      log.warn('handleResourceLinkClick failed', {
        href: normalizedHref,
        spaceId,
        errorMessage: outcome.errorMessage,
      })
    }
    expandCanvasAfterInSpaceOpen(tabScopeKey, outcome)
  })
}

export interface OpenResourceUrlInSpaceOptions {
  /**
   * 为 true 时失败不弹 toast，由调用方统一反馈。
   * 「本轮产物」等入口需要自定义文案 / 避免与自身 toast 叠成双层弹层。
   */
  suppressErrorToast?: boolean
  openIntentHints?: OpenIntentHints
  /** 当前聊天宿主已解析出的执行 Space；共享 IM 会话不能回退到全局选中态。 */
  executionSpaceId?: string | null
}

/**
 * 纯 URL 入口 —— 不依赖 DOM MouseEvent 的「在当前 Space 内打开 http(s) 链接」。
 *
 * 用于 canvas 渲染或跨包场景（拿不到原始鼠标事件），如 TabData 网格 URL 单元格、
 * TabDoc 文档正文链接（经宿主动作回流）。与 `handleResourceLinkClick` 同源走
 * ResourceRouter（D2 五层优先级 + 失败兜底 `openExternal`），仅默认不走 ⌘ 逃生通道——
 * 这些入口的普通点击一律「在当前 Space 内置浏览器打开」。
 *
 * 返回 router 的 OpenOutcome（router 从不抛异常，失败折进 outcome='error'），
 * 让调用方能对失败做用户可见反馈（如「本轮产物」预览失败 toast）；href 为空或
 * 解析失败返回 null。fire-and-forget 调用方可继续忽略返回值。
 */
export function openResourceUrlInSpace(
  href: string,
  tabScopeKey?: string | null,
  options?: OpenResourceUrlInSpaceOptions,
): Promise<OpenOutcome | null> {
  if (!href) return Promise.resolve(null)
  const normalizedHref = normalizeSchemelessWebHref(href)
  // TabData / TabDoc / TurnArtifacts 等纯 URL 入口：可预览直链进 Lightbox，
  // 不展开画布、不进 BrowserView。
  if (tryOpenPreviewableDirectUrl(normalizedHref, {
    filename: options?.openIntentHints?.filename,
    mimeType: options?.openIntentHints?.mimeType,
    fileId: options?.openIntentHints?.assetId,
  })) {
    return Promise.resolve(PREVIEW_MODAL_OPENED)
  }
  const suppressErrorToast = options?.suppressErrorToast === true
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, options?.executionSpaceId)
  // 未传 / 传裸 spaceId 时升到前台 desktop:/conversation: 桶，避免 tabweb 落到
  // 用户看不见的 legacy UUID 桶（ setActiveKey: key not in tabOrder）。
  const resolvedTabScopeKey = spaceId
    ? resolveBrowserOpenTabScopeKey(spaceId, tabScopeKey)
    : (tabScopeKey || null)
  let pointer: ResourcePointer
  try {
    pointer = parseResourcePointer(normalizedHref)
  } catch {
    log.warn('openResourceUrlInSpace parse failed', { hrefLen: href.length })
    if (!suppressErrorToast) {
      toast({
        title: '无法打开链接',
        description: '链接格式无效',
        variant: 'destructive',
      })
    }
    return Promise.resolve(null)
  }
  // ：Project Task 执行会话里打开候选 TabDoc 时，禁止走 openTeamSpaceTabdoc
  //（会选隐藏伴生工作空间并踢出 Project）。留在 Project 顶层预览弹窗。
  const pointerType = pointer.type?.toLowerCase()
  if (
    pointer.type
    && (
      pointerType === 'document'
      || pointerType === 'doc'
      || pointerType === 'tabdoc'
    )
  ) {
    if (openProjectTaskDocumentPreview({
      resourceType: pointer.type,
      resourceId: pointer.id,
      tabScopeKey: tabScopeKey ?? null,
    })) {
      return Promise.resolve({
        outcome: 'in_space_opened',
        carrierAppId: 'tabdoc',
        resolveSource: 'manifest_default',
      })
    }
  }

  if (options?.openIntentHints) {
    pointer = {
      ...pointer,
      meta: {
        ...(pointer.meta ?? {}),
        openIntentHints: options.openIntentHints,
      },
    }
  }
  return resourceRouter.open(spaceId, pointer, {
    triggerSource: 'window_open_fallback',
    // 没有关联 Space 的 IM 会话仍可能交付 TabTin 内部资源。此时必须让
    // ResourceRouter 按内部载体分发，不能把 tabtin:// 交给 shell.openExternal
    // （后者只允许 http/https/mailto）。外链则继续沿用原有外开兜底，协议
    // 白名单仍由 main IPC 统一执行。
    ...(spaceId || pointer.scheme === 'tabtin'
      ? { tabScopeKey: resolvedTabScopeKey }
      : { modifierExternal: true }),
  }).then((outcome) => {
    if (outcome.outcome === 'error') {
      log.warn('openResourceUrlInSpace failed', {
        href: normalizedHref,
        spaceId: spaceId || '(empty)',
        tabScopeKey: resolvedTabScopeKey || '(empty)',
        errorMessage: outcome.errorMessage,
      })
      if (!suppressErrorToast) {
        toast({
          title: '无法打开链接',
          description: outcome.errorMessage ?? '请稍后重试',
          variant: 'destructive',
        })
      }
    }
    expandCanvasAfterInSpaceOpen(resolvedTabScopeKey, outcome)
    return outcome
  })
}

/**
 * 右键 onContextMenu handler —— 直接 attach 到 `<a onContextMenu={...}>`。
 *
 * 与 chat MarkdownRenderer 右键完全同款（共享 ResourceLinkContextMenu Host
 * 单例）—— 用户场景：用户在 IM 气泡 / Memo 卡片里右键链接，能看到"用 X
 * 打开" / "始终用 X 打开" / "在外部应用打开" / "复制链接"等选项，与 chat
 * 内体验一致（D1 一视同仁原则）。
 */
export function handleResourceLinkContextMenu(
  e: MouseEvent<HTMLAnchorElement> | MouseEvent<HTMLElement>,
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): void {
  e.preventDefault()
  if (!href) return
  const normalizedHref = normalizeSchemelessWebHref(href)
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, executionSpaceId)
  let pointer: ResourcePointer
  try {
    pointer = parseResourcePointer(normalizedHref)
  } catch {
    log.warn('handleResourceLinkContextMenu parse failed', { hrefLen: href.length })
    return
  }
  showResourceLinkContextMenu({
    x: e.clientX,
    y: e.clientY,
    href: normalizedHref,
    spaceId,
    ...(tabScopeKey ? { tabScopeKey } : {}),
    pointer,
  })
}
