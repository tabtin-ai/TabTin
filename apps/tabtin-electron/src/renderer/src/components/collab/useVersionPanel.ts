/**
 * useVersionPanel — Electron 薄封装
 *
 * 内部使用共享包 @tabtin/collab-core 的 useVersionPanel，
 * 自动注入 Electron 特有的 token、API URL、i18n labels。
 * 保持与原有消费方完全兼容的接口。
 */
import { joinApiPath } from '@tabtin/config'
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/useAuthStore'
import { API_BASE_URL } from '@/config/api'
import {
  useVersionPanel as useSharedVersionPanel,
  type VersionHistoryItem,
  type VersionPanelLabels,
  type ViewConversationOptions,
} from '@tabtin/collab-core'
import { toast } from '@tabtin/smartsheet-ui'
import { navigateToConversationFromVersionPanel } from './versionPanelConversationNavigation'

function useDefaultLabels(): VersionPanelLabels {
  const { t } = useTranslation('collab')
  return useMemo(() => ({
    title: t('version.title', '版本历史'),
    allVersions: t('version.all', '全部'),
    namedVersions: t('version.named', '命名版本'),
    save: t('version.save', '保存'),
    restore: t('version.restore', '还原到此版本'),
    confirmRestore: t('version.confirmRestore', '确认还原到此版本?'),
    cancel: t('version.cancel', '取消'),
    loadMore: t('version.loadMore', '加载更多'),
    loading: t('version.loading', '加载中...'),
    nameVersion: t('version.nameVersion', '命名此版本'),
    unname: t('version.unname', '取消命名'),
    pin: t('version.pin', '置顶'),
    unpin: t('version.unpin', '取消置顶'),
    pinnedVersions: t('version.pinnedVersions', '置顶'),
    preview: t('version.preview', '版本预览'),
    noVersions: t('version.noVersions', '暂无版本记录'),
    versionCount: t('version.versionCount', { count: '{count}', defaultValue: '共 {count} 个版本' } as Record<string, unknown>),
    expiresAt: t('version.expiresAt', '过期于'),
    current: t('version.current', '当前'),
    editorUser: t('version.editorUser', '用户'),
    editorSystem: t('version.editorSystem', '系统'),
    editorAI: t('version.editorAI', 'AI'),
    editorUserManual: t('version.editorUserManual', '由你手动编辑'),
    hasSubTasks: t('version.hasSubTasks', '含子任务'),
    hasSubTasksWithCount: t('version.hasSubTasksWithCount', '含 {count} 个子任务'),
    saveVersionFailed: t('version.saveVersionFailed', '保存版本失败'),
    restoreFailed: t('version.restoreFailed', '版本还原失败'),
    renameFailed: t('version.renameFailed', '重命名失败'),
    pinFailed: t('version.pinFailed', '置顶操作失败'),
    unnameFailed: t('version.unnameFailed', '取消命名失败'),
    justNow: t('version.justNow', '刚刚'),
    minutesAgo: (n: number) => t('version.minutesAgo', { n, defaultValue: '{{n}} 分钟前' }),
    hoursAgo: (n: number) => t('version.hoursAgo', { n, defaultValue: '{{n}} 小时前' }),
    daysAgo: (n: number) => t('version.daysAgo', { n, defaultValue: '{{n}} 天前' }),
    lessThanMinuteFromNow: t('version.lessThanMinuteFromNow', '1 分钟内'),
    minutesFromNow: (n: number) => t('version.minutesFromNow', { n, defaultValue: '{{n}} 分钟后' }),
    hoursFromNow: (n: number) => t('version.hoursFromNow', { n, defaultValue: '{{n}} 小时后' }),
    daysFromNow: (n: number) => t('version.daysFromNow', { n, defaultValue: '{{n}} 天后' }),
    today: t('version.today', '今天'),
    yesterday: t('version.yesterday', '昨天'),
    earlierThisWeek: t('version.earlierThisWeek', '本周更早'),
    viewConversation: t('version.viewConversation', '查看对话'),
    viewConversationSegment: t('version.viewConversationSegment', '查看对话片段'),
    openFullConversation: t('version.openFullConversation', '查看完整对话 →'),
    conversationSegmentTitle: t('version.conversationSegmentTitle', '对话片段'),
    conversationSegmentError: t('version.conversationSegmentError', '无法加载对话片段'),
    conversationSegmentEmpty: t('version.conversationSegmentEmpty', '暂无对话消息'),
    roleUser: t('version.roleUser', '你'),
    roleAssistant: t('version.roleAssistant', 'AI 助手'),
    conversationSessionArchived: t('version.conversationSessionArchived', '原始对话已归档'),
    subTaskLabel: t('version.subTaskLabel', '子任务'),
    subTaskExpand: t('version.subTaskExpand', '展开子任务对话 ↓'),
    subTaskCollapse: t('version.subTaskCollapse', '收起子任务对话 ↑'),
    subTaskViewMore: t('version.subTaskViewMore', '查看更多子任务 →'),
    subTaskLoading: t('version.subTaskLoading', '加载子任务对话中…'),
    subTaskEmpty: t('version.subTaskEmpty', '子任务暂无对话内容'),
  }), [t])
}

const defaultOnViewConversation = async (agentRunId: string, options?: ViewConversationOptions) => {
  try {
    await navigateToConversationFromVersionPanel(agentRunId, options)
  } catch {
    // best-effort
  }
}

interface UseVersionPanelOptions {
  resourceType: string
  resourceId: string | null | undefined
  title?: string
  resourceName?: string
  isReadonly?: boolean
  onRestoreComplete?: (info?: { syncMode?: string }) => void
  DiffPreview?: React.ComponentType<{ versionId: string; version?: VersionHistoryItem }>
  labels?: VersionPanelLabels
  footerNotice?: React.ReactNode
  onViewConversation?: (agentRunId: string, options?: ViewConversationOptions) => void
}

export function useVersionPanel(options: UseVersionPanelOptions) {
  const token = useAuthStore((s) => s.accessToken)
  const { i18n } = useTranslation()
  const { t: tCollab } = useTranslation('collab')
  const { t: tCommon } = useTranslation('common')
  const defaultLabels = useDefaultLabels()

  const defaultFooterNotice = useMemo(() =>
    React.createElement('span',
      { className: 'text-caption text-muted-foreground/60' },
      tCollab('version.restoreHint', '恢复单个资源的历史版本。如需回退所有 AI 操作，请在对话中使用「回退到此消息」'),
    ), [tCollab])

  return useSharedVersionPanel({
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    apiBase: joinApiPath(API_BASE_URL, `/collab/v1`),
    token: token || '',
    locale: i18n.language,
    resourceName: options.resourceName,
    labels: options.labels ?? defaultLabels,
    isReadonly: options.isReadonly,
    onRestoreComplete: options.onRestoreComplete,
    DiffPreview: options.DiffPreview,
    footerNotice: options.footerNotice ?? defaultFooterNotice,
    onViewConversation: options.onViewConversation ?? defaultOnViewConversation,
    chatApiBase: joinApiPath(API_BASE_URL, `/chat`),
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key.startsWith('version.')) return tCollab(key, opts) as string
      return tCommon(key, opts) as string
    },
    toast: {
      success: (msg: string) => toast({ title: msg }),
      error: (msg: string) => toast({ title: msg, variant: 'destructive' }),
    },
  })
}
