import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import {
  configureDocEditorHost,
  createAutoSaveController,
  markdownToPlaintext,
  markdownToPmJson,
  registerProbeIntent,
  unregisterProbeIntent,
  resetDocEditorHost,
  type AutoSaveController,
  type DocumentContentDraft,
  type DocumentSavePayload,
  type DocumentSaveResult,
  type AutoSaveConflictResolution,
} from '@tabtin/doc-editor'
import { saveDraft, loadDraft, deleteDraft, cleanupExpiredDrafts } from './utils/offlineCache'
import {
  getDocument,
  createRecoveryDraft,
  saveContent,
  type TabdocContent,
  type TabdocDocument,
  type TabdocRevision,
} from './api-client'
import { mergeDocumentPreservingRole } from './mergeDocumentPreservingRole'
import {
  assessDocumentContentBudget,
  formatDocumentContentBudgetError,
} from './documentContentBudget'
import { useAppHostClient } from '@tabtin/app-host-sdk'

/**
 * E2E-9: 检测内容是否为 HTML 格式（而非 Markdown）
 * 当历史恢复返回的 description_markdown 实际包含 HTML 时需要转换
 */
function looksLikeHtml(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (/^<(!DOCTYPE|html|body|div|p|h[1-6]|ul|ol|blockquote|table|pre)\b/i.test(trimmed)) {
    return true
  }
  // BIZ-012 fix: 先移除代码块内容再统计 HTML 标签，避免技术文档被误判
  const withoutCodeBlocks = trimmed
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
  const blockTagCount = (withoutCodeBlocks.match(/<\/(p|div|h[1-6]|ul|ol|li|blockquote|table|tr|td|th|pre|br\s*\/?)>/gi) || []).length
  return blockTagCount >= 3
}

/**
 * E2E-9: 将 HTML 内容转换为 Markdown（基础转换，覆盖常见标签）
 * 运行在浏览器环境，使用 DOMParser
 */
function htmlToMarkdown(html: string): string {
  if (typeof DOMParser === 'undefined') return html

  const doc = new DOMParser().parseFromString(html, 'text/html')

  function convertNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? ''
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''

    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const childContent = Array.from(el.childNodes).map(convertNode).join('')

    switch (tag) {
      case 'h1': return `# ${childContent.trim()}\n\n`
      case 'h2': return `## ${childContent.trim()}\n\n`
      case 'h3': return `### ${childContent.trim()}\n\n`
      case 'h4': return `#### ${childContent.trim()}\n\n`
      case 'h5': return `##### ${childContent.trim()}\n\n`
      case 'h6': return `###### ${childContent.trim()}\n\n`
      case 'p': return `${childContent.trim()}\n\n`
      case 'br': return '\n'
      case 'strong':
      case 'b': return `**${childContent}**`
      case 'em':
      case 'i': return `*${childContent}*`
      case 'code': return `\`${childContent}\``
      case 'pre': {
        const codeEl = el.querySelector('code')
        const codeText = codeEl ? (codeEl.textContent ?? '') : childContent
        return `\`\`\`\n${codeText.trim()}\n\`\`\`\n\n`
      }
      case 'blockquote': return childContent.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n'
      case 'ul':
      case 'ol': return `${childContent}\n`
      case 'li': {
        const parent = el.parentElement?.tagName.toLowerCase()
        const prefix = parent === 'ol'
          ? `${Array.from(el.parentElement!.children).indexOf(el) + 1}. `
          : '- '
        return `${prefix}${childContent.trim()}\n`
      }
      case 'a': {
        const href = el.getAttribute('href')
        return href ? `[${childContent}](${href})` : childContent
      }
      case 'img': {
        const src = el.getAttribute('src')
        const alt = el.getAttribute('alt') ?? ''
        return src ? `![${alt}](${src})` : ''
      }
      case 'hr': return '---\n\n'
      case 'table':
      case 'thead':
      case 'tbody':
      case 'tfoot': return childContent
      case 'tr': {
        const cells = Array.from(el.children).map(td => convertNode(td).trim())
        return `| ${cells.join(' | ')} |\n`
      }
      case 'th':
      case 'td': return childContent
      case 'del':
      case 's': return `~~${childContent}~~`
      default: return childContent
    }
  }

  const body = doc.body
  const result = Array.from(body.childNodes).map(convertNode).join('')
  // 清理多余空行
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
export type DocumentSyncState = 'synced' | 'awaiting_remote_apply' | 'recovering_legacy_draft' | 'degraded'
export type DocumentLoadErrorKind = 'unauthorized' | 'permission_denied' | 'not_found' | 'unknown'

export interface UseDocEditorInput {
  documentId: string | null
}

export interface UseDocEditorReturn {
  currentDocument: TabdocDocument | null
  currentRevision: TabdocRevision | null
  saveState: SaveState
  saveMessage: string
  syncState: DocumentSyncState
  isLoadingDetail: boolean
  initialPmJson: Record<string, unknown>
  initialMarkdown: string
  editorKey: number
  draftRef: React.RefObject<DocumentContentDraft>
  baseVersionRef: React.RefObject<number | null>
  baseUpdatedAtRef: React.RefObject<string | null>
  activeDocumentIdRef: React.RefObject<string | null>
  autoSaveControllerRef: React.RefObject<AutoSaveController | null>
  handleEditorUpdate: (markdown: string, pmJson: Record<string, unknown>) => void
  /** UI-2: 仅更新 draftRef（不触发自动保存），用于协作模式下 runtime monitor 采样 */
  updateDraftOnly: (markdown: string, pmJson: Record<string, unknown>) => void
  manualSave: () => Promise<void>
  patchCurrentDocument: (updates: Partial<TabdocDocument>) => void
  /** E2E-6: 加载失败时的错误信息 */
  loadError: string | null
  /** 加载错误的稳定分类；宿主据此选择权限页、失效页或通用错误页。 */
  loadErrorKind?: DocumentLoadErrorKind | null
  /** E2E-6: 重试加载文档（也用于版本恢复后重新加载文档内容） */
  retryLoad: () => void
  /** Preserve a divergent legacy draft, then apply the authoritative document. */
  recoverFromExternalUpdate: () => Promise<AutoSaveConflictResolution>
  markAwaitingRemoteApply: () => void
  markDocumentSynced: () => void
}

type TabDocTranslate = (key: string, options?: Record<string, unknown>) => string

interface LoadErrorLike {
  status?: number
  statusCode?: number
  code?: string
  errorCode?: string
  message?: string
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const err = error as LoadErrorLike
  return err.status ?? err.statusCode
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const err = error as LoadErrorLike
  return err.code ?? err.errorCode ?? ''
}

export function getDocumentLoadErrorKind(error: unknown): DocumentLoadErrorKind {
  const status = getErrorStatus(error)
  const code = getErrorCode(error)

  if (status === 401 || code === 'UNAUTHORIZED') return 'unauthorized'
  if (status === 403 || code === 'PERMISSION_DENIED') return 'permission_denied'
  if (
    status === 404
    || status === 410
    || code === 'NOT_FOUND'
    || code === 'RESOURCE_NOT_FOUND'
  ) return 'not_found'
  return 'unknown'
}

export function normalizeDocumentLoadError(error: unknown, t: TabDocTranslate): string {
  const kind = getDocumentLoadErrorKind(error)

  if (kind === 'unauthorized') {
    return t('loadUnauthorized', {
      defaultValue: '登录已过期，请重新登录后再打开文档',
    })
  }

  if (kind === 'permission_denied') {
    return t('loadPermissionDenied', {
      defaultValue: '无权访问该文档，请联系文档所有者申请权限',
    })
  }

  if (kind === 'not_found') {
    return t('loadNotFound', {
      defaultValue: '文档不存在或已被删除',
    })
  }

  return error instanceof Error && error.message
    ? error.message
    : t('loadFailed', { defaultValue: '加载文档失败' })
}

// BIZ-009 fix: 多实例 notify 分发，避免全局单例覆盖
type NotifyMsg = { level: string; message: string }
const _notifySubscribers = new Set<(msg: NotifyMsg) => void>()
let _hostConfigured = false

export function useDocEditor({ documentId }: UseDocEditorInput): UseDocEditorReturn {
  const { t } = useTranslation('tabdoc')
  const tRef = useRef(t)
  tRef.current = t

  const client = useAppHostClient()
  const clientRef = useRef(client)
  clientRef.current = client

  const [currentDocument, setCurrentDocument] = useState<TabdocDocument | null>(null)
  const [currentRevision, setCurrentRevision] = useState<TabdocRevision | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const [syncState, setSyncState] = useState<DocumentSyncState>('synced')
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [initialPmJson, setInitialPmJson] = useState<Record<string, unknown>>({})
  const [initialMarkdown, setInitialMarkdown] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadErrorKind, setLoadErrorKind] = useState<DocumentLoadErrorKind | null>(null)
  const [loadRetrySeq, setLoadRetrySeq] = useState(0)

  const draftRef = useRef<DocumentContentDraft>({
    pmJson: { type: 'doc', content: [] },
    markdown: '',
    plaintext: '',
  })
  const baseVersionRef = useRef<number | null>(null)
  const baseUpdatedAtRef = useRef<string | null>(null)
  const activeDocumentIdRef = useRef<string | null>(null)
  const autoSaveControllerRef = useRef<AutoSaveController | null>(null)
  const offlineCacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A recovery draft is durable server-side state. If the follow-up fetch
  // fails, retain its id for an unchanged draft so a retry resumes the
  // recovery instead of creating another copy. A user can continue editing
  // after that failure, though: its changed fingerprint must create a new
  // recovery record before the local IndexedDB draft is discarded.
  const pendingRecoveryDraftRef = useRef<{
    documentId: string
    id: string
    fingerprint: string
  } | null>(null)

  const applyContent = useCallback((
    content: TabdocContent | null,
    doc: TabdocDocument | null,
    revision: TabdocRevision | null,
  ): { applied: true } | { applied: false; error: string } => {
    let md = content?.description_markdown
      || revision?.content_markdown
      || ''
    // E2E-9: 历史恢复时检测 HTML 内容，自动转换为 Markdown
    if (md && looksLikeHtml(md)) {
      md = htmlToMarkdown(md)
    }
    const plaintext = content?.description_plaintext
      || revision?.content_plaintext
      || markdownToPlaintext(md)
    const rawPmJson = content?.description_json
      || revision?.content_pm_json
      || {}
    const hasPmJson = Object.keys(rawPmJson).length > 0
    const pmJson = hasPmJson
      ? rawPmJson
      : { type: 'doc', content: [] }

    // : refuse amplified / oversized payloads before ProseMirror mounts
    const budget = assessDocumentContentBudget(
      hasPmJson ? (rawPmJson as Record<string, unknown>) : null,
      md,
    )
    if (!budget.ok) {
      console.error('[TabDoc] content budget exceeded', {
        documentId: doc?.id,
        reason: budget.reason,
        topLevelBlocks: budget.topLevelBlocks,
        contentBytes: budget.contentBytes,
        maxContentBytes: budget.maxContentBytes,
        maxTopLevelBlocks: budget.maxTopLevelBlocks,
      })
      return {
        applied: false,
        error: formatDocumentContentBudgetError(budget, tRef.current),
      }
    }

    draftRef.current = {
      pmJson: pmJson as Record<string, unknown>,
      markdown: md,
      plaintext,
    }
    baseVersionRef.current = doc?.latest_version ?? revision?.version ?? null
    baseUpdatedAtRef.current = doc?.updated_at ?? null
    setCurrentRevision(revision)
    setSyncState('synced')
    setSaveState('idle')
    setSaveMessage('')
    setInitialPmJson(hasPmJson ? (rawPmJson as Record<string, unknown>) : {})
    setInitialMarkdown(md)
    setEditorKey(prev => prev + 1)
    return { applied: true }
  }, [])

  const recoverFromExternalUpdate = useCallback(async (): Promise<AutoSaveConflictResolution> => {
    const docId = activeDocumentIdRef.current
    if (!docId) return { action: 'blocked' }

    const preservedDraft = { ...draftRef.current }
    const originalBaseVersion = baseVersionRef.current
    const recoveryFingerprint = JSON.stringify({
      baseVersion: originalBaseVersion,
      pmJson: preservedDraft.pmJson,
      markdown: preservedDraft.markdown,
      plaintext: preservedDraft.plaintext ?? markdownToPlaintext(preservedDraft.markdown),
    })
    setSyncState('recovering_legacy_draft')
    setSaveState('saving')
    setSaveMessage('正在保全本地编辑…')

    try {
      let recovery = pendingRecoveryDraftRef.current
      if (
        !recovery
        || recovery.documentId !== docId
        || recovery.fingerprint !== recoveryFingerprint
      ) {
        const created = await createRecoveryDraft(clientRef.current, docId, {
          baseVersion: originalBaseVersion,
          pmJson: preservedDraft.pmJson,
          markdown: preservedDraft.markdown,
          plaintext: preservedDraft.plaintext ?? markdownToPlaintext(preservedDraft.markdown),
        })
        recovery = { documentId: docId, id: created.id, fingerprint: recoveryFingerprint }
        pendingRecoveryDraftRef.current = recovery
      }
      const detail = await getDocument(clientRef.current, docId)
      if (activeDocumentIdRef.current !== docId) return { action: 'blocked' }
      const applied = applyContent(detail.content, detail.document, detail.latest_revision)
      if (!applied.applied) {
        // `applyContent` can reject an incompatible/oversized remote payload.
        // The durable server recovery copy is already safe, but persist the
        // local copy as well so a temporary client-side failure never leaves
        // the user without an offline retry path.
        saveDraft({
          documentId: docId,
          baseVersion: originalBaseVersion,
          pmJson: preservedDraft.pmJson,
          markdown: preservedDraft.markdown,
          plaintext: preservedDraft.plaintext ?? markdownToPlaintext(preservedDraft.markdown),
        }).catch(() => {})
        setSyncState('degraded')
        setSaveMessage(applied.error)
        return { action: 'blocked' }
      }
      setCurrentDocument(detail.document)
      autoSaveControllerRef.current?.discardPendingDraft()
      deleteDraft(docId).catch(() => {})
      pendingRecoveryDraftRef.current = null
      setSyncState('synced')
      setSaveState('saved')
      setSaveMessage('已同步最新内容；未同步编辑已保存为恢复草稿')
      toast({
        title: '已同步最新内容',
        description: '未同步编辑已保存为恢复草稿，可在版本历史中查看。',
      })
      console.info('[TabDoc] recovery draft preserved', {
        documentId: docId,
        recoveryDraftId: recovery.id,
        originalBaseVersion,
      })
      return { action: 'resolved' }
    } catch (error) {
      // IndexedDB is kept by the caller/onError path.  This is intentionally a
      // recoverable state rather than a raw backend error exposed in the UI.
      const draft = draftRef.current
      saveDraft({
        documentId: docId,
        pmJson: draft.pmJson,
        markdown: draft.markdown,
        plaintext: draft.plaintext ?? '',
        baseVersion: originalBaseVersion,
      }).catch(() => {})
      setSyncState('degraded')
      setSaveState('dirty')
      setSaveMessage('本地编辑正在安全保留，网络恢复后会自动重试')
      return { action: 'blocked' }
    }
  }, [applyContent])

  const markAwaitingRemoteApply = useCallback(() => {
    setSyncState('awaiting_remote_apply')
    setSaveMessage('正在同步最新内容…')
  }, [])

  const markDocumentSynced = useCallback(() => {
    setSyncState('synced')
  }, [])

  useEffect(() => {
    // BIZ-009 fix: 每个实例注册独立的 notify 回调，unmount 时仅移除自己
    const notifyFn = ({ level, message }: NotifyMsg) => {
      setSaveMessage(`${level}: ${message}`)
    }
    _notifySubscribers.add(notifyFn)
    if (!_hostConfigured) {
      configureDocEditorHost({
        notify: (msg) => _notifySubscribers.forEach(fn => fn(msg)),
        now: () => Date.now(),
      })
      _hostConfigured = true
    }

    const controller = createAutoSaveController({
      getDraft: () => draftRef.current,
      getBaseVersion: () => baseVersionRef.current,
      save: async (payload: DocumentSavePayload): Promise<DocumentSaveResult> => {
        const nextT = tRef.current
        const docId = activeDocumentIdRef.current
        if (!docId) throw new Error(nextT('noDocumentSelected'))

        setSaveState('saving')
        setSaveMessage(nextT('savingMessage'))

        const result = await saveContent(clientRef.current, docId, {
          baseVersion: payload.baseVersion,
          baseUpdatedAt: baseUpdatedAtRef.current,
          pmJson: payload.pmJson,
          markdown: payload.markdown,
          plaintext: payload.plaintext,
        })

        if (activeDocumentIdRef.current === docId) {
          baseVersionRef.current = result.document.latest_version
          baseUpdatedAtRef.current = result.document.updated_at
          // ：写响应可能省略 current_user_role；整对象替换会让分享面板误入只读
          setCurrentDocument(prev => mergeDocumentPreservingRole(prev, result.document))
          setSaveState('saved')
          setSaveMessage(nextT('savedVersion', { version: result.document.latest_version }))
          // 保存成功，清除本地离线缓存
          deleteDraft(docId).catch(() => {})
        }

        return {
          version: result.document.latest_version,
          revisionId: result.document.id,
          savedAt: result.document.updated_at
            ? new Date(result.document.updated_at).getTime()
            : Date.now(),
        }
      },
      onConflict: async (): Promise<AutoSaveConflictResolution> => {
        /* legacy conflict handler retained below for context while this flow is migrated
        try {
        const docId = activeDocumentIdRef.current
        if (!docId) return { action: 'blocked' }
        const detail = await getDocument(clientRef.current, docId)
        const doc = detail.document
        // 对比服务端内容与本地草稿，若服务端有不同变更则中止自动重试
        const serverMarkdown = detail.content?.description_markdown
          ?? detail.latest_revision?.content_markdown
          ?? ''
        const localMarkdown = draftRef.current.markdown
        const serverPmJson = detail.content?.description_json
          ?? detail.latest_revision?.content_pm_json
          ?? {}
        const contentDiverged = serverMarkdown !== localMarkdown
          || JSON.stringify(serverPmJson) !== JSON.stringify(draftRef.current.pmJson)
        if (contentDiverged) {
          return recoverFromExternalUpdate()
        }
        if (doc) {
          baseVersionRef.current = doc.latest_version
          baseUpdatedAtRef.current = doc.updated_at
          setCurrentDocument(doc)
        }
        return { action: 'retry' }
        } catch {
          setSyncState('degraded')
          setSaveMessage('Local changes are being preserved; retrying when online.')
          return { action: 'blocked' }
        }
      },
        // 服务端内容未变化（仅版本号不同），安全重试
      },
        */
        return recoverFromExternalUpdate()
      },
      onError: (error) => {
        const nextT = tRef.current
        setSaveState('error')
        const msg = error.message || nextT('saveFailed')
        setSaveMessage(msg)

        // 保存失败时，紧急写入离线缓存确保不丢失
        const docId = activeDocumentIdRef.current
        if (docId) {
          const draft = draftRef.current
          saveDraft({
            documentId: docId,
            pmJson: draft.pmJson,
            markdown: draft.markdown,
            plaintext: draft.plaintext ?? '',
            baseVersion: baseVersionRef.current,
          }).catch((cacheErr) => {
            console.warn('[TabDoc] 保存失败后离线缓存写入也失败:', cacheErr)
          })
        }

        // E2E-10: 通过 status code 和 error_code 判断冲突，不依赖 message 文本
        const errObj = error as Error & { status?: number; statusCode?: number; code?: string; errorCode?: string }
        const errStatus = errObj.status ?? errObj.statusCode
        const errCode = errObj.code ?? errObj.errorCode ?? ''
        const isConflict =
          errStatus === 409 ||
          errCode === 'VERSION_CONFLICT' ||
          errCode === 'version_conflict'
        if (isConflict) {
          setSyncState('recovering_legacy_draft')
          setSaveMessage('正在安全保留本地编辑…')
        } else {
          toast({ title: nextT('saveError'), description: msg, variant: 'destructive' })
        }
      },
    })

    autoSaveControllerRef.current = controller

    // 启动时清理过期离线草稿
    cleanupExpiredDrafts().catch(() => {})

    return () => {
      if (offlineCacheTimerRef.current) {
        clearTimeout(offlineCacheTimerRef.current)
        offlineCacheTimerRef.current = null
      }
      // 组件卸载时，如果有未保存的脏内容，立即写入离线缓存
      const docId = activeDocumentIdRef.current
      if (docId && autoSaveControllerRef.current?.isDirty()) {
        const draft = draftRef.current
        saveDraft({
          documentId: docId,
          pmJson: draft.pmJson,
          markdown: draft.markdown,
          plaintext: draft.plaintext ?? '',
          baseVersion: baseVersionRef.current,
        }).catch(() => {})
      }
      autoSaveControllerRef.current?.cancel()
      autoSaveControllerRef.current = null
      _notifySubscribers.delete(notifyFn)
      if (_notifySubscribers.size === 0) {
        _hostConfigured = false
        resetDocEditorHost()
      }
    }
  }, [])

  useEffect(() => {
    if (!documentId) {
      activeDocumentIdRef.current = null
      pendingRecoveryDraftRef.current = null
      setCurrentDocument(null)
      applyContent(null, null, null)
      return
    }

    let cancelled = false
    pendingRecoveryDraftRef.current = null
    setIsLoadingDetail(true)
    setLoadError(null)
    setLoadErrorKind(null)

    void (async () => {
      try {
        const detail = await getDocument(clientRef.current, documentId)
        if (cancelled) return
        const applied = applyContent(detail.content, detail.document, detail.latest_revision)
        if (!applied.applied) {
          // : 预算失败时必须清空 draft / 取消 autosave，且不要把
          // activeDocumentId 绑到新文档——否则上一篇 dirty 草稿可能写到本篇。
          autoSaveControllerRef.current?.cancel()
          activeDocumentIdRef.current = null
          draftRef.current = {
            pmJson: { type: 'doc', content: [] },
            markdown: '',
            plaintext: '',
          }
          baseVersionRef.current = null
          baseUpdatedAtRef.current = null
          setCurrentDocument(detail.document)
          setCurrentRevision(detail.latest_revision)
          setSaveState('idle')
          setSaveMessage(applied.error)
          setLoadError(applied.error)
          setInitialPmJson({})
          setInitialMarkdown('')
          return
        }
        activeDocumentIdRef.current = detail.document.id
        setCurrentDocument(detail.document)

        // 检查 IndexedDB 中是否有比服务端更新的本地草稿
        try {
          const cached = await loadDraft(documentId)
          if (cached && !cancelled) {
            const serverVersion = detail.document.latest_version ?? 0
            const serverMarkdown = detail.content?.description_markdown
              ?? detail.latest_revision?.content_markdown
              ?? ''
            // 本地草稿 baseVersion >= 服务端版本且内容与服务端不同，说明有未保存的编辑
            const hasNewerDraft =
              cached.baseVersion !== null &&
              cached.baseVersion >= serverVersion &&
              cached.markdown !== serverMarkdown
            if (hasNewerDraft) {
              const draftBudget = assessDocumentContentBudget(cached.pmJson, cached.markdown)
              if (!draftBudget.ok) {
                deleteDraft(documentId).catch(() => {})
              } else {
                // BIZ-051: 通知用户发现本地草稿，自动恢复但明确提示
                const nextT = tRef.current
                draftRef.current = {
                  pmJson: cached.pmJson,
                  markdown: cached.markdown,
                  plaintext: cached.plaintext,
                }
                setInitialPmJson(cached.pmJson)
                setInitialMarkdown(cached.markdown)
                setEditorKey(prev => prev + 1)
                setSaveState('dirty')
                setSaveMessage(nextT('offlineDraftRestored', { defaultValue: '已恢复本地草稿' }))
                autoSaveControllerRef.current?.markDirty()
                toast({
                  title: nextT('offlineDraftRestored', { defaultValue: '已恢复本地草稿' }),
                  description: nextT('offlineDraftRestoredDesc', {
                    defaultValue: '检测到上次未成功保存的编辑内容，已自动恢复。如需使用服务端版本，请手动刷新文档。',
                  }),
                  duration: 8000,
                })
              }
            } else {
              // 服务端已有更新版本，清理过期本地缓存
              deleteDraft(documentId).catch(() => {})
            }
          }
        } catch {
          // IndexedDB 不可用时静默忽略
        }

      } catch (err) {
        if (!cancelled) {
          const errMsg = normalizeDocumentLoadError(err, tRef.current)
          const errorKind = getDocumentLoadErrorKind(err)
          activeDocumentIdRef.current = null
          setCurrentDocument(null)
          applyContent(null, null, null)
          setSaveMessage(errMsg)
          // E2E-6: 设置加载错误状态，供 UI 显示重试按钮
          setLoadError(errMsg)
          setLoadErrorKind(errorKind)
        }
      } finally {
        if (!cancelled) setIsLoadingDetail(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [documentId, applyContent, loadRetrySeq])

  // E2E-6: 重试加载
  const retryLoad = useCallback(() => {
    setLoadRetrySeq(prev => prev + 1)
  }, [])

  const handleEditorUpdate = useCallback(
    (markdown: string, pmJson: Record<string, unknown>) => {
      const plaintext = markdownToPlaintext(markdown)
      draftRef.current = { pmJson, markdown, plaintext }

      const docId = activeDocumentIdRef.current
      if (!docId) return

      setSaveState('dirty')
      setSaveMessage(tRef.current('pendingSave'))
      autoSaveControllerRef.current?.markDirty()

      // debounce 写入 IndexedDB 离线缓存（2s）
      if (offlineCacheTimerRef.current) {
        clearTimeout(offlineCacheTimerRef.current)
      }
      offlineCacheTimerRef.current = setTimeout(() => {
        offlineCacheTimerRef.current = null
        saveDraft({
          documentId: docId,
          pmJson,
          markdown,
          plaintext,
          baseVersion: baseVersionRef.current,
        }).catch((err) => {
          console.warn('[TabDoc] 离线缓存写入失败:', err)
        })
      }, 2000)
    },
    [],
  )

  // UI-2: 仅更新 draftRef，不触发自动保存/离线缓存，用于协作模式下 runtime monitor 采样
  const updateDraftOnly = useCallback(
    (markdown: string, pmJson: Record<string, unknown>) => {
      const plaintext = markdownToPlaintext(markdown)
      draftRef.current = { pmJson, markdown, plaintext }
    },
    [],
  )

  const manualSave = useCallback(async () => {
    if (!activeDocumentIdRef.current) return
    try {
      await autoSaveControllerRef.current?.flush()
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : tRef.current('saveFailed'))
    }
  }, [])

  // 探针意图：复用 UI 同款 handler，使 agent 驱动与真人编辑走完全一致的数据流。
  // fireProbeIntent 期间事件标 origin='agent'，用于断言「AI 链路 == 用户链路」。
  const handleEditorUpdateRef = useRef(handleEditorUpdate)
  handleEditorUpdateRef.current = handleEditorUpdate
  const manualSaveRef = useRef(manualSave)
  manualSaveRef.current = manualSave
  useEffect(() => {
    const applyEdit = (args?: Record<string, unknown>) => {
      const md = typeof args?.markdown === 'string'
        ? args.markdown
        : `probe edit ${new Date().toISOString()}`
      const pmJson = markdownToPmJson(md) as Record<string, unknown>
      handleEditorUpdateRef.current(md, pmJson)
      return { markdown: md }
    }
    registerProbeIntent('tabdoc.edit', async (args) => applyEdit(args),
      '注入一次编辑（markdown→pmJson→handleEditorUpdate），触发自动保存')
    registerProbeIntent('tabdoc.save', async () => {
      await manualSaveRef.current()
    }, '立即刷新自动保存（flush），等价于用户手动保存')
    registerProbeIntent('tabdoc.editAndSave', async (args) => {
      const r = applyEdit(args)
      await manualSaveRef.current()
      return r
    }, '注入一次编辑并立即保存，覆盖 edit→autosave→http 全链路')
    return () => {
      unregisterProbeIntent('tabdoc.edit')
      unregisterProbeIntent('tabdoc.save')
      unregisterProbeIntent('tabdoc.editAndSave')
    }
  }, [])

  const patchCurrentDocument = useCallback((updates: Partial<TabdocDocument>) => {
    if (typeof updates.latest_version === 'number') {
      baseVersionRef.current = updates.latest_version
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'updated_at')) {
      baseUpdatedAtRef.current = updates.updated_at ?? null
    }
    setCurrentDocument(prev => prev ? { ...prev, ...updates } : prev)
  }, [])

  return {
    currentDocument,
    currentRevision,
    saveState,
    saveMessage,
    syncState,
    isLoadingDetail,
    initialPmJson,
    initialMarkdown,
    editorKey,
    draftRef,
    baseVersionRef,
    baseUpdatedAtRef,
    activeDocumentIdRef,
    autoSaveControllerRef,
    handleEditorUpdate,
    updateDraftOnly,
    manualSave,
    patchCurrentDocument,
    loadError,
    loadErrorKind,
    retryLoad,
    recoverFromExternalUpdate,
    markAwaitingRemoteApply,
    markDocumentSynced,
  }
}
