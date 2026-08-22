import { useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import {
  Copy,
  FileText,
  ImageIcon,
  Upload,
  History,
  Loader2,
  MoreHorizontal,
  Search,
  Share2,
  Send,
  Pencil,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Separator,
  ShareDialog,
  Switch,
  cn,
} from '@tabtin/smartsheet-ui'
import { CollabStatusBadge, CollabConnectionStatus, CollabStatus } from '@tabtin/collab-core'
import type { ExportFormat, FontStyle } from '../api-client'
import type { SaveState } from '../useDocEditor'
import type { DocumentSyncState } from '../useDocEditor'
import { IMAGE_IMPORT_FILE_ACCEPT } from './import-file-utils'

export interface DocEditorToolbarProps {
  doc: {
    id?: string
    space_id?: string
    organization_id?: string
    title?: string
    font_style?: FontStyle
    is_full_width?: boolean
    properties?: Record<string, unknown>
  } | null
  saveState: string
  saveMessage?: string | null
  syncState?: DocumentSyncState
  wordCount: number
  showRevisions?: boolean
  exporting: boolean
  waitingForSave: boolean
  isOffline: boolean
  collabStatus?: CollabStatus | null
  /** Provider 连接生命周期；stuck-connecting 时显示「连接异常」并提供重连入口 */
  collabConnectionStatus?: string | null
  /** 手动重连（重建 Provider 保留 Y.Doc/IndexedDB） */
  onCollabReconnect?: () => void
  /** 当前用户是否可编辑文档；false 时「更多」菜单仅保留只读可用项（拷贝/导出）。缺省 true。 */
  canEdit?: boolean
  onToggleRevisions?: () => void
  onExport: (format: ExportFormat) => Promise<void>
  /** 切换正文字体（文档级，写入 font_style）。 */
  onSetFontStyle?: (style: FontStyle) => void
  /** 切换全宽展示（文档级，写入 is_full_width）。 */
  onToggleFullWidth?: () => void
  /** 切换小字号（文档级，写入 properties.small_text）。 */
  onToggleSmallText?: () => void
  /** 拷贝当前正文内容（Markdown）到剪贴板。 */
  onCopyContent?: () => void | Promise<void>
  /** 打开文件选择器前抓取光标位置，保证导入图片插在光标处。 */
  onPrepareImportImage?: () => void
  /** 导入图片，插入到准备时记录的光标位置。 */
  onImportFile?: (file: File) => void | Promise<void>
  /** 打开文档内查找浮层。 */
  onOpenFind?: () => void
  /** 公开分享 URL 前缀（如 https://app.example.com/shared/docs/），未提供则不生成可复制链接 */
  shareUrlPrefix?: string
  /**
   * 当前 organization id（用于 ShareDialog 搜索成员）。
   * 未提供时分享按钮仍然可见，但搜索会回退到 doc.organization_id（若有）。
   */
  organizationId?: string
  /**
   * D10: 当前用户是否能管理分享（owner/admin = true）。
   * 缺省 false：用户仍能打开对话框查看自己的协作者状态，但所有管理控件 readonly。
   */
  canManage?: boolean
  /** 宿主注入的在线人员区（「N 人在线」）；与 ShareDialog 权限语义分离 */
  onlinePresence?: ReactNode
  /** 打开「发送到私信」弹窗（由 Electron 宿主注入 SendToIMDialog）。 */
  onSendToIM?: () => void
  /** 仅查看角色申请编辑（由 Electron 宿主在 viewer 时注入）。 */
  onRequestEditAccess?: () => void
}

const saveStateColors: Record<SaveState, string> = {
  idle: 'text-muted-foreground',
  dirty: 'text-warning',
  saving: 'text-info',
  saved: 'text-success',
  error: 'text-destructive',
}

function saveIndicatorClass(saveState: string): string {
  if (
    saveState === 'idle' ||
    saveState === 'dirty' ||
    saveState === 'saving' ||
    saveState === 'saved' ||
    saveState === 'error'
  ) {
    return saveStateColors[saveState]
  }
  return 'text-muted-foreground'
}

function syncIndicatorClass(syncState: DocumentSyncState | undefined): string | null {
  if (syncState === 'synced' || !syncState) return null
  if (syncState === 'degraded') return 'text-warning'
  return 'text-info'
}

const collabStatusColors: Partial<Record<CollabStatus, string>> = {
  [CollabStatus.CONNECTING]: 'text-info',
  [CollabStatus.SYNCING]: 'text-info',
  [CollabStatus.SYNCED]: 'text-success',
  [CollabStatus.DISCONNECTED]: 'text-warning',
  [CollabStatus.FORCE_CLOSED]: 'text-destructive',
}

function collabStatusLabel(
  status: CollabStatus,
  tCommon: (key: string) => string,
): string {
  switch (status) {
    case CollabStatus.CONNECTING: return tCommon('collab.statusConnecting')
    case CollabStatus.SYNCING: return tCommon('collab.statusSyncing')
    case CollabStatus.SYNCED: return tCommon('collab.statusSynced')
    case CollabStatus.DISCONNECTED: return tCommon('collab.statusDisconnected')
    case CollabStatus.FORCE_CLOSED: return tCommon('collab.statusForceClosed')
    default: return ''
  }
}

export function DocEditorToolbar({
  doc,
  saveState,
  saveMessage,
  syncState,
  wordCount,
  showRevisions,
  exporting,
  waitingForSave,
  isOffline,
  collabStatus,
  collabConnectionStatus,
  onCollabReconnect,
  canEdit = true,
  onToggleRevisions,
  onExport,
  onSetFontStyle,
  onToggleFullWidth,
  onToggleSmallText,
  onCopyContent,
  onPrepareImportImage,
  onImportFile,
  onOpenFind,
  shareUrlPrefix,
  organizationId,
  canManage = false,
  onlinePresence,
  onSendToIM,
  onRequestEditAccess,
}: DocEditorToolbarProps) {
  const { t } = useTranslation('tabdoc')
  const { t: tCommon } = useTranslation('common')
  const indicatorClass = saveIndicatorClass(saveState)
  const syncClass = syncIndicatorClass(syncState)
  const importInputRef = useRef<HTMLInputElement>(null)
  const currentFontStyle: FontStyle = doc?.font_style ?? 'default'
  const isFullWidth = Boolean(doc?.is_full_width)
  const isSmallText = Boolean((doc?.properties as Record<string, unknown> | undefined)?.small_text)
  const fontOptions: { value: FontStyle; labelKey: string; previewClass: string }[] = [
    { value: 'default', labelKey: 'fontDefault', previewClass: 'font-sans' },
    { value: 'serif', labelKey: 'fontSerif', previewClass: 'font-serif' },
    { value: 'mono', labelKey: 'fontMono', previewClass: 'font-mono' },
  ]
  // 协作态下本地 autosave 链路不触发（saveState 恒为 idle），原「未修改」文字处改为
  // 反映协作同步状态（同步中/已同步…）；非协作态仍显示本地保存状态文案。
  const collabActive = collabStatus != null && collabStatus !== CollabStatus.INITIAL
  // ：挂起状态独立于 collabStatus（挂起降级后 collabStatus 会被置 null，
  // 但「连接异常 + 重连入口」必须保留）
  const collabStuck = collabConnectionStatus === CollabConnectionStatus.STUCK_CONNECTING

  const [showShareDialog, setShowShareDialog] = useState(false)
  const [importingFile, setImportingFile] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  /** Remount file input after each pick so a stuck `files` own-property (e.g. CDP probe) cannot poison later imports. */
  const [importInputKey, setImportInputKey] = useState(0)

  const effectiveOrganizationId = organizationId ?? doc?.organization_id ?? ''

  useLayoutEffect(() => {
    setMoreMenuOpen(false)
  }, [doc?.id])

  const resetImportInput = () => {
    const input = importInputRef.current
    if (!input) return
    input.value = ''
    // CDP/tests may Object.defineProperty(input, 'files', …); drop the own property so the next native pick works.
    try {
      Reflect.deleteProperty(input, 'files')
    } catch {
      // ignore
    }
    setImportInputKey((key) => key + 1)
  }

  const handleImportInputChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportingFile(true)
    try {
      await onImportFile?.(file)
    } catch (error) {
      console.error('[DocEditorToolbar] import file failed:', error)
    } finally {
      setImportingFile(false)
      resetImportInput()
    }
  }

  return (
    <>
      <div className="tabdoc-editor-toolbar flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="tabdoc-editor-toolbar-status flex min-w-0 items-center gap-2 text-body">
          <span
            className={`font-medium ${
              collabStuck
                ? 'text-destructive'
                : syncClass ?? (collabStatus != null && collabStatus !== CollabStatus.INITIAL
                  ? (collabStatusColors[collabStatus] ?? 'text-muted-foreground')
                  : indicatorClass)
            }`}
          >
            {collabStuck ? tCommon('collab.statusStuckConnecting')
              : syncState === 'recovering_legacy_draft' ? '正在恢复本地草稿'
              : syncState === 'degraded' ? '本地编辑正在安全保留'
              : syncState === 'awaiting_remote_apply' ? '同步中'
              : collabActive && collabStatus != null
              ? collabStatusLabel(collabStatus, tCommon)
              : (
                <>
                  {saveState === 'idle' && t('saveIdle')}
                  {saveState === 'dirty' && t('saveDirty')}
                  {saveState === 'saving' && t('saveSaving')}
                  {saveState === 'saved' && t('saveSaved')}
                  {saveState === 'error' && t('saveError')}
                </>
              )}
          </span>
          {saveMessage && <span className="text-muted-foreground">{saveMessage}</span>}
          {((collabStatus != null && collabStatus !== CollabStatus.INITIAL) || collabStuck) && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <CollabStatusBadge
                status={collabStatus ?? CollabStatus.CONNECTING}
                connectionStatus={collabStuck ? CollabConnectionStatus.STUCK_CONNECTING : undefined}
                onReconnect={onCollabReconnect}
                compact
                labels={{
                  [CollabStatus.INITIAL]: tCommon('collab.statusInitial'),
                  [CollabStatus.CONNECTING]: tCommon('collab.statusConnecting'),
                  [CollabStatus.SYNCING]: tCommon('collab.statusSyncing'),
                  [CollabStatus.SYNCED]: tCommon('collab.statusSynced'),
                  [CollabStatus.DISCONNECTED]: tCommon('collab.statusDisconnected'),
                  [CollabStatus.FORCE_CLOSED]: tCommon('collab.statusForceClosed'),
                }}
                stuckLabel={tCommon('collab.statusStuckConnecting')}
                reconnectHint={tCommon('collab.clickToReconnect')}
              />
            </>
          )}
        </div>

        <div className="tabdoc-editor-toolbar-actions flex shrink-0 items-center gap-1 text-body">
          {onlinePresence}
          {doc && (
            <span className="text-muted-foreground">
              {t('wordCount', { count: wordCount })}
            </span>
          )}

          <Separator orientation="vertical" className="mx-1 h-4" />

          <button
            type="button"
            disabled={!doc}
            onClick={() => onOpenFind?.()}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t('find.open')}
            aria-label={t('find.open')}
          >
            <Search className="h-3 w-3" />
          </button>

          <button
            type="button"
            onClick={() => onToggleRevisions?.()}
            className={`flex items-center gap-1 rounded px-1.5 py-1 ${
              showRevisions
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            title={t('toggleRevisions')}
          >
            <History className="h-3 w-3" />
          </button>

          {doc?.id && (
            <button
              type="button"
              onClick={() => setShowShareDialog(true)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('share', { defaultValue: '分享' })}
            >
              <Share2 className="h-3 w-3" />
            </button>
          )}

          {doc?.id && onSendToIM && (
            <button
              type="button"
              onClick={onSendToIM}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('sendToIM', { defaultValue: '发送到私信' })}
              aria-label={t('sendToIM', { defaultValue: '发送到私信' })}
            >
              <Send className="h-3 w-3" />
            </button>
          )}

          {doc?.id && onRequestEditAccess && (
            <button
              type="button"
              onClick={onRequestEditAccess}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-primary hover:bg-primary/10 hover:text-primary"
              title={t('requestEditAccess', { defaultValue: '申请编辑权限' })}
              aria-label={t('requestEditAccess', { defaultValue: '申请编辑权限' })}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}

          <DropdownMenu modal={false} open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!doc || importingFile}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                title={importingFile
                  ? t('menuImportingImage', { defaultValue: '导入图片中...' })
                  : t('more', { defaultValue: '更多' })}
                aria-busy={importingFile || undefined}
              >
                {importingFile ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-3 w-3" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="tabdoc-toolbar-dropdown-menu min-w-[240px]">
              {canEdit && (
                <>
                  <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                    {fontOptions.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => onSetFontStyle?.(opt.value)}
                        className={cn(
                          'flex flex-1 flex-col items-center gap-1 rounded-interactive border px-2 py-1.5 transition-colors',
                          currentFontStyle === opt.value
                            ? 'border-primary text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <span className={cn('text-title leading-none', opt.previewClass)}>Ag</span>
                        <span className="text-caption">{t(opt.labelKey)}</span>
                      </button>
                    ))}
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuItem className="text-body" onClick={() => void onCopyContent?.()}>
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                {t('copyContent')}
              </DropdownMenuItem>

              {canEdit && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="justify-between text-body"
                    onSelect={(e) => { e.preventDefault(); onToggleSmallText?.() }}
                  >
                    {t('smallText')}
                    <Switch checked={isSmallText} className="pointer-events-none ml-2" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="justify-between text-body"
                    onSelect={(e) => { e.preventDefault(); onToggleFullWidth?.() }}
                  >
                    {t('fullWidth')}
                    <Switch checked={isFullWidth} className="pointer-events-none ml-2" />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-body"
                    disabled={importingFile || !onImportFile}
                    onSelect={(e) => {
                      e.preventDefault()
                      if (importingFile) return
                      onPrepareImportImage?.()
                      importInputRef.current?.click()
                    }}
                  >
                    {importingFile ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {importingFile
                      ? t('menuImportingImage', { defaultValue: '导入图片中...' })
                      : t('menuImportImage', { defaultValue: '导入图片' })}
                  </DropdownMenuItem>
                </>
              )}

              {doc && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="text-body" disabled={exporting || waitingForSave}>
                      {exporting || waitingForSave ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {waitingForSave ? t('waitingForSave', { defaultValue: '等待保存完成…' }) : t('export')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="tabdoc-toolbar-dropdown-menu min-w-[180px]">
                      <DropdownMenuItem className="text-body font-medium" onClick={() => void onExport('docx')}>
                        <FileText className="h-3.5 w-3.5 text-info" />
                        {t('exportDocx')}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-body font-medium" onClick={() => void onExport('pdf')}>
                        <FileText className="h-3.5 w-3.5 text-info" />
                        {t('exportPdf')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-body" onClick={() => void onExport('markdown')}>
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('exportMarkdown')}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-body" onClick={() => void onExport('txt')}>
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('exportTxt')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-body" onClick={() => void onExport('html')}>
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('exportHtml')}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {canEdit && (
            <input
              key={importInputKey}
              ref={importInputRef}
              type="file"
              accept={IMAGE_IMPORT_FILE_ACCEPT}
              className="hidden"
              disabled={importingFile}
              onChange={(e) => void handleImportInputChange(e)}
            />
          )}
        </div>
      </div>

      {doc?.id && showShareDialog && (
        <ShareDialog
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          resourceType="doc"
          resourceId={doc.id}
          resourceTitle={doc.title || ''}
          organizationId={effectiveOrganizationId}
          shareUrlPrefix={shareUrlPrefix}
          canManage={canManage}
          t={(key, opts) => tCommon(key, opts) as string}
        />
      )}

      {isOffline && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-body text-warning">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
          {t('offlineBanner', { defaultValue: '网络已断开，编辑内容将在恢复连接后保存' })}
        </div>
      )}
    </>
  )
}
