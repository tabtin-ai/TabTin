import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Globe2,
  ExternalLink,
  Upload,
  History,
  Copy,
  Loader2,
  Code2,
  RefreshCw,
  Monitor,
  Smartphone,
  FolderOpen,
  Sparkles,
  RotateCcw,
  Archive,
  Play,
  Square,
  Settings,
} from 'lucide-react'
import {
  Button, Separator, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, toast,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Input, Label,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { onResourceEvent } from '@/stores/useUnifiedResources'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
const SiteSettingsPanel = React.lazy(() => import('./SiteSettingsPanel'))

interface TabSitePaneHostProps {
  resourceId: string
  spaceId: string | null
}

function SiteTooltip({
  content,
  side = 'top',
  children,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface SiteVersion {
  version: number
  message: string
  dist_url: string
  is_current: boolean
  created_at: string
}

interface SiteData {
  id: string
  name: string
  slug: string
  description: string
  status: string
  framework: string
  published_url: string
  current_version: number
  dist_oss_url: string
  total_views: number
  is_public: boolean
  code_project_path: string
  versions: SiteVersion[]
}

const TabSitePaneHost: React.FC<TabSitePaneHostProps> = ({
  resourceId,
  spaceId,
}) => {
  const { t } = useTranslation('tabsite')
  const [site, setSite] = useState<SiteData | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')
  const [initializing, setInitializing] = useState(false)
  const isArchived = site?.status === 'archived'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    import('@/services/api')
      .then(({ apiService }) =>
        apiService.request<SiteData>({ method: 'GET', url: `/tabsite/sites/${resourceId}/` }),
      )
      .then((data) => {
        if (!cancelled && data) {
          setSite(data)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[TabSitePaneHost] fetch site failed:', err)
          toast({
            title: t('error.loadFailed', { defaultValue: '站点加载失败' }),
            description: err instanceof Error ? err.message : String(err),
            variant: 'destructive',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [resourceId])

  const copyUrl = useCallback(() => {
    if (site?.published_url) {
      navigator.clipboard.writeText(site.published_url).then(() => {
        toast({ title: t('actions.urlCopied', { defaultValue: '链接已复制' }) })
      })
    }
  }, [site?.published_url, t])

  // 单根契约下 TabSite 已下架（见 single-root-space-prd.md §2.6 C 方案）；
  // 这条 openInTabCode 跨 root 跳转仅作为代码壳保留，运行时不会被触发
  // （context-space registry / Quick Actions 都已 hide tabsite）。
  // commit 5 顺手清掉对 useTabCodeStore.addRecentProject 的依赖（已删字段）。
  const openInTabCode = useCallback(async () => {
    if (!site?.code_project_path || !spaceId) return
    const localPath = site.code_project_path
    const id = btoa(unescape(encodeURIComponent(localPath)))
    const title = localPath.split('/').filter(Boolean).pop() || 'Code'
    const { useSpaceContextTabsStore } = await import('@stores/useSpaceContextTabsStore')
    useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(spaceId), {
      type: 'tabcode',
      id,
      title,
      meta: { path: localPath, spaceId },
    })
  }, [site?.code_project_path, spaceId])

  const refreshingRef = useRef(false)
  const refreshSite = useCallback(() => {
    if (!resourceId || refreshingRef.current) return
    refreshingRef.current = true
    setLoading(true)
    import('@/services/api')
      .then(({ apiService }) => apiService.request<SiteData>({ method: 'GET', url: `/tabsite/sites/${resourceId}/` }))
      .then((data) => { if (data) setSite(data) })
      .catch((err) => console.error('[TabSitePaneHost] refresh failed:', err))
      .finally(() => { setLoading(false); refreshingRef.current = false })
  }, [resourceId])

  useEffect(() => {
    const unsub = onResourceEvent('tabsite', (event) => {
      if (event.resource_id === resourceId) refreshSite()
    }, { spaceId: spaceId || undefined })
    return unsub
  }, [resourceId, spaceId, refreshSite])

  // ── Dev server state ──
  const [devServerUrl, setDevServerUrl] = useState<string | null>(null)
  const [devServerStarting, setDevServerStarting] = useState(false)
  const devServerCheckedRef = useRef(false)

  useEffect(() => {
    if (!resourceId || devServerCheckedRef.current) return
    devServerCheckedRef.current = true
    window.tabtin?.tabsite?.getDevServerStatus(resourceId).then((status) => {
      if (status?.running && status.url) {
        setDevServerUrl(status.url)
      }
    }).catch(() => {})
  }, [resourceId])

  const handleStartDevServer = useCallback(async () => {
    if (!resourceId || !site?.code_project_path || devServerStarting) return
    setDevServerStarting(true)
    try {
      const result = await window.tabtin?.tabsite?.startDevServer(resourceId, site.code_project_path)
      if (result?.success && result.url) {
        setDevServerUrl(result.url)
        if (result.already_running) {
          toast({ title: t('preview.devServerAlreadyRunning', { defaultValue: 'Dev server 已在运行' }) })
        } else {
          toast({ title: t('preview.devServerStarted', { defaultValue: 'Dev server 已启动' }) })
        }
      } else {
        toast({
          title: t('preview.devServerFailed', { defaultValue: 'Dev server 启动失败' }),
          description: result?.error,
          variant: 'destructive',
        })
      }
    } catch (err: any) {
      toast({
        title: t('preview.devServerFailed', { defaultValue: 'Dev server 启动失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setDevServerStarting(false)
    }
  }, [resourceId, site?.code_project_path, devServerStarting, t])

  const handleStopDevServer = useCallback(async () => {
    if (!resourceId) return
    await window.tabtin?.tabsite?.stopDevServer(resourceId)
    setDevServerUrl(null)
    toast({ title: t('preview.devServerStopped', { defaultValue: 'Dev server 已停止' }) })
  }, [resourceId, t])

  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishMessage, setPublishMessage] = useState('')
  const [publishing, setPublishing] = useState(false)
  const publishInputRef = useRef<HTMLInputElement>(null)

  const openPublishDialog = useCallback(() => {
    if (!resourceId || !site || isArchived) return
    if (!site.dist_oss_url) {
      toast({
        title: t('error.noDistUrl', { defaultValue: '请先构建并上传产物' }),
        description: t('error.noDistUrlHint', { defaultValue: '在 TabCode 中执行 build，或使用 CLI: tabtin site build' }),
        variant: 'destructive',
      })
      return
    }
    setPublishMessage(`v${site.current_version + 1}`)
    setPublishDialogOpen(true)
    setTimeout(() => publishInputRef.current?.select(), 50)
  }, [resourceId, site, isArchived, t])

  const confirmPublish = useCallback(async () => {
    if (!resourceId || !site?.dist_oss_url || publishing) return
    setPublishing(true)
    try {
      await import('@/services/api').then(({ apiService }) =>
        apiService.request({
          method: 'POST',
          url: `/tabsite/sites/${resourceId}/publish/`,
          data: { message: publishMessage || `v${site.current_version + 1}`, dist_url: site.dist_oss_url },
        }),
      )
      toast({ title: t('actions.publishSuccess', { defaultValue: '发布成功' }) })
      setPublishDialogOpen(false)
      refreshSite()
    } catch (err: any) {
      console.error('[TabSitePaneHost] publish failed:', err)
      toast({
        title: t('error.publishFailed', { defaultValue: '发布失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }, [resourceId, site, publishMessage, publishing, refreshSite, t])

  const handleInitTemplate = useCallback(async () => {
    if (!resourceId || !spaceId || initializing) return
    setInitializing(true)
    try {
      const result = await window.tabtin?.tabsite?.initTemplate(resourceId, spaceId)
      if (result?.success) {
        toast({ title: t('guide.initSuccess', { defaultValue: '项目初始化成功' }) })

        // TC-003: Token 配置失败时向用户展示明确警告
        if (result.token_warning) {
          toast({
            title: t('guide.tokenWarning', { defaultValue: 'Token 配置异常' }),
            description: result.token_warning,
            variant: 'destructive',
          })
        }

        // TC-008: Token 即将过期预警
        if (result.token_expires_soon) {
          toast({
            title: t('guide.tokenExpiresSoon', { defaultValue: 'Token 即将过期' }),
            description: t('guide.tokenExpiresSoonHint', { defaultValue: '站点数据 Token 将在 30 天内过期，建议重新初始化以刷新 Token' }),
          })
        }

        refreshSite()
      } else {
        toast({
          title: t('guide.initFailed', { defaultValue: '初始化失败' }),
          description: result?.error,
          variant: 'destructive',
        })
      }
    } catch (err: any) {
      console.error('[TabSitePaneHost] initTemplate failed:', err)
      toast({
        title: t('guide.initFailed', { defaultValue: '初始化失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setInitializing(false)
    }
  }, [resourceId, spaceId, initializing, refreshSite, t])

  const handleLinkDirectory = useCallback(async () => {
    if (!resourceId) return
    try {
      const paths = await window.tabtin?.showOpenDialog({
        properties: ['openDirectory'],
      })
      if (!paths || paths.length === 0) return
      const dirPath = paths[0]
      const dirResult = await window.tabtin?.fileSystem?.readDir(dirPath)
      const hasPackageJson = dirResult?.entries?.some((e: { name: string }) => e.name === 'package.json') || false
      if (!hasPackageJson) {
        toast({
          title: t('guide.linkWarning', { defaultValue: '目录中未找到 package.json' }),
          description: t('guide.linkWarningHint', { defaultValue: '关联后可能无法正常构建，确认这是正确的项目目录' }),
        })
      }
      const { apiService } = await import('@/services/api')
      await apiService.request({
        method: 'PATCH',
        url: `/tabsite/sites/${resourceId}/`,
        data: { code_project_path: dirPath },
      })
      toast({ title: t('guide.linkSuccess', { defaultValue: '目录已关联' }) })
      refreshSite()
    } catch (err: any) {
      console.error('[TabSitePaneHost] linkDirectory failed:', err)
      toast({
        title: t('guide.linkFailed', { defaultValue: '关联失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    }
  }, [resourceId, refreshSite, t])

  const [sidebarTab, setSidebarTab] = useState<'info' | 'settings'>('info')
  const [rollingBack, setRollingBack] = useState<number | null>(null)

  const handleRollback = useCallback(async (versionNum: number) => {
    if (!resourceId || rollingBack !== null || isArchived) return
    setRollingBack(versionNum)
    try {
      await import('@/services/api').then(({ apiService }) =>
        apiService.request({
          method: 'POST',
          url: `/tabsite/sites/${resourceId}/rollback/${versionNum}/`,
        }),
      )
      toast({ title: t('version.rollbackSuccess', { defaultValue: `已回滚到 v${versionNum}` }) })
      refreshSite()
    } catch (err: any) {
      console.error('[TabSitePaneHost] rollback failed:', err)
      toast({
        title: t('version.rollbackFailed', { defaultValue: '回滚失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setRollingBack(null)
    }
  }, [resourceId, rollingBack, isArchived, refreshSite, t])

  if (loading && !site) {
    return <PaneLoadingSkeleton />
  }

  if (!site) {
    return (
      <div className="flex h-full w-full items-center justify-center text-body text-muted-foreground">
        {t('error.siteNotFound', { defaultValue: '站点未找到' })}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Globe2 className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-body font-semibold">{site.name}</h2>
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <span
                className={`rounded-full px-1.5 py-0.5 text-caption font-medium ${
                  isArchived
                    ? 'bg-destructive/10 text-destructive'
                    : site.status === 'published'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {isArchived
                  ? t('status.archived', { defaultValue: '已归档' })
                  : site.status === 'published'
                    ? t('status.published', { defaultValue: '已发布' })
                    : t('status.draft', { defaultValue: '草稿' })}
              </span>
              {site.current_version > 0 && <span>v{site.current_version}</span>}
              <span>&middot;</span>
              <span>
                {t('stats.views', {
                  count: site.total_views,
                  defaultValue: `${site.total_views} 次访问`,
                })}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {site.published_url && (
            <SiteTooltip content={t('actions.copyUrl', { defaultValue: '复制链接' })} side="bottom">
              <Button variant="ghost" size="sm" onClick={copyUrl}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </SiteTooltip>
          )}
          {site.published_url && (
            // W8 L29 / L77：发布链接走 ResourceRouter（D1 一视同仁）
            <Button variant="ghost" size="sm" asChild>
              <a
                href={site.published_url}
                onClick={(e) => handleResourceLinkClick(e, site.published_url!)}
                onContextMenu={(e) => handleResourceLinkContextMenu(e, site.published_url!)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {site.code_project_path && (
            <Button variant="outline" size="sm" onClick={openInTabCode}>
              <Code2 className="mr-1.5 h-3.5 w-3.5" />
              {t('actions.editCode', { defaultValue: '编辑代码' })}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={refreshSite}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button variant="default" size="sm" onClick={openPublishDialog} disabled={isArchived}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {t('actions.newVersion', { defaultValue: '创建新版本' })}
          </Button>
        </div>
      </div>

      {/* 归档提示横幅 */}
      {isArchived && (
        <div className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-body text-destructive">
          <Archive className="h-4 w-4 shrink-0" />
          {t('status.archivedBanner', { defaultValue: '此站点已归档，无法执行发布或回滚操作' })}
        </div>
      )}

      {/* 主体：预览 + 侧栏 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 预览区 */}
        <div className="flex flex-1 flex-col bg-muted/30">
          <div className="flex items-center justify-between border-b px-4 py-1.5">
            <div className="flex items-center gap-1">
              <SiteTooltip content={t('preview.desktop', { defaultValue: '桌面预览' })} side="bottom">
                <Button
                  variant={previewMode === 'desktop' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setPreviewMode('desktop')}
                >
                  <Monitor className="h-3.5 w-3.5" />
                </Button>
              </SiteTooltip>
              <SiteTooltip content={t('preview.mobile', { defaultValue: '移动端预览' })} side="bottom">
                <Button
                  variant={previewMode === 'mobile' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setPreviewMode('mobile')}
                >
                  <Smartphone className="h-3.5 w-3.5" />
                </Button>
              </SiteTooltip>
            </div>
            {site.code_project_path && !isArchived && (
              <div className="flex items-center gap-1">
                {devServerUrl ? (
                  <>
                    <span className="flex items-center gap-1 text-caption text-emerald-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {t('preview.devRunning', { defaultValue: 'Dev Server' })}
                    </span>
                    <SiteTooltip content={t('preview.stopDev', { defaultValue: '停止预览服务器' })} side="bottom">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={handleStopDevServer}
                      >
                        <Square className="h-3 w-3" />
                      </Button>
                    </SiteTooltip>
                  </>
                ) : !site.dist_oss_url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-caption"
                    onClick={handleStartDevServer}
                    disabled={devServerStarting}
                  >
                    {devServerStarting
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Play className="h-3 w-3" />}
                    {t('preview.startDev', { defaultValue: '启动预览' })}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <div className="flex-1 p-4">
          <div
            className="mx-auto h-full overflow-hidden rounded-lg border bg-background shadow-sm"
            style={{ maxWidth: previewMode === 'mobile' ? '375px' : '100%' }}
          >
            {isArchived ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Archive className="h-16 w-16 opacity-15" />
                <p className="text-subtitle font-medium text-foreground">
                  {t('status.archivedPreview', { defaultValue: '站点已归档' })}
                </p>
                <p className="text-body">
                  {t('status.archivedPreviewHint', { defaultValue: '归档站点不可预览，如需恢复请在右侧「设置」中操作' })}
                </p>
              </div>
            ) : !site.code_project_path ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-muted-foreground">
                <Globe2 className="h-16 w-16 opacity-15" />
                <div className="text-center">
                  <p className="text-subtitle font-medium text-foreground">
                    {t('guide.initTitle', { defaultValue: '站点项目未初始化' })}
                  </p>
                  <p className="mt-1 text-body">
                    {t('guide.initDescription', { defaultValue: '初始化模板项目后即可在 TabCode 中编辑代码' })}
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <Button onClick={handleInitTemplate} disabled={initializing}>
                    {initializing
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Sparkles className="mr-2 h-4 w-4" />}
                    {t('guide.initButton', { defaultValue: '初始化项目' })}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleLinkDirectory}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5" />
                    {t('guide.linkButton', { defaultValue: '关联已有目录' })}
                  </Button>
                </div>
              </div>
            ) : site.dist_oss_url ? (
              <iframe
                src={site.dist_oss_url.replace(/\/$/, '') + '/index.html'}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-popups allow-forms"
                title={site.name}
              />
            ) : devServerUrl ? (
              <iframe
                src={devServerUrl}
                className="h-full w-full border-0"
                title={`${site.name} (dev)`}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Globe2 className="h-12 w-12 opacity-20" />
                <p className="text-body">
                  {t('preview.empty', { defaultValue: '暂无预览' })}
                </p>
                <p className="text-caption text-muted-foreground/60">
                  {t('preview.emptyHint', { defaultValue: '启动预览服务器查看实时效果，或构建发布后查看' })}
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleStartDevServer} disabled={devServerStarting}>
                    {devServerStarting
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <Play className="mr-1.5 h-3.5 w-3.5" />}
                    {t('preview.startDev', { defaultValue: '启动预览' })}
                  </Button>
                  <Button variant="outline" size="sm" onClick={openInTabCode}>
                    <Code2 className="mr-1.5 h-3.5 w-3.5" />
                    {t('actions.buildInTabCode', { defaultValue: '在 TabCode 中构建' })}
                  </Button>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* 侧栏 */}
        <div className="w-72 shrink-0 overflow-y-auto border-l">
          {/* 侧栏 Tab 切换 */}
          <div className="flex border-b">
            <button
              className={`flex-1 px-3 py-2 text-caption font-medium transition-colors ${
                sidebarTab === 'info'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setSidebarTab('info')}
            >
              <History className="mr-1 inline h-3 w-3" />
              {t('sidebar.info', { defaultValue: '信息' })}
            </button>
            <button
              className={`flex-1 px-3 py-2 text-caption font-medium transition-colors ${
                sidebarTab === 'settings'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setSidebarTab('settings')}
            >
              <Settings className="mr-1 inline h-3 w-3" />
              {t('sidebar.settings', { defaultValue: '设置' })}
            </button>
          </div>

          <div className="p-4">
            {sidebarTab === 'info' ? (
              <>
                {/* 站点信息 */}
                <div className="space-y-3">
                  {site.published_url && (
                    <div>
                      <div className="text-body text-muted-foreground">
                        {t('sidebar.url', { defaultValue: '访问地址' })}
                      </div>
                      <a
                        href={site.published_url}
                        onClick={(e) => handleResourceLinkClick(e, site.published_url!)}
                        onContextMenu={(e) => handleResourceLinkContextMenu(e, site.published_url!)}
                        className="break-all text-body text-primary hover:underline"
                      >
                        {site.published_url}
                      </a>
                    </div>
                  )}
                  <div>
                    <div className="text-body text-muted-foreground">
                      {t('sidebar.framework', { defaultValue: '技术栈' })}
                    </div>
                    <div className="text-body">
                      {site.framework === 'react' ? 'React + Vite' : 'HTML'}
                    </div>
                  </div>
                  <div>
                    <div className="text-body text-muted-foreground">
                      {t('sidebar.visibility', { defaultValue: '可见性' })}
                    </div>
                    <div className="text-body">
                      {site.is_public
                        ? t('sidebar.public', { defaultValue: '公开' })
                        : t('sidebar.private', { defaultValue: '私有' })}
                    </div>
                  </div>
                </div>

                <Separator className="my-4" />

                {/* 版本记录 */}
                <div className="space-y-2">
                  <h3 className="text-body font-medium uppercase text-muted-foreground">
                    <History className="mr-1 inline h-3 w-3" />
                    {t('sidebar.versions', { defaultValue: '版本记录' })}
                  </h3>
                  {site.versions.length === 0 ? (
                    <p className="text-body text-muted-foreground">
                      {t('sidebar.noVersions', { defaultValue: '尚未发布过' })}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {site.versions.map((v) => (
                        <div key={v.version} className="rounded-md border p-2">
                          <div className="flex items-center justify-between">
                            <span className="text-body font-medium">v{v.version}</span>
                            <div className="flex items-center gap-1">
                              {v.is_current ? (
                                <span className="rounded-full border px-1.5 py-0.5 text-caption font-medium text-muted-foreground">
                                  {t('version.current', { defaultValue: '当前' })}
                                </span>
                              ) : (
                                <SiteTooltip content={isArchived ? t('status.archivedAction', { defaultValue: '已归档站点不可操作' }) : t('version.rollback', { defaultValue: '回滚到此版本' })} side="left">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                    disabled={rollingBack !== null || isArchived}
                                    onClick={() => handleRollback(v.version)}
                                  >
                                    {rollingBack === v.version
                                      ? <Loader2 className="h-3 w-3 animate-spin" />
                                      : <RotateCcw className="h-3 w-3" />}
                                  </Button>
                                </SiteTooltip>
                              )}
                            </div>
                          </div>
                          {v.message && (
                            <p className="mt-0.5 text-body text-muted-foreground">
                              {v.message}
                            </p>
                          )}
                          <p className="mt-0.5 text-caption text-muted-foreground">
                            {new Date(v.created_at).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <React.Suspense fallback={<div className="py-4 text-center text-body text-muted-foreground">...</div>}>
                <SiteSettingsPanel
                  site={{
                    id: site.id,
                    name: site.name,
                    slug: site.slug,
                    is_public: site.is_public,
                    custom_domain: (site as any).custom_domain || '',
                    status: site.status,
                    password_protected: (site as any).password_protected || false,
                  }}
                  onUpdate={refreshSite}
                />
              </React.Suspense>
            )}
          </div>
        </div>
      </div>

      {/* 发布确认弹窗 */}
      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('publish.dialogTitle', { defaultValue: '创建新版本（当前产物）' })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="publish-message">
                {t('publish.messageLabel', { defaultValue: '版本说明' })}
              </Label>
              <Input
                ref={publishInputRef}
                id="publish-message"
                value={publishMessage}
                onChange={(e) => setPublishMessage(e.target.value)}
                placeholder={t('publish.messagePlaceholder', { defaultValue: '描述本次发布的变更' })}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) confirmPublish() }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishDialogOpen(false)} disabled={publishing}>
              {t('dialog.cancel', { defaultValue: '取消' })}
            </Button>
            <Button onClick={confirmPublish} disabled={publishing}>
              {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('actions.publish', { defaultValue: '发布' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default TabSitePaneHost
