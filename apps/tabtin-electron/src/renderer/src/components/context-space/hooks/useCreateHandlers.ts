/**
 * useCreateHandlers — 聚合所有「创建资源」handler
 *
 * 从 SpaceContextContainer 中提取，降低容器组件的复杂度。
 * 返回 Record<appId, handler> 供 ContextHome 的 Quick Actions 和各 HomeSection 使用。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from '@components/ui'
import { createLogger } from '@/utils/logger'
import type { AppHttpRequest } from '@tabtin/contracts/app'
import { createDirectAppClient } from '@tabtin/app-host-sdk/host'
import { requireTableApiPort, type CreateTableRequest, type Table } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { API_CONFIG } from '@/config/api'
import { apiService } from '@/services/api'
import {
  MIN_NEW_TABLE_VISIBLE_ROW_COUNT,
  prefillNewTableRows,
} from '@/components/table/utils/prefillNewTableRows'
import { useCreateSiteDialog } from '@/stores/useCreateSiteDialog'
import { createDocument } from '@tabtin/tabdoc-ui/api-client'
// Wave 1（PRD V3.3 §11.5）：syncAgentSkills 已删除（草稿不上云），本地扫描由
// 主进程 LocalSkillRegistry 完成。
import { openTinsPanel } from '../../tins/openTinsPanel'
import {
  recordResourceAccessByResourceId,
  useUnifiedResources,
} from '@/stores/useUnifiedResources'
import { guardApp, executeGuardedCreate } from './useGuardedCreate'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { buildSearchUrl, useBrowserPrefsStore, type SearchEngineId } from '@stores/useBrowserPrefsStore'
import { contextRegistry } from '../registry/instance'
import { extractBillingErrorCode, showBillingErrorToast } from '@/lib/billingErrorHandler'
import {
  getEffectiveScopeForResourceType,
  reloadResourceBucketsForScope,
} from '../resourceScope'
import { TINS_UI_ENABLED } from '@/utils/featureFlags'
import { markResourceMembershipPending } from '../restore/resourceMembershipPending'
import type { ContextItemMeta } from '@stores/contextTabs/types'
import type { CreateResourceHandler, CreateResourceOptions } from './createResourceTypes'

export type { CreateResourceHandler, CreateResourceOptions } from './createResourceTypes'

interface UseCreateHandlersParams {
  spaceId: string
  spaceOrganizationId?: string | null
  isAppEnabled: (appId?: string) => boolean
  tableSource: {
    selectedOrganizationId: string | null
    /** org-only 建表；space_id 可选不强制 */
    createTable: (data: CreateTableRequest) => Promise<Table | null>
  }
  terminalSource: {
    createSession: () => { tabKey: string }
  }
  navigation: {
    openTable: (tableId: string, table?: Table | null, meta?: ContextItemMeta) => void
    openDocument: (docId: string, title?: string, meta?: Record<string, unknown>) => void
    openSlide: (id: string) => void
    openSite: (siteId: string, title?: string) => void
    createWebTab: (url?: string) => void | Promise<unknown>
    openEmbeddedWebApp: (
      appId: string,
    ) => void | Promise<void | { crawlspaceId: string; viewId: string } | null>
  }
}

const log = createLogger('CreateHandlers')

const EMPTY_CREATING_APP_IDS: ReadonlySet<string> = new Set()

export interface CreateHandlerResults {
  createHandlers: Record<string, CreateResourceHandler>
  creatingAppIds: ReadonlySet<string>
}

function normalizeBrowserCreateUrl(input: string, engineId: SearchEngineId): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^localhost(:\d+)?/i.test(trimmed)) return `http://${trimmed}`
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/.test(trimmed)) return `http://${trimmed}`
  if (/^\[.*\](:\d+)?/.test(trimmed)) return `http://${trimmed}`
  if (/^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}/.test(trimmed)) return `https://${trimmed}`
  if (/^[a-zA-Z0-9][-a-zA-Z0-9]*:\d+/.test(trimmed)) return `http://${trimmed}`
  return buildSearchUrl(engineId, trimmed)
}

function getErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return error instanceof Error ? error.message : error ? String(error) : undefined
}

export function useCreateHandlers({
  spaceId,
  spaceOrganizationId,
  isAppEnabled,
  tableSource,
  terminalSource,
  navigation,
}: UseCreateHandlersParams): CreateHandlerResults {
  const { t } = useTranslation('context')
  const fallbackWsId = useOrganizationStore((s) => s.selectedOrganization?.id)
  const requestedScope = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).resourceScope)
  const browserHomepageUrl = useBrowserPrefsStore(s => s.homepageUrl)
  const browserSearchEngine = useBrowserPrefsStore(s => s.searchEngine)

  const refreshResources = useCallback((resourceType: string) => {
    const targetSpaceId = spaceId
    const effectiveScope = getEffectiveScopeForResourceType(requestedScope, resourceType)
    setTimeout(() => {
      if (useUnifiedResources.getState().currentSpaceId === targetSpaceId) {
        void reloadResourceBucketsForScope(
          useUnifiedResources.getState().load,
          targetSpaceId,
          effectiveScope,
        )
      }
    }, 300)
  }, [requestedScope, spaceId])

  const {
    openTable,
    openDocument,
    openSlide,
    openSite,
    createWebTab,
    openEmbeddedWebApp,
  } = navigation

  const { selectedOrganizationId, createTable } = tableSource
  const { createSession } = terminalSource

  // ── 防重入 refs + UI busy 态 ──
  const isCreatingTableRef = useRef(false)
  const isCreatingDocRef = useRef(false)
  const isCreatingSiteRef = useRef(false)
  const [creatingAppIds, setCreatingAppIds] = useState<ReadonlySet<string>>(EMPTY_CREATING_APP_IDS)

  const setAppBusy = useCallback((appId: string, busy: boolean) => {
    setCreatingAppIds((prev) => {
      const has = prev.has(appId)
      if (busy === has) return prev
      const next = new Set(prev)
      if (busy) next.add(appId)
      else next.delete(appId)
      return next.size === 0 ? EMPTY_CREATING_APP_IDS : next
    })
  }, [])

  // ── Create handlers ──

  const handleCreateTable = useCallback((options?: CreateResourceOptions) =>
    executeGuardedCreate({
      creatingRef: isCreatingTableRef,
      setBusy: (busy) => setAppBusy('tabdata', busy),
      appId: 'tabdata', appLabel: 'TabData',
      isAppEnabled, t,
      create: async () => {
        if (!selectedOrganizationId) {
          toast({ title: t('error.createTableNoOrganization'), variant: 'destructive' })
          return null
        }
        const startedAt = performance.now()
        log.info(`createTable start organizationId=${selectedOrganizationId}`)
        const table = await createTable({
          organization_id: selectedOrganizationId,
          name: t('label.untitledTable'),
          collection_id: options?.collectionId ?? undefined,
          parent_item_id: options?.parentItemId ?? undefined,
        })
        if (!table) {
          log.warn(`createTable returned null elapsedMs=${Math.round(performance.now() - startedAt)}`)
          return null
        }
        log.info(`createTable ok tableId=${table.id} elapsedMs=${Math.round(performance.now() - startedAt)}`)
        // 默认不再预填空白行；仅当显式调高 MIN_NEW_TABLE_VISIBLE_ROW_COUNT 时才走补齐。
        if (MIN_NEW_TABLE_VISIBLE_ROW_COUNT > 0) {
          try {
            await prefillNewTableRows(table.id)
          } catch (seedError) {
            log.warn('failed to seed empty row after table creation:', seedError)
            toast({
              title: t('error.createTableRowsPrefillFailed', {
                defaultValue: '表格已创建，但空白行补齐失败，可稍后手动新增记录。',
              }),
              description: seedError instanceof Error ? seedError.message : undefined,
              variant: 'destructive',
            })
          }
        }
        return table
      },
      onSuccess: (table) => {
        openTable(table.id, table, markResourceMembershipPending())
        // ：新建打开不经 useResourceInit / 知识树，需按 resource_id 记访问（可等 WS 回填）
        recordResourceAccessByResourceId(table.id, { resourceType: 'tabdata' })
        refreshResources('tabdata')
      },
      onError: (error) => {
        log.error('createTable failed:', error)
        // ：配额/权益错误走统一 billing toast（含升级 CTA），与建文档一致
        const billingCode = extractBillingErrorCode(error)
        if (billingCode) {
          showBillingErrorToast(billingCode, { resourceType: 'tabdata' })
          return
        }
        toast({
          title: t('error.createTableFailed'),
          description: getErrorMessage(error),
          variant: 'destructive',
        })
      },
    }),
  [createTable, isAppEnabled, openTable, refreshResources, selectedOrganizationId, setAppBusy, t])

  // 单根契约（见 docs/single-root-space-prd.md）：TabCode / TabFolder 不再有
  // "侧边栏入口 / Quick Action 创建独立标签"的语义。Agent 目录由 Orchestration
  // HomeSection（apphome:orchestration sticky tab）按 working_dir_type 自动渲
  // 染 TabCode 或 TabFolder 视图，进入 Space 即可见，不需要手动打开。
  // 因此 handleOpenCodeProject / handleOpenAgentFolder / handleOpenFolder 全部
  // 删除；createHandlers 中也不再注册 'tabcode' / 'tabfolder' 键。
  // 跨工件流（chat 卡片点开代码文件、git worktree 跳转、Skill 在代码中打开等）
  // 仍走 useFileOpenAction / TabCodePaneHost 等专用路径，与本 hook 解耦。

  const handleDocumentClick = useCallback(
    (doc: { id: string; title?: string }, meta?: Record<string, unknown>) => {
      if (!guardApp('tabdoc', 'TabDoc', isAppEnabled, t)) return
      openDocument(doc.id, doc.title, meta)
    },
    [isAppEnabled, openDocument, t],
  )

  const handleCreateDocument = useCallback((options?: CreateResourceOptions) =>
    executeGuardedCreate({
      creatingRef: isCreatingDocRef,
      setBusy: (busy) => setAppBusy('tabdoc', busy),
      appId: 'tabdoc', appLabel: 'TabDoc',
      isAppEnabled, t,
      create: async () => {
        const organizationId = spaceOrganizationId || fallbackWsId
        if (!organizationId) return null
        const startedAt = performance.now()
        log.info(`createDocument start organizationId=${organizationId}`)
        const apiPort = requireTableApiPort()
        const client = createDirectAppClient({
          appId: 'tabdoc',
          spaceId,
          organizationId,
          getAccessToken: () => apiPort.getAccessToken(),
          baseApiUrl: API_CONFIG.baseURL,
          httpTransport: (req: AppHttpRequest) => apiPort.request(req),
        })
        const result = await createDocument(client, {
          organizationId,
          title: t('tabdoc:untitledDocument'),
          markdown: '',
          collectionId: options?.collectionId ?? null,
          // ：知识库树用 parentItemId；不再写 Document.parent（parentId）
          parentItemId: options?.parentItemId ?? null,
          parentId: options?.parentItemId ? null : (options?.parentDocumentId ?? null),
        })
        log.info(
          `createDocument ok documentId=${result.document.id} elapsedMs=${Math.round(performance.now() - startedAt)}`,
        )
        return result
      },
      onSuccess: (result) => {
        handleDocumentClick(
          { id: result.document.id, title: result.document.title },
          markResourceMembershipPending({ focusTitle: true }),
        )
        // ：新建打开不经 useResourceInit / 知识树，需按 resource_id 记访问（可等 WS 回填）
        recordResourceAccessByResourceId(result.document.id, { resourceType: 'tabdoc' })
        refreshResources('tabdoc')
      },
      onError: (error) => {
        log.error('createDocument failed:', error)
        const billingCode = extractBillingErrorCode(error)
        if (billingCode) {
          showBillingErrorToast(billingCode, {
            description: getErrorMessage(error),
            resourceType: 'tabdoc',
          })
          return
        }
        toast({
          title: t('tabdoc:createFailed'),
          description: getErrorMessage(error),
          variant: 'destructive',
        })
      },
    }),
  [fallbackWsId, handleDocumentClick, isAppEnabled, refreshResources, setAppBusy, spaceId, spaceOrganizationId, t])

  const handleCreateWebTab = useCallback(() => {
    if (!guardApp('tabweb', 'Browser', isAppEnabled, t)) return
    const homepage = browserHomepageUrl.trim()
    void createWebTab(homepage ? normalizeBrowserCreateUrl(homepage, browserSearchEngine) : undefined)
  }, [browserHomepageUrl, browserSearchEngine, createWebTab, isAppEnabled, t])

  const handleCreateTerminal = useCallback(() => {
    if (!guardApp('terminal', 'Terminal', isAppEnabled, t)) return
    try {
      createSession()
    } catch (err) {
      // PRD §11 遥控器模式：当前 device ≠ Agent.control_device 时禁止开终端
      if (err instanceof Error && err.message === 'TERMINAL_NOT_ON_CONTROL_DEVICE') {
        toast({
          title: t('terminal.remoteBlockedTitle', { defaultValue: '当前设备不能开终端' }),
          description: t('terminal.remoteBlockedDesc', {
            defaultValue: 'Agent 在另一台设备上工作，请切换到该设备再开终端。',
          }),
        })
        return
      }
      throw err
    }
  }, [createSession, isAppEnabled, t])

  const handleCreateSlide = useCallback(() => {
    if (!guardApp('tabslide', 'TabSlide', isAppEnabled, t)) return
    // 直接打开空白编辑器（与 Keynote/PPT 的肌肉记忆一致）。
    // 想让 Agent 帮忙搭大纲的入口在 SlideEditorHost 工具栏的"让 Agent 帮忙"按钮，
    // 那里会调用 requestAgentForSlide helper 唤起侧栏对话 + 注入 tabslide.createSlide preset。
    const tempId = `new-${Date.now()}`
    openSlide(tempId)
  }, [isAppEnabled, openSlide, t])

  const handleOpenTins = useCallback(() => {
    if (!TINS_UI_ENABLED) return
    if (!guardApp('tins', 'Tins', isAppEnabled, t)) return
    openTinsPanel(spaceId)
  }, [isAppEnabled, spaceId, t])

  const handleCreateSite = useCallback(() =>
    executeGuardedCreate<{ id: string; name?: string; opts: { name: string; framework?: string; template?: string } }>({
      creatingRef: isCreatingSiteRef,
      setBusy: (busy) => setAppBusy('tabsite', busy),
      appId: 'tabsite', appLabel: 'TabSite',
      isAppEnabled, t,
      create: async () => {
        const opts = await useCreateSiteDialog.getState().open()
        if (!opts) return null
        const wsId = spaceOrganizationId || fallbackWsId
        if (!wsId) {
          toast({
            title: t('createError.noOrganizationDesc'),
            description: t('createError.noOrganizationHint', { defaultValue: '请先选择一个工作空间后再创建站点' }),
            variant: 'destructive',
          })
          return null
        }
        const created = await apiService.request<{ id: string; name?: string }>({
          method: 'POST',
          url: '/tabsite/sites/',
          data: {
            organization_id: wsId,
            space_id: spaceId,
            name: opts.name,
            framework: opts.framework,
            template: opts.template,
          },
        })
        if (!created?.id) return null
        return { ...created, opts }
      },
      onSuccess: ({ id, name, opts }) => {
        openSite(id, name || opts.name)
        // contract W2-β: tabsite.initTemplate (LEGACY_HANDLERS) 返 raw
        // `{success, template?, token_provisioned?, error?}`。模板初始化是后台任务，
        // 失败 toast 但不阻断主创建流程；warn 路径（token_provisioned=false）也单独 toast。
        // 双分支语义保留，重命名变量避开字面 result.success。
        window.tabtin?.tabsite?.initTemplate(id, spaceId).then((initRes) => {
          if (initRes && !initRes.success) {
            toast({
              title: t('apps.initTemplateFailed', { defaultValue: '模板初始化失败' }),
              description: initRes.error || t('apps.initTemplateRetryHint', { defaultValue: '可在站点面板中手动初始化' }),
              variant: 'destructive',
            })
          } else if (initRes?.success && initRes.template === 'dashboard' && initRes.token_provisioned === false) {
            toast({
              title: t('apps.tokenProvisionWarning', { defaultValue: 'TabData Token 配置失败' }),
              description: t('apps.tokenProvisionRetryHint', { defaultValue: 'Dashboard 数据连接未就绪，请在站点设置中重新初始化以恢复 Token' }),
              variant: 'destructive',
            })
          }
        }).catch((err: unknown) => {
          // catch 块覆盖 envelope ok:false 短路抛出
          console.error('[useCreateHandlers] initTemplate background call failed:', err)
          toast({
            title: t('apps.initTemplateFailed', { defaultValue: '模板初始化失败' }),
            description: err instanceof Error ? err.message : t('apps.initTemplateRetryHint', { defaultValue: '可在站点面板中手动初始化' }),
            variant: 'destructive',
          })
        })
        refreshResources('tabsite')
      },
      onError: (err) => {
        log.error('createSite failed:', err)
        toast({
          title: t('apps.createFailed', { appName: 'TabSite', defaultValue: '创建站点失败' }),
          variant: 'destructive',
        })
      },
    }),
  [fallbackWsId, isAppEnabled, openSite, refreshResources, setAppBusy, spaceId, spaceOrganizationId, t])

  // ── 聚合 ──

  const createHandlers = useMemo(
    () => {
      // TabSite C 方案下架（docs/single-root-space-prd.md §2.6）：不暴露 Quick Action。
      // 底层 handleCreateSite 仍保留（避免改动 hook 内部依赖图），仅不挂到 manual map。
      void handleCreateSite
      // 单根契约：tabcode / tabfolder 不在 createHandlers 中注册——它们是
      // Agent 目录的内嵌视图（由 Orchestration HomeSection 按 working_dir_type
      // 自动渲染），不存在"用户主动创建独立 Tab"的语义。
      const manual: Record<string, CreateResourceHandler> = {
        tabweb: handleCreateWebTab,
        tabdata: handleCreateTable,
        tabdoc: handleCreateDocument,
        tabslide: handleCreateSlide,
        terminal: handleCreateTerminal,
      }
      if (TINS_UI_ENABLED) {
        manual.tins = handleOpenTins
      }

      for (const handler of contextRegistry.getAllHandlers()) {
        if (handler.embeddedWeb?.baseUrl && handler.appId && !manual[handler.appId]) {
          const appId = handler.appId
          const appLabel = handler.displayLabel || appId
          manual[appId] = () => {
            if (!guardApp(appId, appLabel, isAppEnabled, t)) return
            void openEmbeddedWebApp(appId)
          }
        }
      }

      return manual
    },
    [
      handleCreateWebTab,
      handleCreateTable,
      handleCreateDocument,
      handleCreateSlide,
      handleCreateSite,
      handleCreateTerminal,
      handleOpenTins,
      openEmbeddedWebApp,
      isAppEnabled,
      t,
    ],
  )

  return {
    createHandlers,
    creatingAppIds,
  }
}
