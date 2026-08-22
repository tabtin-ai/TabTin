/**
 * FeishuImportDialog — 云盘「外部资源 / 飞书」选择多维表格或云文档
 *
 * 开启「检索关联」时：收束为右下角独立扫描任务（RelationScanProgressPanel，
 * source=feishu，可与其它第三方源任务并行）；完成后弹窗再打开进入审查步。
 * 确认导入后进度由 useFeishuImportJobStore + FeishuImportProgressPanel 承接。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Building2, ChevronDown, ChevronRight, HelpCircle, Link2, Loader2, Trash2, Unplug,
} from 'lucide-react'
import { Skeleton } from '@tabtin/smartsheet-ui'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Input,
  ScrollArea,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { preventDialogDismissOnImportFloatPanel } from '../importFloatPanel'
import { createLogger } from '@/utils/logger'
import { buildWebsiteUrl } from '@/config/api'
import { cn } from '@utils/cn'
import {
  disconnectFeishu,
  filterFeishuResourcesByKind,
  getFeishuConnection,
  getFeishuDisplayName,
  listFeishuBitableTables,
  listFeishuImportableResources,
  previewFeishuImport,
  removeFeishuOAuthProvider,
  resolveFeishuWikiResource,
  saveFeishuOAuthProvider,
  startFeishuOAuth,
  type FeishuBitableTable,
  type FeishuImportDocumentRef,
  type FeishuImportableResource,
  type FeishuImportPreviewResult,
  type FeishuResourceKind,
} from './feishuApi'
import { useFeishuImportJobStore } from './useFeishuImportJobStore'
import {
  filterPreviewByExcludedKeys,
  useRelationScanJobStore,
} from '../relation-scan'
import { FeishuBrowseTree } from './FeishuBrowseTree'
import {
  docSelectionKey,
  getBitableTableSelectionState,
  parseDocSelectionKey,
  parseTableSelectionKey,
  phaseFromConnection,
  tableSelectionKey,
  toggleBitableTableSelection,
  type FeishuImportPhase,
  type FeishuImportProgressItem,
} from './feishuImportPhase'
import {
  buildPreviewWithoutRelations,
  defaultCheckedFromPreview,
  filterDegradedEdges,
  filterVisibleEdges,
  resolveFinalImportTables,
  toggleReviewTable,
} from './feishuImportReview'

const log = createLogger('FeishuImportDialog')

const FEISHU_CONNECTED_PATH = 'integrations/feishu/connected'
const FEISHU_SETUP_GUIDE_URL = buildWebsiteUrl('/help/feishu-custom-app-import.html')
/** 列表区随弹窗剩余高度伸缩，避免矮屏时撑破 max-h-[85vh] */
const LIST_SCROLL_CLASS = 'min-h-[140px] max-h-[280px] flex-1'
const APP_TITLE_SKELETON_WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%'] as const

type KindFilter = 'all' | FeishuResourceKind

export interface FeishuImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string | null
  spaceId: string
  collectionId?: string | null
  /** @deprecated 进度完成后 store 会自行刷新目录；保留以免调用方类型断裂 */
  onImported?: (tableIds: string[]) => void
}

function AppListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-1 p-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 px-2 py-2">
          <Skeleton width={14} height={14} rounded="sm" className="opacity-70" />
          <Skeleton
            width={APP_TITLE_SKELETON_WIDTHS[index % APP_TITLE_SKELETON_WIDTHS.length]}
            height={14}
            rounded="md"
          />
        </div>
      ))}
    </div>
  )
}

export const FeishuImportDialog: React.FC<FeishuImportDialogProps> = ({
  open,
  onOpenChange,
  organizationId,
  spaceId,
  collectionId = null,
}) => {
  const { t } = useTranslation('context')
  const startJob = useFeishuImportJobStore((s) => s.startJob)
  const startRelationScanTask = useRelationScanJobStore((s) => s.startTask)
  const markRelationScanRunning = useRelationScanJobStore((s) => s.markTaskRunning)
  const completeRelationScanTask = useRelationScanJobStore((s) => s.completeTask)
  const failRelationScanTask = useRelationScanJobStore((s) => s.failTask)
  const dismissRelationScanTask = useRelationScanJobStore((s) => s.dismissTask)
  const expandRelationScanTask = useRelationScanJobStore((s) => s.expandTask)
  const getRelationScanActiveKeys = useRelationScanJobStore((s) => s.getActiveItemKeys)

  const [phase, setPhase] = useState<FeishuImportPhase>('checking')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [providerConfigured, setProviderConfigured] = useState(false)
  const [canManageProvider, setCanManageProvider] = useState(false)
  const [providerAppId, setProviderAppId] = useState('')
  const [providerAppSecret, setProviderAppSecret] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resources, setResources] = useState<FeishuImportableResource[]>([])
  const [resourcesLoading, setResourcesLoading] = useState(false)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [tablesByApp, setTablesByApp] = useState<Record<string, FeishuBitableTable[]>>({})
  const [expandedApps, setExpandedApps] = useState<Set<string>>(() => new Set())
  const [loadingTables, setLoadingTables] = useState<Set<string>>(() => new Set())
  const [resolvingResources, setResolvingResources] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState<FeishuImportPreviewResult | null>(null)
  const [reviewChecked, setReviewChecked] = useState<Set<string>>(() => new Set())
  const [pendingDocs, setPendingDocs] = useState<FeishuImportDocumentRef[]>([])
  const [includeAttachments, setIncludeAttachments] = useState(false)
  /** 默认开启：与现网「导入前总是分析关联」一致 */
  const [scanRelations, setScanRelations] = useState(true)
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false)
  const [removeProviderConfirmOpen, setRemoveProviderConfirmOpen] = useState(false)
  /** 树浏览 / 勾选时缓存的可读名（selectionKey → name） */
  const [knownNames, setKnownNames] = useState<Record<string, string>>({})
  const searchInputRef = useRef<HTMLInputElement>(null)
  const resourcesLoadSeqRef = useRef(0)
  /** 关联扫描完成后弹回审查步：跳过 reset / checkConnection */
  const resumeReviewRef = useRef(false)
  /** 当前弹窗会话绑定的扫描任务（可与其它 source 任务并行） */
  const relationScanTaskIdRef = useRef<string | null>(null)

  const rememberNames = useCallback((entries: Array<{ key: string; name: string }>) => {
    if (entries.length === 0) return
    setKnownNames((prev) => {
      let changed = false
      const next = { ...prev }
      for (const entry of entries) {
        const name = entry.name.trim()
        if (!entry.key || !name) continue
        if (next[entry.key] === name) continue
        next[entry.key] = name
        changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const resetPickerState = useCallback(() => {
    setPhase('checking')
    setDisplayName(null)
    setProviderConfigured(false)
    setCanManageProvider(false)
    setProviderAppId('')
    setProviderAppSecret('')
    setProviderSaving(false)
    setErrorMessage(null)
    setResources([])
    setResourcesLoading(false)
    setKindFilter('all')
    setTablesByApp({})
    setExpandedApps(new Set())
    setLoadingTables(new Set())
    setResolvingResources(new Set())
    setSelected(new Set())
    setSearch('')
    setAuthorizing(false)
    setPreviewLoading(false)
    setPreview(null)
    setReviewChecked(new Set())
    setPendingDocs([])
    setIncludeAttachments(false)
    setScanRelations(true)
    setDisconnectConfirmOpen(false)
    setRemoveProviderConfirmOpen(false)
    setKnownNames({})
    resumeReviewRef.current = false
    relationScanTaskIdRef.current = null
  }, [])

  const loadResources = useCallback(async (orgId: string, searchKey = '') => {
    const seq = ++resourcesLoadSeqRef.current
    setResourcesLoading(true)
    try {
      const list = await listFeishuImportableResources(orgId, searchKey, 'all')
      if (resourcesLoadSeqRef.current !== seq) return
      setResources(list)
      rememberNames(
        list
          .filter((row) => row.name && row.name !== row.token)
          .map((row) => ({
            key: row.kind === 'docx' ? docSelectionKey(row.token) : `app:${row.token}`,
            name: row.name,
          })),
      )
    } finally {
      if (resourcesLoadSeqRef.current === seq) {
        setResourcesLoading(false)
      }
    }
  }, [rememberNames])

  const checkConnection = useCallback(async () => {
    if (!organizationId) {
      setPhase('error')
      setErrorMessage(t('createError.noOrganizationDesc', { defaultValue: '未找到组织' }))
      return
    }
    setPhase('checking')
    setErrorMessage(null)
    try {
      const conn = await getFeishuConnection(organizationId)
      const next = phaseFromConnection(conn)
      setDisplayName(conn?.display_name?.trim() || null)
      setProviderConfigured(Boolean(conn?.provider_configured))
      setCanManageProvider(Boolean(conn?.can_manage_provider))
      setProviderAppId(conn?.provider_app_id?.trim() || '')
      setProviderAppSecret('')
      setPhase(next)
    } catch (err) {
      log.error('check connection failed', err)
      setPhase('error')
      const msg = err instanceof Error ? err.message : String(err)
      const status = err && typeof err === 'object' && 'statusCode' in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 0
      setErrorMessage(
        status
          ? `${msg}${msg.includes(String(status)) ? '' : `（HTTP ${status}）`}`
          : msg,
      )
    }
  }, [organizationId, t])

  const searchMode = search.trim().length > 0
  const visibleResources = useMemo(
    () => filterFeishuResourcesByKind(resources, kindFilter),
    [kindFilter, resources],
  )

  useEffect(() => {
    // 树浏览不预拉扁平列表；仅搜索模式走 /resources
    if (!open || phase !== 'browsing' || !organizationId || !searchMode) return
    const handle = window.setTimeout(() => {
      void loadResources(organizationId, search).catch((err) => {
        log.error('search resources failed', err)
        toast({
          title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      })
    }, 300)
    return () => window.clearTimeout(handle)
  }, [open, phase, organizationId, search, searchMode, loadResources, t])

  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    const holdingThisScan = () => {
      const taskId = relationScanTaskIdRef.current
      if (!taskId) return false
      return useRelationScanJobStore.getState().isHoldingDialog(taskId)
    }

    if (!open) {
      // 本会话扫描任务收束期间：保留选表/预览态，供完成后弹回审查
      if (holdingThisScan()) return
      resetPickerState()
      return
    }
    if (resumeReviewRef.current) {
      resumeReviewRef.current = false
      return
    }
    // 扫描仍在进行时用户又打开弹窗：勿 checkConnection，避免异步把后续 review 打回 browsing
    if (holdingThisScan()) return
    void checkConnection()
  }, [open, checkConnection, resetPickerState])

  useEffect(() => {
    if (!open || phase !== 'browsing') return
    const handle = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [open, phase])

  useEffect(() => {
    if (!open) return
    const tabtin = window.tabtin
    if (!tabtin?.deepLink?.onDeepLink) return
    return tabtin.deepLink.onDeepLink((data: { path: string; url: string }) => {
      if (!data.path.includes(FEISHU_CONNECTED_PATH)) return
      log.info('feishu connected deep link received', { path: data.path })
      setAuthorizing(false)
      void checkConnection()
    })
  }, [open, checkConnection])

  const handleAuthorize = useCallback(async () => {
    if (!organizationId) return
    setAuthorizing(true)
    try {
      const authorizeUrl = await startFeishuOAuth(organizationId)
      const result = await window.tabtin?.openExternal?.(authorizeUrl)
      if (result && result.success === false) {
        throw new Error(result.error || 'openExternal failed')
      }
    } catch (err) {
      log.error('open authorize failed', err)
      setAuthorizing(false)
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [organizationId, t])

  const handleSaveProvider = useCallback(async () => {
    if (!organizationId || !providerAppId.trim() || !providerAppSecret.trim()) return
    setProviderSaving(true)
    log.info('save Feishu OAuth provider started', { organizationId })
    try {
      await saveFeishuOAuthProvider(
        organizationId,
        providerAppId.trim(),
        providerAppSecret,
      )
      log.info('save Feishu OAuth provider completed', { organizationId })
      await checkConnection()
    } catch (err) {
      log.error('save Feishu OAuth provider failed', err)
      toast({
        title: t('home.assetBrowser.feishuProviderSaveFailed', {
          defaultValue: '企业应用配置失败',
        }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      setProviderAppSecret('')
      setProviderSaving(false)
    }
  }, [checkConnection, organizationId, providerAppId, providerAppSecret, t])

  const handleRemoveProvider = useCallback(async () => {
    if (!organizationId) return
    log.info('remove Feishu OAuth provider started', { organizationId })
    try {
      await removeFeishuOAuthProvider(organizationId)
      log.info('remove Feishu OAuth provider completed', { organizationId })
      setRemoveProviderConfirmOpen(false)
      setProviderAppId('')
      setProviderAppSecret('')
      await checkConnection()
    } catch (err) {
      log.error('remove Feishu OAuth provider failed', err)
      toast({
        title: t('home.assetBrowser.feishuProviderRemoveFailed', {
          defaultValue: '移除企业应用失败',
        }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [checkConnection, organizationId, t])

  const handleOpenSetupGuide = useCallback(async () => {
    try {
      const result = await window.tabtin?.openExternal?.(FEISHU_SETUP_GUIDE_URL)
      if (!result || result.success === false) {
        throw new Error(result?.error || 'openExternal unavailable')
      }
    } catch (err) {
      log.error('open Feishu setup guide failed', err)
      toast({
        title: t('home.assetBrowser.feishuGuideOpenFailed', {
          defaultValue: '无法打开接入教程',
        }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [t])

  const handleDisconnect = useCallback(async () => {
    if (!organizationId) return
    try {
      await disconnectFeishu(organizationId)
      setDisplayName(null)
      setResources([])
      setTablesByApp({})
      setSelected(new Set())
      setPhase('need_auth')
    } catch (err) {
      log.error('disconnect failed', err)
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [organizationId, t])

  const ensureTablesLoaded = useCallback(async (appToken: string): Promise<FeishuBitableTable[]> => {
    if (!organizationId) return []
    if (tablesByApp[appToken]) return tablesByApp[appToken]
    setLoadingTables((prev) => new Set(prev).add(appToken))
    try {
      const tables = await listFeishuBitableTables(organizationId, appToken)
      setTablesByApp((prev) => ({ ...prev, [appToken]: tables }))
      rememberNames(
        tables
          .filter((row) => row.name && row.name !== row.table_id)
          .map((row) => ({
            key: tableSelectionKey(appToken, row.table_id),
            name: row.name,
          })),
      )
      return tables
    } catch (err) {
      log.error('list tables failed', { appToken, err })
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
      return []
    } finally {
      setLoadingTables((prev) => {
        const next = new Set(prev)
        next.delete(appToken)
        return next
      })
    }
  }, [organizationId, rememberNames, t, tablesByApp])

  const resolveSearchResource = useCallback(async (
    resource: FeishuImportableResource,
  ): Promise<FeishuImportableResource | null> => {
    const nodeToken = resource.wiki_node_token?.trim()
    if (!nodeToken) return resource
    if (!organizationId) return null

    setResolvingResources((prev) => new Set(prev).add(resource.token))
    try {
      const resolved = await resolveFeishuWikiResource(
        organizationId,
        nodeToken,
        resource.kind,
      )
      const next = {
        ...resolved,
        name: resource.name || resolved.name,
      }
      setResources((prev) => prev.map((row) => (
        row.token === resource.token && row.wiki_node_token === nodeToken ? next : row
      )))
      rememberNames([{
        key: next.kind === 'docx' ? docSelectionKey(next.token) : `app:${next.token}`,
        name: next.name,
      }])
      return next
    } catch (err) {
      log.error('resolve wiki search resource failed', { nodeToken, err })
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
      return null
    } finally {
      setResolvingResources((prev) => {
        const next = new Set(prev)
        next.delete(resource.token)
        return next
      })
    }
  }, [organizationId, rememberNames, t])

  const toggleAppExpanded = useCallback(async (appToken: string) => {
    setExpandedApps((prev) => {
      const next = new Set(prev)
      if (next.has(appToken)) next.delete(appToken)
      else next.add(appToken)
      return next
    })
    await ensureTablesLoaded(appToken)
  }, [ensureTablesLoaded])

  const toggleTable = useCallback((
    appToken: string,
    tableId: string,
    checked: boolean,
    name?: string,
  ) => {
    const key = tableSelectionKey(appToken, tableId)
    if (checked && name?.trim() && name.trim() !== tableId) {
      rememberNames([{ key, name: name.trim() }])
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [rememberNames])

  const toggleBitableTables = useCallback((
    appToken: string,
    tables: FeishuBitableTable[],
    checked: boolean,
  ) => {
    if (checked) {
      rememberNames(tables.map((table) => ({
        key: tableSelectionKey(appToken, table.table_id),
        name: table.name,
      })))
    }
    setSelected((prev) => toggleBitableTableSelection(
      prev,
      appToken,
      tables,
      checked,
    ))
  }, [rememberNames])

  const toggleDoc = useCallback((docToken: string, checked: boolean, name?: string) => {
    const key = docSelectionKey(docToken)
    if (checked && name?.trim() && name.trim() !== docToken) {
      rememberNames([{ key, name: name.trim() }])
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [rememberNames])

  const resolveTableName = useCallback((appToken: string, tableId: string) => {
    const key = tableSelectionKey(appToken, tableId)
    const remembered = knownNames[key]?.trim()
    if (remembered && remembered !== tableId) return remembered
    const table = tablesByApp[appToken]?.find((row) => row.table_id === tableId)
    if (table?.name && table.name !== tableId) return table.name
    // 空串：让 preview/runner 用飞书 list_tables 回填，避免用 table_id 覆盖真名
    return ''
  }, [knownNames, tablesByApp])

  const resolveSelectedDocuments = useCallback((): FeishuImportDocumentRef[] => {
    return [...selected]
      .map(parseDocSelectionKey)
      .filter((token): token is string => token != null)
      .map((token) => {
        const key = docSelectionKey(token)
        const remembered = knownNames[key]?.trim()
        const resource = resources.find((row) => row.kind === 'docx' && row.token === token)
        // 未知时留空，后端用 metas/batch_query 回填；勿用 token 冒充标题
        const name = (remembered && remembered !== token)
          ? remembered
          : (resource?.name && resource.name !== token ? resource.name : '')
        return {
          doc_token: token,
          name,
          doc_type: 'docx' as const,
        }
      })
  }, [knownNames, resources, selected])

  const startDocumentsImport = useCallback(async (documents: FeishuImportDocumentRef[]) => {
    if (!organizationId || documents.length === 0) return

    const items = documents.map((doc) => ({
      name: getFeishuDisplayName('docx', doc.name, [doc.doc_token]),
      tableKey: docSelectionKey(doc.doc_token),
      itemKind: 'docx' as const,
      docToken: doc.doc_token,
    }))

    onOpenChange(false)
    try {
      await startJob({
        organizationId,
        spaceId,
        collectionId,
        tables: [],
        documents,
        items,
      })
    } catch (err) {
      log.error('import failed', err)
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [collectionId, onOpenChange, organizationId, spaceId, startJob, t])

  const enterReview = useCallback((
    result: FeishuImportPreviewResult,
    documents: FeishuImportDocumentRef[],
  ) => {
    setPreview(result)
    setReviewChecked(defaultCheckedFromPreview(result))
    setPendingDocs(documents)
    setIncludeAttachments(false)
    setPhase('review')
    // preview / list_tables 回填的真名写入缓存，进度面板与再次勾选可复用
    rememberNames([
      ...result.tables
        .filter((row) => Boolean(row.name?.trim()) && row.name !== row.table_id)
        .map((row) => ({
          key: tableSelectionKey(row.app_token, row.table_id),
          name: (row.name || '').trim(),
        })),
      ...documents
        .filter((doc) => Boolean(doc.name?.trim()) && doc.name !== doc.doc_token)
        .map((doc) => ({
          key: docSelectionKey(doc.doc_token),
          name: (doc.name || '').trim(),
        })),
    ])
  }, [rememberNames])

  const handleOpenReview = useCallback(async () => {
    if (!organizationId || selected.size === 0) return

    const documents = resolveSelectedDocuments()
    const tables = [...selected]
      .filter((key) => parseDocSelectionKey(key) == null)
      .map(parseTableSelectionKey)
      .filter((row): row is { app_token: string; table_id: string } => row != null)
      .map((row) => ({
        ...row,
        name: resolveTableName(row.app_token, row.table_id),
      }))

    if (tables.length === 0) {
      if (documents.length > 0) {
        await startDocumentsImport(documents)
      }
      return
    }

    // 关闭关联扫描：直接进入审查（无闭包、无 edges）
    if (!scanRelations) {
      enterReview(buildPreviewWithoutRelations(tables), documents)
      return
    }

    setPreviewLoading(true)
    setErrorMessage(null)
    const taskId = startRelationScanTask({
      source: 'feishu',
      title: t('home.assetBrowser.relationScanTitleFeishu', {
        defaultValue: '飞书 · 关联扫描',
      }),
      items: tables.map((row) => ({
        key: tableSelectionKey(row.app_token, row.table_id),
        name: row.name || row.table_id,
      })),
      holdingDialog: true,
    })
    relationScanTaskIdRef.current = taskId
    log.info('feishu relation scan started', { tables: tables.length, taskId })
    // 收束弹窗 → 右下角独立扫描任务；可与其它 source 任务并行
    onOpenChange(false)

    const abort = new AbortController()
    const unsubscribe = useRelationScanJobStore.subscribe((state) => {
      const task = state.tasks.find((row) => row.id === taskId)
      if (!task || task.status !== 'scanning') return
      const active = task.items.filter((item) => (
        item.status !== 'skipped' && item.status !== 'cancelled'
      ))
      if (active.length === 0) {
        abort.abort()
      }
    })

    try {
      // 让出一帧，便于用户立刻取消仍为 pending 的表
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0)
      })
      if (abort.signal.aborted) {
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        if (!openRef.current) onOpenChange(true)
        return
      }

      const activeKeys = new Set(getRelationScanActiveKeys(taskId))
      if (activeKeys.size === 0) {
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        if (!openRef.current) onOpenChange(true)
        return
      }

      markRelationScanRunning(taskId)
      const tablesToScan = tables.filter((row) => (
        activeKeys.has(tableSelectionKey(row.app_token, row.table_id))
      ))
      const result = await previewFeishuImport({
        organization_id: organizationId,
        tables: tablesToScan,
      })
      if (abort.signal.aborted) {
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        return
      }

      const outcome = completeRelationScanTask(taskId)
      if (!outcome.ok) return

      const excluded = new Set([
        ...outcome.excludedKeys,
        ...useRelationScanJobStore.getState().getExcludedKeys(taskId),
      ])
      const filtered = filterPreviewByExcludedKeys(result, excluded)
      log.info('feishu relation scan completed', {
        taskId,
        tables: filtered.tables.length,
        edges: filtered.edges.length,
        excluded: excluded.size,
        shouldResume: outcome.shouldResume,
      })

      if (filtered.tables.length === 0) {
        toast({
          title: t('home.assetBrowser.relationScanAllSkipped', {
            defaultValue: '已跳过全部表',
          }),
        })
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        if (outcome.shouldResume && !openRef.current) {
          onOpenChange(true)
        }
        return
      }

      if (outcome.shouldResume) {
        enterReview(filtered, documents)
        if (openRef.current) {
          resumeReviewRef.current = false
        } else {
          resumeReviewRef.current = true
          onOpenChange(true)
        }
      }
      dismissRelationScanTask(taskId)
      if (relationScanTaskIdRef.current === taskId) {
        relationScanTaskIdRef.current = null
      }
    } catch (err) {
      if (abort.signal.aborted) {
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        return
      }
      log.error('preview failed', err)
      const message = err instanceof Error ? err.message : String(err)
      const outcome = failRelationScanTask(taskId, message)
      if (!outcome.ok) return
      toast({
        title: t('home.assetBrowser.feishuRelationScanFailed', {
          defaultValue: '关联扫描失败',
        }),
        description: message,
        variant: 'destructive',
      })
      expandRelationScanTask(taskId)
      window.setTimeout(() => {
        if (!useRelationScanJobStore.getState().tasks.some((row) => row.id === taskId)) {
          return
        }
        dismissRelationScanTask(taskId)
        if (relationScanTaskIdRef.current === taskId) {
          relationScanTaskIdRef.current = null
        }
        if (outcome.shouldResume && !openRef.current) {
          onOpenChange(true)
        }
      }, 1600)
    } finally {
      unsubscribe()
      setPreviewLoading(false)
    }
  }, [
    completeRelationScanTask,
    dismissRelationScanTask,
    enterReview,
    expandRelationScanTask,
    failRelationScanTask,
    getRelationScanActiveKeys,
    markRelationScanRunning,
    onOpenChange,
    organizationId,
    resolveSelectedDocuments,
    resolveTableName,
    scanRelations,
    selected,
    startDocumentsImport,
    startRelationScanTask,
    t,
  ])

  const handleConfirmImport = useCallback(async () => {
    if (!organizationId || !preview) return
    const tables = resolveFinalImportTables(preview, reviewChecked)
    const documents = pendingDocs
    if (tables.length === 0 && documents.length === 0) {
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: t('home.assetBrowser.feishuReviewEmpty', {
          defaultValue: '请至少保留一张表',
        }),
        variant: 'destructive',
      })
      return
    }

    const tableItems: FeishuImportProgressItem[] = tables.map((row) => {
      const tableKey = tableSelectionKey(row.app_token, row.table_id)
      return {
        key: tableKey,
        tableKey,
        batchId: '',
        name: row.name,
        status: 'pending',
      }
    })

    onOpenChange(false)
    try {
      await startJob({
        organizationId,
        spaceId,
        collectionId,
        tables,
        documents,
        includeAttachments,
        items: [
          ...tableItems.map((row) => ({
            name: row.name,
            tableKey: row.tableKey,
          })),
          ...documents.map((doc) => ({
            name: getFeishuDisplayName('docx', doc.name, [doc.doc_token]),
            tableKey: docSelectionKey(doc.doc_token),
            itemKind: 'docx' as const,
            docToken: doc.doc_token,
          })),
        ],
      })
    } catch (err) {
      log.error('import failed', err)
      toast({
        title: t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [
    collectionId,
    includeAttachments,
    onOpenChange,
    organizationId,
    pendingDocs,
    preview,
    reviewChecked,
    spaceId,
    startJob,
    t,
  ])

  const connectedHint = displayName
    ? t('home.assetBrowser.feishuConnectedAs', {
        name: displayName,
        defaultValue: '已连接：{{name}}',
      })
    : null

  const showBrowsingChrome = phase === 'browsing' || phase === 'checking'
  const visibleEdges = preview
    ? filterVisibleEdges(preview.edges, reviewChecked)
    : []
  const degradedEdges = preview
    ? filterDegradedEdges(preview.edges, reviewChecked)
    : []
  const reviewImportCount = reviewChecked.size + pendingDocs.length
  const selectedTableCount = useMemo(
    () => [...selected].filter((key) => parseDocSelectionKey(key) == null).length,
    [selected],
  )

  const kindFilterLabel = (kind: KindFilter) => {
    if (kind === 'all') {
      return t('home.assetBrowser.feishuKindAll', { defaultValue: '全部' })
    }
    if (kind === 'bitable') {
      return t('home.assetBrowser.feishuKindBitable', { defaultValue: '多维表格' })
    }
    return t('home.assetBrowser.feishuKindDocx', { defaultValue: '云文档' })
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-8rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          if (phase === 'checking' || phase === 'browsing') {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={preventDialogDismissOnImportFloatPanel}
        onInteractOutside={preventDialogDismissOnImportFloatPanel}
        onFocusOutside={preventDialogDismissOnImportFloatPanel}
      >
        <ContextDialogHeader
          icon={<Link2 className="h-7 w-7" />}
          title={t('home.assetBrowser.feishuImportTitle', { defaultValue: '从飞书导入' })}
          titleAccessory={
            phase === 'browsing' ? (
              <div className="flex items-center gap-1">
                {canManageProvider ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-auto gap-1 px-1.5 py-0.5 text-caption font-normal text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/80"
                    onClick={() => setPhase('provider_setup')}
                  >
                    <Building2 className="h-3.5 w-3.5" />
                    {t('home.assetBrowser.feishuProviderSettings', { defaultValue: '企业应用' })}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-auto gap-1 px-1.5 py-0.5 text-caption font-normal text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/80"
                  onClick={() => setDisconnectConfirmOpen(true)}
                >
                  <Unplug className="h-3.5 w-3.5" />
                  {t('home.assetBrowser.feishuDisconnect', { defaultValue: '断开我的飞书' })}
                </Button>
              </div>
            ) : null
          }
          description={t('home.assetBrowser.feishuImportDesc', {
            defaultValue: '授权后选择多维表格或云文档，导入到当前云盘文件夹',
          })}
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5">
          {phase === 'provider_setup' ? (
            <div className="flex flex-col gap-4 py-6">
              <div className="flex flex-col gap-1">
                <p className="text-body font-medium">
                  {t('home.assetBrowser.feishuProviderTitle', {
                    defaultValue: '配置企业自建应用',
                  })}
                </p>
                <p className="text-caption text-muted-foreground/80">
                  {t('home.assetBrowser.feishuProviderDesc', {
                    defaultValue: '此配置对当前组织生效。保存并验证后，每位成员仍需授权自己的飞书帐号。',
                  })}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-caption font-medium">
                  <span>App ID</span>
                  <Input
                    value={providerAppId}
                    onChange={(event) => setProviderAppId(event.target.value)}
                    placeholder="cli_xxxxxxxxxxxxxxxx"
                    autoComplete="off"
                    disabled={providerSaving}
                  />
                </label>
                <label className="flex flex-col gap-1 text-caption font-medium">
                  <span>App Secret</span>
                  <Input
                    type="password"
                    value={providerAppSecret}
                    onChange={(event) => setProviderAppSecret(event.target.value)}
                    placeholder={providerConfigured ? '输入新的 Secret 以验证并保存' : '输入 App Secret'}
                    autoComplete="new-password"
                    disabled={providerSaving}
                  />
                </label>
              </div>
              <Button
                type="button"
                variant="link"
                className="h-auto w-fit p-0 text-caption"
                onClick={() => void handleOpenSetupGuide()}
              >
                {t('home.assetBrowser.feishuSetupGuideAction', {
                  defaultValue: '查看接入教程',
                })}
              </Button>
              <div className="flex items-center justify-between gap-2">
                <div>
                  {providerConfigured ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="gap-2 text-destructive hover:text-destructive"
                      disabled={providerSaving}
                      onClick={() => setRemoveProviderConfirmOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('home.assetBrowser.feishuProviderRemove', {
                        defaultValue: '移除企业应用',
                      })}
                    </Button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {providerConfigured ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={providerSaving}
                      onClick={() => void checkConnection()}
                    >
                      {t('common.cancel', { defaultValue: '取消' })}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    className="gap-2"
                    disabled={providerSaving || !providerAppId.trim() || !providerAppSecret.trim()}
                    onClick={() => void handleSaveProvider()}
                  >
                    {providerSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t('home.assetBrowser.feishuProviderValidateSave', {
                      defaultValue: '验证并保存',
                    })}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {phase === 'provider_wait' ? (
            <div className="flex flex-col gap-4 py-6">
              <p className="text-body font-medium">
                {t('home.assetBrowser.feishuProviderWaitingTitle', {
                  defaultValue: '等待管理员配置飞书应用',
                })}
              </p>
              <p className="text-caption text-muted-foreground/80">
                {t('home.assetBrowser.feishuProviderWaitingDesc', {
                  defaultValue: '请联系组织 Owner 或 Admin，在此处配置企业自建应用。配置完成后你即可授权自己的飞书帐号。',
                })}
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => void handleOpenSetupGuide()}>
                  {t('home.assetBrowser.feishuSetupGuideAction', { defaultValue: '查看接入教程' })}
                </Button>
                <Button type="button" onClick={() => void checkConnection()}>
                  {t('common.refresh', { defaultValue: '刷新状态' })}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === 'need_auth' ? (
            <div className="flex flex-col gap-4 py-6">
              <p className="text-body text-muted-foreground/80">
                {t('home.assetBrowser.feishuPersonalAuthDesc', {
                  defaultValue: '企业应用已配置。请授权你自己的飞书帐号，然后选择有权访问的资源。',
                })}
              </p>
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-caption text-muted-foreground/60">
                <span>
                  {t('home.assetBrowser.feishuNeedCollaboratorHint', {
                    defaultValue: '授权仅用于读取你有权访问的多维表格、云文档和知识库。',
                  })}
                </span>
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => void handleOpenSetupGuide()}
                >
                  {t('home.assetBrowser.feishuSetupGuideAction', {
                    defaultValue: '查看接入教程',
                  })}
                </button>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  className="w-full gap-2"
                  disabled={authorizing}
                  onClick={() => void handleAuthorize()}
                >
                  {authorizing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('home.assetBrowser.feishuAuthorizing', { defaultValue: '正在打开授权页…' })}
                    </>
                  ) : (
                    t('home.assetBrowser.feishuAuthorize', { defaultValue: '授权我的飞书帐号' })
                  )}
                </Button>
                {canManageProvider ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setPhase('provider_setup')}
                  >
                    {t('home.assetBrowser.feishuProviderSettings', { defaultValue: '管理企业应用' })}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {showBrowsingChrome ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              {phase === 'checking' ? (
                <p className="shrink-0 text-caption text-muted-foreground/80">
                  {t('home.assetBrowser.feishuChecking', { defaultValue: '正在检查飞书连接…' })}
                </p>
              ) : connectedHint ? (
                <p className="shrink-0 text-caption text-muted-foreground/80">{connectedHint}</p>
              ) : (
                <p className="shrink-0 text-caption text-muted-foreground/80">&nbsp;</p>
              )}
              <div
                className="flex shrink-0 flex-wrap gap-1.5"
                role="tablist"
                aria-label={t('home.assetBrowser.feishuKindFilter', {
                  defaultValue: '资源类型',
                })}
              >
                {(['all', 'bitable', 'docx'] as const).map((kind) => {
                  const active = kindFilter === kind
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      disabled={phase !== 'browsing'}
                      onClick={() => setKindFilter(kind)}
                      className={cn(
                        'h-7 inline-flex items-center rounded-full px-3 text-caption transition-colors',
                        'disabled:pointer-events-none disabled:opacity-50',
                        active
                          ? 'bg-primary text-primary-foreground font-medium'
                          : 'bg-muted/40 text-foreground/80 hover:bg-muted/60',
                      )}
                    >
                      {kindFilterLabel(kind)}
                    </button>
                  )
                })}
              </div>
              <Input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('home.assetBrowser.feishuSearchPlaceholder', {
                  defaultValue: '搜索多维表格或云文档…',
                })}
                disabled={phase !== 'browsing'}
                className="h-9 shrink-0"
              />
              <p className="shrink-0 text-caption text-muted-foreground/60">
                {searchMode
                  ? t('home.assetBrowser.feishuSelectResources', {
                      defaultValue: '选择要导入的数据表或云文档',
                    })
                  : t('home.assetBrowser.feishuBrowseHint', {
                      defaultValue: '从云盘或知识库逐层展开选择；也可搜索名称',
                    })}
              </p>
              <ScrollArea
                className={cn(LIST_SCROLL_CLASS, 'rounded-lg border border-border/60')}
                aria-busy={phase === 'checking' || (searchMode && resourcesLoading)}
              >
                {phase === 'checking' ? (
                  <div className="relative">
                    <AppListSkeleton />
                    <span className="sr-only">
                      {t('home.assetBrowser.feishuChecking', {
                        defaultValue: '正在检查飞书连接…',
                      })}
                    </span>
                  </div>
                ) : !searchMode && organizationId && phase === 'browsing' ? (
                  <FeishuBrowseTree
                    organizationId={organizationId}
                    kindFilter={kindFilter}
                    selected={selected}
                    disabled={phase !== 'browsing'}
                    onToggleTable={toggleTable}
                    onToggleTables={toggleBitableTables}
                    onToggleDoc={toggleDoc}
                    onNamesKnown={rememberNames}
                    onError={(message) => {
                      toast({
                        title: t('home.assetBrowser.feishuImportFailed', {
                          defaultValue: '导入失败',
                        }),
                        description: message,
                        variant: 'destructive',
                      })
                    }}
                  />
                ) : resourcesLoading ? (
                  <div className="relative">
                    <AppListSkeleton />
                    <span className="sr-only">
                      {t('home.assetBrowser.feishuResourcesLoading', {
                        defaultValue: '正在加载资源列表…',
                      })}
                    </span>
                  </div>
                ) : visibleResources.length === 0 ? (
                  <div className="px-3 py-8 text-center text-body text-muted-foreground/60">
                    {t('home.assetBrowser.feishuNoResources', {
                      defaultValue:
                        '未找到多维表格或云文档。可输入名称搜索；若一直为空，请确认已开通云文档只读权限并重新授权',
                    })}
                  </div>
                ) : (
                  <ul className="divide-y divide-border/50 p-1">
                    {visibleResources.map((resource) => {
                      if (resource.kind === 'docx') {
                        const key = docSelectionKey(resource.token)
                        const checked = selected.has(key)
                        const resolving = resolvingResources.has(resource.token)
                        const docDisabled = phase !== 'browsing'
                          || resolving
                        return (
                          <li key={resource.token}>
                            <label
                              className={cn(
                                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2',
                                'hover:bg-foreground/[0.04]',
                                docDisabled && 'pointer-events-none opacity-60',
                              )}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={async (v) => {
                                  const resolved = await resolveSearchResource(resource)
                                  if (resolved) {
                                    toggleDoc(resolved.token, v === true, resolved.name)
                                  }
                                }}
                                disabled={docDisabled}
                              />
                              <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                                {resource.name}
                              </span>
                              {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                            </label>
                          </li>
                        )
                      }

                      const appToken = resource.token
                      const expanded = expandedApps.has(appToken)
                      const tables = tablesByApp[appToken]
                      const resolving = resolvingResources.has(appToken)
                      const loading = loadingTables.has(appToken) || resolving
                      const selectionState = getBitableTableSelectionState(
                        selected,
                        appToken,
                        tables || [],
                      )
                      const parentChecked = selectionState === 'checked'
                        ? true
                        : selectionState === 'indeterminate'
                          ? 'indeterminate' as const
                          : false
                      const parentDisabled = phase !== 'browsing'
                        || loading
                      return (
                        <li key={appToken}>
                          <div className="flex items-center gap-1 rounded-md px-2 hover:bg-foreground/[0.04]">
                            <Checkbox
                              checked={parentChecked}
                              disabled={parentDisabled}
                              onCheckedChange={async () => {
                                const resolved = await resolveSearchResource(resource)
                                if (!resolved) return
                                const loaded = await ensureTablesLoaded(resolved.token)
                                toggleBitableTables(
                                  resolved.token,
                                  loaded,
                                  selectionState !== 'checked',
                                )
                              }}
                            />
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                              onClick={() => {
                                void resolveSearchResource(resource).then((resolved) => {
                                  if (resolved) void toggleAppExpanded(resolved.token)
                                })
                              }}
                              disabled={phase !== 'browsing' || loading}
                            >
                              {expanded
                                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                              <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                                {resource.name}
                              </span>
                              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                            </button>
                          </div>
                          {expanded ? (
                            <ul className="pb-1 pl-7 pr-2">
                              {loading && !tables ? (
                                <li className="px-2 py-2 text-caption text-muted-foreground/60">
                                  <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                                  …
                                </li>
                              ) : null}
                              {(tables || []).map((table) => {
                                const key = tableSelectionKey(appToken, table.table_id)
                                const checked = selected.has(key)
                                const tableDisabled = phase !== 'browsing'
                                return (
                                  <li key={table.table_id}>
                                    <label
                                      className={cn(
                                        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5',
                                        'hover:bg-foreground/[0.04]',
                                        tableDisabled && 'pointer-events-none opacity-60',
                                      )}
                                    >
                                      <Checkbox
                                        checked={checked}
                                        onCheckedChange={(v) => {
                                          toggleTable(appToken, table.table_id, v === true)
                                        }}
                                        disabled={tableDisabled}
                                      />
                                      <span className="truncate text-body text-foreground/80">
                                        {table.name}
                                      </span>
                                    </label>
                                  </li>
                                )
                              })}
                              {tables && tables.length === 0 ? (
                                <li className="px-2 py-2 text-caption text-muted-foreground/60">
                                  —
                                </li>
                              ) : null}
                            </ul>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </ScrollArea>

              <label
                className={cn(
                  'flex shrink-0 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5',
                  selectedTableCount === 0 && 'opacity-60',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-body text-foreground/90">
                      {t('home.assetBrowser.feishuScanRelations', {
                        defaultValue: '检索关联关系',
                      })}
                    </p>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                            aria-label={t('home.assetBrowser.feishuScanRelationsTooltip', {
                              defaultValue:
                                '开启后会扫描所选表格的字段内容，识别表之间的关联关系；关闭则只导入已选表，关联字段将降级为文本',
                            })}
                          >
                            <HelpCircle className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[240px]">
                          {t('home.assetBrowser.feishuScanRelationsTooltip', {
                            defaultValue:
                              '开启后会扫描所选表格的字段内容，识别表之间的关联关系；关闭则只导入已选表，关联字段将降级为文本',
                          })}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-caption text-muted-foreground/60">
                    {t('home.assetBrowser.feishuScanRelationsHint', {
                      defaultValue: '开启后将扫描表格字段以获取关联',
                    })}
                  </p>
                </div>
                <Switch
                  checked={scanRelations}
                  onCheckedChange={setScanRelations}
                  disabled={phase !== 'browsing' || selectedTableCount === 0 || previewLoading}
                />
              </label>

              <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  {t('common.cancel', { defaultValue: '取消' })}
                </Button>
                <Button
                  type="button"
                  disabled={
                    phase !== 'browsing'
                    || selected.size === 0
                    || previewLoading
                  }
                  onClick={() => void handleOpenReview()}
                >
                  {previewLoading ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      {t('home.assetBrowser.feishuAnalyzing', { defaultValue: '分析关联…' })}
                    </>
                  ) : (
                    <>
                      {t('home.assetBrowser.feishuImportAction', { defaultValue: '导入所选' })}
                      {selected.size > 0 ? ` (${selected.size})` : ''}
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === 'review' && preview ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
                {pendingDocs.length > 0 ? (
                  <div className="rounded-lg border border-border/60 px-3 py-2">
                    <p className="mb-1 text-caption text-muted-foreground/80">
                      {t('home.assetBrowser.feishuReviewPendingDocs', {
                        defaultValue: '将导入为 TabDoc',
                      })}
                    </p>
                    <ul className="max-h-24 space-y-1 overflow-y-auto">
                      {pendingDocs.map((doc) => (
                        <li
                          key={doc.doc_token}
                          className="text-caption text-foreground/80"
                        >
                          {getFeishuDisplayName('docx', doc.name, [doc.doc_token])}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-caption text-muted-foreground/80">
                  {(preview.edges || []).length > 0
                    ? t('home.assetBrowser.feishuReviewHint', {
                        defaultValue: '将一并导入关联表并重建关联字段；可取消不需要的依赖表',
                      })
                    : t('home.assetBrowser.feishuReviewHintNoEdges', {
                        defaultValue: '未检索关联关系，将仅导入下列已选表；关联字段会降级为文本',
                      })}
                </p>
                <div className="rounded-lg border border-border/60">
                  <ul className="divide-y divide-border/50 p-1">
                    {preview.tables.map((row) => {
                      const key = tableSelectionKey(row.app_token, row.table_id)
                      const checked = reviewChecked.has(key)
                      return (
                        <li key={key}>
                          <label
                            className={cn(
                              'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2',
                              'hover:bg-foreground/[0.04]',
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => {
                                setReviewChecked((prev) => (
                                  toggleReviewTable(prev, row.app_token, row.table_id, v === true)
                                ))
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                              {row.name || row.table_id}
                            </span>
                            {row.auto_included ? (
                              <span className="shrink-0 text-caption text-muted-foreground/60">
                                {t('home.assetBrowser.feishuReviewAutoIncluded', {
                                  defaultValue: '因关联加入',
                                })}
                              </span>
                            ) : (
                              <span className="shrink-0 text-caption text-muted-foreground/60">
                                {t('home.assetBrowser.feishuReviewSelected', {
                                  defaultValue: '已选',
                                })}
                              </span>
                            )}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>

                {visibleEdges.length > 0 ? (
                  <div className="rounded-lg border border-border/60 px-3 py-2">
                    <p className="mb-1 text-caption text-muted-foreground/80">
                      {t('home.assetBrowser.feishuReviewEdges', { defaultValue: '关联关系' })}
                    </p>
                    <ul className="max-h-24 space-y-1 overflow-y-auto">
                      {visibleEdges.map((edge) => (
                        <li
                          key={`${edge.from_table_id}:${edge.field_name}:${edge.to_table_id}`}
                          className="text-caption text-foreground/80"
                        >
                          {edge.from_table_name}
                          {' → '}
                          {edge.to_table_name}
                          <span className="text-muted-foreground/60">
                            {` (${edge.field_name}${edge.duplex ? ' · 双向' : ''})`}
                          </span>
                          {edge.same_base === false ? (
                            <span className="text-amber-600/90">
                              {` · ${t('home.assetBrowser.feishuReviewCrossBase', {
                                defaultValue: '跨 Base，将降级为文本',
                              })}`}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {(preview.warnings || []).length > 0 || degradedEdges.length > 0 ? (
                  <ul className="max-h-16 space-y-0.5 overflow-y-auto text-caption text-amber-700/90 dark:text-amber-400/90">
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                    {degradedEdges.map((edge) => (
                      <li key={`degraded:${edge.from_table_id}:${edge.field_name}:${edge.to_table_id}`}>
                        {t('home.assetBrowser.feishuReviewDegraded', {
                          from: edge.from_table_name,
                          field: edge.field_name,
                          to: edge.to_table_name,
                          defaultValue:
                            '「{{from}}」的「{{field}}」因未导入「{{to}}」将降级为文本',
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-body text-foreground/90">
                      {t('home.assetBrowser.feishuIncludeAttachments', {
                        defaultValue: '同步附件（较慢）',
                      })}
                    </p>
                    <p className="text-caption text-muted-foreground/60">
                      {t('home.assetBrowser.feishuIncludeAttachmentsHint', {
                        defaultValue: '默认关闭；开启后下载飞书文件并写入 TabTin 附件',
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={includeAttachments}
                    onCheckedChange={setIncludeAttachments}
                  />
                </label>
              </div>

              <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPhase('browsing')
                    setPreview(null)
                    setPendingDocs([])
                  }}
                >
                  {t('home.assetBrowser.feishuReviewBack', { defaultValue: '返回选表' })}
                </Button>
                <Button
                  type="button"
                  disabled={reviewImportCount === 0}
                  onClick={() => void handleConfirmImport()}
                >
                  {t('home.assetBrowser.feishuReviewConfirm', { defaultValue: '确认导入' })}
                  {reviewImportCount > 0 ? ` (${reviewImportCount})` : ''}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === 'error' ? (
            <div className="flex flex-col gap-4 py-6">
              <p className="text-body text-destructive">
                {errorMessage
                  || t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' })}
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common.cancel', { defaultValue: '取消' })}
                </Button>
                <Button type="button" onClick={() => void checkConnection()}>
                  {t('common.retry', { defaultValue: '重试' })}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>

    {disconnectConfirmOpen ? (
      <ConfirmDialog
        open
        onOpenChange={setDisconnectConfirmOpen}
        title={t('home.assetBrowser.feishuDisconnectConfirmTitle', {
          defaultValue: '断开我的飞书帐号？',
        })}
        description={t('home.assetBrowser.feishuDisconnectConfirmDesc', {
          defaultValue: '只会移除你的个人授权，不影响组织的企业应用配置和其他成员。',
        })}
        confirmText={t('home.assetBrowser.feishuDisconnect', { defaultValue: '断开我的飞书' })}
        variant="destructive"
        onConfirm={handleDisconnect}
        container={null}
        onPointerDownOutside={preventDialogDismissOnImportFloatPanel}
        onInteractOutside={preventDialogDismissOnImportFloatPanel}
        onFocusOutside={preventDialogDismissOnImportFloatPanel}
      />
    ) : null}

    {removeProviderConfirmOpen ? (
      <ConfirmDialog
        open
        onOpenChange={setRemoveProviderConfirmOpen}
        title={t('home.assetBrowser.feishuProviderRemoveConfirmTitle', {
          defaultValue: '移除企业自建应用？',
        })}
        description={t('home.assetBrowser.feishuProviderRemoveConfirmDesc', {
          defaultValue: '这会让当前组织所有成员的飞书授权失效。正在运行导入任务时无法移除。',
        })}
        confirmText={t('home.assetBrowser.feishuProviderRemove', {
          defaultValue: '移除企业应用',
        })}
        variant="destructive"
        onConfirm={handleRemoveProvider}
        container={null}
        onPointerDownOutside={preventDialogDismissOnImportFloatPanel}
        onInteractOutside={preventDialogDismissOnImportFloatPanel}
        onFocusOutside={preventDialogDismissOnImportFloatPanel}
      />
    ) : null}
    </>
  )
}
