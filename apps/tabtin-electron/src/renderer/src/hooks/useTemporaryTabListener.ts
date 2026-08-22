/**
 * 临时标签事件监听器 (Legacy)
 *
 * 监听主进程创建/关闭临时标签的 IPC 请求。
 * Workspace 内部 view 已迁移到 Context 系统（SpaceContextTabs），
 * 此 hook 仅处理非 workspace 的临时标签（如外部链接预览）。
 *
 * 受 VITE_ALLOW_TEMP_TAB_UI 环境变量门控。
 *
 * @deprecated 计划在 v3 迁移中将所有标签管理统一到 Context 系统，届时移除此 hook。
 */

import { useEffect, useRef } from 'react'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('TempTab')

/** @deprecated Legacy hook — see module JSDoc */
export function useTemporaryTabListener() {
  // ✅ 使用 useRef 来防止监听器重复注册
  const handlersRegistered = useRef(false)

  useEffect(() => {
    const allowTempTabUi = import.meta.env.VITE_ALLOW_TEMP_TAB_UI === 'true'
    if (!allowTempTabUi) {
      log.debug(i18n.t('crawl:temporaryTab.logs.uiEntryDisabled'))
      return
    }

    // ✅ 如果已经注册过，直接返回
    if (handlersRegistered.current) {
      log.debug(i18n.t('crawl:temporaryTab.logs.listenerAlreadyRegistered'))
      return
    }

    // 监听创建临时标签请求
    const handleCreateTemporaryTab = (_event: any, data: {
      id: string
      url: string
      name: string
      temporary: boolean
      skipAutoSelect?: boolean  // 🆕 是否跳过自动选中
      metadata?: Record<string, any>
      profile?: string
      kind?: 'workspace-view' | 'normal-view'
      crawlspaceId?: string
      partition?: string
      isPreview?: boolean
    }) => {
      log.debug(i18n.t('crawl:temporaryTab.logs.createRequestReceived'), data)

      const store = useCrawlTabStore.getState()
      const crawlspaceIdFromMetadata =
        typeof data.crawlspaceId === 'string'
          ? data.crawlspaceId
          : typeof data.metadata?.crawlspaceId === 'string'
            ? data.metadata.crawlspaceId
            : null
      const isWorkspaceInternalView =
        Boolean(crawlspaceIdFromMetadata) ||
        data.kind === 'workspace-view' ||
        data.metadata?.kind === 'workspace-view'

      // ✅ 新模型：workspace 内部 view 不走 temporary-tab 入口，交由 Context 统一同步
      if (isWorkspaceInternalView && crawlspaceIdFromMetadata) {
        log.debug(i18n.t('crawl:temporaryTab.logs.workspaceInternalViewHandled'), {
          crawlspaceId: crawlspaceIdFromMetadata,
          viewId: data.id
        })
        return
      }

      if (!data.temporary) {
        log.debug(i18n.t('crawl:temporaryTab.logs.nonTemporaryIgnored'), {
          id: data.id,
          profile: data.profile,
          kind: data.kind
        })
        return
      }

      // 🆕 防重复创建：检查标签是否已存在
      const tabExists = store.tabs.some(tab => tab.id === data.id)
      if (tabExists) {
        log.warn(i18n.t('crawl:temporaryTab.logs.tabExistsSkipped'), data.id)
        return
      }

      // 创建临时标签，使用主进程传来的 ID
      const resolvedMetadata = {
        ...(data.metadata || {}),
        profile: data.profile ?? data.metadata?.profile,
        kind: data.kind ?? data.metadata?.kind,
        crawlspaceId: data.crawlspaceId ?? data.metadata?.crawlspaceId,
        partition: data.partition ?? data.metadata?.partition,
        isPreview: data.isPreview ?? data.metadata?.isPreview
      }

      const tab = useCrawlTabStore.getState().createTab(data.url, data.name, {
        id: data.id,  // 使用主进程传来的 ID，确保关闭时能匹配
        temporary: data.temporary,  // 🔑 使用主进程传来的值，不硬编码
        autoClose: true,
        skipAutoSelect: data.skipAutoSelect,  // 🆕 直接传递 skipAutoSelect 标志
        kind: data.temporary ? 'temporary' : 'normal',
        legacy: true,
        metadata: resolvedMetadata  // 🆕 传递 metadata
      })

      log.debug(i18n.t('crawl:temporaryTab.logs.tabCreated'), {
        id: tab.id,
        skipAutoSelect: data.skipAutoSelect
      })

      if (data.skipAutoSelect) {
        log.debug(i18n.t('crawl:temporaryTab.logs.skipAutoSelect'))
      }
    }

    // 监听关闭临时标签请求
    const handleCloseTemporaryTab = (_event: any, data: {
      tabId: string
      profile?: string
      kind?: 'workspace-view' | 'normal-view'
      crawlspaceId?: string
    }) => {
      log.debug(i18n.t('crawl:temporaryTab.logs.closeRequestReceived'), data.tabId)

      const store = useCrawlTabStore.getState()
      if (data.crawlspaceId || data.kind === 'workspace-view') {
        log.debug(i18n.t('crawl:temporaryTab.logs.workspaceViewSkipClose'), {
          tabId: data.tabId,
          crawlspaceId: data.crawlspaceId,
          kind: data.kind
        })
        return
      }

      // 1) 如果是普通 tab，直接删
      const existsAsTab = store.tabs.some(t => t.id === data.tabId)
      if (existsAsTab) {
        // 如果是 crawlspace 列表中的标签，统一走 closeCrawlspace 以便收尾
        const tab = store.tabs.find(t => t.id === data.tabId)
        if (tab && tab.kind === 'workspace') {
          log.debug(i18n.t('crawl:temporaryTab.logs.workspaceTabSkipClose'), {
            tabId: data.tabId
          })
          return
        }
        if (tab && !tab.temporary) {
          log.debug(i18n.t('crawl:temporaryTab.logs.nonTemporarySkipClose'), {
            tabId: data.tabId,
            profile: data.profile
          })
          return
        }
        store.deleteTab(data.tabId)
        return
      }

      // 2) 未知：忽略（可能是主进程已销毁但 renderer 不持有 UI 状态）
      log.debug(i18n.t('crawl:temporaryTab.logs.closeRequestNoTab'), data.tabId)
    }

    // 注册监听器
    const ipc = window.electron?.ipcRenderer
    if (ipc) {
      const unsubCreate = ipc.on('crawl-view:temporary-tab-created', handleCreateTemporaryTab)
      const unsubClose = ipc.on('crawl-view:close-temporary-tab', handleCloseTemporaryTab)
      handlersRegistered.current = true
      log.debug(i18n.t('crawl:temporaryTab.logs.listenerRegistered'))

      return () => {
        unsubCreate()
        unsubClose()
        handlersRegistered.current = false
        log.debug(i18n.t('crawl:temporaryTab.logs.listenerCleaned'))
      }
    }
  }, [])  // ✅ 空依赖数组，确保只运行一次
}
