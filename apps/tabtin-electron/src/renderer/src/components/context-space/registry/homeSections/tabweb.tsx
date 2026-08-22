/**
 * Browser App 的 Home Section —— 浏览器起始页
 *
 * 起始页聚焦三块内容，呈居中式排版（搜索引擎首页观感）：
 * - 居中的 URL/搜索输入框（使用用户选择的搜索引擎）
 * - 快捷入口（书签 / 浏览历史 / 下载管理）
 * - 浏览器设置（搜索引擎、主页、访问策略、凭证）
 *
 * 已打开标签由顶部 Tab 栏承载，起始页不再重复列出。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, ChevronDown, ChevronRight, Clock, Cookie, Download, Globe,
  Home, Plus, Power, Search, Shield, Star, X,
} from 'lucide-react'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceAppEnabled } from '@stores/useSpaceApps'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  useBrowserPrefsStore,
  SEARCH_ENGINES,
  ACCESS_POLICIES,
  type SearchEngineId,
  type AccessPolicyId,
} from '@stores/useBrowserPrefsStore'
import { normalizeBrowserAddressInput } from '@utils/browserAddressInput'
import { useBrowsingHistoryStore } from '@stores/useBrowsingHistoryStore'
import { contextRegistry } from '../instance'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { BrowserTabIcon } from '../handlers/browser'
import { TabWebCapabilityBanner } from '../../tabweb/TabWebCapabilityBanner'
import { useSpaceContextState } from '@components/context-space/SpaceContextAreaContext'
import { useIsRemoteViewer } from '../../hooks/useIsRemoteViewer'
import { RemoteAgentBanner } from '../../folder/RemoteAgentBanner'
import i18n from '@/i18n'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { activateBrowserView } from '@/services/browserViewActivation'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SettingsRowProps {
  icon: React.ReactNode
  label: string
  detail?: React.ReactNode
  rightElement?: React.ReactNode
  onClick?: () => void
}

const SettingsRow: React.FC<SettingsRowProps> = ({ icon, label, detail, rightElement, onClick }) => {
  const content = (
    <>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-body text-foreground/80">{label}</span>
      {detail && (
        <span className={cn('shrink-0', CANVAS_TEXT_META)}>{detail}</span>
      )}
      {rightElement && (
        <div className="shrink-0 ml-2" onClick={e => e.stopPropagation()}>
          {rightElement}
        </div>
      )}
    </>
  )

  const className = "flex w-full items-center gap-2.5 rounded-interactive px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] min-w-0 group"

  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
        className={cn(className, 'cursor-pointer')}
      >
        {content}
      </div>
    )
  }

  return (
    <div className={className}>
      {content}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search Engine Selector (Native Select)
// ---------------------------------------------------------------------------

const SearchEngineSelector: React.FC = () => {
  const searchEngine = useBrowserPrefsStore(s => s.searchEngine)
  const setSearchEngine = useBrowserPrefsStore(s => s.setSearchEngine)

  return (
    <Select
      value={searchEngine}
      onValueChange={value => setSearchEngine(value as SearchEngineId)}
    >
      <SelectTrigger className={cn('h-7', 'w-[120px]', 'bg-transparent', 'px-2', CANVAS_TEXT_META)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SEARCH_ENGINES.map(engine => (
          <SelectItem key={engine.id} value={engine.id}>
            {engine.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Access Policy Selector
// ---------------------------------------------------------------------------

const AccessPolicySelector: React.FC = () => {
  const { t } = useTranslation('context')
  const accessPolicy = useBrowserPrefsStore(s => s.accessPolicy)
  const setAccessPolicy = useBrowserPrefsStore(s => s.setAccessPolicy)

  return (
    <Select
      value={accessPolicy}
      onValueChange={value => setAccessPolicy(value as AccessPolicyId)}
    >
      <SelectTrigger className={cn('h-7', 'w-[120px]', 'bg-transparent', 'px-2', CANVAS_TEXT_META)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ACCESS_POLICIES.map(policy => (
          <SelectItem key={policy.id} value={policy.id}>
            {t(policy.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Homepage URL Editor
// ---------------------------------------------------------------------------

const HomepageEditor: React.FC = () => {
  const { t } = useTranslation('context')
  const homepageUrl = useBrowserPrefsStore(s => s.homepageUrl)
  const setHomepageUrl = useBrowserPrefsStore(s => s.setHomepageUrl)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(homepageUrl)

  const handleSave = useCallback(() => {
    setHomepageUrl(draft)
    setEditing(false)
  }, [draft, setHomepageUrl])

  if (!editing) {
    return (
      <SettingsRow
        icon={<Home className="h-4 w-4" />}
        label={t('home.browserHome.homepage')}
        detail={
          <span className="max-w-[120px] truncate">
            {homepageUrl || t('home.browserHome.homepageEmpty')}
          </span>
        }
        onClick={() => { setDraft(homepageUrl); setEditing(true) }}
      />
    )
  }

  return (
    <div className="mx-1 my-0.5 flex items-center gap-2 rounded-interactive bg-foreground/[0.025] px-2.5 py-1.5 transition-colors focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring dark:bg-foreground/[0.04]">
      <Home className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        className={cn('h-auto', 'min-w-0', 'flex-1', 'border-none', 'bg-transparent', 'p-0', 'text-foreground', 'outline-none', 'placeholder:text-muted-foreground/60', 'focus-visible:bg-transparent', 'focus-visible:ring-0', CANVAS_TEXT_META)}
        placeholder={t('home.browserHome.homepagePlaceholder')}
        value={draft}
        autoFocus
        onChange={e => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSave()
          if (e.key === 'Escape') {
            setDraft(homepageUrl)
            setEditing(false)
          }
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session List Section — 展示当前 Space 下的命名 Session（身份隔离）
// ---------------------------------------------------------------------------

const SessionListSection: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const [expandedSession, setExpandedSession] = useState<string | null>(null)

  const tabs = useCrawlTabStore(s => s.tabs)
  const sessionList = useMemo(() =>
    tabs
      .filter(
        tab =>
          tab.kind === 'workspace' &&
          tab.metadata?.crawlspaceConfig?.sessionName &&
          (tab.metadata?.crawlspaceConfig?.spaceId ?? tab.metadata?.crawlspaceConfig?.projectId) === spaceId
      )
      .map(tab => ({
        sessionName: tab.metadata?.crawlspaceConfig?.sessionName ?? '',
        crawlspaceId: tab.id,
        sessionColor: tab.metadata?.crawlspaceConfig?.sessionColor ?? '#6b7280',
      })),
    [tabs, spaceId],
  )

  const contextCache = useCrawlTabStore(s => s.crawlspaceContextCache)

  if (sessionList.length === 0) return null

  return (
    <div className="px-1">
      <span className={cn('font-medium', 'mb-2', 'block', 'px-1.5', CANVAS_TEXT_META)}>
        Session
      </span>
      <div className="flex flex-col gap-0.5">
        {sessionList.map(session => {
          const views = contextCache[session.crawlspaceId]?.viewList?.filter(v => !v.isClosing) ?? []
          const isExpanded = expandedSession === session.crawlspaceId

          return (
            <div key={session.crawlspaceId}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="group flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-interactive px-2.5 py-2 text-left font-normal whitespace-normal"
                onClick={() => setExpandedSession(isExpanded ? null : session.crawlspaceId)}
              >
                <span
                  className="shrink-0 rounded-full"
                  style={{ width: 8, height: 8, backgroundColor: session.sessionColor }}
                />
                <span className="flex-1 min-w-0 truncate text-body text-foreground/80">
                  {session.sessionName}
                </span>
                <span className={cn('shrink-0', CANVAS_TEXT_META)}>
                  {views.length}
                </span>
                {views.length > 0 && (
                  isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                )}
              </Button>
              {isExpanded && views.length > 0 && (
                <div className="ml-5 flex flex-col gap-0.5">
                  {views.map(view => (
                    <div
                      key={view.viewId}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-interactive min-w-0"
                    >
                      <BrowserTabIcon
                        favicon={view.favicon}
                        url={view.url}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className={cn('min-w-0', 'flex-1', 'truncate', 'text-foreground/80', CANVAS_TEXT_META)}>
                        {view.title || '新标签页'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Proxy Settings Section — 代理服务器配置
// ---------------------------------------------------------------------------

const ProxySettingsSection: React.FC = () => {
  const [expanded, setExpanded] = useState(false)
  const [proxyInput, setProxyInput] = useState('')

  const proxyList = useBrowserPrefsStore(s => s.proxyList)
  const addProxy = useBrowserPrefsStore(s => s.addProxy)
  const removeProxy = useBrowserPrefsStore(s => s.removeProxy)
  const toggleProxy = useBrowserPrefsStore(s => s.toggleProxy)

  const handleAddProxy = useCallback(() => {
    const trimmed = proxyInput.trim()
    if (!trimmed) return

    try {
      const url = new URL(trimmed)
      addProxy({
        server: `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`,
        username: url.username || undefined,
        password: url.password || undefined,
      })
      setProxyInput('')
    } catch {
      if (/^[\w.-]+:\d+$/.test(trimmed)) {
        addProxy({ server: `http://${trimmed}` })
        setProxyInput('')
      } else {
        toast({
          title: '代理格式不正确',
          description: '支持 http://host:port 或 http://user:pass@host:port',
          variant: 'destructive',
        })
      }
    }
  }, [proxyInput, addProxy])

  if (!expanded) {
    return (
      <SettingsRow
        icon={<Globe className="h-4 w-4" />}
        label="代理设置"
        detail={proxyList.length > 0 ? `${proxyList.length} 个代理` : undefined}
        onClick={() => setExpanded(true)}
      />
    )
  }

  return (
    <div className="my-0.5 rounded-interactive bg-foreground/[0.025] dark:bg-foreground/[0.04]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-interactive px-2.5 py-2 text-left font-normal whitespace-normal"
        onClick={() => setExpanded(false)}
      >
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 min-w-0 truncate text-body text-foreground/80">代理设置</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </Button>

      {proxyList.length > 0 && (
        <div className="flex flex-col gap-0.5 px-2 pb-1">
          {proxyList.map((proxy, idx) => (
            <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-interactive hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] min-w-0">
              <span className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                proxy.enabled ? 'bg-success' : 'bg-muted-foreground/60',
              )} />
              <span className={cn('flex-1', 'min-w-0', 'truncate', 'text-foreground/80', CANVAS_TEXT_META)}>
                {proxy.server}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 w-5 shrink-0 p-0 text-muted-foreground/60 hover:text-foreground"
                onClick={() => toggleProxy(idx)}
                title={proxy.enabled ? '禁用' : '启用'}
              >
                <Power className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 w-5 shrink-0 p-0 text-muted-foreground/60 hover:text-destructive"
                onClick={() => removeProxy(idx)}
                title="删除"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="px-2 pb-2">
        <div className="flex items-center gap-1.5">
          <Input
            className={cn('flex-1', 'min-w-0', 'h-7', 'px-2', 'bg-background/60', 'text-foreground', 'rounded-interactive', 'border-transparent', 'outline-none', 'placeholder:text-muted-foreground/60', 'focus:ring-1', 'focus:ring-inset', 'focus:ring-ring', 'transition-colors', CANVAS_TEXT_META)}
            placeholder="http://host:port"
            value={proxyInput}
            onChange={e => setProxyInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAddProxy() }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleAddProxy}
            disabled={!proxyInput.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className={cn('mt-1', 'px-0.5', CANVAS_TEXT_META)}>
          支持 http://host:port 或 http://user:pass@host:port
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick Access Card —— 起始页快捷入口（书签 / 历史 / 下载）
// ---------------------------------------------------------------------------

interface QuickAccessCardProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
}

const QuickAccessCard: React.FC<QuickAccessCardProps> = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="group flex flex-col items-center justify-center gap-2 rounded-[12px] bg-foreground/[0.03] px-3 py-5 text-center transition-colors hover:bg-foreground/[0.06] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
  >
    <span className="text-muted-foreground transition-colors group-hover:text-foreground">
      {icon}
    </span>
    <span className="text-body text-foreground/80 transition-colors group-hover:text-foreground">
      {label}
    </span>
  </button>
)

// ---------------------------------------------------------------------------
// BrowserSection (main component)
// ---------------------------------------------------------------------------

const BrowserSection: React.FC<HomeSectionProps> = ({
  spaceId,
}) => {
  const { t } = useTranslation('context')
  const isBrowserEnabled = useSpaceAppEnabled(spaceId, 'tabweb')
  const { isRemoteViewer, controlDeviceName, workingDir: remoteWorkingDir } = useIsRemoteViewer(spaceId)
  const [urlInput, setUrlInput] = useState('')
  const [isNavigating, setIsNavigating] = useState(false)
  const navigatingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 起始页搜索框直接发起导航，此时尚未挂载 EmbeddedCrawlView，需提前订阅导航事件
  useEffect(() => {
    useBrowsingHistoryStore.getState().initialize()
  }, [])

  const { tabScopeKey } = useSpaceContextState()
  const storageKey = tabScopeKey || spaceId
  const ensureScopedCrawlspace = useCrawlTabStore(s => s.ensureScopedCrawlspace)

  // ── Actions ──

  const handleNavigate = useCallback(async (url: string) => {
    if (!url.trim() || navigatingRef.current) return
    navigatingRef.current = true
    if (mountedRef.current) setIsNavigating(true)

    const currentEngine = useBrowserPrefsStore.getState().searchEngine
    const targetUrl = normalizeBrowserAddressInput(url, currentEngine)
    let nextKey: string | null = null
    const prevKey = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null

    try {
      const crawlspace = ensureScopedCrawlspace(spaceId, storageKey)
      const csId = crawlspace.id
      const ipcAdapter = createElectronIpcAdapter(csId, spaceId)
      const viewId = `view-${csId}-${Date.now()}`
      nextKey = contextRegistry.buildTabKey('tabweb', viewId)

      // 须在 createView 成功后再 setActiveKey：提前切换会让 RestoreCoord /
      // stale-active guard 看到「tabweb 尚无 live view」→ 回退 tabOrder[0]
      //（apphome:orchestration = Agent 起始页），表现为点「+」偶发跳到 Agent。
      const created = await ipcAdapter.createView(viewId, targetUrl)
      if (!created) {
        throw new Error(i18n.t('error.createWebTabFailed', { ns: 'context' }))
      }

      const result = await activateBrowserView(csId, viewId, {
        spaceId,
        selection: { tabScopeKey: storageKey, tabKey: nextKey },
      })
      if (!result.ok) {
        throw new Error(result.message || i18n.t('error.switchWebTabFailed', { ns: 'context' }))
      }
      if (result.code === 'cancelled') return
      useBrowsingHistoryStore.getState().recordVisit(targetUrl)

      if (mountedRef.current) setUrlInput('')
    } catch (error) {
      const currentKey = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
      if (nextKey && currentKey === nextKey) {
        useSpaceContextTabsStore.getState().setActiveKey(storageKey, prevKey)
      }
      toast({
        title: i18n.t('error.createWebTabFailed', { ns: 'context' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      navigatingRef.current = false
      if (mountedRef.current) setIsNavigating(false)
    }
  }, [ensureScopedCrawlspace, spaceId, storageKey])

  const handleOpenDownloads = useCallback(() => {
    useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
      type: 'tindownloads',
      id: 'downloads',
      title: t('home.browserHome.downloads'),
    })
  }, [storageKey, t])

  const handleOpenHistory = useCallback(() => {
    useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
      type: 'tinhistory',
      id: 'history',
      title: t('home.browserHome.history'),
    })
  }, [storageKey, t])

  const handleOpenBookmarks = useCallback(() => {
    useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
      type: 'tinbookmarks',
      id: 'bookmarks',
      title: t('home.browserHome.bookmarks'),
    })
  }, [storageKey, t])

  const handleOpenCredentials = useCallback(() => {
    useSettingsSpaceStore
      .getState()
      .openSettings({ category: 'device', section: 'credentials-browser' })
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && urlInput.trim()) {
      void handleNavigate(urlInput)
    }
  }, [handleNavigate, urlInput])

  // 遥控器视角（取向 B）：浏览器画面在 control_device 上,本机点开统一显示占位 banner,
  // 不再展示「本机」标签列表/设置入口（那不是远端 Agent 的浏览器）。与其它执行设备型 App 同形态。
  if (isRemoteViewer) {
    return (
      <RemoteAgentBanner
        controlDeviceName={controlDeviceName}
        workingDir={remoteWorkingDir ?? undefined}
        appLabel={t('remoteApp.tabweb', { ns: 'context', defaultValue: '浏览器' })}
      />
    )
  }

  return (
    <div className="relative h-full min-h-0 min-w-0 w-full">
      <div className="h-full min-h-0 min-w-0 w-full overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 pb-12 pt-16">
          {/* ── Hero：品牌标识 + 居中搜索 ── */}
          <div className="flex flex-col items-center gap-6">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-[12px] bg-foreground/[0.04] text-muted-foreground">
                <Globe className="h-7 w-7" />
              </div>
              <h1 className="text-title font-semibold text-foreground">
                {t('home.assetBrowser.browser')}
              </h1>
            </div>

            <div
              className={cn(
                'flex h-12 w-full max-w-xl items-center gap-2 rounded-full bg-foreground/[0.04] px-4 transition-colors focus-within:bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring',
                (!isBrowserEnabled || isNavigating) && 'pointer-events-none opacity-50',
              )}
            >
              <Search className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              <input
                type="text"
                className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0"
                placeholder={t('home.assetBrowser.browserUrlPlaceholder')}
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!isBrowserEnabled || isNavigating}
                spellCheck={false}
                autoComplete="off"
              />
              {urlInput.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => void handleNavigate(urlInput)}
                  disabled={!isBrowserEnabled || isNavigating}
                  title={t('home.assetBrowser.browserOpenUrl')}
                >
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* ── 快捷入口：书签 / 浏览历史 / 下载管理 ── */}
          <div className="flex flex-col gap-3">
            <span className={cn('px-1', 'font-medium', CANVAS_TEXT_META)}>
              {t('home.browserHome.quickActions')}
            </span>
            <div className="grid grid-cols-3 gap-3">
              <QuickAccessCard
                icon={<Star className="h-5 w-5" />}
                label={t('home.browserHome.bookmarks')}
                onClick={handleOpenBookmarks}
              />
              <QuickAccessCard
                icon={<Clock className="h-5 w-5" />}
                label={t('home.browserHome.history')}
                onClick={handleOpenHistory}
              />
              <QuickAccessCard
                icon={<Download className="h-5 w-5" />}
                label={t('home.browserHome.downloads')}
                onClick={handleOpenDownloads}
              />
            </div>
          </div>

          {/* ── 命名 Session（仅在存在时展示） ── */}
          <SessionListSection spaceId={spaceId} />

          {/* ── 浏览器设置 ── */}
          <div className="flex flex-col gap-2">
            <span className={cn('px-1', 'font-medium', CANVAS_TEXT_META)}>
              {t('home.browserHome.settings')}
            </span>
            <div className="flex flex-col gap-0.5">
              <SettingsRow
                icon={<Search className="h-4 w-4" />}
                label={t('home.browserHome.searchEngine')}
                rightElement={<SearchEngineSelector />}
              />
              <HomepageEditor />
              <SettingsRow
                icon={<Shield className="h-4 w-4" />}
                label={t('home.browserHome.accessPolicy')}
                rightElement={<AccessPolicySelector />}
              />
              <SettingsRow
                icon={<Cookie className="h-4 w-4" />}
                label={t('home.browserHome.credentialSettings')}
                onClick={handleOpenCredentials}
              />
            </div>
          </div>
        </div>
      </div>

      <TabWebCapabilityBanner spaceId={spaceId} />
    </div>
  )
}

export const tabwebHomeSection: HomeSectionHandler = {
  appId: 'tabweb',
  labelKey: 'home.assetBrowser.browser',
  Component: BrowserSection,
}
