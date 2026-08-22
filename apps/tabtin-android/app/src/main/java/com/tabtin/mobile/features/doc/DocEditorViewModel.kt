package com.tabtin.mobile.features.doc

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.doc.CommentAnchor
import com.tabtin.mobile.data.model.doc.CommentThread
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.doc.DocContent
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.features.doc.comment.DocCommentPresentation
import com.tabtin.mobile.features.doc.comment.DocCommentPresentationLabels
import com.tabtin.mobile.features.doc.comment.DocCommentWritePolicy
import com.tabtin.mobile.features.doc.comment.presentCommentThreads
import com.tabtin.mobile.features.doc.editor.DocEditorOrchestrator
import com.tabtin.mobile.features.doc.editor.TableProjectionLocalization
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineMarkKind
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.features.doc.model.NativeDocumentConflictRebasePolicy
import com.tabtin.mobile.features.doc.model.NativeDocumentSafetyPolicy
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableRow
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.oss.UploadConfig
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.DefaultDispatcher
import com.tabtin.mobile.util.IoDispatcher
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CoroutineDispatcher
import javax.inject.Inject

/** 文档保存状态 */
public enum class SaveState(@StringRes public val labelRes: Int) {
    IDLE(0),
    DIRTY(com.tabtin.mobile.R.string.doc_save_edited),
    SAVING(com.tabtin.mobile.R.string.doc_save_saving),
    SAVED(com.tabtin.mobile.R.string.doc_save_saved),
    FAILED(com.tabtin.mobile.R.string.doc_save_failed),
    CONFLICT(com.tabtin.mobile.R.string.doc_save_conflict_short),
    PERMISSION_DENIED(com.tabtin.mobile.R.string.doc_permission_revoked),
}

internal fun docDraftScope(userId: String?, organizationId: String?, documentId: String): String? {
    val user = userId?.takeIf(String::isNotBlank) ?: return null
    val organization = organizationId?.takeIf(String::isNotBlank) ?: return null
    if (documentId.isBlank()) return null
    return buildString(user.length + organization.length + documentId.length + 24) {
        append("u")
        append(user.length)
        append(":")
        append(user)
        append("|o")
        append(organization.length)
        append(":")
        append(organization)
        append("|d")
        append(documentId.length)
        append(":")
        append(documentId)
    }
}

/**
 * 文档编辑器 ViewModel —— 连接 RecyclerView Adapter 与数据层的核心。
 *
 * 内部持有 DocBlock 列表（ProseMirror 数据模型），
 * 通过 BlockViewConverter 转换为 TabDocBlockView 列表供 UI 消费。
 */
@HiltViewModel
public class DocEditorViewModel @Inject constructor(
    private val docRepository: DocRepository,
    private val ossUploadService: OSSUploadService,
    private val tokenManager: TokenManager,
    private val streamManager: StreamManager,
    @ApplicationContext private val appContext: Context,
    savedStateHandle: SavedStateHandle,
    // W A0.3.续7：dispatcher 注入治本，让 saveIfNeeded/loadDocument/checkAndRestoreDraft 内
    // `withContext(coroutineDispatcher)` 在 unit test 的 runTest 上下文里仍可被
    // `advanceTimeBy/advanceUntilIdle` 调度。生产由 Hilt 注入 Dispatchers.Default
    // (DispatcherModule.provideDefaultDispatcher)，测试 createVm 显式传 testDispatcher。
    @DefaultDispatcher private val coroutineDispatcher: CoroutineDispatcher = Dispatchers.Default,
    // W D（2026-05-04）：IO dispatcher 注入。覆盖 onImagePicked 内 OSS 上传前的 file IO
    // 路径（resolver.openFileDescriptor / readBytes，line ~1089）。生产由 Hilt 注入
    // Dispatchers.IO (DispatcherModule.provideIoDispatcher)，测试 createVm 显式传 testDispatcher
    // 让 advanceUntilIdle 推进到 OSS 上传完成。详见 docs/Android-coroutines-conventions.md §3。
    @IoDispatcher private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val documentId: String = savedStateHandle["documentId"]
        ?: savedStateHandle["resourceId"]
        ?: ""
    private val routeOrganizationId: String? = savedStateHandle["organizationId"]
    private val draftUserId: String? = tokenManager.userId?.takeIf(String::isNotBlank)
    private val initialDraftOrganizationId: String? = routeOrganizationId?.takeIf(String::isNotBlank)
        ?: tokenManager.organizationId?.takeIf(String::isNotBlank)

    // ── 内部状态 ──────────────────────────────────────────────────────

    /** ProseMirror 数据模型 —— 真正的编辑状态 */
    private var blocks = mutableListOf<DocBlock>()
    /**
     * 远端 ProseMirror 文档根。编辑只替换 content，根级 type / attrs / 扩展键必须原样流转。
     * 新建或旧测试未经过远端加载时为 null，保存退回 canonical `{type: "doc"}`。
     */
    private var documentEnvelope: ProseMirrorParser.ParsedDocument? = null
    /**
     * 最后一次已由远端确认的文档，blocks 保留对应保存快照的运行期 id。
     * 它与 [documentEnvelope] 分离：后者可能承载保存期间继续产生的本地编辑，不能作为
     * 后续 409 的 committed baseline。
     */
    private var lastAcknowledgedDocument: ProseMirrorParser.ParsedDocument? = null
    private var documentTitle = ""
    private var document: Doc? = null
    private var content: DocContent? = null
    /** 下一次写入使用的远端 CAS 基线；冲突重查后可以推进到最新版本。 */
    private var saveBaseVersion: Int? = null
    private var saveBaseUpdatedAt: String? = null
    /**
     * 当前未保存草稿产生时的远端基线。
     *
     * 它与写入 CAS 基线有意分离：409 或写入 403 后可以用最新远端版本继续本次会话，
     * 但落盘草稿必须保留最初分叉点。进程重建后才能再次识别远端变化并停在冲突态。
     */
    private var draftOriginBaseVersion: Int? = null
    private var draftOriginBaseUpdatedAt: String? = null

    /** 焦点与光标 */
    private var focusedBlockId: String? = null
    private var cursorPosition: Int? = null
    /** 选区范围 —— 用于格式操作 */
    private var selectionStart: Int = 0
    private var selectionEnd: Int = 0
    /** Slash 命令的 "/" 字符在文本中的起始位置 */
    private var slashStartPosition: Int = -1

    // ── UI 状态 ──────────────────────────────────────────────────────

    public data class UiState(
        val documentId: String = "",
        val title: String = "",
        val organizationId: String = "",
        val spaceId: String? = null,
        val currentUserRole: String? = null,
        val blockViews: List<TabDocBlockView> = emptyList(),
        val isLoading: Boolean = true,
        @StringRes val errorRes: Int? = null,
        val saveState: SaveState = SaveState.IDLE,
        val conflictMessage: String? = null,
        // Slash 菜单
        val showSlashMenu: Boolean = false,
        val slashFilter: String = "",
        val slashBlockId: String? = null,
        // 格式工具栏
        val showFormatToolbar: Boolean = false,
        val activeMarks: Set<InlineMarkKind> = emptySet(),
        val activeTextColor: String = "",
        val activeHighlight: String = "",
        // 颜色选择弹窗
        val showTextColorPicker: Boolean = false,
        val showHighlightPicker: Boolean = false,
        // Undo/Redo
        val canUndo: Boolean = false,
        val canRedo: Boolean = false,
        // 块操作菜单
        val showBlockActionMenu: Boolean = false,
        val actionBlockEditable: Boolean = true,
        val actionBlockCanDeleteWholeBlock: Boolean = true,
        val actionBlockId: String? = null,
        val actionBlockKind: BlockKind? = null,
        val actionBlockIsFirst: Boolean = false,
        val actionBlockIsLast: Boolean = false,
        // 代码块语言选择
        val showLanguageSelector: Boolean = false,
        val languageSelectorBlockId: String? = null,
        val currentCodeLanguage: String = "",
        // 块选区
        val isSelectionMode: Boolean = false,
        val selectedBlockIds: Set<String> = emptySet(),
        // 权限
        val isPermissionRevoked: Boolean = false,
        val isReadOnlyByRole: Boolean = false,
        /** 当前 ProseMirror 结构超出原生无损编辑范围；内容可查看但必须去完整编辑器修改。 */
        val requiresFullEditor: Boolean = false,
        // Agent 执行冲突防护
        val isAgentEditing: Boolean = false,
        // 版本历史
        val showVersionHistory: Boolean = false,
        val versionHistories: List<com.tabtin.mobile.data.model.doc.DocHistoryEntry> = emptyList(),
        val isLoadingHistories: Boolean = false,
        val isRestoringHistory: Boolean = false,
        /** 初载暂态失败时恢复的本地草稿；远端权限与版本未知，因此只能查看/复制。 */
        val isOfflineDraftPreview: Boolean = false,
        val commentThreads: List<CommentThread> = emptyList(),
        val commentPresentations: List<DocCommentPresentation> = emptyList(),
        val canCreateComment: Boolean = false,
        val isLoadingComments: Boolean = false,
        val isPostingComment: Boolean = false,
        val showBlockCommentComposer: Boolean = false,
        val commentComposerBlockRuntimeId: String? = null,
        val documentCommentDraft: String = "",
        val blockCommentDraft: String = "",
    )

    public sealed class EditorEvent {
        public data class CopyToClipboard(val text: String) : EditorEvent()
        public data class PickImage(val blockId: String) : EditorEvent()
        public data class ConfirmBulkDelete(val count: Int) : EditorEvent()
        public data object ConfirmDiscardDraftForFullEditor : EditorEvent()
        public data class ShowToast(@StringRes val messageRes: Int) : EditorEvent()
        public data object OpenFullEditor : EditorEvent()
    }

    private val _uiState = MutableStateFlow(UiState(documentId = documentId))
    public val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    private val _events = MutableSharedFlow<EditorEvent>(extraBufferCapacity = 4)
    public val events: SharedFlow<EditorEvent> = _events.asSharedFlow()

    /** 只负责 1.2 秒输入防抖；进入网络层前可安全取消。 */
    private var autosaveJob: Job? = null
    /** 已发出的保存请求必须 single-flight，后续编辑只能合并，不能取消。 */
    private var saveJob: Deferred<Boolean>? = null
    private var retryCount = 0
    private var retryJob: Job? = null
    private var draftSaveJob: Job? = null
    private var permissionCheckJob: Job? = null
    private var loadJob: Job? = null
    private var commentLoadJob: Job? = null
    private var commentPostJob: Job? = null
    private data class ImageDisplayUrlRequest(val blockId: String, val fileId: String)

    /** fileId 只用于换取运行期展示地址；结果以 block runtime id + fileId 二次校验。 */
    private val imageDisplayUrlJobs = mutableMapOf<ImageDisplayUrlRequest, Job>()
    /**
     * 所有会回写文档正文、版本或权限的异步操作共用同一代际。
     *
     * Web 回程刷新、自动保存和权限轮询可能交错；旧响应只有在代际仍匹配时才能落地，
     * 避免较早的 Web 快照覆盖较新的本地编辑或保存结果。
     */
    private var documentOperationGeneration = 0L
    /** 仅在当前文档会话被明确废弃时推进；普通编辑不能使保存回执失效。 */
    private var saveSessionGeneration = 0L
    /** 每次本地编辑单调推进，用来判断保存期间是否又产生了更新内容。 */
    private var localEditRevision = 0L
    /** 请求可能已落库但成功响应丢失时，供下一次 409 识别自己的远端快照。 */
    private var unacknowledgedSave: SaveAttempt? = null

    private val draftPrefs: SharedPreferences by lazy {
        appContext.getSharedPreferences(DRAFT_PREFS_NAME, Context.MODE_PRIVATE)
    }

    // ── Undo/Redo ──────────────────────────────────────────────────────

    private data class EditorSnapshot(
        val blocks: List<DocBlock>,
        val title: String,
        val focusedBlockId: String?,
        val cursorPosition: Int?,
    )

    private data class SaveAttempt(
        val revision: Long,
        val title: String,
        val blocks: List<DocBlock>,
        val content: DocContent,
        val baseVersion: Int?,
        val baseUpdatedAt: String?,
        val sessionGeneration: Long,
    )

    private val undoStack = ArrayDeque<EditorSnapshot>()
    private val redoStack = ArrayDeque<EditorSnapshot>()

    /** 文本输入 debounce：首次按键时捕获的快照，500ms 无输入后推入 undoStack */
    private var pendingUndoSnapshot: EditorSnapshot? = null
    private var textUndoJob: Job? = null

    /**
     * 文本输入专用：首次按键捕获快照，后续按键仅重置定时器。
     * 必须在修改 blocks/documentTitle **之前** 调用。
     */
    private fun scheduleTextUndo() {
        if (pendingUndoSnapshot == null) {
            pendingUndoSnapshot = EditorSnapshot(blocks.toList(), documentTitle, focusedBlockId, cursorPosition)
        }
        textUndoJob?.cancel()
        textUndoJob = viewModelScope.launch {
            delay(TEXT_UNDO_DEBOUNCE_MS)
            flushPendingUndo()
        }
    }

    /**
     * 将 debounce 中暂存的文本快照立即推入 undoStack。
     * 由定时器到期、或非文本操作（pushUndo）触发。
     */
    private fun flushPendingUndo() {
        val snapshot = pendingUndoSnapshot ?: return
        pendingUndoSnapshot = null
        textUndoJob?.cancel()
        textUndoJob = null
        undoStack.addLast(snapshot)
        if (undoStack.size > MAX_UNDO_HISTORY) undoStack.removeFirst()
        redoStack.clear()
        _uiState.update { it.copy(canUndo = true, canRedo = false) }
    }

    private fun pushUndo() {
        flushPendingUndo()
        undoStack.addLast(EditorSnapshot(blocks.toList(), documentTitle, focusedBlockId, cursorPosition))
        if (undoStack.size > MAX_UNDO_HISTORY) undoStack.removeFirst()
        redoStack.clear()
        _uiState.update { it.copy(canUndo = true, canRedo = false) }
    }

    public fun undo() {
        if (!canMutate()) return
        flushPendingUndo()
        val snapshot = undoStack.removeLastOrNull() ?: return
        redoStack.addLast(EditorSnapshot(blocks.toList(), documentTitle, focusedBlockId, cursorPosition))
        restoreSnapshot(snapshot)
        _uiState.update { it.copy(title = documentTitle, canUndo = undoStack.isNotEmpty(), canRedo = true) }
        refreshBlockViews()
        scheduleSave()
    }

    public fun redo() {
        if (!canMutate()) return
        flushPendingUndo()
        val snapshot = redoStack.removeLastOrNull() ?: return
        undoStack.addLast(EditorSnapshot(blocks.toList(), documentTitle, focusedBlockId, cursorPosition))
        restoreSnapshot(snapshot)
        _uiState.update { it.copy(title = documentTitle, canUndo = true, canRedo = redoStack.isNotEmpty()) }
        refreshBlockViews()
        scheduleSave()
    }

    private fun restoreSnapshot(snapshot: EditorSnapshot) {
        blocks = snapshot.blocks.toMutableList()
        documentTitle = snapshot.title
        focusedBlockId = snapshot.focusedBlockId
        cursorPosition = snapshot.cursorPosition
    }

    init {
        loadDocument()
        observeAgentPhase()
    }

    private fun observeAgentPhase() {
        viewModelScope.launch {
            streamManager.currentPhase.collect { phase ->
                val editing = phase == AgentPhase.EXECUTING || phase == AgentPhase.PLANNING
                _uiState.update { it.copy(isAgentEditing = editing) }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        autosaveJob?.cancel()
        saveJob?.cancel()
        retryJob?.cancel()
        draftSaveJob?.cancel()
        textUndoJob?.cancel()
        permissionCheckJob?.cancel()
        loadJob?.cancel()
        commentLoadJob?.cancel()
        commentPostJob?.cancel()
        imageDisplayUrlJobs.values.forEach(Job::cancel)
        imageDisplayUrlJobs.clear()
        val state = _uiState.value.saveState
        if (hasCurrentDraftIdentity() &&
            (state == SaveState.DIRTY || state == SaveState.SAVING ||
                state == SaveState.FAILED || state == SaveState.CONFLICT)
        ) {
            persistDraft(sync = true)
        }
    }

    // ── 文档加载 ─────────────────────────────────────────────────────

    public fun reload(): Unit = loadDocument(preserveLocalDraft = document != null)

    /** Web 完整模式可能改正文、标题、版本和权限；回到原生页时必须重拉完整 detail。 */
    public fun refreshOnResume() {
        if (_uiState.value.isPermissionRevoked) return
        // 首次进入页面时 LifecycleResumeEffect 会与 init 同时触发；保留 init 加载，
        // 让它有机会恢复磁盘草稿，而不是用“回程刷新”取消它并跳过草稿恢复。
        if (document == null && loadJob?.isActive == true) return
        loadDocument(preserveLocalDraft = document != null)
    }

    private fun loadDocument(preserveLocalDraft: Boolean = false) {
        if (documentId.isEmpty()) return
        if (_uiState.value.isPermissionRevoked) return
        if (!hasCurrentRouteIdentity()) {
            handlePermissionRevoked()
            return
        }
        val generation = ++documentOperationGeneration
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = if (preserveLocalDraft) it.isLoading else true,
                    errorRes = null,
                )
            }
            try {
                val detail = docRepository.getDocumentDetail(documentId)
                if (generation != documentOperationGeneration) return@launch
                if (!hasCurrentRouteIdentity() || !hasMatchingOrganization(detail.document.organizationId)) {
                    handlePermissionRevoked()
                    return@launch
                }
                if (detail.document.id != documentId) {
                    handleMismatchedDocumentResponse(persistCurrentState = preserveLocalDraft)
                    return@launch
                }
                val projection = projectRemoteContent(detail.content)
                if (generation != documentOperationGeneration) return@launch
                if (!hasCurrentRouteIdentity() || !hasMatchingOrganization(detail.document.organizationId)) {
                    handlePermissionRevoked()
                    return@launch
                }
                applyRemoteDetail(detail, projection, preserveLocalDraft)
                if (!preserveLocalDraft) checkAndRestoreDraft(generation)
                loadCommentThreads(generation)
                startPermissionCheckIfNeeded()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (generation != documentOperationGeneration) return@launch
                if (isPermissionDenied(e)) {
                    handlePermissionRevoked()
                    return@launch
                }
                if (!preserveLocalDraft && restoreDraftForOfflinePreview(generation)) return@launch
                _uiState.update {
                    it.copy(
                        errorRes = com.tabtin.mobile.R.string.doc_error_load_failed,
                        isLoading = false,
                    )
                }
            } finally {
                if (generation == documentOperationGeneration) loadJob = null
            }
        }
    }

    private data class RemoteContentProjection(
        val documentEnvelope: ProseMirrorParser.ParsedDocument,
        val requiresFullEditor: Boolean,
    )

    private suspend fun projectRemoteContent(remoteContent: DocContent): RemoteContentProjection {
        val rootContent = remoteContent.descriptionJson["content"]
        val sourceDocument = withContext(coroutineDispatcher) {
            ProseMirrorParser.parseDocument(remoteContent.descriptionJson)
        }
        var parsed = sourceDocument.blocks
        val restoredFromMarkdown = rootContent == null &&
            remoteContent.descriptionMarkdown.isNotBlank() &&
            parsed.isEmpty()
        if (restoredFromMarkdown) {
            parsed = withContext(coroutineDispatcher) {
                ProseMirrorParser.parseMarkdownFallback(remoteContent.descriptionMarkdown)
            }
        }
        // 批次 1b：内容复杂度不再让整篇只读。parser 已逐块判定可编辑性，
        // 复杂块（合并单元格表格、未知节点、未知 mark 段落等）局部只读并保留
        // 原始子树。只有当「一个可原生变更的块都没有」时才整体交给完整编辑器；
        // 已有正典独立图片虽不可替换，仍可在原生界面无损删除整块引用。
        val requiresFullEditor = when {
            parsed.isNotEmpty() -> parsed.none { it.canDeleteWholeBlock }
            restoredFromMarkdown -> false
            isUnambiguouslyEmptyDocument(remoteContent) -> false
            // content 为明确空数组同样是安全的空文档（旧行为由 canEditWithoutLoss 覆盖）。
            (remoteContent.descriptionJson["content"] as? JsonArray)?.isEmpty() == true -> false
            else -> true
        }
        val projectedBlocks = parsed.ifEmpty { listOf(DocBlock.empty(BlockKind.PARAGRAPH)) }
        return RemoteContentProjection(
            documentEnvelope = sourceDocument.copy(blocks = projectedBlocks),
            requiresFullEditor = requiresFullEditor,
        )
    }

    /**
     * 新建文档与 iOS 一样可能收到 `{}` / `{"type":"doc"}`，此时三个正文投影都为空
     * 才能确认它是一份真正的空文档。任一旧投影仍有内容时继续只读，避免首次输入覆盖正文。
     */
    private fun isUnambiguouslyEmptyDocument(remoteContent: DocContent): Boolean {
        if (remoteContent.descriptionMarkdown.isNotBlank() ||
            remoteContent.descriptionPlaintext.isNotBlank()
        ) return false
        val document = remoteContent.descriptionJson
        if (document.keys.any { it != "type" }) return false
        val type = document["type"] ?: return true
        return (type as? JsonPrimitive)?.contentOrNull == "doc"
    }

    private fun applyRemoteDetail(
        detail: com.tabtin.mobile.data.model.doc.DocDetailResponse,
        projection: RemoteContentProjection,
        preserveLocalDraft: Boolean,
    ) {
        val state = _uiState.value
        val hasLocalDraft = preserveLocalDraft && state.saveState in LOCAL_DRAFT_STATES
        val remoteChanged = hasLocalDraft && remoteChangedSinceDraft(detail.document)

        document = detail.document
        content = detail.content
        lastAcknowledgedDocument = projection.documentEnvelope
        if (!detail.document.canEdit || projection.requiresFullEditor) {
            invalidateSaveSession()
        }

        if (hasLocalDraft) {
            if (documentEnvelope == null) documentEnvelope = projection.documentEnvelope
            // 远端 detail 是本会话后续显式保存的 CAS 基线；草稿 origin 仍保留分叉前版本。
            saveBaseVersion = detail.document.latestVersion
            saveBaseUpdatedAt = detail.document.updatedAt
            val nextSaveState = when {
                state.saveState == SaveState.CONFLICT || remoteChanged -> SaveState.CONFLICT
                state.saveState == SaveState.SAVING -> SaveState.DIRTY
                else -> state.saveState
            }
            _uiState.update {
                it.copy(
                    organizationId = detail.document.organizationId,
                    spaceId = detail.document.spaceId,
                    currentUserRole = detail.document.currentUserRole,
                    isLoading = false,
                    errorRes = null,
                    saveState = nextSaveState,
                    conflictMessage = if (nextSaveState == SaveState.CONFLICT) {
                        appContext.getString(R.string.doc_save_conflict)
                    } else it.conflictMessage,
                    requiresFullEditor = projection.requiresFullEditor,
                    isReadOnlyByRole = !detail.document.canEdit,
                )
            }
            if (nextSaveState == SaveState.CONFLICT || !detail.document.canEdit || projection.requiresFullEditor) {
                persistDraft(sync = false)
            }
            return
        }

        invalidateSaveSession()
        draftSaveJob?.cancel()
        draftSaveJob = null
        textUndoJob?.cancel()
        textUndoJob = null
        pendingUndoSnapshot = null
        undoStack.clear()
        redoStack.clear()
        documentEnvelope = projection.documentEnvelope
        blocks = projection.documentEnvelope.blocks.toMutableList()
        documentTitle = detail.document.title
        saveBaseVersion = detail.document.latestVersion
        saveBaseUpdatedAt = detail.document.updatedAt
        draftOriginBaseVersion = detail.document.latestVersion
        draftOriginBaseUpdatedAt = detail.document.updatedAt
        localEditRevision = 0L
        focusedBlockId = blocks.firstOrNull()?.id
        cursorPosition = null
        _uiState.update {
            it.copy(
                title = documentTitle,
                organizationId = detail.document.organizationId,
                spaceId = detail.document.spaceId,
                currentUserRole = detail.document.currentUserRole,
                isLoading = false,
                errorRes = null,
                saveState = SaveState.IDLE,
                conflictMessage = null,
                requiresFullEditor = projection.requiresFullEditor,
                isReadOnlyByRole = !detail.document.canEdit,
                isOfflineDraftPreview = false,
                canUndo = false,
                canRedo = false,
            )
        }
        refreshBlockViews()
        refreshCommentUi()
    }

    // ── 文档保存 ─────────────────────────────────────────────────────

    public fun saveDocument() {
        viewModelScope.launch { flushPendingSaves(retryFailed = true) }
    }

    /**
     * 退出编辑面前收口所有待保存内容。网络失败时草稿已经同步落盘，调用方可以决定
     * 留在页面还是明确带着本地草稿离开。
     */
    public suspend fun flush(): Boolean {
        cancelPendingAutosave()
        retryJob?.cancel()
        retryJob = null
        if (_uiState.value.saveState in LOCAL_DRAFT_STATES) persistDraft(sync = true)
        return flushPendingSaves(retryFailed = true)
    }

    /** 退后台不阻塞生命周期回调：先同步保草稿，再让当前 ViewModel 尽力排空保存队列。 */
    public fun flushForLifecycle() {
        val state = _uiState.value.saveState
        if (state in LOCAL_DRAFT_STATES) persistDraft(sync = true)
        cancelPendingAutosave()
        if (state == SaveState.DIRTY || state == SaveState.SAVING || state == SaveState.FAILED) {
            viewModelScope.launch { flushPendingSaves(retryFailed = true) }
        }
    }

    private fun cancelPendingAutosave() {
        autosaveJob?.cancel()
        autosaveJob = null
    }

    /** 权限、资源或编辑表面被明确替换时，旧保存回执不得再更新当前会话。 */
    private fun invalidateSaveSession() {
        saveSessionGeneration++
        cancelPendingAutosave()
        saveJob?.cancel()
        saveJob = null
        retryJob?.cancel()
        retryJob = null
        unacknowledgedSave = null
    }

    private suspend fun flushPendingSaves(retryFailed: Boolean): Boolean {
        saveJob?.let { return it.await() }

        if (_uiState.value.saveState == SaveState.FAILED && retryFailed) {
            retryJob?.cancel()
            retryJob = null
            _uiState.update { it.copy(saveState = SaveState.DIRTY, conflictMessage = null) }
        }
        when (_uiState.value.saveState) {
            SaveState.IDLE, SaveState.SAVED -> return true
            SaveState.DIRTY -> Unit
            SaveState.SAVING -> return saveJob?.await() ?: false
            SaveState.FAILED, SaveState.CONFLICT, SaveState.PERMISSION_DENIED -> return false
        }

        val sessionGeneration = saveSessionGeneration
        lateinit var task: Deferred<Boolean>
        task = viewModelScope.async(start = CoroutineStart.LAZY) {
            try {
                while (sessionGeneration == saveSessionGeneration) {
                    when (_uiState.value.saveState) {
                        SaveState.DIRTY -> if (!saveIfNeeded()) return@async false
                        SaveState.IDLE, SaveState.SAVED -> return@async true
                        SaveState.SAVING -> return@async false
                        SaveState.FAILED, SaveState.CONFLICT, SaveState.PERMISSION_DENIED -> {
                            return@async false
                        }
                    }
                }
                false
            } finally {
                if (saveJob === task) saveJob = null
            }
        }
        saveJob = task
        task.start()
        return task.await()
    }

    /** 离线预览只提供取回内容，不建立任何写入路径。 */
    public fun copyOfflineDraft() {
        if (!_uiState.value.isOfflineDraftPreview) return
        val body = ProseMirrorParser.blocksToPlaintext(blocks.toList()) { cell ->
            TableProjectionLocalization.cellText(appContext, cell)
        }
        val text = listOf(documentTitle, body).filter(String::isNotBlank).joinToString("\n\n")
        if (text.isNotBlank()) _events.tryEmit(EditorEvent.CopyToClipboard(text))
    }

    /**
     * 切到 Web 前先收口原生写入。脏内容只有保存成功才直接放行；失败/冲突时保留草稿，
     * 并要求用户明确确认放弃后才打开完整编辑器。
     */
    public fun requestOpenFullEditor() {
        viewModelScope.launch {
            if (_uiState.value.isOfflineDraftPreview && hasCurrentRouteIdentity()) {
                _events.emit(EditorEvent.ConfirmDiscardDraftForFullEditor)
                return@launch
            }
            if (!hasCurrentDocumentIdentity()) {
                handlePermissionRevoked()
                return@launch
            }
            when (_uiState.value.saveState) {
                SaveState.DIRTY, SaveState.SAVING, SaveState.FAILED -> {
                    if (flush()) {
                        _events.emit(EditorEvent.OpenFullEditor)
                    } else {
                        _events.emit(EditorEvent.ConfirmDiscardDraftForFullEditor)
                    }
                }
                SaveState.CONFLICT -> {
                    persistDraft(sync = true)
                    _events.emit(EditorEvent.ConfirmDiscardDraftForFullEditor)
                }
                SaveState.IDLE, SaveState.SAVED -> {
                    cancelPendingAutosave()
                    retryJob?.cancel()
                    retryJob = null
                    _events.emit(EditorEvent.OpenFullEditor)
                }
                SaveState.PERMISSION_DENIED -> Unit
            }
        }
    }

    /**
     * 用户已明确选择放弃当前文档的本地草稿。只清理当前 user/org/document scope；
     * 同步删除成功后才离开，避免 SharedPreferences apply 失败造成静默丢稿。
     */
    public fun discardDraftAndOpenFullEditor() {
        viewModelScope.launch {
            val canDiscardOfflinePreview = _uiState.value.isOfflineDraftPreview && hasCurrentRouteIdentity()
            if (!canDiscardOfflinePreview && !hasCurrentDocumentIdentity()) {
                handlePermissionRevoked()
                return@launch
            }
            invalidateSaveSession()
            draftSaveJob?.cancel()
            draftSaveJob = null
            textUndoJob?.cancel()
            textUndoJob = null
            pendingUndoSnapshot = null

            if (!clearDraftSynchronously()) {
                _events.emit(EditorEvent.ShowToast(R.string.doc_full_editor_discard_failed))
                return@launch
            }
            retryCount = 0
            applyDiscardedDraftRemoteBaseline()
            _events.emit(EditorEvent.OpenFullEditor)
        }
    }

    /**
     * 用户从版本冲突页确认离开：先同步清掉当前文档草稿，下次打开才会落到云端最新版。
     * 不清稿就返回会把冲突草稿写回，再进文档仍是分叉内容。
     */
    public fun discardLocalDraft(): Boolean {
        val canDiscardOfflinePreview = _uiState.value.isOfflineDraftPreview && hasCurrentRouteIdentity()
        if (!canDiscardOfflinePreview && !hasCurrentDocumentIdentity()) {
            handlePermissionRevoked()
            return false
        }
        invalidateSaveSession()
        draftSaveJob?.cancel()
        draftSaveJob = null
        textUndoJob?.cancel()
        textUndoJob = null
        pendingUndoSnapshot = null
        if (!clearDraftSynchronously()) {
            return false
        }
        retryCount = 0
        applyDiscardedDraftRemoteBaseline()
        return true
    }

    private fun applyDiscardedDraftRemoteBaseline() {
        val remoteDocument = lastAcknowledgedDocument
        if (remoteDocument != null) {
            applyDocumentEnvelope(remoteDocument)
            documentTitle = document?.title ?: documentTitle
            draftOriginBaseVersion = saveBaseVersion
            draftOriginBaseUpdatedAt = saveBaseUpdatedAt
            refreshBlockViews()
        }
        _uiState.update {
            it.copy(
                title = documentTitle,
                saveState = SaveState.IDLE,
                conflictMessage = null,
            )
        }
    }

    private fun scheduleSave() {
        if (_uiState.value.requiresFullEditor || _uiState.value.isPermissionRevoked ||
            _uiState.value.isOfflineDraftPreview
        ) return
        // 编辑发生后，任何更早发出的 Web 回程/权限快照都不能再覆盖本地内容。
        documentOperationGeneration++
        localEditRevision++
        _uiState.update { it.copy(saveState = SaveState.DIRTY, conflictMessage = null) }
        retryCount = 0
        retryJob?.cancel()
        retryJob = null
        cancelPendingAutosave()
        autosaveJob = viewModelScope.launch {
            delay(AUTOSAVE_DELAY_MS)
            autosaveJob = null
            flushPendingSaves(retryFailed = false)
        }
        scheduleDraftPersist()
    }

    private fun canMutate(): Boolean {
        if (_uiState.value.requiresFullEditor ||
            _uiState.value.isPermissionRevoked ||
            _uiState.value.isOfflineDraftPreview ||
            _uiState.value.saveState == SaveState.CONFLICT ||
            document?.canEdit == false
        ) return false
        if (!hasCurrentDocumentIdentity()) {
            handlePermissionRevoked()
            return false
        }
        return true
    }

    private suspend fun saveIfNeeded(allowEquivalentConflictRebase: Boolean = true): Boolean {
        if (_uiState.value.isPermissionRevoked || _uiState.value.requiresFullEditor ||
            _uiState.value.isOfflineDraftPreview
        ) return false
        if (document?.canEdit == false) return false
        if (!hasCurrentDocumentIdentity()) {
            handlePermissionRevoked()
            return false
        }
        if (_uiState.value.saveState != SaveState.DIRTY) {
            return _uiState.value.saveState == SaveState.SAVED ||
                _uiState.value.saveState == SaveState.IDLE
        }
        // 只用于让更早发起的详情读取失效；普通编辑不再使本次保存回执失效。
        documentOperationGeneration++
        val attemptRevision = localEditRevision
        val attemptSessionGeneration = saveSessionGeneration
        val attemptBaseVersion = saveBaseVersion
        val attemptBaseUpdatedAt = saveBaseUpdatedAt
        _uiState.update { it.copy(saveState = SaveState.SAVING) }
        val snapshot = blocks.toList()
        val documentEnvelopeSnapshot = documentEnvelope
        val titleSnapshot = documentTitle
        var attempt: SaveAttempt? = null
        try {
            // W A0.3.续6：三次序列化（serialize / blocksToMarkdown / blocksToPlaintext）合并到 1 次
            // withContext(coroutineDispatcher)，避免长文档 1000+ blocks 在 Main 阻塞掉帧。
            // snapshot 已在 Main 抓取（避免 mutableList race），序列化期间 blocks 继续被编辑不影响。
            // W A0.3.续7：dispatcher 改为注入参数，让 testDispatcher 可控制序列化任务调度。
            val (pmJson, markdown, plaintext) = withContext(coroutineDispatcher) {
                Triple(
                    serializeEditorDocument(snapshot, documentEnvelopeSnapshot),
                    ProseMirrorParser.blocksToMarkdown(snapshot),
                    ProseMirrorParser.blocksToPlaintext(snapshot),
                )
            }
            val currentAttempt = SaveAttempt(
                revision = attemptRevision,
                title = titleSnapshot,
                blocks = snapshot,
                content = DocContent(
                    descriptionJson = pmJson,
                    descriptionMarkdown = markdown,
                    descriptionPlaintext = plaintext,
                ),
                baseVersion = attemptBaseVersion,
                baseUpdatedAt = attemptBaseUpdatedAt,
                sessionGeneration = attemptSessionGeneration,
            )
            attempt = currentAttempt
            if (currentAttempt.sessionGeneration != saveSessionGeneration) return false
            val response = docRepository.saveContent(
                documentId = documentId,
                contentPmJson = pmJson,
                contentMarkdown = markdown,
                contentPlaintext = plaintext,
                baseVersion = currentAttempt.baseVersion,
                // 单调版本号存在时只使用版本 CAS；时间戳仅为无版本旧数据兜底，
                // 避免同版本因时间精度差异被服务端判成伪冲突。
                baseUpdatedAt = currentAttempt.baseUpdatedAt.takeIf {
                    currentAttempt.baseVersion == null
                },
                title = titleSnapshot,
            )
            if (currentAttempt.sessionGeneration != saveSessionGeneration) return false
            if (!hasCurrentDocumentIdentity() ||
                !hasMatchingOrganization(response.document.organizationId)
            ) {
                handlePermissionRevoked()
                return false
            }
            if (response.document.id != documentId) {
                // 同组织的错误资源回包不能被当前页面接纳，但它也不证明用户失去了
                // 原文档的读取权限。保住本地稿并停在冲突态，避免误清稿或把正文
                // 写入另一个资源的版本基线。
                persistDraft(sync = true)
                retryCount = 0
                retryJob?.cancel()
                _uiState.update { current ->
                    current.copy(
                        saveState = SaveState.CONFLICT,
                        conflictMessage = appContext.getString(R.string.doc_save_conflict),
                    )
                }
                return false
            }
            val currentRemoteVersion = document?.latestVersion
            val responseVersion = response.document.latestVersion
            if (currentRemoteVersion != null && responseVersion != null &&
                responseVersion < currentRemoteVersion
            ) {
                // 回程刷新已经观察到更高版本时，迟到的保存回执不能倒退 CAS 基线。
                persistDraft(sync = false)
                _uiState.update {
                    it.copy(
                        saveState = SaveState.CONFLICT,
                        conflictMessage = appContext.getString(R.string.doc_save_conflict),
                    )
                }
                return false
            }
            val authoritativeContent = response.content?.takeIf(::hasDocumentBody)
            val authoritativeProjection = authoritativeContent?.let { projectRemoteContent(it) }
            if (currentAttempt.sessionGeneration != saveSessionGeneration) return false
            // response content 的解析会离开 Main；返回后重新判定，避免解析期间的新输入被旧回执覆盖。
            val hasNewerEdits = localEditRevision != currentAttempt.revision
            val savedDocument = ProseMirrorParser
                .parseDocument(currentAttempt.content.descriptionJson)
                .copy(blocks = currentAttempt.blocks)
            if (authoritativeProjection != null) {
                val acknowledgedDocument = requireNotNull(mergeRemoteDocument(
                    remoteDocument = authoritativeProjection.documentEnvelope,
                    savedDocument = savedDocument,
                    currentBlocks = currentAttempt.blocks,
                    preserveCurrentEdits = false,
                ))
                val mergedDocument = if (hasNewerEdits) {
                    mergeRemoteDocument(
                        remoteDocument = authoritativeProjection.documentEnvelope,
                        savedDocument = savedDocument,
                        currentBlocks = blocks,
                        preserveCurrentEdits = true,
                    )
                } else {
                    acknowledgedDocument
                }
                if (mergedDocument == null) {
                    // 请求本身已成功，但回执无法证明只做了身份/缺省值规范化。服务端
                    // 结构可能已经改变；保住保存期间的新输入，禁止自动 whole-replace。
                    document = response.document
                    content = authoritativeContent
                    saveBaseVersion = response.document.latestVersion
                    saveBaseUpdatedAt = response.document.updatedAt
                    lastAcknowledgedDocument = acknowledgedDocument
                    unacknowledgedSave = null
                    retryCount = 0
                    retryJob?.cancel()
                    retryJob = null
                    cancelPendingAutosave()
                    persistDraft(sync = false)
                    _uiState.update { current ->
                        current.copy(
                            saveState = SaveState.CONFLICT,
                            conflictMessage = appContext.getString(R.string.doc_save_conflict),
                            organizationId = response.document.organizationId,
                            spaceId = response.document.spaceId,
                            currentUserRole = response.document.currentUserRole,
                            isReadOnlyByRole = !response.document.canEdit,
                        )
                    }
                    return false
                }
                applyDocumentEnvelope(mergedDocument)
                lastAcknowledgedDocument = acknowledgedDocument
            } else {
                // 无正文回执等价于确认本次请求快照；根仍沿用当前 envelope，但块基线必须
                // 推进到已提交内容，否则下一次 409 会拿加载时旧正文做等价比较。
                documentEnvelope = documentEnvelope?.copy(blocks = currentAttempt.blocks)
                lastAcknowledgedDocument = savedDocument
            }
            document = response.document
            content = authoritativeContent ?: currentAttempt.content
            saveBaseVersion = response.document.latestVersion
            saveBaseUpdatedAt = response.document.updatedAt
            draftOriginBaseVersion = response.document.latestVersion
            draftOriginBaseUpdatedAt = response.document.updatedAt
            unacknowledgedSave = null
            retryCount = 0
            retryJob?.cancel()
            retryJob = null
            if (hasNewerEdits) {
                // 本次回执只确认 snapshot；编辑器中的更新内容继续作为下一笔，不清草稿。
                cancelPendingAutosave()
                persistDraft(sync = false)
            } else {
                cancelPendingAutosave()
                clearDraft()
            }
            _uiState.update { current ->
                current.copy(
                    saveState = if (hasNewerEdits) SaveState.DIRTY else SaveState.SAVED,
                    conflictMessage = null,
                    organizationId = response.document.organizationId,
                    spaceId = response.document.spaceId,
                    currentUserRole = response.document.currentUserRole,
                    isReadOnlyByRole = !response.document.canEdit,
                )
            }
            if (authoritativeProjection != null) refreshBlockViews()
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (_: AppError.VersionConflict) {
            val conflictedAttempt = attempt ?: return false
            if (conflictedAttempt.sessionGeneration != saveSessionGeneration) {
                return false
            }
            return recoverFromSaveConflict(conflictedAttempt, allowEquivalentConflictRebase)
        } catch (e: Exception) {
            val failedAttempt = attempt
            if (failedAttempt == null || failedAttempt.sessionGeneration != saveSessionGeneration) {
                return false
            }
            if (isPermissionDenied(e)) {
                recoverFromWritePermissionDenied(failedAttempt.sessionGeneration)
                return false
            }
            // 请求可能已在服务端提交；保留快照，让下一次 409 能识别自己的写入。
            unacknowledgedSave = failedAttempt
            _uiState.update { current ->
                current.copy(saveState = SaveState.FAILED)
            }
            scheduleRetry()
            return false
        }
    }

    /**
     * 写入 403 只证明 editor 权限丢失，不代表 viewer 读取权也丢失。
     * 先保全本地草稿并用 GET detail 重新判权；只有 GET 也拒绝或会话越界才清敏感内容。
     */
    private suspend fun recoverFromWritePermissionDenied(sessionGeneration: Long) {
        persistDraft(sync = true)
        retryJob?.cancel()
        retryJob = null
        retryCount = 0
        try {
            val detail = docRepository.getDocumentDetail(documentId)
            if (sessionGeneration != saveSessionGeneration) return
            if (!hasCurrentDocumentIdentity() ||
                !hasMatchingOrganization(detail.document.organizationId)
            ) {
                handlePermissionRevoked()
                return
            }
            if (detail.document.id != documentId) {
                handleMismatchedDocumentResponse()
                return
            }
            val projection = projectRemoteContent(detail.content)
            if (sessionGeneration != saveSessionGeneration) return
            document = detail.document
            content = detail.content
            saveBaseVersion = detail.document.latestVersion
            saveBaseUpdatedAt = detail.document.updatedAt
            _uiState.update {
                it.copy(
                    title = documentTitle,
                    organizationId = detail.document.organizationId,
                    spaceId = detail.document.spaceId,
                    currentUserRole = detail.document.currentUserRole,
                    isLoading = false,
                    saveState = SaveState.CONFLICT,
                    conflictMessage = appContext.getString(R.string.doc_save_conflict),
                    requiresFullEditor = projection.requiresFullEditor,
                    isReadOnlyByRole = !detail.document.canEdit,
                )
            }
            refreshBlockViews()
            persistDraft(sync = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (sessionGeneration != saveSessionGeneration) return
            if (isPermissionDenied(e)) {
                handlePermissionRevoked()
                return
            }
            _uiState.update {
                it.copy(
                    title = documentTitle,
                    saveState = SaveState.FAILED,
                    conflictMessage = appContext.getString(R.string.doc_save_failed),
                )
            }
            refreshBlockViews()
        }
    }

    private suspend fun recoverFromSaveConflict(
        attempt: SaveAttempt,
        allowEquivalentConflictRebase: Boolean,
    ): Boolean {
        val committedDocument = document
        val committedSnapshotDocument = lastAcknowledgedDocument
        val priorUnacknowledgedSave = unacknowledgedSave
        var canRetryAgainstEquivalentRemote = false
        var acknowledgedRevision: Long? = null

        try {
            val detail = docRepository.getDocumentDetail(documentId)
            if (attempt.sessionGeneration != saveSessionGeneration) return false
            if (!hasCurrentDocumentIdentity() ||
                !hasMatchingOrganization(detail.document.organizationId)
            ) {
                handlePermissionRevoked()
                return false
            }
            if (detail.document.id != documentId) {
                handleMismatchedDocumentResponse()
                return false
            }
            val projection = projectRemoteContent(detail.content)
            if (attempt.sessionGeneration != saveSessionGeneration) return false
            val attemptDocument = ProseMirrorParser.parseDocument(attempt.content.descriptionJson)
                .copy(blocks = attempt.blocks)
            val priorDocument = priorUnacknowledgedSave?.let { prior ->
                ProseMirrorParser.parseDocument(prior.content.descriptionJson)
                    .copy(blocks = prior.blocks)
            }
            val remoteMatchesAttempt = detail.document.title == attempt.title &&
                isSafeRemoteNormalization(attemptDocument, projection.documentEnvelope)
            val remoteMatchesPriorUnacknowledged = priorUnacknowledgedSave != null &&
                priorDocument != null &&
                detail.document.title == priorUnacknowledgedSave.title &&
                isSafeRemoteNormalization(priorDocument, projection.documentEnvelope)
            val remoteMatchesCommitted = committedDocument != null &&
                committedSnapshotDocument != null &&
                detail.document.title == committedDocument.title &&
                isSafeRemoteNormalization(committedSnapshotDocument, projection.documentEnvelope)
            canRetryAgainstEquivalentRemote = allowEquivalentConflictRebase &&
                detail.document.canEdit &&
                !projection.requiresFullEditor &&
                (remoteMatchesAttempt || remoteMatchesPriorUnacknowledged || remoteMatchesCommitted)
            acknowledgedRevision = when {
                remoteMatchesAttempt -> attempt.revision
                remoteMatchesPriorUnacknowledged -> priorUnacknowledgedSave.revision
                else -> null
            }
            if (canRetryAgainstEquivalentRemote) {
                val savedDocumentForRemote = when {
                    remoteMatchesAttempt -> attemptDocument
                    remoteMatchesPriorUnacknowledged -> priorDocument
                    remoteMatchesCommitted -> committedSnapshotDocument
                    else -> null
                }
                val preserveCurrentEdits = acknowledgedRevision != localEditRevision
                val acknowledgedRemoteDocument = savedDocumentForRemote?.let { savedDocument ->
                    mergeRemoteDocument(
                        remoteDocument = projection.documentEnvelope,
                        savedDocument = savedDocument,
                        currentBlocks = savedDocument.blocks,
                        preserveCurrentEdits = false,
                    )
                }
                val mergedDocument = if (savedDocumentForRemote != null) {
                    if (preserveCurrentEdits) {
                        mergeRemoteDocument(
                            remoteDocument = projection.documentEnvelope,
                            savedDocument = savedDocumentForRemote,
                            currentBlocks = blocks,
                            preserveCurrentEdits = true,
                        )
                    } else {
                        acknowledgedRemoteDocument
                    }
                } else if (preserveCurrentEdits) {
                    projection.documentEnvelope.copy(blocks = blocks.toList())
                } else {
                    projection.documentEnvelope
                }
                if (mergedDocument != null) {
                    applyDocumentEnvelope(mergedDocument)
                    lastAcknowledgedDocument = acknowledgedRemoteDocument ?: projection.documentEnvelope
                } else {
                    canRetryAgainstEquivalentRemote = false
                    acknowledgedRevision = null
                }
            }
            if (!canRetryAgainstEquivalentRemote) {
                lastAcknowledgedDocument = projection.documentEnvelope
            }
            document = detail.document
            content = detail.content
            saveBaseVersion = detail.document.latestVersion
            saveBaseUpdatedAt = detail.document.updatedAt
            if (canRetryAgainstEquivalentRemote) {
                draftOriginBaseVersion = detail.document.latestVersion
                draftOriginBaseUpdatedAt = detail.document.updatedAt
                unacknowledgedSave = null
            }
            _uiState.update {
                it.copy(
                    organizationId = detail.document.organizationId,
                    spaceId = detail.document.spaceId,
                    currentUserRole = detail.document.currentUserRole,
                    requiresFullEditor = projection.requiresFullEditor,
                    isReadOnlyByRole = !detail.document.canEdit,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (attempt.sessionGeneration != saveSessionGeneration) return false
            if (isPermissionDenied(e)) {
                handlePermissionRevoked()
                return false
            }
            // 拉取最新版本失败则仅保留草稿，不更新 base
        }
        if (attempt.sessionGeneration != saveSessionGeneration) return false
        if (!hasCurrentDocumentIdentity()) {
            handlePermissionRevoked()
            return false
        }

        retryCount = 0
        retryJob?.cancel()
        retryJob = null

        if (canRetryAgainstEquivalentRemote) {
            refreshBlockViews()
            if (acknowledgedRevision == localEditRevision) {
                cancelPendingAutosave()
                clearDraft()
                _uiState.update { current ->
                    current.copy(
                        title = documentTitle,
                        saveState = SaveState.SAVED,
                        conflictMessage = null,
                    )
                }
                return true
            }
            _uiState.update { current ->
                current.copy(
                    title = documentTitle,
                    saveState = SaveState.DIRTY,
                    conflictMessage = null,
                )
            }
            // 最多自动重试一次。若重试仍 409，下一轮恢复会强制进入冲突态。
            return saveIfNeeded(allowEquivalentConflictRebase = false)
        }

        unacknowledgedSave = null
        persistDraft(sync = false)

        _uiState.update { current ->
            current.copy(
                saveState = SaveState.CONFLICT,
                conflictMessage = appContext.getString(com.tabtin.mobile.R.string.doc_save_conflict),
            )
        }
        return false
    }

    // ── 草稿持久化 ─────────────────────────────────────────────────────

    private fun draftScope(): String? {
        val organizationId = document?.organizationId?.takeIf(String::isNotBlank)
            ?: initialDraftOrganizationId
        return docDraftScope(draftUserId, organizationId, documentId)
    }

    /** 路由、当前会话和响应资源必须都携带同一组织；缺失也按不可见处理。 */
    private fun hasMatchingOrganization(responseOrganizationId: String): Boolean {
        val route = routeOrganizationId?.takeIf(String::isNotBlank) ?: return false
        val active = tokenManager.organizationId?.takeIf(String::isNotBlank) ?: return false
        val response = responseOrganizationId.takeIf(String::isNotBlank) ?: return false
        return route == active && active == response
    }

    /** 页面创建时的用户与路由组织仍是当前登录上下文；用于资源响应尚未落入 document 前。 */
    private fun hasCurrentRouteIdentity(): Boolean {
        val activeUser = tokenManager.userId?.takeIf(String::isNotBlank) ?: return false
        val activeOrganization = tokenManager.organizationId?.takeIf(String::isNotBlank) ?: return false
        val routeOrganization = routeOrganizationId?.takeIf(String::isNotBlank) ?: return false
        return tokenManager.isLoggedIn &&
            activeUser == draftUserId &&
            activeOrganization == routeOrganization
    }

    /** 页面创建时的用户、路由组织、当前会话与已加载资源必须始终属于同一身份边界。 */
    private fun hasCurrentDocumentIdentity(): Boolean {
        val activeUser = tokenManager.userId?.takeIf(String::isNotBlank) ?: return false
        val activeOrganization = tokenManager.organizationId?.takeIf(String::isNotBlank) ?: return false
        val routeOrganization = routeOrganizationId?.takeIf(String::isNotBlank) ?: return false
        val documentOrganization = document?.organizationId?.takeIf(String::isNotBlank) ?: return false
        return tokenManager.isLoggedIn &&
            activeUser == draftUserId &&
            activeOrganization == routeOrganization &&
            routeOrganization == documentOrganization
    }

    /** 防止 token 失效或换账号后，onCleared 把已清除的旧用户草稿重新写回。 */
    private fun hasCurrentDraftIdentity(): Boolean {
        val activeUser = tokenManager.userId?.takeIf(String::isNotBlank) ?: return false
        val activeOrganization = tokenManager.organizationId?.takeIf(String::isNotBlank) ?: return false
        return tokenManager.isLoggedIn && activeUser == draftUserId && activeOrganization == initialDraftOrganizationId
    }

    private fun remoteChangedSinceDraft(remoteDocument: Doc): Boolean {
        val originVersion = draftOriginBaseVersion
        val remoteVersion = remoteDocument.latestVersion
        var hasComparableBase = false
        if (originVersion != null && remoteVersion != null) {
            hasComparableBase = true
            if (originVersion != remoteVersion) return true
        }

        val originUpdatedAt = draftOriginBaseUpdatedAt
        val remoteUpdatedAt = remoteDocument.updatedAt
        if (originUpdatedAt != null && remoteUpdatedAt != null) {
            hasComparableBase = true
            if (originUpdatedAt != remoteUpdatedAt) return true
        }

        if (hasComparableBase) return false
        return originVersion != remoteVersion || originUpdatedAt != remoteUpdatedAt
    }

    private fun draftBlocksKey(scope: String) = "draft_blocks_$scope"
    private fun draftTitleKey(scope: String) = "draft_title_$scope"
    private fun draftTimestampKey(scope: String) = "draft_ts_$scope"
    private fun draftBaseVersionKey(scope: String) = "draft_base_version_$scope"
    private fun draftBaseUpdatedAtKey(scope: String) = "draft_base_updated_at_$scope"

    private fun hasDocumentBody(candidate: DocContent): Boolean =
        "content" in candidate.descriptionJson || candidate.descriptionMarkdown.isNotBlank()

    /**
     * 把服务端权威根与本地编辑状态重新合成一个文档。
     *
     * 没有更新输入时，服务端结构是权威；运行期 id 先按全局唯一 blockId，再按无 blockId
     * 的唯一语义匹配保留，避免前插或重排后焦点跳块。保存期间又有输入时则必须证明远端
     * 只是给同序块补 blockId / schema 缺省值，否则返回 null 让调用方进入冲突态。
     */
    private fun mergeRemoteDocument(
        remoteDocument: ProseMirrorParser.ParsedDocument,
        savedDocument: ProseMirrorParser.ParsedDocument,
        currentBlocks: List<DocBlock>,
        preserveCurrentEdits: Boolean,
    ): ProseMirrorParser.ParsedDocument? {
        val savedBlocks = savedDocument.blocks
        if (!preserveCurrentEdits) {
            val correspondences = authoritativeBlockCorrespondences(savedBlocks, remoteDocument.blocks)
            val savedByRemoteIndex = correspondences.associate { it.remoteIndex to savedBlocks[it.savedIndex] }
            val authoritativeBlocks = remoteDocument.blocks.mapIndexed { index, remoteBlock ->
                savedByRemoteIndex[index]?.let { remoteBlock.copy(id = it.id) } ?: remoteBlock
            }
            return remoteDocument.copy(blocks = authoritativeBlocks)
        }

        if (!isSafeRemoteNormalization(savedDocument, remoteDocument)) return null

        val remoteBySavedRuntimeId = savedBlocks.indices.associate { index ->
            savedBlocks[index].id to remoteDocument.blocks[index]
        }
        val savedByRuntimeId = savedBlocks.associateBy(DocBlock::id)
        val rebasedBlocks = currentBlocks.map { localBlock ->
            val savedBlock = savedByRuntimeId[localBlock.id] ?: return@map localBlock
            val remoteBlock = remoteBySavedRuntimeId[localBlock.id] ?: return@map localBlock
            rebaseGeneratedBlockIdentity(localBlock, savedBlock, remoteBlock)
        }
        return remoteDocument.copy(blocks = rebasedBlocks)
    }

    private data class BlockCorrespondence(val savedIndex: Int, val remoteIndex: Int)

    private fun authoritativeBlockCorrespondences(
        savedBlocks: List<DocBlock>,
        remoteBlocks: List<DocBlock>,
    ): List<BlockCorrespondence> {
        val matches = mutableListOf<BlockCorrespondence>()
        val unmatchedSaved = savedBlocks.indices.toMutableSet()
        val unmatchedRemote = remoteBlocks.indices.toMutableSet()

        val savedIndexesByIdentity = savedBlocks.indices
            .mapNotNull { index -> savedBlocks[index].blockId?.takeIf(String::isNotBlank)?.let { it to index } }
            .groupBy({ it.first }, { it.second })
        val remoteIndexesByIdentity = remoteBlocks.indices
            .mapNotNull { index -> remoteBlocks[index].blockId?.takeIf(String::isNotBlank)?.let { it to index } }
            .groupBy({ it.first }, { it.second })
        savedIndexesByIdentity.forEach { (identity, savedIndexes) ->
            val remoteIndexes = remoteIndexesByIdentity[identity]
            if (savedIndexes.size == 1 && remoteIndexes?.size == 1) {
                val savedIndex = savedIndexes.single()
                val remoteIndex = remoteIndexes.single()
                matches += BlockCorrespondence(savedIndex, remoteIndex)
                unmatchedSaved -= savedIndex
                unmatchedRemote -= remoteIndex
            }
        }

        val semanticCandidates = unmatchedSaved.filter { savedBlocks[it].blockId == null }
        semanticCandidates.forEach { savedIndex ->
            if (savedIndex !in unmatchedSaved) return@forEach
            val candidates = unmatchedRemote.filter { remoteIndex ->
                blocksMatchIgnoringGeneratedIdentity(savedBlocks[savedIndex], remoteBlocks[remoteIndex])
            }
            if (candidates.size != 1) return@forEach
            val remoteIndex = candidates.single()
            val reverseCandidates = unmatchedSaved.count { otherSavedIndex ->
                savedBlocks[otherSavedIndex].blockId == null &&
                    blocksMatchIgnoringGeneratedIdentity(
                        savedBlocks[otherSavedIndex],
                        remoteBlocks[remoteIndex],
                    )
            }
            if (reverseCandidates == 1) {
                matches += BlockCorrespondence(savedIndex, remoteIndex)
                unmatchedSaved -= savedIndex
                unmatchedRemote -= remoteIndex
            }
        }
        return matches
    }

    private fun isSafeRemoteNormalization(
        savedDocument: ProseMirrorParser.ParsedDocument,
        remoteDocument: ProseMirrorParser.ParsedDocument,
    ): Boolean {
        if (documentRootWithoutContent(savedDocument) != documentRootWithoutContent(remoteDocument)) {
            return false
        }
        val savedBlocks = savedDocument.blocks
        val remoteBlocks = remoteDocument.blocks
        if (savedBlocks.size != remoteBlocks.size) return false
        return savedBlocks.indices.all { index ->
            isSafeBlockNormalization(savedBlocks[index], remoteBlocks[index])
        }
    }

    private fun documentRootWithoutContent(document: ProseMirrorParser.ParsedDocument): JsonObject =
        JsonObject(document.sourceRoot.filterKeys { it != "content" })

    private fun isSafeBlockNormalization(saved: DocBlock, remote: DocBlock): Boolean {
        if (saved.kind != remote.kind) return false
        val savedNode = serializedBlockElement(saved) ?: return false
        val remoteNode = serializedBlockElement(remote) ?: return false
        if (saved.rawNode != null || saved.rawElement != null ||
            remote.rawNode != null || remote.rawElement != null
        ) {
            return savedNode == remoteNode
        }
        if (!blocksMatchIgnoringGeneratedIdentity(saved, remote)) return false

        val savedIdentity = saved.blockId
        val remoteIdentity = remote.blockId
        if (savedIdentity != null && remoteIdentity != savedIdentity) return false
        if (savedIdentity == null && remoteIdentity?.isBlank() == true) return false

        val savedNestedIdentities = collectBlockIdentities(savedNode)
        val remoteNestedIdentities = collectBlockIdentities(remoteNode)
        if (savedIdentity != null || remoteIdentity == null) {
            return savedNestedIdentities == remoteNestedIdentities
        }
        if (savedNestedIdentities.any { (path, value) -> remoteNestedIdentities[path] != value }) {
            return false
        }
        val additions = remoteNestedIdentities.filterKeys { it !in savedNestedIdentities }
        return additions.size == 1 && additions.values.single() == JsonPrimitive(remoteIdentity)
    }

    private fun serializedBlockElement(block: DocBlock): kotlinx.serialization.json.JsonElement? =
        (ProseMirrorParser.serializeBlocks(listOf(block))["content"] as? JsonArray)?.singleOrNull()

    private fun collectBlockIdentities(
        element: kotlinx.serialization.json.JsonElement,
    ): Map<String, kotlinx.serialization.json.JsonElement> {
        val identities = linkedMapOf<String, kotlinx.serialization.json.JsonElement>()
        fun visit(current: kotlinx.serialization.json.JsonElement, path: String) {
            when (current) {
                is JsonObject -> current.forEach { (key, value) ->
                    val childPath = "$path/$key"
                    if (key == "blockId") identities[childPath] = value
                    visit(value, childPath)
                }
                is JsonArray -> current.forEachIndexed { index, value -> visit(value, "$path/$index") }
                else -> Unit
            }
        }
        visit(element, "$")
        return identities
    }

    private fun blocksMatchIgnoringGeneratedIdentity(saved: DocBlock, remote: DocBlock): Boolean =
        NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "",
            remoteDocument = ProseMirrorParser.serializeBlocks(listOf(remote)),
            committedTitle = "",
            committedDocument = ProseMirrorParser.serializeBlocks(listOf(saved)),
        )

    private fun rebaseGeneratedBlockIdentity(
        local: DocBlock,
        saved: DocBlock,
        remote: DocBlock,
    ): DocBlock {
        val remoteBlockId = remote.blockId ?: return local
        if (!local.editable || !saved.editable || !remote.editable) return local
        if (local.kind != saved.kind || remote.kind != saved.kind) return local
        if (local.rawNode != null || local.rawElement != null ||
            saved.rawNode != null || saved.rawElement != null ||
            remote.rawNode != null || remote.rawElement != null
        ) return local
        if (local.blockId != saved.blockId) return local
        if (saved.blockId != null && saved.blockId != remoteBlockId) return local
        return local.copy(blockId = remoteBlockId)
    }

    private fun applyDocumentEnvelope(document: ProseMirrorParser.ParsedDocument) {
        rebaseHistoryBlockIdentities(blocks, document.blocks)
        documentEnvelope = document
        blocks = document.blocks.toMutableList()
        val currentFocus = focusedBlockId
        if (currentFocus != null && blocks.none { it.id == currentFocus }) {
            focusedBlockId = null
            cursorPosition = null
        }
    }

    private data class HistoryIdentityRebase(
        val previousBlockId: String?,
        val authoritativeBlockId: String,
    )

    private fun rebaseHistoryBlockIdentities(
        previousBlocks: List<DocBlock>,
        authoritativeBlocks: List<DocBlock>,
    ) {
        val previousByRuntimeId = previousBlocks.associateBy(DocBlock::id)
        val identityRebases = authoritativeBlocks.mapNotNull { authoritative ->
            val previous = previousByRuntimeId[authoritative.id] ?: return@mapNotNull null
            val authoritativeIdentity = authoritative.blockId?.takeIf(String::isNotBlank)
                ?: return@mapNotNull null
            if (previous.blockId != null || previous.kind != authoritative.kind) return@mapNotNull null
            if (previous.rawNode != null || previous.rawElement != null ||
                authoritative.rawNode != null || authoritative.rawElement != null
            ) return@mapNotNull null
            authoritative.id to HistoryIdentityRebase(previous.blockId, authoritativeIdentity)
        }.toMap()
        if (identityRebases.isEmpty()) return

        fun EditorSnapshot.rebased(): EditorSnapshot = copy(
            blocks = blocks.map { block ->
                val rebase = identityRebases[block.id] ?: return@map block
                if (block.blockId != rebase.previousBlockId ||
                    block.rawNode != null || block.rawElement != null
                ) block else block.copy(blockId = rebase.authoritativeBlockId)
            },
        )

        pendingUndoSnapshot = pendingUndoSnapshot?.rebased()
        val rebasedUndo = undoStack.map(EditorSnapshot::rebased)
        undoStack.clear()
        rebasedUndo.forEach(undoStack::addLast)
        val rebasedRedo = redoStack.map(EditorSnapshot::rebased)
        redoStack.clear()
        rebasedRedo.forEach(redoStack::addLast)
    }

    private fun serializeEditorDocument(
        blockSnapshot: List<DocBlock>,
        envelopeSnapshot: ProseMirrorParser.ParsedDocument? = documentEnvelope,
    ): JsonObject = envelopeSnapshot
        ?.let { ProseMirrorParser.serializeDocument(it.copy(blocks = blockSnapshot)) }
        ?: ProseMirrorParser.serializeBlocks(blockSnapshot)

    /**
     * 将当前编辑内容持久化到 SharedPreferences。
     * sync=true 使用 commit()（阻塞，用于 onCleared），sync=false 使用 apply()。
     */
    private fun persistDraft(sync: Boolean) {
        if (documentId.isEmpty() || blocks.isEmpty() || !hasCurrentDraftIdentity()) return
        val scope = draftScope() ?: return
        try {
            val pmJson = serializeEditorDocument(blocks.toList())
            val editor = draftPrefs.edit()
                .putString(draftBlocksKey(scope), pmJson.toString())
                .putString(draftTitleKey(scope), documentTitle)
                .putLong(draftTimestampKey(scope), System.currentTimeMillis())
                .putLong(
                    draftBaseVersionKey(scope),
                    draftOriginBaseVersion?.toLong() ?: NO_DRAFT_BASE_VERSION,
                )
                .putString(draftBaseUpdatedAtKey(scope), draftOriginBaseUpdatedAt)
            if (sync) editor.commit() else editor.apply()
        } catch (_: Exception) {
            Log.w("DocEditor", "Failed to persist draft for $documentId")
        }
    }

    private fun clearDraft() {
        // W A0.3.续4：先取消未来的 persistDraft 任务，避免 saveIfNeeded success → clearDraft 后
        // 已调度的 draftSaveJob (delay 2000ms) 又把 draft 写回 prefs 的 race condition；
        // 用户场景：连续编辑 → 1.2s 后 save 成功清 draft → 2s 后 draft 被异步重写 → 下次启动
        // 恢复"过期 draft"覆盖 server 真值（详 W A0.3.续3 反思 §3.2 + §6.1 选项 3）。
        draftSaveJob?.cancel()
        draftSaveJob = null
        val scope = draftScope() ?: return
        draftPrefs.edit()
            .remove(draftBlocksKey(scope))
            .remove(draftTitleKey(scope))
            .remove(draftTimestampKey(scope))
            .remove(draftBaseVersionKey(scope))
            .remove(draftBaseUpdatedAtKey(scope))
            .apply()
    }

    private fun clearDraftSynchronously(): Boolean {
        val scope = draftScope() ?: return false
        return try {
            draftPrefs.edit()
                .remove(draftBlocksKey(scope))
                .remove(draftTitleKey(scope))
                .remove(draftTimestampKey(scope))
                .remove(draftBaseVersionKey(scope))
                .remove(draftBaseUpdatedAtKey(scope))
                .commit()
        } catch (_: Exception) {
            false
        }
    }

    private fun scheduleDraftPersist() {
        draftSaveJob?.cancel()
        draftSaveJob = viewModelScope.launch {
            delay(DRAFT_PERSIST_INTERVAL_MS)
            persistDraft(sync = false)
        }
    }

    /**
     * 加载文档后检查本地草稿：恢复同基线草稿并触发保存；过期草稿停在冲突态。
     * 仅在 loadDocument 成功后调用，保证 document 元数据可用。
     */
    private suspend fun checkAndRestoreDraft(generation: Long) {
        if (generation != documentOperationGeneration) return
        val scope = draftScope() ?: return
        val draftJson = draftPrefs.getString(draftBlocksKey(scope), null)
        if (draftJson.isNullOrEmpty()) return
        val draftTs = draftPrefs.getLong(draftTimestampKey(scope), 0L)
        if (draftTs == 0L) return
        val storedBaseVersion = draftPrefs.getLong(
            draftBaseVersionKey(scope),
            NO_DRAFT_BASE_VERSION,
        ).takeIf { it != NO_DRAFT_BASE_VERSION }?.toInt()
        val storedBaseUpdatedAt = draftPrefs.getString(draftBaseUpdatedAtKey(scope), null)
        try {
            // W A0.3.续6：parseDocument 包 withContext(coroutineDispatcher)，避免长文档草稿
            // 在 Main 阻塞。详见排查报告 §1.4 推荐方案 A。
            // W A0.3.续7：dispatcher 改为注入参数，测试可注入 testDispatcher 让 advanceUntilIdle 调度。
            // W D（2026-05-04）：Json.parseToJsonElement(draftJson) 也是 CPU 密集（长草稿 JSON
            // 词法 + 语法 + AST 构造），与 parseDocument 同步搬入 withContext 块，避免大草稿
            // 在 Main 抓 JSON 时阻塞键盘 / 滚动。详见 docs/Android-coroutines-conventions.md §3。
            val draftDocument = withContext(coroutineDispatcher) {
                val jsonObj = Json.parseToJsonElement(draftJson).jsonObject
                ProseMirrorParser.parseDocument(jsonObj)
            }
            val draftBlocks = draftDocument.blocks
            if (generation != documentOperationGeneration) return
            if (draftBlocks.isEmpty()) {
                clearDraft()
                return
            }
            val draftTitle = draftPrefs.getString(draftTitleKey(scope), null)
            // applyRemoteDetail 已把写入 CAS 基线设为当前远端版本。恢复草稿判定必须先
            // 还原其原始分叉点，否则会把当前远端误当作草稿基线，漏掉真实版本推进。
            draftOriginBaseVersion = storedBaseVersion
            draftOriginBaseUpdatedAt = storedBaseUpdatedAt
            val effectiveDraftTitle = draftTitle ?: documentTitle
            val serverChangedSinceDraft = remoteChangedSinceDraft(requireNotNull(document))
            val remoteDocument = content?.descriptionJson
            if (serverChangedSinceDraft && remoteDocument != null &&
                NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
                    remoteTitle = requireNotNull(document).title,
                    remoteDocument = remoteDocument,
                    committedTitle = effectiveDraftTitle,
                    committedDocument = ProseMirrorParser.serializeDocument(draftDocument),
                )
            ) {
                // REST 写入成功、协作回流推进版本、进程又在成功回执前退出时，会留下
                // 旧基线但内容已落云的草稿。严格语义等价时保留当前远端 canonical
                // 内容并清掉伪冲突草稿；真实内容差异仍走下面的冲突保护。
                clearDraft()
                Log.d("DocEditor", "Cleared equivalent synced draft for $documentId")
                return
            }
            documentEnvelope = draftDocument
            blocks = draftBlocks.toMutableList()
            if (draftTitle != null) documentTitle = draftTitle
            focusedBlockId = blocks.firstOrNull()?.id
            Log.d("DocEditor", "Restored local draft for $documentId (ts=$draftTs)")
            _uiState.update {
                it.copy(
                    title = documentTitle,
                    saveState = if (serverChangedSinceDraft) SaveState.CONFLICT else SaveState.DIRTY,
                    conflictMessage = if (serverChangedSinceDraft) {
                        appContext.getString(com.tabtin.mobile.R.string.doc_save_conflict)
                    } else null,
                )
            }
            refreshBlockViews()
            if (!serverChangedSinceDraft) scheduleSave()
        } catch (_: Exception) {
            clearDraft()
        }
    }

    /**
     * 远端暂时不可达时仍允许用户取回同 user / organization / document scope 的本地草稿。
     * 此路径没有远端文档、权限或版本基线，必须保持不可编辑、不可保存。
     */
    private suspend fun restoreDraftForOfflinePreview(generation: Long): Boolean {
        if (generation != documentOperationGeneration || !hasCurrentRouteIdentity()) return false
        val scope = docDraftScope(draftUserId, initialDraftOrganizationId, documentId) ?: return false
        val draftJson = draftPrefs.getString(draftBlocksKey(scope), null)?.takeIf(String::isNotBlank)
            ?: return false
        return try {
            val draftDocument = withContext(coroutineDispatcher) {
                ProseMirrorParser.parseDocument(Json.parseToJsonElement(draftJson).jsonObject)
            }
            val draftBlocks = draftDocument.blocks
            if (generation != documentOperationGeneration || !hasCurrentRouteIdentity() || draftBlocks.isEmpty()) {
                false
            } else {
                documentEnvelope = draftDocument
                lastAcknowledgedDocument = null
                blocks = draftBlocks.toMutableList()
                documentTitle = draftPrefs.getString(draftTitleKey(scope), null).orEmpty()
                document = null
                content = null
                saveBaseVersion = null
                saveBaseUpdatedAt = null
                draftOriginBaseVersion = null
                draftOriginBaseUpdatedAt = null
                focusedBlockId = null
                cursorPosition = null
                invalidateSaveSession()
                draftSaveJob?.cancel()
                _uiState.update {
                    it.copy(
                        title = documentTitle,
                        organizationId = "",
                        spaceId = null,
                        currentUserRole = null,
                        isLoading = false,
                        errorRes = null,
                        saveState = SaveState.FAILED,
                        conflictMessage = appContext.getString(R.string.doc_offline_draft_message),
                        isReadOnlyByRole = true,
                        isOfflineDraftPreview = true,
                        canUndo = false,
                        canRedo = false,
                    )
                }
                refreshBlockViews()
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    // ── 保存重试 ─────────────────────────────────────────────────────

    private fun scheduleRetry() {
        if (retryCount >= MAX_RETRY_COUNT) return
        retryJob?.cancel()
        val delayMs = (INITIAL_RETRY_DELAY_MS * (1L shl retryCount.coerceAtMost(4)))
            .coerceAtMost(MAX_RETRY_DELAY_MS)
        retryCount++
        retryJob = viewModelScope.launch {
            delay(delayMs)
            retryJob = null
            if (_uiState.value.saveState != SaveState.FAILED) return@launch
            _uiState.update { it.copy(saveState = SaveState.DIRTY) }
            flushPendingSaves(retryFailed = false)
        }
    }

    // ── 编辑操作（与 DocBlockAdapter 回调一一对应） ──────────────────────

    /**
     * 文本内容变更 —— 来自 TextHolder 的 TextWatcher。
     * 将 TabDocMarkup.Mark 转换回 InlineSpan 写入 DocBlock。
     */
    public fun onTextChanged(blockId: String, text: String, marks: List<TabDocMarkup.Mark>) {
        if (!canMutate()) return
        scheduleTextUndo()
        val newSpans = BlockViewConverter.marksToSpans(text, marks)
        blocks = DocEditorOrchestrator.updateBlockText(blocks, blockId, newSpans).toMutableList()

        if (marks.isEmpty()) {
            val block = blocks.find { it.id == blockId }
            if (block != null && block.kind == BlockKind.PARAGRAPH) {
                val match = detectMarkdownShortcut(text)
                if (match != null) {
                    applyMarkdownShortcut(blockId, text, match)
                    return
                }
            }
        }
        scheduleSave()
    }

    /**
     * Enter 键 —— 在光标位置将块一分为二。
     * @param range 光标位置 range，使用 range.first 作为分割点。
     */
    public fun onEnterPressed(blockId: String, range: IntRange) {
        if (!canMutate()) return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return
        pushUndo()

        val current = blocks[index]
        val (newBlocks, newBlock) = DocEditorOrchestrator.splitBlock(
            blocks = blocks,
            blockId = blockId,
            cursorPosition = range.first,
            spans = current.spans,
        )
        blocks = newBlocks.toMutableList()
        focusedBlockId = newBlock.id
        cursorPosition = 0
        refreshBlockViews()
        scheduleSave()
    }

    /** 块首按 Backspace —— 将当前块合并到上一块，并把光标放到原边界。 */
    public fun onEmptyBackspace(blockId: String) {
        if (!canMutate()) return
        pushUndo()
        val (newBlocks, focusId, cursorPos) = DocEditorOrchestrator.mergeWithPrevious(blocks, blockId)
        blocks = newBlocks.toMutableList()
        focusedBlockId = focusId
        cursorPosition = cursorPos
        refreshBlockViews()
        scheduleSave()
    }

    /** 焦点变更 —— 由 ViewHolder 焦点回调触发 */
    public fun onFocusChanged(blockId: String) {
        if (!canMutate()) return
        if (_uiState.value.isSelectionMode) return
        focusedBlockId = blockId
        val block = blocks.find { it.id == blockId }
        val showToolbar = block != null && block.kind.isEditable && block.kind != BlockKind.CODE_BLOCK
        _uiState.update {
            it.copy(
                showFormatToolbar = showToolbar,
                activeMarks = emptySet(),
            )
        }
        refreshBlockViews()
    }

    /** 点击正文空白处退出编辑态；正文内容不变，只清焦点、键盘相关浮层和光标。 */
    public fun onEditorBackgroundTapped() {
        if (_uiState.value.isSelectionMode) return
        focusedBlockId = null
        cursorPosition = null
        _uiState.update {
            it.copy(
                showFormatToolbar = false,
                activeMarks = emptySet(),
                showSlashMenu = false,
                slashFilter = "",
            )
        }
        refreshBlockViews()
    }

    /**
     * Slash 命令事件 —— 由 SlashTextWatcher 产生。
     * Start → 显示菜单，Filter → 更新过滤词，Stop → 隐藏菜单。
     */
    public fun onSlashEvent(blockId: String, state: SlashTextWatcherState) {
        if (!canMutate()) return
        when (state) {
            is SlashTextWatcherState.Start -> {
                slashStartPosition = state.start
                _uiState.update {
                    it.copy(
                        showSlashMenu = true,
                        slashBlockId = blockId,
                        slashFilter = "",
                    )
                }
            }
            is SlashTextWatcherState.Filter -> {
                _uiState.update {
                    it.copy(slashFilter = state.text.toString().removePrefix("/"))
                }
            }
            is SlashTextWatcherState.Stop -> {
                slashStartPosition = -1
                _uiState.update {
                    it.copy(showSlashMenu = false, slashBlockId = null, slashFilter = "")
                }
            }
        }
    }

    /** 选区变更 —— 更新活跃的 mark 状态用于格式工具栏高亮 */
    public fun onSelectionChanged(blockId: String, range: IntRange) {
        if (blockId != focusedBlockId) return
        selectionStart = range.first
        selectionEnd = range.last
        val block = blocks.find { it.id == blockId } ?: return
        val result = computeActiveMarks(block, range.first, range.last)
        _uiState.update {
            it.copy(
                activeMarks = result.kinds,
                activeTextColor = result.textColor,
                activeHighlight = result.highlight,
            )
        }
    }

    /** Checkbox 勾选切换 */
    public fun onCheckChanged(blockId: String, isChecked: Boolean) {
        if (!canMutate()) return
        pushUndo()
        blocks = DocEditorOrchestrator.updateCheckbox(blocks, blockId, isChecked).toMutableList()
        refreshBlockViews()
        scheduleSave()
    }

    /** 代码块文本变更 —— CodeHolder 的回调，无 marks */
    public fun onCodeTextChanged(blockId: String, text: String) {
        if (!canMutate()) return
        scheduleTextUndo()
        val newSpans = listOf(InlineSpan(text))
        blocks = DocEditorOrchestrator.updateBlockText(blocks, blockId, newSpans).toMutableList()
        scheduleSave()
    }

    /** 标题变更 */
    public fun onTitleChanged(title: String) {
        if (!canMutate()) return
        scheduleTextUndo()
        documentTitle = title
        _uiState.update { it.copy(title = title) }
        scheduleSave()
    }

    // ── Slash 菜单操作 ──────────────────────────────────────────────

    /** 从 Slash 菜单选择一个块类型插入 */
    public fun onSlashItemSelected(blockKind: BlockKind) {
        if (!canMutate()) return
        val slashBlockId = _uiState.value.slashBlockId ?: return
        pushUndo()

        val result = DocEditorOrchestrator.applySlashCommand(
            blocks = blocks,
            blockId = slashBlockId,
            slashStart = slashStartPosition,
            filterLen = _uiState.value.slashFilter.length,
            targetKind = blockKind,
        )
        blocks = result.blocks.toMutableList()
        focusedBlockId = result.focusBlockId
        cursorPosition = result.cursorPosition
        slashStartPosition = -1

        _uiState.update { it.copy(showSlashMenu = false, slashBlockId = null, slashFilter = "") }
        refreshBlockViews()
        scheduleSave()
    }

    /** 关闭 Slash 菜单 */
    public fun onSlashDismissed() {
        if (!canMutate()) return
        val slashBlockId = _uiState.value.slashBlockId
        if (slashBlockId != null) {
            val index = blocks.indexOfFirst { it.id == slashBlockId }
            if (index >= 0 && blocks[index].text == "/") {
                blocks[index] = blocks[index].copy(spans = listOf(InlineSpan("")))
                refreshBlockViews()
            }
        }
        slashStartPosition = -1
        _uiState.update { it.copy(showSlashMenu = false, slashBlockId = null, slashFilter = "") }
    }

    // ── 格式操作 ─────────────────────────────────────────────────────

    /** 切换选区的 mark 格式（由格式工具栏调用） */
    public fun onToggleFormat(markKind: InlineMarkKind) {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return

        if (selectionStart < selectionEnd) {
            pushUndo()
            blocks = DocEditorOrchestrator.toggleMark(
                blocks, blockId, markKind, selectionStart, selectionEnd,
            ).toMutableList()
            refreshBlockViews()
            scheduleSave()
        }

        val activeMarks = _uiState.value.activeMarks
        val newMarks = if (markKind in activeMarks) activeMarks - markKind else activeMarks + markKind
        _uiState.update { it.copy(activeMarks = newMarks) }
    }

    /** 插入链接 */
    public fun onInsertLink(url: String) {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return

        if (selectionStart < selectionEnd) {
            pushUndo()
            blocks = DocEditorOrchestrator.toggleMark(
                blocks, blockId, InlineMarkKind.LINK, selectionStart, selectionEnd, linkUrl = url,
            ).toMutableList()
            refreshBlockViews()
            scheduleSave()
        }

        _uiState.update { it.copy(activeMarks = _uiState.value.activeMarks + InlineMarkKind.LINK) }
    }

    public fun onShowTextColorPicker() {
        if (!canMutate()) return
        _uiState.update { it.copy(showTextColorPicker = true) }
    }

    public fun onShowHighlightPicker() {
        if (!canMutate()) return
        _uiState.update { it.copy(showHighlightPicker = true) }
    }

    public fun dismissColorPicker() {
        _uiState.update { it.copy(showTextColorPicker = false, showHighlightPicker = false) }
    }

    public fun onSetTextColor(color: String) {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return
        if (selectionStart < selectionEnd) {
            pushUndo()
            blocks = DocEditorOrchestrator.setColorMark(
                blocks, blockId, InlineMarkKind.TEXT_COLOR, selectionStart, selectionEnd, color,
            ).toMutableList()
            refreshBlockViews()
            scheduleSave()
            _uiState.update { it.copy(showTextColorPicker = false, activeTextColor = color) }
        } else {
            _uiState.update { it.copy(showTextColorPicker = false) }
        }
    }

    public fun onSetHighlight(color: String) {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return
        if (selectionStart < selectionEnd) {
            pushUndo()
            blocks = DocEditorOrchestrator.setColorMark(
                blocks, blockId, InlineMarkKind.HIGHLIGHT, selectionStart, selectionEnd, color,
            ).toMutableList()
            refreshBlockViews()
            scheduleSave()
            _uiState.update { it.copy(showHighlightPicker = false, activeHighlight = color) }
        } else {
            _uiState.update { it.copy(showHighlightPicker = false) }
        }
    }

    // ── 内部方法 ─────────────────────────────────────────────────────

    /**
     * 将内部 DocBlock 列表转换为 TabDocBlockView 列表并刷新 UI 状态。
     */
    private fun refreshBlockViews() {
        val views = BlockViewConverter.toBlockViews(
            blocks = blocks,
            focusedBlockId = if (_uiState.value.isSelectionMode) null else focusedBlockId,
            cursorPosition = if (_uiState.value.isSelectionMode) null else cursorPosition,
            selectedBlockIds = _uiState.value.selectedBlockIds,
        )
        _uiState.update { it.copy(blockViews = views) }
        cursorPosition = null
        resolveMissingImageDisplayUrls()
        refreshCommentUi()
    }

    /**
     * 行内图片与块级图片共用同一条鉴权链路。行内图片没有独立的 DocBlock 承载运行期
     * URL，所以由呈现层按需拉取，这里只暴露解析能力本身。
     */
    public suspend fun resolveInlineImageDisplayUrl(fileId: String): String? {
        if (fileId.isBlank()) return null
        return try {
            ossUploadService.resolveFile(fileId).displayUrl.takeIf(String::isNotBlank)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("DocEditor", "Inline image display URL resolve failed: ${e.message}")
            null
        }
    }

    /**
     * 历史文档可能只持久化 fileId。这里复用 OSS 权限接口换取短时展示 URL，
     * 只更新运行期 [DocBlock.imageURL]；只读图片序列化仍严格复用 rawNode。
     */
    private fun resolveMissingImageDisplayUrls() {
        val candidates = blocks.filter { block ->
            block.kind == BlockKind.IMAGE &&
                !block.editable &&
                block.rawNode != null &&
                block.imageURL.isBlank() &&
                block.imageFileId.isNotBlank()
        }
        val requests = candidates.map { ImageDisplayUrlRequest(it.id, it.imageFileId) }.toSet()
        imageDisplayUrlJobs.keys.filterNot(requests::contains).forEach { request ->
            imageDisplayUrlJobs.remove(request)?.cancel()
        }
        candidates.forEach { block ->
            val request = ImageDisplayUrlRequest(block.id, block.imageFileId)
            if (imageDisplayUrlJobs[request]?.isActive == true) return@forEach
            lateinit var job: Job
            job = viewModelScope.launch(start = CoroutineStart.LAZY) {
                val displayUrl = try {
                    ossUploadService.resolveFile(request.fileId).displayUrl
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("DocEditor", "Image display URL resolve failed: ${e.message}")
                    ""
                } finally {
                    if (imageDisplayUrlJobs[request] === job) {
                        imageDisplayUrlJobs.remove(request)
                    }
                }
                if (displayUrl.isBlank()) return@launch
                val index = blocks.indexOfFirst { current ->
                    current.id == request.blockId &&
                        current.kind == BlockKind.IMAGE &&
                        !current.editable &&
                        current.rawNode != null &&
                        current.imageFileId == request.fileId &&
                        current.imageURL.isBlank()
                }
                if (index < 0) return@launch
                blocks[index] = blocks[index].copy(imageURL = displayUrl)
                refreshBlockViews()
            }
            imageDisplayUrlJobs[request] = job
            job.start()
        }
    }

    private data class ActiveMarksResult(
        val kinds: Set<InlineMarkKind>,
        val textColor: String = "",
        val highlight: String = "",
    )

    private fun computeActiveMarks(block: DocBlock, selStart: Int, selEnd: Int): ActiveMarksResult {
        if (selStart == selEnd) {
            var offset = 0
            for (span in block.spans) {
                val spanEnd = offset + span.text.length
                if (selStart in offset..spanEnd && span.marks.isNotEmpty()) {
                    val tc = span.marks.filterIsInstance<InlineMark.TextColor>().firstOrNull()?.color ?: ""
                    val hl = span.marks.filterIsInstance<InlineMark.Highlight>().firstOrNull()?.color ?: ""
                    return ActiveMarksResult(span.marks.map { it.kind }.toSet(), tc, hl)
                }
                offset = spanEnd
            }
            return ActiveMarksResult(emptySet())
        }

        val body = block.text
        val blockMarks = BlockViewConverter.spansToMarks(body, block.spans)
        val kinds = InlineMarkKind.entries.filter { kind ->
            blockMarks.any { mark ->
                DocEditorOrchestrator.markKindOf(mark) == kind && mark.from <= selStart && mark.to >= selEnd
            }
        }.toSet()

        val tc = blockMarks.filterIsInstance<TabDocMarkup.Mark.TextColor>()
            .firstOrNull { it.from <= selStart && it.to >= selEnd }?.color ?: ""
        val hl = blockMarks.filterIsInstance<TabDocMarkup.Mark.Highlight>()
            .firstOrNull { it.from <= selStart && it.to >= selEnd }?.color ?: ""

        return ActiveMarksResult(kinds, tc, hl)
    }

    // ── 缩进操作 ─────────────────────────────────────────────────────

    public fun onIndent() {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return
        pushUndo()
        blocks = DocEditorOrchestrator.indent(blocks, blockId).toMutableList()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onUnindent() {
        if (!canMutate()) return
        val blockId = focusedBlockId ?: return
        pushUndo()
        blocks = DocEditorOrchestrator.unindent(blocks, blockId).toMutableList()
        refreshBlockViews()
        scheduleSave()
    }

    // ── 块操作菜单 ─────────────────────────────────────────────────────

    public fun onBlockLongPress(blockId: String) {
        if (!canMutate()) return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return
        val block = blocks[index]
        _uiState.update {
            it.copy(
                showBlockActionMenu = true,
                actionBlockId = blockId,
                actionBlockKind = block.kind,
                actionBlockEditable = block.editable,
                actionBlockCanDeleteWholeBlock = block.canDeleteWholeBlock,
                actionBlockIsFirst = index == 0,
                actionBlockIsLast = index == blocks.lastIndex,
            )
        }
    }

    public fun dismissBlockAction() {
        _uiState.update {
            it.copy(
                showBlockActionMenu = false,
                actionBlockId = null,
                actionBlockKind = null,
                actionBlockEditable = true,
                actionBlockCanDeleteWholeBlock = true,
                actionBlockIsFirst = false,
                actionBlockIsLast = false,
            )
        }
    }

    public fun onDeleteBlock() {
        if (!canMutate()) return
        val action = _uiState.value
        val blockId = action.actionBlockId ?: return
        val blockKind = action.actionBlockKind ?: return
        if (!action.actionBlockCanDeleteWholeBlock) return
        // 回调可能晚于协作/权限变化：必须以当前同 id 块的类型与能力再判定，
        // 不能用打开菜单时的旧快照删掉新内容。
        val currentBlock = blocks.find { it.id == blockId } ?: return
        if (currentBlock.kind != blockKind || !currentBlock.canDeleteWholeBlock) return
        val deletedIndex = blocks.indexOfFirst { it.id == blockId }
        pushUndo()
        blocks = DocEditorOrchestrator.deleteBlock(blocks, blockId).toMutableList()
        if (blocks.isEmpty()) blocks.add(DocBlock.empty(BlockKind.PARAGRAPH))
        val focusIndex = (deletedIndex - 1).coerceIn(0, blocks.lastIndex)
        focusedBlockId = blocks.getOrNull(focusIndex)?.id
        cursorPosition = blocks.getOrNull(focusIndex)?.text?.length
        dismissBlockAction()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onDuplicateBlock() {
        if (!canMutate()) return
        val blockId = _uiState.value.actionBlockId ?: return
        if (blocks.find { it.id == blockId }?.editable == false) return
        val (newBlocks, newBlock) = DocEditorOrchestrator.duplicateBlock(blocks, blockId)
        if (newBlock == null) {
            dismissBlockAction()
            return
        }
        pushUndo()
        blocks = newBlocks.toMutableList()
        focusedBlockId = newBlock.id
        cursorPosition = 0
        dismissBlockAction()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onCopyBlockText() {
        val blockId = _uiState.value.actionBlockId ?: return
        val block = blocks.find { it.id == blockId } ?: return
        _events.tryEmit(EditorEvent.CopyToClipboard(block.clipboardText()))
        dismissBlockAction()
    }

    public fun onTurnInto(kind: BlockKind) {
        if (!canMutate()) return
        val blockId = _uiState.value.actionBlockId ?: return
        if (blocks.find { it.id == blockId }?.editable == false) return
        pushUndo()
        blocks = DocEditorOrchestrator.turnIntoBlock(blocks, blockId, kind).toMutableList()
        dismissBlockAction()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onMoveBlockUp() {
        if (!canMutate()) return
        val blockId = _uiState.value.actionBlockId ?: return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index <= 0) { dismissBlockAction(); return }
        pushUndo()
        blocks = DocEditorOrchestrator.moveBlock(blocks, index, index - 1).toMutableList()
        dismissBlockAction()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onMoveBlockDown() {
        if (!canMutate()) return
        val blockId = _uiState.value.actionBlockId ?: return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0 || index >= blocks.size - 1) { dismissBlockAction(); return }
        pushUndo()
        blocks = DocEditorOrchestrator.moveBlock(blocks, index, index + 1).toMutableList()
        dismissBlockAction()
        refreshBlockViews()
        scheduleSave()
    }

    public fun onBlockMoved(fromIndex: Int, toIndex: Int) {
        if (!canMutate()) return
        if (fromIndex == toIndex) return
        pushUndo()
        blocks = DocEditorOrchestrator.moveBlock(blocks, fromIndex, toIndex).toMutableList()
        refreshBlockViews()
        scheduleSave()
    }

    // ── Markdown 快捷语法 ──────────────────────────────────────────────

    private data class MarkdownMatch(val kind: BlockKind, val prefixLength: Int)

    private fun detectMarkdownShortcut(text: String): MarkdownMatch? = when {
        text.startsWith("### ") -> MarkdownMatch(BlockKind.HEADING3, 4)
        text.startsWith("## ") -> MarkdownMatch(BlockKind.HEADING2, 3)
        text.startsWith("# ") -> MarkdownMatch(BlockKind.HEADING1, 2)
        text.startsWith("- ") || text.startsWith("* ") -> MarkdownMatch(BlockKind.BULLET_ITEM, 2)
        text.startsWith("1. ") -> MarkdownMatch(BlockKind.ORDERED_ITEM, 3)
        text.startsWith("> ") -> MarkdownMatch(BlockKind.BLOCKQUOTE, 2)
        text.startsWith("[] ") -> MarkdownMatch(BlockKind.TODO_ITEM, 3)
        text.startsWith("[ ] ") -> MarkdownMatch(BlockKind.TODO_ITEM, 4)
        text.startsWith("[x] ") -> MarkdownMatch(BlockKind.TODO_ITEM, 4)
        text == "---" || text == "***" -> MarkdownMatch(BlockKind.DIVIDER, text.length)
        text.startsWith("``` ") || text == "```" -> MarkdownMatch(BlockKind.CODE_BLOCK, text.length)
        else -> null
    }

    private fun applyMarkdownShortcut(blockId: String, text: String, match: MarkdownMatch) {
        pushUndo()
        val result = DocEditorOrchestrator.applyMarkdownShortcut(
            blocks, blockId, text, match.kind, match.prefixLength,
        )
        blocks = result.blocks.toMutableList()
        if (result.focusBlockId != null) focusedBlockId = result.focusBlockId
        cursorPosition = result.cursorPosition
        refreshBlockViews()
        scheduleSave()
    }

    // ── 块选区 ──────────────────────────────────────────────────────

    public fun enterSelectionMode(initialBlockId: String? = null) {
        if (!canMutate()) return
        val initial = when (initialBlockId) {
            null -> emptySet()
            else -> {
                val block = blocks.find { it.id == initialBlockId }
                if (block?.canDeleteWholeBlock != true) {
                    dismissBlockAction()
                    return
                }
                setOf(initialBlockId)
            }
        }
        dismissBlockAction()
        _uiState.update {
            it.copy(
                isSelectionMode = true,
                selectedBlockIds = initial,
                showFormatToolbar = false,
            )
        }
        refreshBlockViews()
    }

    public fun exitSelectionMode() {
        _uiState.update {
            it.copy(isSelectionMode = false, selectedBlockIds = emptySet())
        }
        refreshBlockViews()
    }

    public fun toggleBlockSelection(blockId: String) {
        if (!_uiState.value.isSelectionMode) return
        // 只有当前允许整块删除的块才参与破坏性选择。
        if (blocks.find { it.id == blockId }?.canDeleteWholeBlock != true) return
        val current = _uiState.value.selectedBlockIds
        val updated = if (blockId in current) current - blockId else current + blockId
        if (updated.isEmpty()) {
            exitSelectionMode()
        } else {
            _uiState.update { it.copy(selectedBlockIds = updated) }
            refreshBlockViews()
        }
    }

    public fun selectAll() {
        if (!canMutate()) return
        val allIds = blocks.filter { it.canDeleteWholeBlock }.map { it.id }.toSet()
        _uiState.update { it.copy(selectedBlockIds = allIds) }
        refreshBlockViews()
    }

    public fun requestDeleteSelectedBlocks() {
        if (!canMutate()) return
        val selectedIds = _uiState.value.selectedBlockIds
        val ids = blocks
            .filter { it.id in selectedIds && it.canDeleteWholeBlock }
            .map { it.id }
            .toSet()
        if (ids.isEmpty()) {
            exitSelectionMode()
            return
        }
        if (ids.size >= 2) {
            _events.tryEmit(EditorEvent.ConfirmBulkDelete(ids.size))
        } else {
            confirmDeleteSelectedBlocks()
        }
    }

    public fun confirmDeleteSelectedBlocks() {
        if (!canMutate()) return
        val ids = _uiState.value.selectedBlockIds
        if (ids.isEmpty()) return
        // 协作变更可能让选择集过期，执行时仍以当前整块删除能力为准。
        val deletableIds = blocks
            .filter { it.id in ids && it.canDeleteWholeBlock }
            .map { it.id }
            .toSet()
        if (deletableIds.isEmpty()) { exitSelectionMode(); return }
        pushUndo()
        blocks = blocks.filter { it.id !in deletableIds }.toMutableList()
        if (blocks.isEmpty()) blocks.add(DocBlock.empty(BlockKind.PARAGRAPH))
        focusedBlockId = blocks.firstOrNull()?.id
        cursorPosition = 0
        exitSelectionMode()
        scheduleSave()
    }

    public fun copySelectedBlocksText() {
        val ids = _uiState.value.selectedBlockIds
        val orderedTexts = blocks.filter { it.id in ids }.map { it.clipboardText() }
        val text = orderedTexts.joinToString("\n")
        _events.tryEmit(EditorEvent.CopyToClipboard(text))
        exitSelectionMode()
    }

    public fun onBlockClick(blockId: String) {
        if (_uiState.value.isSelectionMode) {
            toggleBlockSelection(blockId)
        }
    }

    private fun DocBlock.clipboardText(): String = when (kind) {
        BlockKind.TABLE -> tableData?.let { table ->
            TableProjectionLocalization.tableText(appContext, table)
        }.orEmpty()
        else -> text
    }

    // ── 图片块 ──────────────────────────────────────────────────────

    public fun onImagePlaceholderClick(blockId: String) {
        if (!canMutate()) return
        if (!isEditableImageTarget(blockId)) return
        _events.tryEmit(EditorEvent.PickImage(blockId))
    }

    public fun onImagePicked(blockId: String, uriString: String) {
        if (!canMutate()) return
        if (!isEditableImageTarget(blockId)) return
        val uri = Uri.parse(uriString)
        viewModelScope.launch {
            if (!canMutate()) return@launch
            if (!isEditableImageTarget(blockId)) return@launch

            _events.tryEmit(EditorEvent.ShowToast(com.tabtin.mobile.R.string.doc_image_uploading))

            try {
                val resolver = appContext.contentResolver
                val maxBytes = UploadConfig.MAX_IMAGE_SIZE

                // W D：dispatcher 改注入（原硬编码 Dispatchers.IO）。详见 docs/Android-coroutines-conventions.md §3。
                val (bytes, mimeType) = withContext(ioDispatcher) {
                    val size = resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L
                    if (size > maxBytes) {
                        val maxMB = (maxBytes / 1024 / 1024).toInt()
                        throw Exception(appContext.getString(com.tabtin.mobile.R.string.doc_image_too_large, maxMB))
                    }
                    val data = resolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw Exception(appContext.getString(com.tabtin.mobile.R.string.doc_image_cannot_read))
                    val mime = resolver.getType(uri) ?: "image/jpeg"
                    data to mime
                }

                val ext = MimeTypeMap.getSingleton()
                    .getExtensionFromMimeType(mimeType) ?: "jpg"
                val fileName = "doc-image-${System.currentTimeMillis()}.$ext"
                // 选择器回调和本地读取之间可能发生权限变化、删除或块级降级；
                // 网络上传前再校验一次，尽量不创建注定会被丢弃的 FileUsage。
                if (!canMutate() || !isEditableImageTarget(blockId)) return@launch
                val uploadScope = nativeTabDocImageUploadScope(
                    documentId = documentId,
                    organizationId = document?.organizationId.orEmpty(),
                )

                val result = ossUploadService.directUpload(
                    data = bytes,
                    fileName = fileName,
                    contentType = mimeType,
                    folder = "doc/images",
                    scope = uploadScope,
                )

                val ossUrl = result.accessUrl
                if (ossUrl.isBlank()) {
                    deactivateAbandonedImage(result.fileId, uploadScope)
                    throw Exception(appContext.getString(com.tabtin.mobile.R.string.doc_image_empty_url))
                }

                if (!canMutate() || !isEditableImageTarget(blockId)) {
                    deactivateAbandonedImage(result.fileId, uploadScope)
                    return@launch
                }
                val idx = blocks.indexOfFirst { it.id == blockId }
                if (idx < 0) return@launch
                pushUndo()
                blocks[idx] = blocks[idx].copy(
                    imageURL = ossUrl,
                    imageFileId = result.fileId,
                )
                refreshBlockViews()
                scheduleSave()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e("DocEditor", "Image upload failed", e)
                _events.tryEmit(EditorEvent.ShowToast(com.tabtin.mobile.R.string.doc_image_upload_failed))
            }
        }
    }

    private fun isEditableImageTarget(blockId: String): Boolean = blocks.any { block ->
        block.id == blockId && block.kind == BlockKind.IMAGE && block.editable
    }

    private fun deactivateAbandonedImage(fileId: String, scope: UploadScope) {
        ossUploadService.deactivateUsageDetached(
            fileId = fileId,
            module = scope.module,
            contextType = scope.contextType,
            contextId = scope.contextId,
        )
    }

    // ── 表格块 ──────────────────────────────────────────────────────

    public fun onCellTextChanged(
        blockId: String,
        row: Int,
        col: Int,
        text: String,
        marks: List<TabDocMarkup.Mark> = emptyList(),
    ) {
        if (!canMutate()) return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return
        val block = blocks[index]
        if (!block.editable) return
        val table = block.tableData ?: return
        if (row !in table.rows.indices) return
        val rowData = table.rows[row]
        if (col !in rowData.cells.indices) return

        val oldCell = rowData.cells[col]
        if (oldCell.isReadOnlyProjection) return
        // 格子必须走正文同一条 marks→spans；用纯文本重建会把加粗压平。
        val newSpans = BlockViewConverter.marksToSpans(text, marks)
        if (oldCell.text == text && oldCell.spans == newSpans) return

        scheduleTextUndo()

        val newCell = oldCell.copy(
            text = text,
            spans = newSpans,
        )
        val newCells = rowData.cells.toMutableList().also { it[col] = newCell }
        val newRow = rowData.copy(cells = newCells)
        val newRows = table.rows.toMutableList().also { it[row] = newRow }
        val newTable = table.copy(rows = newRows)

        blocks[index] = block.copy(tableData = newTable)
        refreshBlockViews()
        scheduleSave()
    }

    public fun onAddTableRow(blockId: String, afterRow: Int? = null) {
        if (!canMutate()) return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return
        val block = blocks[index]
        if (!block.editable) return
        val table = block.tableData ?: return
        if (!table.canAddRow) return

        val insertionIndex = if (afterRow == null) {
            table.rows.size
        } else {
            if (afterRow !in table.rows.indices) return
            afterRow + 1
        }

        pushUndo()
        val cells = List(table.rows.first().cells.size) { TableCell() }
        val rows = table.rows.toMutableList().also {
            it.add(insertionIndex, TableRow(cells))
        }
        blocks[index] = block.copy(
            tableData = table.copy(rows = rows),
        )
        refreshBlockViews()
        scheduleSave()
    }

    public fun onAddTableColumn(blockId: String, afterColumn: Int? = null) {
        if (!canMutate()) return
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return
        val block = blocks[index]
        if (!block.editable) return
        val table = block.tableData ?: return
        if (!table.canAddColumn || table.rows.any { it.cells.size != table.columnCount }) return

        val insertionIndex = if (afterColumn == null) {
            table.columnCount
        } else {
            if (afterColumn !in 0 until table.columnCount) return
            afterColumn + 1
        }

        pushUndo()
        val rows = table.rows.map { row ->
            val isHeader = row.cells.firstOrNull()?.isHeader == true
            val cells = row.cells.toMutableList().also {
                it.add(insertionIndex, TableCell(isHeader = isHeader))
            }
            row.copy(cells = cells)
        }
        blocks[index] = block.copy(tableData = table.copy(rows = rows))
        refreshBlockViews()
        scheduleSave()
    }

    // ── 代码块语言选择 ──────────────────────────────────────────────

    public fun onLanguageMenuClick(blockId: String) {
        if (!canMutate()) return
        val block = blocks.find { it.id == blockId } ?: return
        _uiState.update {
            it.copy(
                showLanguageSelector = true,
                languageSelectorBlockId = blockId,
                currentCodeLanguage = block.codeLanguage,
            )
        }
    }

    public fun onLanguageSelected(language: String) {
        if (!canMutate()) return
        val blockId = _uiState.value.languageSelectorBlockId ?: return
        pushUndo()
        blocks = DocEditorOrchestrator.updateCodeLanguage(blocks, blockId, language).toMutableList()
        dismissLanguageSelector()
        refreshBlockViews()
        scheduleSave()
    }

    public fun dismissLanguageSelector() {
        _uiState.update {
            it.copy(showLanguageSelector = false, languageSelectorBlockId = null, currentCodeLanguage = "")
        }
    }

    // ── 权限撤销检测 ─────────────────────────────────────────────────

    private fun isPermissionDenied(e: Exception): Boolean {
        if (e is retrofit2.HttpException && e.code() in setOf(403, 404)) return true
        val errorCode = (e as? AppError.RequestFailed)?.errorCode?.trim()?.uppercase()
        return errorCode in setOf("PERMISSION_DENIED", "FORBIDDEN", "NOT_FOUND", "403", "404")
    }

    private fun handlePermissionRevoked() {
        documentOperationGeneration++
        invalidateSaveSession()
        draftSaveJob?.cancel()
        permissionCheckJob?.cancel()
        textUndoJob?.cancel()
        // clearDraft 必须发生在 document 被清空前，才能用原始组织 scope 删除草稿。
        clearDraft()
        blocks.clear()
        documentEnvelope = null
        lastAcknowledgedDocument = null
        documentTitle = ""
        document = null
        content = null
        saveBaseVersion = null
        saveBaseUpdatedAt = null
        draftOriginBaseVersion = null
        draftOriginBaseUpdatedAt = null
        focusedBlockId = null
        cursorPosition = null
        selectionStart = 0
        selectionEnd = 0
        pendingUndoSnapshot = null
        undoStack.clear()
        redoStack.clear()
        _uiState.update {
            it.copy(
                title = "",
                organizationId = "",
                spaceId = null,
                currentUserRole = null,
                blockViews = emptyList(),
                isLoading = false,
                isPermissionRevoked = true,
                saveState = SaveState.PERMISSION_DENIED,
                conflictMessage = appContext.getString(com.tabtin.mobile.R.string.doc_permission_revoked),
                canUndo = false,
                canRedo = false,
                showSlashMenu = false,
                showFormatToolbar = false,
                showBlockActionMenu = false,
                isSelectionMode = false,
                selectedBlockIds = emptySet(),
                showVersionHistory = false,
                versionHistories = emptyList(),
                isLoadingHistories = false,
                isRestoringHistory = false,
                isOfflineDraftPreview = false,
                commentThreads = emptyList(),
                commentPresentations = emptyList(),
                canCreateComment = false,
                showBlockCommentComposer = false,
            )
        }
    }

    /**
     * 同组织却返回了另一个 document，说明响应不能被当前路由接纳，但不等价于读取权丢失。
     * 保留本地稿与当前可见内容，停在不可自动写入的冲突态，等待用户重试或转完整编辑器。
     */
    private fun handleMismatchedDocumentResponse(
        preservedBlocks: List<DocBlock> = blocks.toList(),
        preservedTitle: String = documentTitle,
        persistCurrentState: Boolean = true,
    ) {
        blocks = preservedBlocks.toMutableList()
        documentTitle = preservedTitle
        if (persistCurrentState) persistDraft(sync = true)
        retryCount = 0
        retryJob?.cancel()
        _uiState.update {
            it.copy(
                title = documentTitle,
                isLoading = false,
                saveState = SaveState.CONFLICT,
                conflictMessage = appContext.getString(R.string.doc_save_conflict),
            )
        }
        refreshBlockViews()
    }

    private fun startPermissionCheckIfNeeded() {
        if (permissionCheckJob != null) return
        permissionCheckJob = viewModelScope.launch {
            while (true) {
                delay(PERMISSION_CHECK_INTERVAL_MS)
                if (_uiState.value.isPermissionRevoked) return@launch
                val generation = documentOperationGeneration
                try {
                    val detail = docRepository.getDocumentDetail(documentId)
                    if (!hasMatchingOrganization(detail.document.organizationId) ||
                        !hasCurrentDocumentIdentity()
                    ) {
                        handlePermissionRevoked()
                        return@launch
                    }
                    if (detail.document.id != documentId) {
                        handleMismatchedDocumentResponse()
                        return@launch
                    }
                    val projection = projectRemoteContent(detail.content)
                    if (generation != documentOperationGeneration) continue
                    if (!hasMatchingOrganization(detail.document.organizationId) ||
                        !hasCurrentDocumentIdentity()
                    ) {
                        handlePermissionRevoked()
                        return@launch
                    }
                    applyRemoteDetail(detail, projection, preserveLocalDraft = true)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (generation != documentOperationGeneration) continue
                    if (isPermissionDenied(e)) {
                        handlePermissionRevoked()
                        return@launch
                    }
                }
            }
        }
    }

    // ── 评论第一档：只读展示 + 新增块级/文档级，不写 commentAnchor ──

    public fun updateDocumentCommentDraft(value: String) {
        _uiState.update { it.copy(documentCommentDraft = value) }
    }

    public fun updateBlockCommentDraft(value: String) {
        _uiState.update { it.copy(blockCommentDraft = value) }
    }

    public fun startBlockComment() {
        val runtimeId = _uiState.value.actionBlockId ?: return
        if (!canCreateComment()) {
            dismissBlockAction()
            return
        }
        val block = blocks.find { it.id == runtimeId } ?: return
        if (block.blockId.isNullOrBlank()) {
            dismissBlockAction()
            _events.tryEmit(EditorEvent.ShowToast(R.string.doc_comment_missing_anchor))
            return
        }
        dismissBlockAction()
        _uiState.update {
            it.copy(
                showBlockCommentComposer = true,
                commentComposerBlockRuntimeId = runtimeId,
                blockCommentDraft = "",
            )
        }
    }

    public fun dismissBlockCommentComposer() {
        _uiState.update {
            it.copy(
                showBlockCommentComposer = false,
                commentComposerBlockRuntimeId = null,
                blockCommentDraft = "",
            )
        }
    }

    public fun submitDocumentComment() {
        createDocumentComment(_uiState.value.documentCommentDraft)
    }

    public fun submitBlockComment() {
        val runtimeId = _uiState.value.commentComposerBlockRuntimeId ?: return
        createBlockComment(runtimeId, _uiState.value.blockCommentDraft)
    }

    public fun createDocumentComment(body: String) {
        postComment(
            body = body,
            scope = "document",
            anchor = CommentAnchor(version = 1),
            selectedText = null,
        )
    }

    public fun createBlockComment(runtimeBlockId: String, body: String) {
        val block = blocks.find { it.id == runtimeBlockId } ?: return
        val persistentId = block.blockId?.takeIf(String::isNotBlank) ?: return
        val excerpt = block.text.trim().take(500).ifBlank { null }
        postComment(
            body = body,
            scope = "block",
            anchor = CommentAnchor(
                version = 1,
                blockIds = listOf(persistentId),
                blockType = commentBlockType(block.kind),
                selectedText = excerpt,
            ),
            selectedText = excerpt,
        )
    }

    private fun postComment(
        body: String,
        scope: String,
        anchor: CommentAnchor,
        selectedText: String?,
    ) {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || documentId.isEmpty()) return
        if (!canCreateComment()) return
        if (_uiState.value.isPostingComment) return
        val generation = documentOperationGeneration
        commentPostJob?.cancel()
        commentPostJob = viewModelScope.launch {
            _uiState.update { it.copy(isPostingComment = true) }
            try {
                val created = docRepository.createCommentThread(
                    documentId = documentId,
                    body = trimmed,
                    scope = scope,
                    anchor = anchor,
                    selectedText = selectedText,
                )
                if (generation != documentOperationGeneration) return@launch
                val threads = _uiState.value.commentThreads + created
                refreshCommentUi(threads)
                _uiState.update {
                    it.copy(
                        isPostingComment = false,
                        documentCommentDraft = if (scope == "document") "" else it.documentCommentDraft,
                        showBlockCommentComposer = if (scope == "block") false else it.showBlockCommentComposer,
                        commentComposerBlockRuntimeId = if (scope == "block") null else it.commentComposerBlockRuntimeId,
                        blockCommentDraft = if (scope == "block") "" else it.blockCommentDraft,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (generation != documentOperationGeneration) return@launch
                _uiState.update { it.copy(isPostingComment = false) }
                _events.tryEmit(EditorEvent.ShowToast(R.string.doc_comment_send_failed))
            } finally {
                if (generation == documentOperationGeneration) commentPostJob = null
            }
        }
    }

    private fun canCreateComment(): Boolean {
        val state = _uiState.value
        return DocCommentWritePolicy.canCreate(
            saveState = state.saveState,
            isReadOnly = state.isReadOnlyByRole || state.isPermissionRevoked || state.isOfflineDraftPreview,
            requiresFullEditor = state.requiresFullEditor,
        )
    }

    private fun loadCommentThreads(generation: Long) {
        if (documentId.isEmpty()) return
        commentLoadJob?.cancel()
        commentLoadJob = viewModelScope.launch {
            _uiState.update { it.copy(isLoadingComments = true) }
            try {
                val result = docRepository.listCommentThreads(documentId)
                if (generation != documentOperationGeneration) return@launch
                refreshCommentUi(result.threads)
                _uiState.update { it.copy(isLoadingComments = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (generation != documentOperationGeneration) return@launch
                _uiState.update { it.copy(isLoadingComments = false) }
            } finally {
                if (generation == documentOperationGeneration) commentLoadJob = null
            }
        }
    }

    private fun refreshCommentUi(threads: List<CommentThread> = _uiState.value.commentThreads) {
        _uiState.update {
            it.copy(
                commentThreads = threads,
                commentPresentations = presentCommentThreads(threads, blocks, commentLabels()),
                canCreateComment = canCreateComment(it),
            )
        }
    }

    private fun canCreateComment(state: UiState): Boolean =
        DocCommentWritePolicy.canCreate(
            saveState = state.saveState,
            isReadOnly = state.isReadOnlyByRole || state.isPermissionRevoked || state.isOfflineDraftPreview,
            requiresFullEditor = state.requiresFullEditor,
        )

    private fun commentLabels(): DocCommentPresentationLabels =
        DocCommentPresentationLabels(
            documentTitle = appContext.getString(R.string.doc_comment_document),
            blockTitle = appContext.getString(R.string.doc_comment_block),
            orphanedTitle = appContext.getString(R.string.doc_comment_orphaned),
            anonymousAuthor = appContext.getString(R.string.doc_comment_anonymous),
        )

    private fun commentBlockType(kind: BlockKind): String? = when (kind) {
        BlockKind.PARAGRAPH -> "paragraph"
        BlockKind.HEADING1, BlockKind.HEADING2, BlockKind.HEADING3,
        BlockKind.HEADING4, BlockKind.HEADING5, BlockKind.HEADING6 -> "heading"
        BlockKind.BULLET_ITEM, BlockKind.ORDERED_ITEM, BlockKind.TODO_ITEM -> "listItem"
        BlockKind.CODE_BLOCK -> "codeBlock"
        BlockKind.BLOCKQUOTE -> "blockquote"
        BlockKind.DIVIDER -> "horizontalRule"
        BlockKind.IMAGE -> "image"
        BlockKind.TABLE -> "table"
        BlockKind.UNSUPPORTED -> null
    }

    // ── 版本历史 ──

    public fun showVersionHistory() {
        _uiState.update { it.copy(showVersionHistory = true) }
        loadHistories()
    }

    public fun dismissVersionHistory() {
        _uiState.update { it.copy(showVersionHistory = false) }
    }

    private fun loadHistories() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingHistories = true) }
            try {
                val histories = docRepository.listHistories(documentId)
                _uiState.update { it.copy(versionHistories = histories, isLoadingHistories = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isLoadingHistories = false) }
                _events.tryEmit(EditorEvent.ShowToast(R.string.doc_version_load_failed))
            }
        }
    }

    public fun restoreVersion(historyId: String) {
        if (!canMutate()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isRestoringHistory = true) }
            try {
                docRepository.restoreHistory(documentId, historyId)
                _uiState.update { it.copy(isRestoringHistory = false, showVersionHistory = false) }
                _events.tryEmit(EditorEvent.ShowToast(R.string.doc_version_restored))
                loadDocument()
            } catch (_: Exception) {
                _uiState.update { it.copy(isRestoringHistory = false) }
                _events.tryEmit(EditorEvent.ShowToast(R.string.doc_version_restore_failed))
            }
        }
    }

    public companion object {
        private val LOCAL_DRAFT_STATES = setOf(
            SaveState.DIRTY,
            SaveState.SAVING,
            SaveState.FAILED,
            SaveState.CONFLICT,
        )
        private const val AUTOSAVE_DELAY_MS = 1200L
        private const val MAX_UNDO_HISTORY = 50
        internal const val TEXT_UNDO_DEBOUNCE_MS = 500L
        private const val DRAFT_PREFS_NAME = "tabdoc_drafts"
        private const val DRAFT_PERSIST_INTERVAL_MS = 2000L
        private const val NO_DRAFT_BASE_VERSION = -1L
        internal const val MAX_RETRY_COUNT = 5
        internal const val INITIAL_RETRY_DELAY_MS = 2000L
        private const val MAX_RETRY_DELAY_MS = 30_000L
        internal const val PERMISSION_CHECK_INTERVAL_MS = 60_000L
    }
}

internal fun nativeTabDocImageUploadScope(documentId: String, organizationId: String): UploadScope =
    UploadScope(
        module = "tabdoc",
        contextType = "document",
        contextId = documentId,
        organizationId = organizationId,
        isPublic = false,
    )
