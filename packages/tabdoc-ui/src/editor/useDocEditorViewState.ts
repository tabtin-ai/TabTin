/**
 * useDocEditorViewState — 文档编辑器视图的共享状态管理
 *
 * 从 Electron 和 Web 两端的 DocEditorView 中提取的公共状态逻辑。
 * 宿主只需调用此 hook，然后在 JSX 中消费返回值即可，
 * 不再需要各自维护一套相同的 state/effect/callback 代码。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Extensions } from '@tiptap/core'
import type { EditorInstance } from 'novel'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { TocHeading } from './DocOutlineNav'
import { resolveBlockMenuStateFromHandle, type BlockActionMenuState } from './block-action-menu'
import type { DocEditorToolbarProps } from './DocEditorToolbar'
import {
  createDocFindExtension,
  findTextInDoc,
  findTextInPlaintext,
  isBodyDocFindMatch,
  selectDocFindMatch,
  selectTitleFindMatch,
  updateDocFindDecorations,
  type DocFindMatch,
  type TitleDocFindMatch,
} from './doc-find'
import type { TabdocDocument, ExportFormat } from '../api-client'
import { exportDocument, exportDocumentBlob } from '../api-client'
import {
  flushEditorContentBeforeExport as flushEditorContentBeforeExportCore,
  type ExportSaveBaseline,
} from './flushEditorContentBeforeExport'
import type { FontStyle } from '../api-client'
import type { SaveState } from '../useDocEditor'
import type { CollaborativeState } from '../useCollaborativeDocEditor'
import { useTabDocEditorConfig } from '../TabDocEditorConfigContext'
import { useTabDocHostActions } from '../TabDocHostActionsContext'
import {
  UNTITLED_DOCUMENT_FALLBACK,
  MAX_DOCUMENT_TITLE_LENGTH,
  isUntitledTitle,
  displayTitleFromDoc,
  normalizeTitleInputValue,
  decideTitleSync,
} from './titleSync'
import {
  focusEditorBodyFromTitle,
  focusEditorBodyFromTitleArrowDown,
  resolveInitialEditorContent,
  type TabDocInitialEditorContent,
} from './editor-body'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { getSuggestionItems, createSlashCommand } from './slash-command'
import {
  createEditableExtensions,
  createEmptyDocumentPlaceholder,
  createTabDocDragHandleId,
  getTabDocDragHandleSelector,
} from './extensions'
import { insertUploadedImage } from './image-insert'
import {
  createUploadFn as sharedCreateUploadFn,
  handleImageDrop,
  handleImagePaste,
  uploadImageWithOfflineFallback,
} from './image-upload'
import { reuploadOfflineImages } from './image-reupload'
import { runHtmlUpload, isHtmlUploadFile } from './html-upload'
import { HTML_BLOCK_DEFAULT_HEIGHT } from '@tabtin/doc-editor'
import { snapshotEditorContentWithRepair } from './editor-content-snapshot'
import { writePageContentToClipboard } from './page-content-clipboard'
import type { EditorView } from '@tiptap/pm/view'
import {
  CoverUploadFlowError,
  getCoverPositionX,
  getCoverScale,
  uploadAndSaveCover,
  withoutPrivateCoverFileId,
} from './cover-upload'
import {
  createCollaborationExtensions,
  type TabDocCollaborationUser,
} from './collaboration-extensions'
import { createPasteHandler } from './paste-handler'
import { getBlockId, normalizeBlockText } from './doc-selection-blocks'
import { resolveMathNodeAtEvent } from './resolve-math-node-at-event'
import { focusTitleFromBodyStart, isBodyStartTitleNavigationKey } from './editor-keyboard'
import { countDocumentWords } from '../utils/word-count'
import { handleCommandNavigation } from 'novel'
import { toast } from '@tabtin/smartsheet-ui'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  isCollabContentHydrated,
  resolveCollabEditorPresentation,
  shouldUseRealtimeCollabEditor,
} from './collabMode'
import { tryHandleFileRefImageDrop } from './file-ref-drop'
import {
  getTabDocImportMaxBytes,
  getTabDocImportFileKind,
} from './import-file-utils'
import { resolveTabDocWebLinkInput } from './open-web-link'

// 标题哨值映射 + 同步决策的纯逻辑见 ./titleSync（无副作用、可单测）。

const CHAT_CONTEXT_PREVIEW_MAX_CHARS = 200

function closestElement(target: EventTarget | null, selector: string): Element | null {
  const closest = (target as { closest?: unknown } | null)?.closest
  if (typeof closest !== 'function') return null
  const match = closest.call(target, selector)
  return match instanceof Element ? match : null
}

interface TabDocBlockChatPayload {
  type: 'doc_selection'
  resourceId: string
  label: string
  spaceId?: string
  tabType: 'tabdoc'
  preview: string
  meta: {
    block_ids?: string[]
    full_text: string
  }
}

function buildBlockPreview(text: string): string {
  return text.length > CHAT_CONTEXT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, CHAT_CONTEXT_PREVIEW_MAX_CHARS)}...`
    : text
}

function buildTabDocBlockChatPayload(
  doc: TabdocDocument,
  node: ProseMirrorNode,
): TabDocBlockChatPayload | null {
  const fullText = normalizeBlockText(node)
  if (!fullText) return null

  const preview = buildBlockPreview(fullText)
  const blockId = getBlockId(node)
  return {
    type: 'doc_selection',
    resourceId: doc.id,
    label: `${doc.title || 'TabDoc'} · ${preview}`,
    spaceId: doc.space_id || undefined,
    tabType: 'tabdoc',
    preview,
    meta: {
      ...(blockId ? { block_ids: [blockId] } : {}),
      full_text: fullText,
    },
  }
}

// ── 类型 ──

export interface SlashHostActions {
  onRequestMathFormula?: () => void
  onRequestCreateDatabase?: () => void
  onRequestSelectTable?: () => void
}

export interface UseDocEditorViewStateInput {
  document: TabdocDocument | null
  initialPmJson: Record<string, unknown>
  initialMarkdown: string
  editorKey: number
  isLoading: boolean
  saveState: SaveState
  saveMessage: string
  showRevisions: boolean
  onEditorUpdate: (markdown: string, pmJson: Record<string, unknown>) => void
  onDraftSync?: (markdown: string, pmJson: Record<string, unknown>) => void
  onManualSave: () => void
  onToggleRevisions: () => void
  onTitleChange?: (newTitle: string) => void | Promise<void>
  onDocumentPropertyChange?: (
    updates: Record<string, unknown>,
    options?: { silentError?: boolean },
  ) => void | Promise<void>
  /** flush / 冲突对齐时回写文档字段（含最新 version）；通常接 patchCurrentDocument */
  onContentFlushedBeforeExport?: (document: Partial<TabdocDocument>) => void
  /**
   * 与 autosave 同源的 CAS baseline（读 ref，避免 React 状态滞后导致导出版本冲突）。
   * 未提供时回退到当前 document 字段。
   */
  getSaveBaseline?: () => ExportSaveBaseline
  onSaveVersion?: () => void
  ydoc?: Y.Doc | null
  hocuspocusProvider?: HocuspocusProvider | null
  collaborationUser?: TabDocCollaborationUser | null
  collaborative?: CollaborativeState | null
  slashHostActions?: Partial<SlashHostActions>
  t: (key: string, options?: Record<string, unknown>) => string
  toolbarExtraProps?: Partial<DocEditorToolbarProps>
  /** 新建文档打开后自动聚焦标题输入框（一次性） */
  autoFocusTitle?: boolean
  /** 宿主追加的 TipTap 扩展（如评论高亮装饰）；不写入正文/历史 */
  extraExtensions?: Extensions
}

export interface UseDocEditorViewStateReturn {
  effectiveEditorKey: number
  /** 封面/标题外壳稳定 key（不含 providerGeneration） */
  panelStableKey: number

  isOffline: boolean
  editorInstanceRef: React.RefObject<EditorInstance | null>
  editorDomRef: React.RefObject<HTMLElement | null>
  isRealtimeCollabRef: React.RefObject<boolean>
  onEditorUpdateRef: React.RefObject<(markdown: string, pmJson: Record<string, unknown>) => void>
  onDraftSyncRef: React.RefObject<((markdown: string, pmJson: Record<string, unknown>) => void) | undefined>

  titleValue: string
  titleInputRef: React.RefObject<HTMLTextAreaElement | null>
  handleTitleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleTitlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handleTitleBlur: () => void
  handleTitleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void

  showIconPicker: boolean
  setShowIconPicker: React.Dispatch<React.SetStateAction<boolean>>
  handleIconChange: (icon: string) => void
  handleRemoveIcon: () => void
  coverInputRef: React.RefObject<HTMLInputElement | null>
  isUploadingCover: boolean
  handleAddCoverPreset: () => void
  handleCoverUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  coverCropPreviewUrl: string | null
  coverCropPositionX: number
  setCoverCropPositionX: React.Dispatch<React.SetStateAction<number>>
  coverCropPosition: number
  setCoverCropPosition: React.Dispatch<React.SetStateAction<number>>
  coverCropScale: number
  setCoverCropScale: React.Dispatch<React.SetStateAction<number>>
  coverCropError: string | null
  handleCancelCoverCrop: () => void
  handleConfirmCoverCrop: () => void
  handleRemoveCover: () => void
  emojiCategories: Record<string, string[]>
  showAllEmojis: boolean
  setShowAllEmojis: React.Dispatch<React.SetStateAction<boolean>>
  emojiEntries: [string, string[]][]

  openNode: boolean
  setOpenNode: React.Dispatch<React.SetStateAction<boolean>>
  openColor: boolean
  setOpenColor: React.Dispatch<React.SetStateAction<boolean>>
  openLink: boolean
  setOpenLink: React.Dispatch<React.SetStateAction<boolean>>

  blockMenuState: BlockActionMenuState | null
  handleBlockMenuClose: () => void

  wordCount: number

  scrollRef: React.RefObject<HTMLDivElement | null>
  tocHeadings: TocHeading[]
  extractHeadings: () => void

  showMathDialog: boolean
  mathDialogLatex: string
  mathDialogEditPos: number | null
  openMathDialog: (initial?: { latex?: string; editPos?: number | null }) => void
  setShowMathDialog: (open: boolean) => void
  handleMathConfirm: (latex: string) => void

  editorExtensions: Extensions
  handleEditorUpdate: (editor: EditorInstance) => void
  syncEditorWordCount: (editor: EditorInstance) => void
  initialEditorContent: TabDocInitialEditorContent
  dragHandleId: string
  suggestionItems: ReturnType<typeof getSuggestionItems>
  docUploadFn: ReturnType<typeof sharedCreateUploadFn> | undefined
  createEditorUploadFn: (documentId: string) => ReturnType<typeof sharedCreateUploadFn>

  editorProps: Record<string, unknown>

  exporting: boolean
  handleExport: (format: ExportFormat) => void
  flushEditorContentBeforeExport: () => Promise<void>
  triggerBlobDownload: (blob: Blob, filename: string) => void

  toolbarProps: DocEditorToolbarProps
  handleContainerKeyDown: (event: React.KeyboardEvent) => void
  findOpen: boolean
  findFocusRequest: number
  findQuery: string
  findMatches: DocFindMatch[]
  findActiveIndex: number
  findActiveTitleMatch: TitleDocFindMatch | null
  openFind: () => void
  closeFind: () => void
  setFindQuery: React.Dispatch<React.SetStateAction<string>>
  goToNextFindMatch: () => void
  goToPreviousFindMatch: () => void

  isRealtimeCollab: boolean
  /** ：首次 hydrate 前为 true，壳层显示加载态而非空编辑器 */
  isCollabHydrateLoading: boolean
}

export function useDocEditorViewState(
  input: UseDocEditorViewStateInput,
): UseDocEditorViewStateReturn {
  const {
    document: doc,
    initialPmJson,
    initialMarkdown,
    editorKey,
    isLoading,
    saveState,
    saveMessage,
    showRevisions,
    onEditorUpdate,
    onDraftSync,
    onManualSave,
    onToggleRevisions,
    onTitleChange,
    onDocumentPropertyChange,
    onContentFlushedBeforeExport,
    getSaveBaseline,
    onSaveVersion,
    ydoc,
    hocuspocusProvider,
    collaborationUser,
    collaborative,
    slashHostActions,
    t,
    toolbarExtraProps,
    autoFocusTitle = false,
    extraExtensions,
  } = input

  const editorConfig = useTabDocEditorConfig()
  const client = useAppHostClient()
  const hostActions = useTabDocHostActions()

  // ── Refs ──
  const editorInstanceRef = useRef<EditorInstance | null>(null)
  const editorDomRef = useRef<HTMLElement | null>(null)
  const dragHandleIdRef = useRef<string>(createTabDocDragHandleId())
  const isRealtimeCollabRef = useRef(false)
  const onEditorUpdateRef = useRef(onEditorUpdate)
  onEditorUpdateRef.current = onEditorUpdate
  const onDraftSyncRef = useRef(onDraftSync)
  onDraftSyncRef.current = onDraftSync

  // ── Upload ──
  const createEditorUploadFn = useCallback(
    (documentId: string) => sharedCreateUploadFn(
      documentId,
      editorConfig.imageUpload,
      (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
    ),
    [editorConfig.imageUpload, t],
  )

  // ── HTML 嵌入块上传入口 ──
  // editorConfig.htmlUpload 未注入（公开分享 / 无宿主上传通道）时为 undefined，
  // slash「HTML」项与 .html 拖拽入口随之自动隐藏（与无上传通道时不暴露 image 一致的策略）。
  const htmlUploadPort = editorConfig.htmlUpload
  const htmlUploadFn = useMemo(() => {
    if (!htmlUploadPort) return undefined
    const tFn = (key: string, opts?: Record<string, unknown>) => t(key, opts) as string
    // 上传是异步的：成功后再在 pos 处插块（不做「空占位 + 回填」，简单可靠）。
    return (file: File, _view: EditorView, pos: number) => {
      void runHtmlUpload(file, htmlUploadPort, tFn, { documentId: doc?.id }).then((outcome) => {
        if (!outcome) return
        const editor = editorInstanceRef.current
        if (!editor) return
        const safePos = Math.min(Math.max(pos, 0), editor.state.doc.content.size)
        const blockId =
          typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `htmlblk_${Date.now().toString(36)}`
        editor
          .chain()
          .focus()
          .insertContentAt(safePos, {
            type: 'htmlBlock',
            attrs: {
              blockId,
              fileId: outcome.fileId,
              src: outcome.src,
              title: outcome.title,
              height: HTML_BLOCK_DEFAULT_HEIGHT,
            },
          })
          .run()
      })
    }
  }, [htmlUploadPort, doc?.id, t])

  // ：每个 Y.Doc 首次 hydrate 后 latch，断线/认证恢复不切 REST
  const hydrateLatchRef = useRef(false)
  const hydrateLatchYdocRef = useRef<Y.Doc | null | undefined>(undefined)
  if (ydoc !== hydrateLatchYdocRef.current) {
    hydrateLatchYdocRef.current = ydoc
    hydrateLatchRef.current = false
  }
  if (isCollabContentHydrated(collaborative)) {
    hydrateLatchRef.current = true
  }
  const collabPresentation = resolveCollabEditorPresentation(ydoc, collaborative, {
    hasHydratedLatch: hydrateLatchRef.current,
  })
  const isRealtimeCollab = shouldUseRealtimeCollabEditor(ydoc, collaborative, {
    hasHydratedLatch: hydrateLatchRef.current,
  })
  const isCollabHydrateLoading = collabPresentation === 'loading'
  isRealtimeCollabRef.current = isRealtimeCollab

  // ── ydoc key bump ──
  const [ydocKeyBump, setYdocKeyBump] = useState(0)
  const prevYdocIdentityRef = useRef<Y.Doc | null | undefined>(undefined)
  useEffect(() => {
    if (prevYdocIdentityRef.current === undefined) {
      prevYdocIdentityRef.current = ydoc ?? null
      return
    }
    if (ydoc !== prevYdocIdentityRef.current) {
      setYdocKeyBump(prev => prev + 1)
    }
    prevYdocIdentityRef.current = ydoc ?? null
  }, [ydoc])
  const collabModeKey = isRealtimeCollab ? 1 : isCollabHydrateLoading ? 2 : 0
  // panel 外壳 key：不含 providerGeneration，避免认证恢复误拆封面/标题 ErrorBoundary
  const panelStableKey = editorKey * 1000 + ydocKeyBump * 10 + collabModeKey
  // EditorRoot key：providerGeneration 仅重挂 TipTap（CollaborationCursor 绑死旧 Hocuspocus 实例，）
  const providerGeneration = collaborative?.providerGeneration ?? 0
  const effectiveEditorKey = panelStableKey + providerGeneration * 100

  // ── Network ──
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => {
      setIsOffline(false)
      const editor = editorInstanceRef.current
      if (editor && !isRealtimeCollabRef.current) {
        void reuploadOfflineImages(
          editor, doc?.id, editorConfig.imageUpload,
          (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
        ).then((count) => {
          if (count > 0) {
            const { markdown, pmJson } = snapshotEditorContentWithRepair(editor)
            onEditorUpdateRef.current(markdown, pmJson)
          }
        })
      }
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [doc?.id, editorConfig.imageUpload, t])

  // ── Title ──
  // 显示层把后端的「未命名文档」哨值映射成空字符串，让 placeholder「请输入标题」能露出来；
  // commit 时再把空字符串映射回哨值，保持前后端语义一致。
  const [titleValue, setTitleValue] = useState(() => displayTitleFromDoc(doc?.title))
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null)
  const shouldAutoFocusTitleRef = useRef(autoFocusTitle)
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleCommitSeqRef = useRef(0)
  const pendingTitleRef = useRef<string | null>(null)
  /** 用户已编辑标题输入框，commit 完成或 reset 前置 false */
  const titleLocalEditRef = useRef(false)
  const titleDocIdRef = useRef(doc?.id)

  // 本地是否存在「尚未落库」的标题编辑：debounce 计时中（用户刚敲完还没提交）或 PATCH 在途。
  // 这是旧值回灌的危险窗口——此时必须忽略外部对 doc.title 的回写。
  const hasPendingTitleEdit = useCallback(
    () => titleTimerRef.current !== null || pendingTitleRef.current !== null,
    [],
  )

  // doc.title → 输入框 的同步（决策逻辑见 decideTitleSync）。
  useEffect(() => {
    const decision = decideTitleSync({
      prevDocId: titleDocIdRef.current,
      nextDocId: doc?.id,
      hasPendingEdit: hasPendingTitleEdit(),
      hasLocalEdit: titleLocalEditRef.current,
    })
    titleDocIdRef.current = doc?.id
    if (decision === 'ignore') return
    if (decision === 'reset') {
      // 切换 / 重新打开文档：丢弃任何残留的本地未提交编辑，避免它污染新文档。
      if (titleTimerRef.current) {
        clearTimeout(titleTimerRef.current)
        titleTimerRef.current = null
      }
      pendingTitleRef.current = null
      titleLocalEditRef.current = false
    }
    setTitleValue(displayTitleFromDoc(doc?.title))
  }, [doc?.id, doc?.title, hasPendingTitleEdit])

  useEffect(() => {
    if (!shouldAutoFocusTitleRef.current || isLoading || !doc?.id) return
    shouldAutoFocusTitleRef.current = false
    const focusTitleInput = () => titleInputRef.current?.focus()
    focusTitleInput()
    // 编辑器 onCreate 可能在首帧后抢走焦点，短延迟再试一次
    const timer = setTimeout(focusTitleInput, 50)
    return () => clearTimeout(timer)
  }, [doc?.id, isLoading])

  const commitTitleChange = useCallback((newTitle: string) => {
    const trimmedTitle = newTitle.trim()
    const currentDocTitle = doc?.title ?? ''
    const currentIsUntitled = isUntitledTitle(currentDocTitle)
    const nextIsUntitled = !trimmedTitle

    // 无变化：两端都是 untitled，或两端都是同一非空字符串
    if (currentIsUntitled && nextIsUntitled) {
      setTitleValue('')
      titleLocalEditRef.current = false
      return
    }
    if (!currentIsUntitled && trimmedTitle === currentDocTitle.trim()) {
      setTitleValue(currentDocTitle)
      titleLocalEditRef.current = false
      return
    }

    // 提交值：空标题回落到「未命名文档」哨值，避免触发后端 `tabdoc.title_cannot_be_empty`，
    // 并让后端落库保持「空标题 = 未命名文档」的语义。
    const titleToCommit = nextIsUntitled ? UNTITLED_DOCUMENT_FALLBACK : trimmedTitle
    if (pendingTitleRef.current === titleToCommit) return

    const commitSeq = titleCommitSeqRef.current + 1
    titleCommitSeqRef.current = commitSeq
    pendingTitleRef.current = titleToCommit
    try {
      const result = onTitleChange?.(titleToCommit)
      if (result && typeof result === 'object' && 'catch' in result) {
        void result
          .catch(() => {
            if (titleCommitSeqRef.current === commitSeq) {
              setTitleValue(displayTitleFromDoc(doc?.title))
            }
          })
          .finally(() => {
            if (pendingTitleRef.current === titleToCommit) {
              pendingTitleRef.current = null
            }
            titleLocalEditRef.current = false
          })
      } else {
        pendingTitleRef.current = null
        titleLocalEditRef.current = false
      }
    } catch {
      if (titleCommitSeqRef.current === commitSeq) {
        setTitleValue(displayTitleFromDoc(doc?.title))
      }
      if (pendingTitleRef.current === titleToCommit) {
        pendingTitleRef.current = null
      }
      titleLocalEditRef.current = false
    }
  }, [doc?.title, onTitleChange])

  const scheduleTitleCommit = useCallback((newTitle: string) => {
    titleLocalEditRef.current = true
    setTitleValue(newTitle)
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current)
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null
      commitTitleChange(newTitle)
    }, 600)
  }, [commitTitleChange])

  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    scheduleTitleCommit(
      normalizeTitleInputValue(e.target.value).slice(0, MAX_DOCUMENT_TITLE_LENGTH),
    )
  }, [scheduleTitleCommit])

  const handleTitlePaste = useCallback((_e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // 粘贴可能早于 onChange；先标记本地编辑，避免正文 autosave 回写 doc.title 清掉粘贴内容
    titleLocalEditRef.current = true
  }, [])

  const handleTitleBlur = useCallback(() => {
    if (titleTimerRef.current) { clearTimeout(titleTimerRef.current); titleTimerRef.current = null }
    commitTitleChange(titleValue)
  }, [commitTitleChange, titleValue])

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.blur()
      focusEditorBodyFromTitle(editorInstanceRef.current)
      return
    }

    const isPlainArrowDown = e.key === 'ArrowDown'
      && !e.nativeEvent.isComposing
      && !e.altKey
      && !e.ctrlKey
      && !e.metaKey
      && !e.shiftKey
    if (isPlainArrowDown && focusEditorBodyFromTitleArrowDown(editorInstanceRef.current, e.currentTarget)) {
      e.preventDefault()
    }
  }, [])

  // ── Icon / Cover ──
  const [showIconPicker, setShowIconPicker] = useState(false)
  const handleIconChange = useCallback((icon: string) => {
    setShowIconPicker(false)
    onDocumentPropertyChange?.({ icon })
  }, [onDocumentPropertyChange])
  const handleRemoveIcon = useCallback(() => { onDocumentPropertyChange?.({ icon: '' }) }, [onDocumentPropertyChange])

  const coverInputRef = useRef<HTMLInputElement | null>(null)
  const [isUploadingCover, setIsUploadingCover] = useState(false)
  const [coverCropFile, setCoverCropFile] = useState<File | null>(null)
  const [coverCropPreviewUrl, setCoverCropPreviewUrl] = useState<string | null>(null)
  const [coverCropPositionX, setCoverCropPositionX] = useState(0.5)
  const [coverCropPosition, setCoverCropPosition] = useState(0.5)
  const [coverCropScale, setCoverCropScale] = useState(1)
  const [coverCropError, setCoverCropError] = useState<string | null>(null)
  const coverCropPreviewUrlRef = useRef<string | null>(null)

  const resetCoverInput = useCallback(() => {
    if (coverInputRef.current) coverInputRef.current.value = ''
  }, [])

  const revokeCoverCropPreview = useCallback(() => {
    const previewUrl = coverCropPreviewUrlRef.current
    if (previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(previewUrl)
    }
    coverCropPreviewUrlRef.current = null
  }, [])

  const clearCoverCropDraft = useCallback(() => {
    revokeCoverCropPreview()
    setCoverCropFile(null)
    setCoverCropPreviewUrl(null)
    setCoverCropPositionX(0.5)
    setCoverCropPosition(0.5)
    setCoverCropScale(1)
    setCoverCropError(null)
    resetCoverInput()
  }, [resetCoverInput, revokeCoverCropPreview])

  useEffect(() => () => revokeCoverCropPreview(), [revokeCoverCropPreview])

  const handleAddCoverPreset = useCallback(() => {
    const presets = [
      'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1200&h=400&fit=crop',
      'https://images.unsplash.com/photo-1477346611705-65d1883cee1e?w=1200&h=400&fit=crop',
      'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1200&h=400&fit=crop',
      'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=1200&h=400&fit=crop',
    ]
    onDocumentPropertyChange?.({
      cover_image: presets[Math.floor(Math.random() * presets.length)],
      properties: withoutPrivateCoverFileId(doc?.properties),
    })
  }, [doc?.properties, onDocumentPropertyChange])

  const handleCoverUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!doc?.id || !onDocumentPropertyChange) {
      toast({
        title: t('documentNotReady', { defaultValue: '文档还没准备好，请稍后再试' }),
        variant: 'destructive',
      })
      resetCoverInput()
      return
    }

    if (editorConfig.imageUpload.validate) {
      const { valid, reason, maxSizeLabel } = editorConfig.imageUpload.validate(file)
      if (!valid) {
        toast({
          title: t(reason?.startsWith('fileTooLarge') ? 'imageTooLarge' : 'imageTypeNotSupported', {
            maxSize: maxSizeLabel,
          }),
          variant: 'destructive',
        })
        resetCoverInput()
        return
      }
    }

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      toast({
        title: t('coverPreviewUnavailable', { defaultValue: '当前环境无法预览封面，请稍后再试' }),
        variant: 'destructive',
      })
      resetCoverInput()
      return
    }

    revokeCoverCropPreview()
    const previewUrl = URL.createObjectURL(file)
    coverCropPreviewUrlRef.current = previewUrl
    setCoverCropFile(file)
    setCoverCropPreviewUrl(previewUrl)
    setCoverCropError(null)
    setCoverCropPositionX(getCoverPositionX(doc.properties))
    setCoverCropPosition(typeof doc.cover_position === 'number' ? doc.cover_position : 0.5)
    setCoverCropScale(getCoverScale(doc.properties))
  }, [doc?.id, doc?.cover_position, doc?.properties, editorConfig.imageUpload, onDocumentPropertyChange, resetCoverInput, revokeCoverCropPreview, t])

  const handleCancelCoverCrop = useCallback(() => {
    if (isUploadingCover) return
    clearCoverCropDraft()
  }, [clearCoverCropDraft, isUploadingCover])

  const handleConfirmCoverCrop = useCallback(async () => {
    if (!coverCropFile || !doc?.id || !onDocumentPropertyChange) return

    setCoverCropError(null)
    setIsUploadingCover(true)
    try {
      await uploadAndSaveCover({
        file: coverCropFile,
        documentId: doc.id,
        coverPosition: coverCropPosition,
        coverPositionX: coverCropPositionX,
        coverScale: coverCropScale,
        documentProperties: doc.properties,
        imageUpload: editorConfig.imageUpload,
        onDocumentPropertyChange,
        t,
      })
      clearCoverCropDraft()
    } catch (error) {
      const titleKey = error instanceof CoverUploadFlowError && error.stage === 'save'
        ? 'coverSaveFailed'
        : 'imageUploadFailed'
      const title = t(titleKey, titleKey === 'coverSaveFailed'
        ? { defaultValue: '封面保存失败' }
        : { defaultValue: '封面上传失败' })
      const description = error instanceof Error ? error.message : undefined
      setCoverCropError(description ? `${title}: ${description}` : title)
      toast({
        title,
        description,
        variant: 'destructive',
      })
    } finally {
      setIsUploadingCover(false)
    }
  }, [clearCoverCropDraft, coverCropFile, coverCropPosition, coverCropPositionX, coverCropScale, doc?.id, doc?.properties, editorConfig.imageUpload, onDocumentPropertyChange, t])

  const handleRemoveCover = useCallback(() => {
    onDocumentPropertyChange?.({
      cover_image: '',
      properties: withoutPrivateCoverFileId(doc?.properties),
    })
  }, [doc?.properties, onDocumentPropertyChange])

  // ── Emoji ──
  const emojiCategories = useMemo<Record<string, string[]>>(() => ({
    recent: ['📝', '📋', '📌', '🎯', '💡', '🔖', '📊', '🗂️', '✅', '⭐', '🚀', '🎨', '📎', '🔬', '💻', '📱'],
    objects: ['📄', '📑', '📰', '🗒️', '📓', '📕', '📗', '📘', '📙', '📒', '🔑', '🔒', '🔔', '💬', '💭', '🏷️'],
    symbols: ['❤️', '🔥', '⚡', '💎', '🎵', '🎬', '🏆', '🎁', '🌟', '🔮', '🧩', '🎲', '♻️', '⚙️', '🛡️', '🧪'],
    nature: ['🌈', '🌸', '🌻', '🍀', '🌊', '🌙', '☀️', '⛰️', '🌲', '🐝', '🦋', '🐱', '🐶', '🦊', '🐻', '🌺'],
    faces: ['😀', '😊', '🤔', '😎', '🥳', '😇', '🤩', '😤', '😱', '🥲', '😈', '👻', '🤖', '👽', '💀', '🎃'],
  }), [])
  const [showAllEmojis, setShowAllEmojis] = useState(false)
  const emojiEntries = showAllEmojis
    ? Object.entries(emojiCategories)
    : ([['recent', emojiCategories.recent]] as [string, string[]][])

  // ── Bubble menu ──
  const [openNode, setOpenNode] = useState(false)
  const [openColor, setOpenColor] = useState(false)
  const [openLink, setOpenLink] = useState(false)

  // ── Block action menu ──
  const [blockMenuState, setBlockMenuState] = useState<BlockActionMenuState | null>(null)
  const blockMenuClosedRef = useRef<{ nodePos: number; time: number } | null>(null)

  const [wordCount, setWordCount] = useState(0)

  // ── In-document find ──
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusRequest, setFindFocusRequest] = useState(0)
  const [findQuery, setFindQuery] = useState('')
  const [findMatches, setFindMatches] = useState<DocFindMatch[]>([])
  const [findActiveIndex, setFindActiveIndex] = useState(-1)

  // ── TOC / scroll container ──
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const headingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [tocHeadings, setTocHeadings] = useState<TocHeading[]>([])

  const selectFindMatch = useCallback((matches: DocFindMatch[], index: number) => {
    const match = matches[index]
    if (!match) return
    if (match.kind === 'title') {
      const input = titleInputRef.current
      if (input) selectTitleFindMatch(input, match)
      return
    }
    const editor = editorInstanceRef.current
    if (!editor) return
    selectDocFindMatch(editor, match, scrollRef.current)
  }, [])

  const applyFindMatches = useCallback((matches: DocFindMatch[], index: number, reveal: boolean) => {
    setFindActiveIndex(index)
    const editor = editorInstanceRef.current
    const active = matches[index]
    const bodyMatches = matches.filter(isBodyDocFindMatch)
    const bodyActiveIndex = active && isBodyDocFindMatch(active)
      ? bodyMatches.indexOf(active)
      : -1
    if (editor) updateDocFindDecorations(editor, bodyMatches, bodyActiveIndex)
    if (reveal) selectFindMatch(matches, index)
  }, [selectFindMatch])

  const recomputeFindMatches = useCallback((preferredIndex: number, reveal: boolean) => {
    const editor = editorInstanceRef.current
    const query = findQuery.trim()
    if (!editor || !query) {
      setFindMatches([])
      setFindActiveIndex(-1)
      if (editor) updateDocFindDecorations(editor, [], -1)
      return
    }

    const matches: DocFindMatch[] = [
      ...findTextInPlaintext(titleValue, query),
      ...findTextInDoc(editor.state.doc, query),
    ]
    const nextIndex = matches.length === 0
      ? -1
      : Math.min(Math.max(preferredIndex, 0), matches.length - 1)
    setFindMatches(matches)
    if (nextIndex >= 0) {
      applyFindMatches(matches, nextIndex, reveal)
    } else {
      setFindActiveIndex(-1)
      updateDocFindDecorations(editor, [], -1)
    }
  }, [applyFindMatches, findQuery, titleValue])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindFocusRequest(request => request + 1)
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindMatches([])
    setFindActiveIndex(-1)
    const editor = editorInstanceRef.current
    if (editor) updateDocFindDecorations(editor, [], -1)
  }, [])

  const goToNextFindMatch = useCallback(() => {
    if (findMatches.length === 0) return
    const nextIndex = findActiveIndex < 0 ? 0 : (findActiveIndex + 1) % findMatches.length
    applyFindMatches(findMatches, nextIndex, true)
  }, [applyFindMatches, findActiveIndex, findMatches])

  const goToPreviousFindMatch = useCallback(() => {
    if (findMatches.length === 0) return
    const nextIndex = findActiveIndex < 0
      ? findMatches.length - 1
      : (findActiveIndex - 1 + findMatches.length) % findMatches.length
    applyFindMatches(findMatches, nextIndex, true)
  }, [applyFindMatches, findActiveIndex, findMatches])

  const findActiveTitleMatch = useMemo((): TitleDocFindMatch | null => {
    if (!findOpen || findActiveIndex < 0) return null
    const match = findMatches[findActiveIndex]
    return match?.kind === 'title' ? match : null
  }, [findActiveIndex, findMatches, findOpen])

  useEffect(() => {
    if (!findOpen) return
    recomputeFindMatches(0, true)
  }, [effectiveEditorKey, findOpen, findQuery, recomputeFindMatches])

  const extractHeadings = useCallback(() => {
    const editor = editorInstanceRef.current
    if (!editor?.view?.dom) { setTocHeadings([]); return }
    editorDomRef.current = editor.view.dom as HTMLElement
    const nodes = editor.view.dom.querySelectorAll('h1, h2, h3')
    const result: TocHeading[] = []
    nodes.forEach((el: Element, i: number) => {
      const text = (el as HTMLElement).textContent?.trim()
      if (text) {
        result.push({
          id: `toc-${i}-${text.slice(0, 16).replace(/\s+/g, '-')}`,
          text,
          level: parseInt(el.tagName[1]),
          headingIndex: i,
        })
      }
    })
    setTocHeadings(result)
  }, [])

  const extractHeadingsDebounced = useCallback(() => {
    if (headingTimerRef.current) clearTimeout(headingTimerRef.current)
    headingTimerRef.current = setTimeout(extractHeadings, 300)
  }, [extractHeadings])

  useEffect(() => {
    if (headingTimerRef.current) clearTimeout(headingTimerRef.current)
    setTocHeadings([])
    editorInstanceRef.current = null
    editorDomRef.current = null
  }, [effectiveEditorKey])

  useEffect(() => {
    return () => {
      if (headingTimerRef.current) clearTimeout(headingTimerRef.current)
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current)
    }
  }, [])

  // ── Math formula (Feishu-style input + preview) ──
  const [showMathDialog, setShowMathDialog] = useState(false)
  const [mathDialogLatex, setMathDialogLatex] = useState('')
  const [mathDialogEditPos, setMathDialogEditPos] = useState<number | null>(null)

  const openMathDialog = useCallback((initial?: { latex?: string; editPos?: number | null }) => {
    setMathDialogLatex(initial?.latex ?? '')
    setMathDialogEditPos(initial?.editPos ?? null)
    setShowMathDialog(true)
  }, [])

  const handleMathDialogOpenChange = useCallback((open: boolean) => {
    setShowMathDialog(open)
    if (!open) {
      setMathDialogLatex('')
      setMathDialogEditPos(null)
    }
  }, [])

  const handleMathConfirm = useCallback((latex: string) => {
    const editor = editorInstanceRef.current
    const next = latex.trim()
    if (!editor || !next) {
      handleMathDialogOpenChange(false)
      return
    }

    if (mathDialogEditPos != null) {
      const pos = mathDialogEditPos
      const node = editor.state.doc.nodeAt(pos)
      const mathNames = new Set(['mathematics', 'mathematicsBlock', 'math'])
      if (node && mathNames.has(node.type.name)) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: next })
            return true
          })
          .run()
      } else {
        editor.chain().focus().setLatex({ latex: next }).run()
      }
    } else {
      editor.chain().focus().setLatex({ latex: next }).run()
    }

    handleMathDialogOpenChange(false)
  }, [handleMathDialogOpenChange, mathDialogEditPos])

  // ── Drag handle → block action menu ──
  const handleDragHandleClick = useCallback((e: MouseEvent) => {
    const handle = closestElement(e.target, getTabDocDragHandleSelector(dragHandleIdRef.current))
    if (!handle) return
    const interactiveAncestor = closestElement(e.target, 'button, a, input, [role="button"], [role="menuitem"]')
    if (interactiveAncestor && interactiveAncestor !== handle && handle.contains(interactiveAncestor)) return
    const editor = editorInstanceRef.current
    if (!editor?.view) return
    e.preventDefault()
    e.stopPropagation()
    const next = resolveBlockMenuStateFromHandle(editor, handle)
    if (!next) return
    const closedRecently = blockMenuClosedRef.current
    if (closedRecently && closedRecently.nodePos === next.nodePos && Date.now() - closedRecently.time < 300) return
    setBlockMenuState(next)
  }, [])

  const handleBlockChatDragStart = useCallback((e: DragEvent) => {
    const chatContextDragType = editorConfig.chatContextDragType
    if (!chatContextDragType || !doc?.id || !e.dataTransfer) return

    const handle = closestElement(e.target, getTabDocDragHandleSelector(dragHandleIdRef.current))
    if (!handle) return

    const editor = editorInstanceRef.current
    if (!editor?.view) return

    try {
      let node: ProseMirrorNode | null = null
      const selection = editor.state.selection
      if (selection instanceof NodeSelection) {
        node = selection.node
      } else {
        const handleRect = handle.getBoundingClientRect()
        const editorRect = editor.view.dom.getBoundingClientRect()
        const posInfo = editor.view.posAtCoords({
          left: editorRect.left + 20,
          top: handleRect.top + handleRect.height / 2,
        })
        if (!posInfo) return

        const pos = posInfo.inside < 0 ? posInfo.pos : posInfo.inside
        const $pos = editor.state.doc.resolve(pos)
        const nodePos = $pos.depth > 0 ? $pos.before($pos.depth) : pos
        if (nodePos < 0 || nodePos >= editor.state.doc.content.size) return

        node = editor.state.doc.nodeAt(nodePos)
      }
      if (!node) return

      const payload = buildTabDocBlockChatPayload(doc, node)
      if (!payload) return

      e.dataTransfer.setData(chatContextDragType, JSON.stringify(payload))
    } catch {
      // Dragstart is owned by ProseMirror; context metadata must never crash it.
    }
  }, [doc, editorConfig.chatContextDragType])

  const handleBlockMenuClose = useCallback(() => {
    setBlockMenuState(prev => {
      if (prev) blockMenuClosedRef.current = { nodePos: prev.nodePos, time: Date.now() }
      return null
    })
  }, [])

  useEffect(() => {
    document.addEventListener('click', handleDragHandleClick)
    return () => document.removeEventListener('click', handleDragHandleClick)
  }, [handleDragHandleClick])

  useEffect(() => {
    // GlobalDragHandle clears DataTransfer in its target listener before writing
    // ProseMirror data, so append the chat MIME in bubble phase after it runs.
    document.addEventListener('dragstart', handleBlockChatDragStart)
    return () => document.removeEventListener('dragstart', handleBlockChatDragStart)
  }, [handleBlockChatDragStart])

  // ── Slash / Extensions ──
  const docUploadFn = useMemo(
    () => (doc?.id ? createEditorUploadFn(doc.id) : undefined),
    [doc?.id, createEditorUploadFn],
  )

  const mergedSlashActions = useMemo<SlashHostActions>(() => ({
    onRequestMathFormula: () => openMathDialog(),
    ...slashHostActions,
  }), [openMathDialog, slashHostActions])

  const editorExtensions = useMemo(() => {
    const dragHandleId = dragHandleIdRef.current
    const dragHandleSelector = getTabDocDragHandleSelector(dragHandleId)
    const slash = createSlashCommand(
      (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
      docUploadFn,
      mergedSlashActions,
      undefined,
      htmlUploadFn,
    )
    const collabLive = Boolean(isRealtimeCollab && ydoc)
    const hostExtras = Array.isArray(extraExtensions) ? extraExtensions : []
    const baseExtensions = [
      createEmptyDocumentPlaceholder(
        (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
      ),
      ...createEditableExtensions({
        dragHandleSelector,
        // 协作态由 Yjs 管文档；tiptap-markdown 与 Collaboration 双轨易把 htmlBlock 降格成段落
        disableMarkdown: collabLive,
        // Collaboration 自带 yUndoPlugin；保留 StarterKit History 会导致 Ctrl+Z 失效/乱撤
        disableHistory: collabLive,
      }),
      slash,
      createDocFindExtension(),
      ...hostExtras,
    ]
    if (!isRealtimeCollab || !ydoc) return baseExtensions
    return [...baseExtensions, ...createCollaborationExtensions(ydoc, hocuspocusProvider, collaborationUser)]
  }, [
    docUploadFn,
    htmlUploadFn,
    extraExtensions,
    mergedSlashActions,
    hocuspocusProvider,
    isRealtimeCollab,
    ydoc,
    collaborationUser?.id,
    collaborationUser?.name,
    collaborationUser?.color,
    collaborationUser?.type,
    t,
  ])

  const syncEditorWordCount = useCallback((editor: EditorInstance) => {
    setWordCount(countDocumentWords(editor.getText()))
  }, [])

  // ── Editor update ──
  const handleEditorUpdate = useCallback((editor: EditorInstance) => {
    editorInstanceRef.current = editor
    const { pmJson, markdown, repaired } = snapshotEditorContentWithRepair(editor)
    if (
      initialMarkdown.trim() &&
      !markdown.trim() &&
      !editor.isFocused &&
      !repaired
    ) {
      return
    }
    if (!isRealtimeCollabRef.current) {
      onEditorUpdateRef.current(markdown, pmJson)
    } else {
      onDraftSyncRef.current?.(markdown, pmJson)
    }
    syncEditorWordCount(editor)
    if (findOpen) recomputeFindMatches(findActiveIndex >= 0 ? findActiveIndex : 0, false)
    extractHeadingsDebounced()
  }, [extractHeadingsDebounced, findActiveIndex, findOpen, initialMarkdown, recomputeFindMatches, syncEditorWordCount])

  // ── Export (basic) ──
  const [exporting, setExporting] = useState(false)

  const triggerBlobDownload = useCallback((blob: Blob, filename: string) => {
    const sanitized = filename.replace(/[/\\?%*:|"<>]/g, '-').replace(/\.{2,}/g, '.')
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = sanitized
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }, [])

  const flushEditorContentBeforeExport = useCallback(async () => {
    const editor = editorInstanceRef.current
    const canEdit = toolbarExtraProps?.canEdit !== false
    if (!doc || !editor) return

    await flushEditorContentBeforeExportCore({
      client,
      documentId: doc.id,
      canEdit,
      getEditorSnapshot: () => {
        const liveEditor = editorInstanceRef.current
        if (!liveEditor) return null
        const snapshot = snapshotEditorContentWithRepair(liveEditor)
        return {
          pmJson: snapshot.pmJson,
          markdown: snapshot.markdown,
          plaintext: liveEditor.getText(),
        }
      },
      getSaveBaseline: () => {
        if (getSaveBaseline) return getSaveBaseline()
        return {
          baseVersion: doc.latest_version ?? null,
          baseUpdatedAt: doc.updated_at ?? null,
        }
      },
      applyBaseline: (updates) => {
        onContentFlushedBeforeExport?.(updates)
      },
    })
  }, [client, doc, getSaveBaseline, onContentFlushedBeforeExport, toolbarExtraProps?.canEdit])

  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!doc || exporting) return
    setExporting(true)
    let dismissExportToast: (() => void) | null = null
    try {
      const extMap: Record<string, string> = { markdown: '.md', html: '.html', txt: '.txt', docx: '.docx', pdf: '.pdf' }
      const dedupeExtension = (name: string, ext: string): string =>
        name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext

      const exportToastId = `tabdoc-export-${doc.id}`
      dismissExportToast = toast({
        id: exportToastId,
        title: t('exportInProgress'),
        description: undefined,
        action: undefined,
        variant: undefined,
        duration: 60_000,
      }).dismiss

      await flushEditorContentBeforeExport()

      if (format === 'docx' || format === 'pdf') {
        const { blob, filename } = await exportDocumentBlob(client, doc.id, format)
        triggerBlobDownload(blob, dedupeExtension(filename, extMap[format]))
      } else {
        const result = await exportDocument(client, doc.id, format)
        const blob = new Blob([result.content], { type: result.mime_type || 'text/plain;charset=utf-8' })
        const ext = extMap[format] || `.${format}`
        triggerBlobDownload(blob, result.filename ? dedupeExtension(result.filename, ext) : dedupeExtension(doc.title, ext))
      }
      toast({
        id: exportToastId,
        title: t('exportSuccess'),
        description: undefined,
        action: undefined,
        variant: undefined,
        duration: 4000,
      })
      dismissExportToast = null
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dismissExportToast?.()
        dismissExportToast = null
        return
      }
      toast({
        id: `tabdoc-export-${doc.id}`,
        title: t('exportFailed'),
        description: err instanceof Error ? err.message : undefined,
        action: undefined,
        variant: 'destructive',
      })
    } finally {
      setExporting(false)
    }
  }, [client, doc, t, exporting, flushEditorContentBeforeExport, triggerBlobDownload])

  // ── 文档展示偏好（字体 / 全宽 / 小字号）──
  // 全部走 onDocumentPropertyChange → metadataSaveQueue → PATCH，文档级共享、刷新保留。
  const smallTextEnabled = Boolean(
    (doc?.properties as Record<string, unknown> | undefined)?.small_text,
  )

  const handleSetFontStyle = useCallback((style: FontStyle) => {
    if (!doc || doc.font_style === style) return
    void onDocumentPropertyChange?.({ font_style: style })
  }, [doc, onDocumentPropertyChange])

  const handleToggleFullWidth = useCallback(() => {
    if (!doc) return
    void onDocumentPropertyChange?.({ is_full_width: !doc.is_full_width })
  }, [doc, onDocumentPropertyChange])

  const handleToggleSmallText = useCallback(() => {
    if (!doc) return
    const nextProperties = { ...(doc.properties ?? {}), small_text: !smallTextEnabled }
    void onDocumentPropertyChange?.({ properties: nextProperties })
  }, [doc, smallTextEnabled, onDocumentPropertyChange])

  // ── 拷贝页面内容（富文本 + Markdown → 剪贴板）──
  const handleCopyContent = useCallback(async () => {
    const editor = editorInstanceRef.current
    if (!editor) return
    const { pmJson, markdown } = snapshotEditorContentWithRepair(editor)
    try {
      await writePageContentToClipboard({ pmJson, markdown })
      toast({ title: t('copyContentSuccess', { defaultValue: '已复制页面内容' }) })
    } catch {
      toast({
        title: t('copyContentFailed', { defaultValue: '复制失败，请重试' }),
        variant: 'destructive',
      })
    }
  }, [t])

  // ── 工具栏「导入图片」：await 上传 + toast；插入走 insertUploadedImage ──
  const pendingImageInsertPosRef = useRef<number | null>(null)

  const prepareImportImage = useCallback(() => {
    const editor = editorInstanceRef.current
    if (!editor) {
      pendingImageInsertPosRef.current = null
      return
    }
    pendingImageInsertPosRef.current = editor.state.selection.from
  }, [])

  const handleImportFile = useCallback(async (file: File) => {
    if (!doc?.id) return
    const importKind = getTabDocImportFileKind(file.name, file.type)
    if (importKind !== 'image') {
      toast({
        title: t('imageTypeNotSupported', { defaultValue: '不支持的文件类型，请上传图片文件' }),
        variant: 'destructive',
      })
      return
    }
    const editor = editorInstanceRef.current
    if (!editor) {
      toast({
        title: t('importFailed', { defaultValue: '导入失败' }),
        description: t('documentNotReady', { defaultValue: '文档还没准备好，请稍后再试' }),
        variant: 'destructive',
      })
      return
    }
    if (file.size === 0) {
      toast({
        title: t('importEmptyFile', { defaultValue: '文件为空' }),
        description: t('importEmptyFileDesc', { defaultValue: '无法导入空文件' }),
        variant: 'destructive',
      })
      return
    }
    const maxImportSize = getTabDocImportMaxBytes(file.name, file.type)
    if (file.size > maxImportSize) {
      const maxImportSizeMb = Math.round(maxImportSize / 1024 / 1024)
      toast({
        title: t('importFileTooLarge', { defaultValue: '文件过大' }),
        description: t('importFileTooLargeByLimitDesc', {
          maxMb: maxImportSizeMb,
          defaultValue: `导入文件大小不能超过 ${maxImportSizeMb} MB，请精简内容后重试`,
        }),
        variant: 'destructive',
      })
      return
    }
    if (editorConfig.imageUpload.validate) {
      const { valid, reason, maxSizeLabel } = editorConfig.imageUpload.validate(file)
      if (!valid) {
        toast({
          title: t(
            reason?.startsWith('fileTooLarge') ? 'imageTooLarge' : 'imageTypeNotSupported',
            { maxSize: maxSizeLabel },
          ),
          variant: 'destructive',
        })
        return
      }
    }

    const docSize = editor.state.doc.content.size
    const storedPos = pendingImageInsertPosRef.current
    pendingImageInsertPosRef.current = null
    const pos = Math.max(0, Math.min(storedPos ?? editor.state.selection.from, docSize))
    editor.view.focus()

    // 工具栏需 await 以上报 loading/toast；插入与粘贴共用 insertUploadedImage。
    const toastId = `tabdoc-import-image-${doc.id}`
    toast({
      id: toastId,
      title: t('imageUploading', { defaultValue: '正在上传图片...' }),
      description: undefined,
      action: undefined,
      variant: undefined,
      duration: 60_000,
    })

    try {
      const uploaded = await uploadImageWithOfflineFallback(
        file,
        editorConfig.imageUpload,
        (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
        {
          folder: 'tabdoc/images',
          module: 'tabdoc',
          contextType: 'document',
          contextId: doc.id,
        },
      )
      if (!editor.schema.nodes.image) {
        throw new Error(t('imageUploadFailed', { defaultValue: '图片上传失败' }))
      }
      const insertPos = Math.max(0, Math.min(pos, editor.state.doc.content.size))
      insertUploadedImage(editor.view, insertPos, {
        src: uploaded.fileId ? '' : uploaded.url,
        fileId: uploaded.fileId || undefined,
        alt: file.name,
      })
      toast({
        id: toastId,
        title: t('importSuccess', { defaultValue: '导入成功' }),
        description: undefined,
        action: undefined,
        variant: undefined,
        duration: 4000,
      })
    } catch (err) {
      toast({
        id: toastId,
        title: t('imageUploadFailed', { defaultValue: '图片上传失败' }),
        description: err instanceof Error ? err.message : undefined,
        action: undefined,
        variant: 'destructive',
      })
    }
  }, [doc?.id, editorConfig.imageUpload, t])

  // ── Content normalization ──
  const initialEditorContent = useMemo(
    () => resolveInitialEditorContent(initialPmJson, initialMarkdown),
    [initialMarkdown, initialPmJson],
  )

  const suggestionItems = useMemo(
    () => getSuggestionItems(
      (key, options) => t(key, options) as string,
      docUploadFn,
      mergedSlashActions,
      undefined,
      htmlUploadFn,
    ),
    [t, docUploadFn, mergedSlashActions, htmlUploadFn],
  )

  const isApplePlatform = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
  }, [])

  // ── Editor props ──
  const editorProps = useMemo(() => ({
    // /#8483：正文 http(s) 链接点击交给宿主按附件预览 / tabweb 分流，
    // 不再直跳系统浏览器；其它点击放行（正常编辑）。
    // ：点击已有公式 → 打开飞书式公式编辑框。
    handleClick: (_view: unknown, _pos: number, event: MouseEvent): boolean => {
      const editor = editorInstanceRef.current
      if (editor?.isEditable) {
        const mathNode = resolveMathNodeAtEvent(editor, event)
        if (mathNode) {
          openMathDialog({ latex: mathNode.latex, editPos: mathNode.pos })
          return true
        }
      }

      const webInput = resolveTabDocWebLinkInput(event.target)
      if (!webInput) return false
      event.preventDefault()
      void hostActions.openWebUrl(webInput)
      return true
    },
    handleDOMEvents: {
      keydown: (view: EditorView, event: KeyboardEvent) => {
        const key = event.key.toLowerCase()
        const modPressed = isApplePlatform ? event.metaKey : event.ctrlKey
        if (isBodyStartTitleNavigationKey(event) && focusTitleFromBodyStart(view.state, titleInputRef.current, view.editable)) {
          event.preventDefault(); return true
        }
        if (modPressed && !event.shiftKey && !event.altKey && key === 'f') {
          event.preventDefault(); openFind(); return true
        }
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 's') {
          event.preventDefault(); onSaveVersion?.(); return true
        }
        if ((event.metaKey || event.ctrlKey) && key === 's') {
          event.preventDefault(); onManualSave(); return true
        }
        return handleCommandNavigation(event)
      },
    },
    // 注意：HTML 嵌入块只做「slash 上传」与「.html 文件拖拽」两个入口，粘贴（handlePaste）不拦截。
    // 剪贴板里的 text/html 是普通富文本粘贴的正常载荷（从网页 / 文档复制内容都带 text/html），
    // 若在此拦截会破坏最常见的富文本粘贴体验，得不偿失——所以粘贴沿用原有富文本/图片处理。
    handlePaste: createPasteHandler({
      getDocId: () => doc?.id,
      getEditorInstance: () => editorInstanceRef.current,
      createUploadFn: createEditorUploadFn,
      uploadFn: docUploadFn ?? (() => {}),
      handleImagePaste,
    }),
    handleDrop: (view: Parameters<typeof handleImageDrop>[0], event: Parameters<typeof handleImageDrop>[1], _slice: unknown, moved: boolean) => {
      if (tryHandleFileRefImageDrop(view, event, moved, editorConfig.fileRefDragType, t)) {
        return true
      }
      // 拖入 .html/.htm 文件 → 作为 HTML 嵌入块处理（在图片链路之前拦截）。
      // 只处理外部文件拖入（moved=false 排除编辑器内块拖动），且宿主须注入 htmlUpload。
      // 简化取舍：dataTransfer 里只要含 html 文件，就只处理 html 文件、忽略同批其它文件并 toast 提示，
      //   避免「图片 + html 混合批次」在两条上传链路间交织的复杂度（多文件混拖是低频场景）。
      if (!moved && htmlUploadFn) {
        const files = event.dataTransfer?.files
        if (files && files.length > 0) {
          const allFiles = Array.from(files)
          const htmlFiles = allFiles.filter((f) => isHtmlUploadFile(f))
          if (htmlFiles.length > 0) {
            event.preventDefault()
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            const basePos = coords
              ? (coords.inside >= 0 ? coords.inside : coords.pos)
              : view.state.selection.from
            // 多个 html 文件顺序上传，各自完成后按 basePos+序号落位（插入位置会在 htmlUploadFn 内 clamp）。
            htmlFiles.forEach((file, i) => htmlUploadFn(file, view, basePos + i))
            if (htmlFiles.length < allFiles.length) {
              toast({
                title: t('htmlBlock.dropMixedIgnored', {
                  defaultValue: '仅插入了 HTML 文件，已忽略同批拖入的其它文件',
                }),
              })
            }
            return true
          }
        }
      }
      const fn = doc?.id ? createEditorUploadFn(doc.id) : (docUploadFn ?? (() => {}))
      return handleImageDrop(view, event, moved, fn)
    },
    attributes: { class: 'font-sans focus:outline-none min-h-[50vh] pb-32' },
  }), [doc?.id, createEditorUploadFn, docUploadFn, htmlUploadFn, editorConfig.fileRefDragType, isApplePlatform, onManualSave, onSaveVersion, openFind, openMathDialog, hostActions, t])

  // ── Toolbar ──
  const toolbarProps: DocEditorToolbarProps = useMemo(() => ({
    doc,
    saveState,
    saveMessage,
    wordCount,
    showRevisions,
    exporting,
    waitingForSave: false,
    isOffline,
    onToggleRevisions,
    onExport: handleExport,
    onSetFontStyle: handleSetFontStyle,
    onToggleFullWidth: handleToggleFullWidth,
    onToggleSmallText: handleToggleSmallText,
    onCopyContent: handleCopyContent,
    onPrepareImportImage: prepareImportImage,
    onImportFile: handleImportFile,
    onOpenFind: openFind,
    ...toolbarExtraProps,
  }), [doc, saveState, saveMessage, wordCount, showRevisions, exporting, isOffline, onToggleRevisions, handleExport, handleSetFontStyle, handleToggleFullWidth, handleToggleSmallText, handleCopyContent, prepareImportImage, handleImportFile, openFind, toolbarExtraProps])

  // ── Keyboard ──
  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase()
    const modPressed = isApplePlatform ? event.metaKey : event.ctrlKey
    if (modPressed && !event.shiftKey && !event.altKey && key === 'f') {
      event.preventDefault()
      openFind()
    } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 's') {
      event.preventDefault(); onSaveVersion?.()
    } else if ((event.metaKey || event.ctrlKey) && key === 's') {
      event.preventDefault(); onManualSave()
    }
  }, [isApplePlatform, onManualSave, onSaveVersion, openFind])

  return {
    effectiveEditorKey,
    panelStableKey,
    isOffline,
    editorInstanceRef,
    editorDomRef,
    isRealtimeCollabRef,
    isCollabHydrateLoading,
    onEditorUpdateRef,
    onDraftSyncRef,

    titleValue, titleInputRef, handleTitleChange, handleTitlePaste, handleTitleBlur, handleTitleKeyDown,

    showIconPicker, setShowIconPicker, handleIconChange, handleRemoveIcon,
    coverInputRef, isUploadingCover, handleAddCoverPreset, handleCoverUpload,
    coverCropPreviewUrl, coverCropPositionX, setCoverCropPositionX, coverCropPosition, setCoverCropPosition,
    coverCropScale, setCoverCropScale, coverCropError,
    handleCancelCoverCrop, handleConfirmCoverCrop, handleRemoveCover,
    emojiCategories, showAllEmojis, setShowAllEmojis, emojiEntries,

    openNode, setOpenNode, openColor, setOpenColor, openLink, setOpenLink,
    blockMenuState, handleBlockMenuClose,
    wordCount,

    scrollRef, tocHeadings, extractHeadings,

    showMathDialog,
    mathDialogLatex,
    mathDialogEditPos,
    openMathDialog,
    setShowMathDialog: handleMathDialogOpenChange,
    handleMathConfirm,

    editorExtensions, handleEditorUpdate, syncEditorWordCount,
    initialEditorContent, dragHandleId: dragHandleIdRef.current,
    suggestionItems, docUploadFn, createEditorUploadFn,
    editorProps,

    exporting, handleExport, flushEditorContentBeforeExport, triggerBlobDownload,
    toolbarProps, handleContainerKeyDown,
    findOpen, findFocusRequest, findQuery, findMatches, findActiveIndex, findActiveTitleMatch,
    openFind, closeFind, setFindQuery, goToNextFindMatch, goToPreviousFindMatch,
    isRealtimeCollab,
  }
}
