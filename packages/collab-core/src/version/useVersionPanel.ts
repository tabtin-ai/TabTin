/**
 * useVersionPanel — 统一版本面板 Hook（平台无关）
 *
 * 从 Electron 提升到共享包，通过参数注入平台差异（token、apiBase、labels）。
 * Electron 和 Web 均可直接使用。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { joinApiPath } from "@tabtin/config"
import type { VersionAdapter, VersionHistoryItem, VersionPanelLabels, ViewConversationOptions } from "./types"
import { VersionPanel } from "./VersionPanel"
import { VersionHistoryOverlayShell } from "./VersionHistoryOverlayShell"

export interface UseVersionPanelOptions {
  resourceType: string
  resourceId: string | null | undefined
  /** Collab API base URL（如 https://api.example.com/collab/v1） */
  apiBase: string
  /** JWT access token */
  token: string
  /** 当前语言 locale */
  locale?: string
  /** Dialog 标题中显示的资源名称 */
  resourceName?: string
  /** 自定义文案 */
  labels?: VersionPanelLabels
  /** 只读模式下禁用还原 */
  isReadonly?: boolean
  /**
   * 还原成功回调。info.syncMode 由后端返回：
   * - "resync"：服务端已通过 Yjs 增量广播还原内容，客户端无需 force-reconnect；
   * - "force_close"/未提供：走断线重连兜底，调用方应执行 forceReconnect。
   */
  onRestoreComplete?: (info?: { syncMode?: string }) => void
  /** 传入 DiffPreview 组件以启用版本内容预览 */
  DiffPreview?: React.ComponentType<{ versionId: string; version?: VersionHistoryItem }>
  /** 面板底部通知 */
  footerNotice?: React.ReactNode
  /** 翻译函数，用于默认文案 */
  t?: (key: string, opts?: Record<string, unknown>) => string
  /** toast 通知函数 */
  toast?: {
    success: (message: string) => void
    error: (message: string) => void
  }
  /** 点击 Agent 版本条目的"查看对话"链接（向后兼容：新增可选 options 参数） */
  onViewConversation?: (agentRunId: string, options?: ViewConversationOptions) => void
  /** Chat API base URL for conversation segment popover */
  chatApiBase?: string
}

const DEFAULT_LABELS: VersionPanelLabels = {
  title: "版本历史",
  allVersions: "全部",
  namedVersions: "命名版本",
  save: "保存",
  restore: "还原到此版本",
  confirmRestore: "确认还原到此版本?",
  cancel: "取消",
  loadMore: "加载更多",
  loading: "加载中...",
  nameVersion: "命名此版本",
  unname: "取消命名",
  pin: "置顶",
  unpin: "取消置顶",
  preview: "版本预览",
  noVersions: "暂无版本记录",
  versionCount: "共 {count} 个版本",
  expiresAt: "过期于",
  current: "当前",
  editorUser: "用户",
  editorSystem: "系统",
  editorAI: "AI",
  editorUserManual: "由你手动编辑",
  hasSubTasks: "含子任务",
  hasSubTasksWithCount: "含 {count} 个子任务",
  saveVersionFailed: "保存版本失败",
  restoreFailed: "版本还原失败",
  renameFailed: "重命名失败",
  pinFailed: "置顶操作失败",
  unnameFailed: "取消命名失败",
  justNow: "刚刚",
  minutesAgo: (n: number) => `${n} 分钟前`,
  hoursAgo: (n: number) => `${n} 小时前`,
  daysAgo: (n: number) => `${n} 天前`,
  lessThanMinuteFromNow: "1 分钟内",
  minutesFromNow: (n: number) => `${n} 分钟后`,
  hoursFromNow: (n: number) => `${n} 小时后`,
  daysFromNow: (n: number) => `${n} 天后`,
  today: "今天",
  yesterday: "昨天",
  earlierThisWeek: "本周更早",
  pinnedVersions: "置顶",
  viewConversation: "查看对话",
  viewConversationSegment: "查看对话片段",
  openFullConversation: "查看完整对话 →",
  conversationSegmentTitle: "对话片段",
  conversationSegmentError: "无法加载对话片段",
  conversationSegmentEmpty: "暂无对话消息",
  roleUser: "你",
  roleAssistant: "AI 助手",
  conversationSessionArchived: "原始对话已归档",
  subTaskLabel: "子任务",
  subTaskExpand: "展开子任务对话 ↓",
  subTaskCollapse: "收起子任务对话 ↑",
  subTaskViewMore: "查看更多子任务 →",
  subTaskLoading: "加载子任务对话中…",
  subTaskEmpty: "子任务暂无对话内容",
}

export interface UseVersionPanelReturn {
  show: boolean
  toggle: () => void
  restoreLoading: boolean
  renderPanel: () => React.ReactNode
}

export function useVersionPanel(options: UseVersionPanelOptions): UseVersionPanelReturn {
  const {
    resourceType,
    resourceId,
    apiBase,
    token,
    locale = "zh-CN",
    resourceName,
    labels: labelsProp,
    isReadonly,
    onRestoreComplete,
    DiffPreview,
    footerNotice,
    t: translate,
    toast: toastFn,
    onViewConversation,
    chatApiBase,
  } = options

  const [show, setShow] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<VersionHistoryItem | null>(null)
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null)
  const [pendingRestoreVersion, setPendingRestoreVersion] = useState<VersionHistoryItem | null>(null)
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
  const [restoreLoading, setRestoreLoading] = useState(false)

  // 优先级:① 显式传入的 labels(完全覆盖)
  //          ② 注入了 translate → 用 translate 合成 labels(支持英文等其他语言)
  //          ③ 都没有 → 落回 DEFAULT_LABELS(zh-CN 兜底,警示集成方应注入 translate 或 labels)
  const labels = useMemo<VersionPanelLabels>(() => {
    if (labelsProp) return labelsProp
    if (!translate) return DEFAULT_LABELS
    const tr = (key: string, fallback: string) =>
      translate(`version.${key}`, { defaultValue: fallback }) ?? fallback
    return {
      title: tr("title", DEFAULT_LABELS.title!),
      allVersions: tr("all", DEFAULT_LABELS.allVersions!),
      namedVersions: tr("named", DEFAULT_LABELS.namedVersions!),
      save: tr("save", DEFAULT_LABELS.save!),
      restore: tr("restoreToVersion", DEFAULT_LABELS.restore!),
      confirmRestore: tr("confirmRestoreToVersion", DEFAULT_LABELS.confirmRestore!),
      cancel: tr("cancel", DEFAULT_LABELS.cancel!),
      loadMore: tr("loadMore", DEFAULT_LABELS.loadMore!),
      loading: tr("loading", DEFAULT_LABELS.loading!),
      nameVersion: tr("nameVersion", DEFAULT_LABELS.nameVersion!),
      unname: tr("unname", DEFAULT_LABELS.unname!),
      pin: tr("pin", DEFAULT_LABELS.pin!),
      unpin: tr("unpin", DEFAULT_LABELS.unpin!),
      preview: tr("preview", DEFAULT_LABELS.preview!),
      noVersions: tr("noVersions", DEFAULT_LABELS.noVersions!),
      versionCount: tr("versionCount", DEFAULT_LABELS.versionCount!),
      expiresAt: tr("expiresAt", DEFAULT_LABELS.expiresAt!),
      current: tr("current", DEFAULT_LABELS.current!),
      editorUser: tr("editorUser", DEFAULT_LABELS.editorUser!),
      editorSystem: tr("editorSystem", DEFAULT_LABELS.editorSystem!),
      editorAI: tr("editorAI", DEFAULT_LABELS.editorAI!),
      editorUserManual: tr("editorUserManual", DEFAULT_LABELS.editorUserManual!),
      hasSubTasks: tr("hasSubTasks", DEFAULT_LABELS.hasSubTasks!),
      hasSubTasksWithCount: tr("hasSubTasksWithCount", DEFAULT_LABELS.hasSubTasksWithCount!),
      saveVersionFailed: tr("saveVersionFailed", DEFAULT_LABELS.saveVersionFailed!),
      restoreFailed: tr("restoreFailed", DEFAULT_LABELS.restoreFailed!),
      renameFailed: tr("renameFailed", DEFAULT_LABELS.renameFailed!),
      pinFailed: tr("pinFailed", DEFAULT_LABELS.pinFailed!),
      unnameFailed: tr("unnameFailed", DEFAULT_LABELS.unnameFailed!),
      justNow: tr("justNow", DEFAULT_LABELS.justNow!),
      minutesAgo: (n: number) => translate("version.minutesAgo", { n, defaultValue: `${n} minutes ago` }) ?? `${n} minutes ago`,
      hoursAgo: (n: number) => translate("version.hoursAgo", { n, defaultValue: `${n} hours ago` }) ?? `${n} hours ago`,
      daysAgo: (n: number) => translate("version.daysAgo", { n, defaultValue: `${n} days ago` }) ?? `${n} days ago`,
      lessThanMinuteFromNow: tr("lessThanMinuteFromNow", DEFAULT_LABELS.lessThanMinuteFromNow!),
      minutesFromNow: (n: number) => translate("version.minutesFromNow", { n, defaultValue: `in ${n} minutes` }) ?? `in ${n} minutes`,
      hoursFromNow: (n: number) => translate("version.hoursFromNow", { n, defaultValue: `in ${n} hours` }) ?? `in ${n} hours`,
      daysFromNow: (n: number) => translate("version.daysFromNow", { n, defaultValue: `in ${n} days` }) ?? `in ${n} days`,
      today: tr("today", DEFAULT_LABELS.today!),
      yesterday: tr("yesterday", DEFAULT_LABELS.yesterday!),
      earlierThisWeek: tr("earlierThisWeek", DEFAULT_LABELS.earlierThisWeek!),
      pinnedVersions: tr("pinnedVersions", DEFAULT_LABELS.pinnedVersions!),
      viewConversation: tr("viewConversation", DEFAULT_LABELS.viewConversation!),
      viewConversationSegment: tr("viewConversationSegment", DEFAULT_LABELS.viewConversationSegment!),
      openFullConversation: tr("openFullConversation", DEFAULT_LABELS.openFullConversation!),
      conversationSegmentTitle: tr("conversationSegmentTitle", DEFAULT_LABELS.conversationSegmentTitle!),
      conversationSegmentError: tr("conversationSegmentError", DEFAULT_LABELS.conversationSegmentError!),
      conversationSegmentEmpty: tr("conversationSegmentEmpty", DEFAULT_LABELS.conversationSegmentEmpty!),
      roleUser: tr("roleUser", DEFAULT_LABELS.roleUser!),
      roleAssistant: tr("roleAssistant", DEFAULT_LABELS.roleAssistant!),
      conversationSessionArchived: tr("conversationSessionArchived", DEFAULT_LABELS.conversationSessionArchived!),
      subTaskLabel: tr("subTaskLabel", DEFAULT_LABELS.subTaskLabel!),
      subTaskExpand: tr("subTaskExpand", DEFAULT_LABELS.subTaskExpand!),
      subTaskCollapse: tr("subTaskCollapse", DEFAULT_LABELS.subTaskCollapse!),
      subTaskViewMore: tr("subTaskViewMore", DEFAULT_LABELS.subTaskViewMore!),
      subTaskLoading: tr("subTaskLoading", DEFAULT_LABELS.subTaskLoading!),
      subTaskEmpty: tr("subTaskEmpty", DEFAULT_LABELS.subTaskEmpty!),
    }
  }, [labelsProp, translate])

  const adapter = useMemo<VersionAdapter | null>(() => {
    if (!resourceId) return null
    return { resourceType, resourceId, ...(DiffPreview ? { DiffPreview } : {}) }
  }, [resourceType, resourceId, DiffPreview])

  const toggle = useCallback(() => setShow((prev) => !prev), [])

  useEffect(() => {
    if (show) {
      setSelectedVersionId(null)
      setSelectedVersion(null)
      setPendingRestoreId(null)
      setPendingRestoreVersion(null)
      setShowRestoreConfirm(false)
      setRestoreLoading(false)
    }
  }, [show])

  useEffect(() => {
    if (isReadonly) setShowRestoreConfirm(false)
  }, [isReadonly])

  const handleRestore = useCallback(async (versionId: string | null) => {
    if (!versionId || !adapter || isReadonly) return
    setRestoreLoading(true)
    try {
      const res = await fetch(joinApiPath(apiBase, `/${adapter.resourceType}/${adapter.resourceId}/restore`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ version_id: versionId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.status === "error") {
        toastFn?.error(json.message || labels.restoreFailed)
        return
      }
      toastFn?.success(translate?.("version.restoreSuccess", { defaultValue: "已还原到此版本" }) ?? "已还原到此版本")
      setShowRestoreConfirm(false)
      setPendingRestoreId(null)
      setPendingRestoreVersion(null)
      setSelectedVersionId(null)
      setSelectedVersion(null)
      setShow(false)
      const syncMode: string | undefined = json.data?.sync_mode
      onRestoreComplete?.({ syncMode })
    } catch (err) {
      toastFn?.error(err instanceof Error ? err.message : (labels.restoreFailed ?? "版本还原失败"))
    } finally {
      setRestoreLoading(false)
    }
  }, [adapter, apiBase, token, labels.restoreFailed, translate, toastFn, onRestoreComplete, isReadonly])

  const renderPanel = useCallback(() => {
    if (!show || !adapter) return null

    const modalTitle = resourceName
      ? (translate?.("version.modalTitle", { name: resourceName, defaultValue: `版本历史 — ${resourceName}` }) ?? `版本历史 — ${resourceName}`)
      : labels.title

    const selectToPreview = translate?.("version.selectToPreview", { defaultValue: "选择一个版本以预览" }) ?? "选择一个版本以预览"
    const restoringLabel = translate?.("version.restoring", { defaultValue: "还原中..." }) ?? "还原中..."
    const restoreToVersionLabel = translate?.("version.restoreToVersion", { defaultValue: "还原到此版本" }) ?? "还原到此版本"
    const confirmTitle = translate?.("version.restoreConfirmTitle", { defaultValue: "确认还原到此版本?" }) ?? "确认还原到此版本?"
    const confirmDesc = translate?.("version.restoreConfirmDescription", { defaultValue: "将还原到此版本，当前内容会被覆盖。此操作可通过版本历史回退。" }) ?? "将还原到此版本，当前内容会被覆盖。"
    const cancelLabel = translate?.("cancel", { defaultValue: "取消" }) ?? "取消"

    const restoreConfirmSpinner = React.createElement("span", {
      className: "mr-1.5 inline-block h-3.5 w-3.5 animate-spin motion-reduce:animate-none rounded-full border-2 border-destructive-foreground/30 border-t-destructive-foreground align-[-2px]",
      "aria-hidden": true,
    })

    // 查看对话只切右侧聊天上下文，版本历史 Modal 保持打开，方便用户继续对照版本预览。
    const handleViewConversation = onViewConversation
      ? (agentRunId: string, opts?: ViewConversationOptions) => {
          onViewConversation(agentRunId, opts)
        }
      : undefined

    return React.createElement(React.Fragment, null,
      React.createElement(VersionHistoryOverlayShell, {
        title: modalTitle,
        onClose: () => setShow(false),
        left: selectedVersionId && adapter.DiffPreview
          ? React.createElement(adapter.DiffPreview, {
              versionId: selectedVersionId,
              version: selectedVersion ?? undefined,
            })
          : React.createElement("div", {
              className: "flex flex-1 items-center justify-center text-muted-foreground/60",
            }, selectToPreview),
        right: React.createElement(VersionPanel, {
          adapter,
          apiBase,
          token,
          labels,
          locale,
          mode: "embedded" as const,
          onSelectPreview: (versionId: string | null, version?: VersionHistoryItem) => {
            setSelectedVersionId(versionId)
            setSelectedVersion(version ?? null)
            setPendingRestoreId(versionId)
            setPendingRestoreVersion(version ?? null)
            setShowRestoreConfirm(false)
          },
          onSelectRestore: (versionId: string, version?: VersionHistoryItem) => {
            setPendingRestoreId(versionId)
            setPendingRestoreVersion(version ?? null)
            setShowRestoreConfirm(true)
          },
          footerNotice,
          onViewConversation: handleViewConversation,
          chatApiBase,
          canManageVersions: !isReadonly,
        }),
        footer: isReadonly
          ? undefined
          : React.createElement("button", {
              type: "button",
              className: "rounded bg-primary px-3 py-1.5 text-body text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
              disabled: restoreLoading || !pendingRestoreId,
              onClick: () => setShowRestoreConfirm(true),
            }, restoreLoading ? restoringLabel : restoreToVersionLabel),
      }),
      // Portal 到 document.body：画布列 motion layout 会创建 transform containing block，
      // 留在 Tab 子树内的 fixed 蒙层只能盖住画布列，盖不住 Shell 右侧聊天列。
      showRestoreConfirm && typeof document !== "undefined"
        ? createPortal(
            React.createElement("div", {
              className: "fixed inset-0 z-above-global flex items-center justify-center bg-black/60",
              role: "dialog",
              "aria-modal": true,
              onClick: () => {
                if (!restoreLoading) setShowRestoreConfirm(false)
              },
            },
              React.createElement("div", {
                className: "w-[400px] rounded-lg bg-background p-6 shadow-lg",
                onClick: (e: React.MouseEvent) => e.stopPropagation(),
              },
                React.createElement("h3", { className: "text-subtitle font-semibold" }, confirmTitle),
                React.createElement("p", { className: "mt-2 text-body text-muted-foreground" }, confirmDesc),
                React.createElement("div", { className: "mt-4 flex justify-end gap-2" },
                  React.createElement("button", {
                    type: "button",
                    className: "rounded border px-3 py-1.5 text-body hover:bg-muted disabled:opacity-50 disabled:pointer-events-none",
                    disabled: restoreLoading,
                    onClick: () => setShowRestoreConfirm(false),
                  }, cancelLabel),
                  React.createElement("button", {
                    type: "button",
                    className: "inline-flex items-center rounded bg-destructive px-3 py-1.5 text-body text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 disabled:pointer-events-none",
                    disabled: restoreLoading,
                    onClick: () => { void handleRestore(pendingRestoreId) },
                  }, restoreLoading
                    ? React.createElement(React.Fragment, null, restoreConfirmSpinner, restoringLabel)
                    : restoreToVersionLabel),
                ),
              ),
            ),
            document.body,
          )
        : null,
    )
  }, [show, adapter, selectedVersionId, selectedVersion, pendingRestoreId, pendingRestoreVersion, showRestoreConfirm, restoreLoading, isReadonly, resourceName, apiBase, token, labels, locale, footerNotice, translate, handleRestore, onViewConversation, chatApiBase])

  return { show, toggle, restoreLoading, renderPanel }
}
