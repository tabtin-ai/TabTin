package com.tabtin.mobile.features.doc

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.Editable
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.features.clouddocs.CloudDocsShareSheet
import com.tabtin.mobile.features.clouddocs.CloudDocsShareTarget
import com.tabtin.mobile.features.doc.editor.TableProjectionLocalization
import com.tabtin.mobile.features.doc.editor.core.DocInlineImageLoader
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.DocTextInputWidget
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.editor.core.TextInputTextWatcher
import com.tabtin.mobile.features.doc.editor.core.toSpannable
import com.tabtin.mobile.features.doc.editor.interaction.BlockActionMenuSheet
import com.tabtin.mobile.features.doc.editor.interaction.CodeLanguageSelectorSheet
import com.tabtin.mobile.features.doc.editor.interaction.DocFormatToolbar
import com.tabtin.mobile.features.doc.editor.interaction.HighlightPickerSheet
import com.tabtin.mobile.features.doc.editor.interaction.SelectionToolbar
import com.tabtin.mobile.features.doc.editor.interaction.TextColorPickerSheet
import com.tabtin.mobile.features.doc.comment.DocBlockCommentComposerSheet
import com.tabtin.mobile.features.doc.comment.DocCommentImePolicy
import com.tabtin.mobile.features.doc.comment.DocCommentsFooterUi
import com.tabtin.mobile.features.doc.editor.interaction.DocSlashMenuSheet
import com.tabtin.mobile.features.doc.editor.core.DocFormulaPaintHost
import com.tabtin.mobile.features.doc.editor.core.DocFormulaPaintView
import com.tabtin.mobile.features.doc.editor.holders.DocBlockAdapter
import com.tabtin.mobile.features.doc.editor.holders.extractMarksFromSpannable
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow
import com.tabtin.mobile.features.tabchat.ResourceDirectMessageResource
import com.tabtin.mobile.features.tabchat.ResourceDirectMessageShareSheet
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.applyTTTypography
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

/**
 * 文档编辑器主界面 —— Compose Scaffold 包裹 RecyclerView。
 *
 * 结构：TopBar（返回 + 保存状态）+ RecyclerView（标题 + 正文）+
 *       BottomBar（格式工具栏）+ Slash 菜单 BottomSheet。
 */
@Composable
public fun DocEditorScreen(
    viewModel: DocEditorViewModel,
    onBack: () -> Unit,
    backHandlingEnabled: Boolean = true,
    onOpenFullEditor: (() -> Unit)? = null,
) {
    DocEditorScreenContent(
        viewModel = viewModel,
        onBack = onBack,
        backHandlingEnabled = backHandlingEnabled,
        onOpenFullEditor = onOpenFullEditor,
    )
}

/** Debug 设备夹具复用的生产编辑器表面；不包含网络或身份逻辑。 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun DocEditorReviewSurface(
    initialState: DocEditorViewModel.UiState,
    modifier: Modifier = Modifier,
    onBack: () -> Unit = {},
    onOpenFullEditor: (() -> Unit)? = null,
) {
    var state by remember(initialState) { mutableStateOf(initialState) }
    val context = LocalContext.current
    var tableCellPreview by remember { mutableStateOf<TableCellPreview?>(null) }
    val adapter = remember {
        DocBlockAdapter(
            onTextChanged = { id, text, _ ->
                state = state.copy(
                    blockViews = state.blockViews.map { it.withReviewText(id, text) },
                    saveState = SaveState.DIRTY,
                )
            },
            onEnterPressed = { _, _ -> },
            onEmptyBackspace = {},
            onFocusChanged = {},
            onSlashEvent = { _, _ -> },
            onSelectionChanged = { _, _ -> },
            onCheckChanged = { id, checked ->
                state = state.copy(
                    blockViews = state.blockViews.map { block ->
                        if (block is TabDocBlockView.Text.Checkbox && block.id == id) block.copy(isChecked = checked)
                        else block
                    },
                    saveState = SaveState.DIRTY,
                )
            },
            onCodeTextChanged = { id, text ->
                state = state.copy(
                    blockViews = state.blockViews.map { block ->
                        if (block is TabDocBlockView.Code && block.id == id) block.copy(body = text) else block
                    },
                    saveState = SaveState.DIRTY,
                )
            },
            onTitleChanged = { state = state.copy(title = it, saveState = SaveState.DIRTY) },
            onTableCellClick = { blockId, row, column, table, isEditable, canModifyStructure ->
                tableCellPreview = tableCellPreviewOf(
                    context,
                    blockId,
                    row,
                    column,
                    table,
                    isEditable,
                    canModifyStructure,
                )
            },
            onCopyTable = { copyTableText(context, it) },
            onAddTableRow = { blockId, afterRow ->
                state = state.copy(
                    blockViews = state.blockViews.map {
                        it.withReviewTableRow(blockId, afterRow)
                    },
                    saveState = SaveState.DIRTY,
                )
            },
            onAddTableColumn = { blockId, afterColumn ->
                state = state.copy(
                    blockViews = state.blockViews.map {
                        it.withReviewTableColumn(blockId, afterColumn)
                    },
                    saveState = SaveState.DIRTY,
                )
            },
        )
    }

    DisposableEffect(adapter) { onDispose(adapter::destroy) }
    LaunchedEffect(state.title, state.blockViews, state.requiresFullEditor, state.saveState) {
        adapter.isReadOnly = state.requiresFullEditor || state.isReadOnlyByRole ||
            state.saveState == SaveState.CONFLICT
        adapter.update(DocEditorContentPolicy.adapterItems(state.title, state.blockViews))
    }

    tableCellPreview?.let { preview ->
        TableCellEditorSheet(
            preview = preview,
            onDismiss = { tableCellPreview = null },
            onTextChanged = { text, marks ->
                state = state.copy(
                    blockViews = state.blockViews.map {
                        it.withReviewTableCell(
                            preview.blockId,
                            preview.row,
                            preview.column,
                            text,
                            marks,
                        )
                    },
                    saveState = SaveState.DIRTY,
                )
            },
            onCopy = { copyTableText(context, it) },
            onInsertRowBelow = {
                state = state.copy(
                    blockViews = state.blockViews.map {
                        it.withReviewTableRow(preview.blockId, preview.row)
                    },
                    saveState = SaveState.DIRTY,
                )
            },
            onInsertColumnRight = {
                state = state.copy(
                    blockViews = state.blockViews.map {
                        it.withReviewTableColumn(preview.blockId, preview.column)
                    },
                    saveState = SaveState.DIRTY,
                )
            },
        )
    }

    Box(modifier = modifier.fillMaxSize()) {
        DocFormulaPaintLayer(Modifier.align(Alignment.TopStart))
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = {
                DocEditorTopBar(
                    saveState = state.saveState,
                    moreMenu = DocPageChromePolicy.moreMenu(
                        canShareLink = false,
                        canSendDirectMessage = false,
                        canOpenFullEditor = onOpenFullEditor != null,
                        canSave = false,
                    ),
                    onBack = onBack,
                    onOpenFullEditor = onOpenFullEditor,
                )
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                Column(Modifier.fillMaxSize()) {
                    if (state.requiresFullEditor) {
                        NativeFullEditorRequiredBanner(
                            onOpenFullEditor = onOpenFullEditor,
                            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                        )
                    }
                    AndroidView(
                        factory = { context ->
                            RecyclerView(context).apply {
                                layoutManager = LinearLayoutManager(context)
                                this.adapter = adapter
                                itemAnimator = null
                                clipToPadding = false
                                val bottom = (48 * resources.displayMetrics.density).toInt()
                                setPadding(0, 0, 0, bottom)
                            }
                        },
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    )
                }
            }
        }
    }

    LaunchedEffect(state.title, state.blockViews, state.saveState) {
        when (state.saveState) {
            SaveState.DIRTY -> {
                kotlinx.coroutines.delay(650)
                state = state.copy(saveState = SaveState.SAVING)
            }
            SaveState.SAVING -> {
                kotlinx.coroutines.delay(350)
                state = state.copy(saveState = SaveState.SAVED)
            }
            else -> Unit
        }
    }
}

private fun TabDocBlockView.withReviewText(id: String, text: String): TabDocBlockView = when (this) {
    is TabDocBlockView.Text.Paragraph -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderOne -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderTwo -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderThree -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderFour -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderFive -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.HeaderSix -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.Bulleted -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.Numbered -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.Checkbox -> if (this.id == id) copy(body = text) else this
    is TabDocBlockView.Text.Quote -> if (this.id == id) copy(body = text) else this
    else -> this
}

private fun TabDocBlockView.withReviewTableCell(
    blockId: String,
    row: Int,
    column: Int,
    text: String,
    marks: List<TabDocMarkup.Mark>,
): TabDocBlockView {
    if (this !is TabDocBlockView.Table || id != blockId) return this
    val rowData = tableData.rows.getOrNull(row) ?: return this
    val cell = rowData.cells.getOrNull(column)?.takeUnless(TableCell::isReadOnlyProjection) ?: return this
    val cells = rowData.cells.toMutableList().also {
        it[column] = cell.copy(
            text = text,
            spans = BlockViewConverter.marksToSpans(text, marks),
        )
    }
    val rows = tableData.rows.toMutableList().also { it[row] = rowData.copy(cells = cells) }
    return copy(tableData = tableData.copy(rows = rows))
}

private fun TabDocBlockView.withReviewTableRow(
    blockId: String,
    afterRow: Int?,
): TabDocBlockView {
    if (this !is TabDocBlockView.Table || id != blockId || !tableData.canAddRow) return this
    val insertionIndex = if (afterRow == null) {
        tableData.rows.size
    } else {
        if (afterRow !in tableData.rows.indices) return this
        afterRow + 1
    }
    val cells = List(tableData.rows.first().cells.size) { TableCell() }
    val rows = tableData.rows.toMutableList().also {
        it.add(insertionIndex, TableRow(cells))
    }
    return copy(tableData = tableData.copy(rows = rows))
}

private fun TabDocBlockView.withReviewTableColumn(
    blockId: String,
    afterColumn: Int?,
): TabDocBlockView {
    if (this !is TabDocBlockView.Table || id != blockId || !tableData.canAddColumn ||
        tableData.rows.any { it.cells.size != tableData.columnCount }
    ) return this
    val insertionIndex = if (afterColumn == null) {
        tableData.columnCount
    } else {
        if (afterColumn !in 0 until tableData.columnCount) return this
        afterColumn + 1
    }
    return copy(
        tableData = tableData.copy(
            rows = tableData.rows.map { row ->
                val cells = row.cells.toMutableList().also {
                    it.add(
                        insertionIndex,
                        TableCell(isHeader = row.cells.firstOrNull()?.isHeader == true),
                    )
                }
                row.copy(
                    cells = cells,
                )
            },
        ),
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun DocEditorScreenContent(
    viewModel: DocEditorViewModel,
    onBack: () -> Unit,
    backHandlingEnabled: Boolean,
    onOpenFullEditor: (() -> Unit)?,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val imeVisible = WindowInsets.isImeVisible
    val density = LocalDensity.current
    val imeBottomPx = WindowInsets.ime.getBottom(density)
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val coroutineScope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var showDiscardDialog by remember { mutableStateOf(false) }
    var isFlushingForExit by remember { mutableStateOf(false) }
    var showDiscardDraftForFullEditorDialog by remember { mutableStateOf(false) }
    var showBulkDeleteDialog by remember { mutableStateOf(false) }
    var bulkDeleteCount by remember { mutableIntStateOf(0) }
    var pendingImageBlockId by remember { mutableStateOf<String?>(null) }
    var directMessageResource by remember { mutableStateOf<ResourceDirectMessageResource?>(null) }
    var shareTarget by remember { mutableStateOf<CloudDocsShareTarget?>(null) }
    var tableCellPreview by remember { mutableStateOf<TableCellPreview?>(null) }

    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        val blockId = pendingImageBlockId ?: return@rememberLauncherForActivityResult
        pendingImageBlockId = null
        if (uri != null) {
            viewModel.onImagePicked(blockId, uri.toString())
        }
    }

    LifecycleResumeEffect(viewModel) {
        viewModel.refreshOnResume()
        onPauseOrDispose { viewModel.flushForLifecycle() }
    }

    fun requestBack() {
        if (state.isSelectionMode) {
            viewModel.exitSelectionMode()
            return
        }
        when (state.saveState) {
            SaveState.DIRTY, SaveState.SAVING, SaveState.FAILED -> {
                if (isFlushingForExit) return
                isFlushingForExit = true
                coroutineScope.launch {
                    val saved = viewModel.flush()
                    isFlushingForExit = false
                    if (saved) onBack() else showDiscardDialog = true
                }
            }
            SaveState.CONFLICT -> showDiscardDialog = true
            SaveState.IDLE, SaveState.SAVED, SaveState.PERMISSION_DENIED -> onBack()
        }
    }

    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            when (event) {
                is DocEditorViewModel.EditorEvent.CopyToClipboard -> {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("block text", event.text))
                    Toast.makeText(context, R.string.doc_block_copied, Toast.LENGTH_SHORT).show()
                }
                is DocEditorViewModel.EditorEvent.PickImage -> {
                    pendingImageBlockId = event.blockId
                    imagePicker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }
                is DocEditorViewModel.EditorEvent.ConfirmBulkDelete -> {
                    bulkDeleteCount = event.count
                    showBulkDeleteDialog = true
                }
                DocEditorViewModel.EditorEvent.ConfirmDiscardDraftForFullEditor -> {
                    showDiscardDraftForFullEditorDialog = true
                }
                is DocEditorViewModel.EditorEvent.ShowToast -> {
                    Toast.makeText(context, event.messageRes, Toast.LENGTH_SHORT).show()
                }
                DocEditorViewModel.EditorEvent.OpenFullEditor -> onOpenFullEditor?.invoke()
            }
        }
    }

    BackHandler(enabled = backHandlingEnabled, onBack = ::requestBack)

    if (showDiscardDialog) {
        val isConflictLeave = state.saveState == SaveState.CONFLICT
        AlertDialog(
            onDismissRequest = { showDiscardDialog = false },
            title = {
                Text(
                    stringResource(
                        if (isConflictLeave) R.string.doc_editor_conflict_leave_title
                        else R.string.doc_editor_unsaved_title,
                    ),
                )
            },
            text = {
                Text(
                    stringResource(
                        if (isConflictLeave) R.string.doc_editor_conflict_leave_message
                        else R.string.doc_editor_unsaved_message,
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDiscardDialog = false
                    if (isConflictLeave && !viewModel.discardLocalDraft()) {
                        Toast.makeText(
                            context,
                            R.string.doc_full_editor_discard_failed,
                            Toast.LENGTH_SHORT,
                        ).show()
                        return@TextButton
                    }
                    onBack()
                }) {
                    Text(
                        stringResource(
                            if (isConflictLeave) R.string.doc_editor_discard_and_leave
                            else R.string.doc_editor_leave,
                        ),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardDialog = false }) {
                    Text(stringResource(R.string.doc_editor_stay))
                }
            },
        )
    }

    if (showDiscardDraftForFullEditorDialog) {
        AlertDialog(
            onDismissRequest = { showDiscardDraftForFullEditorDialog = false },
            title = { Text(stringResource(R.string.doc_full_editor_discard_title)) },
            text = { Text(stringResource(R.string.doc_full_editor_discard_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDiscardDraftForFullEditorDialog = false
                        viewModel.discardDraftAndOpenFullEditor()
                    },
                ) {
                    Text(
                        text = stringResource(R.string.doc_full_editor_discard_confirm),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardDraftForFullEditorDialog = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showBulkDeleteDialog) {
        AlertDialog(
            onDismissRequest = { showBulkDeleteDialog = false },
            title = { Text(stringResource(R.string.doc_selection_delete_title)) },
            text = { Text(stringResource(R.string.doc_selection_delete_message, bulkDeleteCount)) },
            confirmButton = {
                TextButton(onClick = {
                    showBulkDeleteDialog = false
                    viewModel.confirmDeleteSelectedBlocks()
                }) {
                    Text(
                        stringResource(R.string.doc_block_action_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showBulkDeleteDialog = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    tableCellPreview?.let { preview ->
        TableCellEditorSheet(
            preview = preview,
            onDismiss = { tableCellPreview = null },
            onTextChanged = { text, marks ->
                viewModel.onCellTextChanged(preview.blockId, preview.row, preview.column, text, marks)
            },
            onCopy = { copyTableText(context, it) },
            onInsertRowBelow = {
                viewModel.onAddTableRow(preview.blockId, preview.row)
            },
            onInsertColumnRight = {
                viewModel.onAddTableColumn(preview.blockId, preview.column)
            },
        )
    }

    // 行内图片加载器与 Adapter 同生命周期：缓存跨滚动复用，切文档时随 Adapter 一起重建。
    val inlineImageScope = rememberCoroutineScope()
    val inlineImageLoader = remember(viewModel) {
        DocInlineImageLoader(
            context = context.applicationContext,
            scope = inlineImageScope,
            resolveDisplayUrl = viewModel::resolveInlineImageDisplayUrl,
        )
    }

    // RecyclerView Adapter —— 只创建一次，回调直连 ViewModel
    val adapter = remember {
        DocBlockAdapter(
            onTextChanged = viewModel::onTextChanged,
            onEnterPressed = viewModel::onEnterPressed,
            onEmptyBackspace = viewModel::onEmptyBackspace,
            onFocusChanged = viewModel::onFocusChanged,
            onSlashEvent = viewModel::onSlashEvent,
            onSelectionChanged = viewModel::onSelectionChanged,
            onCheckChanged = viewModel::onCheckChanged,
            onCodeTextChanged = viewModel::onCodeTextChanged,
            onTitleChanged = viewModel::onTitleChanged,
            onBlockLongPress = viewModel::onBlockLongPress,
            onLanguageMenuClick = viewModel::onLanguageMenuClick,
            onBlockClick = viewModel::onBlockClick,
            onImagePlaceholderClick = viewModel::onImagePlaceholderClick,
            onTableCellClick = { blockId, row, column, table, isEditable, canModifyStructure ->
                tableCellPreview = tableCellPreviewOf(
                    context,
                    blockId,
                    row,
                    column,
                    table,
                    isEditable,
                    canModifyStructure,
                )
            },
            onCopyTable = { copyTableText(context, it) },
            onAddTableRow = viewModel::onAddTableRow,
            onAddTableColumn = viewModel::onAddTableColumn,
            onCommentDraftChange = viewModel::updateDocumentCommentDraft,
            onCommentSubmit = viewModel::submitDocumentComment,
            inlineImageLoader = inlineImageLoader,
        )
    }

    DisposableEffect(adapter) {
        onDispose {
            adapter.destroy()
        }
    }

    Box(Modifier.fillMaxSize()) {
        DocFormulaPaintLayer(Modifier.align(Alignment.TopStart))
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                val moreMenu = DocPageChromePolicy.moreMenu(
                    canShareLink = state.documentId.isNotBlank() &&
                        !state.isPermissionRevoked &&
                        !state.isOfflineDraftPreview,
                    canSendDirectMessage = state.organizationId.isNotBlank() &&
                        !state.isPermissionRevoked &&
                        !state.isOfflineDraftPreview,
                    canOpenFullEditor = onOpenFullEditor != null,
                    canSave = false,
                )
                DocEditorTopBar(
                    saveState = state.saveState,
                    moreMenu = moreMenu,
                    onBack = ::requestBack,
                    onShowHistory = viewModel::showVersionHistory,
                    onShareLink = {
                        shareTarget = CloudDocsShareTarget(
                            resourceId = state.documentId,
                            type = CloudShareResourceType.DOCUMENT,
                            title = state.title,
                        )
                    },
                    onSendToDirectMessage = {
                        directMessageResource = ResourceDirectMessageResource(
                            resourceType = ImResourceCardType.DOCUMENT,
                            resourceId = state.documentId,
                            name = state.title.ifBlank { context.getString(R.string.doc_untitled) },
                            organizationId = state.organizationId,
                            spaceId = state.spaceId,
                            currentUserRole = state.currentUserRole,
                        )
                    },
                    onOpenFullEditor = onOpenFullEditor?.let { viewModel::requestOpenFullEditor },
                    onRetrySave = viewModel::saveDocument,
                )
            },
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
            when {
                state.isLoading -> {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                state.errorRes != null -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            stringResource(state.errorRes ?: R.string.doc_editor_error),
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { viewModel.reload() }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                state.isPermissionRevoked -> {
                    Text(
                        text = stringResource(R.string.doc_permission_revoked),
                        style = TTFonts.body,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(horizontal = TTSpacing.xxxl),
                    )
                }
                else -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        if (state.saveState == SaveState.CONFLICT && state.conflictMessage != null) {
                            ConflictDraftBanner(
                                message = state.conflictMessage.orEmpty(),
                                onDiscardAndReload = {
                                    if (viewModel.discardLocalDraft()) {
                                        viewModel.reload()
                                    }
                                },
                                modifier = Modifier.padding(
                                    horizontal = TTSpacing.lg,
                                    vertical = TTSpacing.sm,
                                ),
                            )
                        }
                        if (state.isAgentEditing) {
                            AgentEditingBanner(
                                modifier = Modifier.padding(
                                    horizontal = TTSpacing.lg,
                                    vertical = TTSpacing.sm,
                                ),
                            )
                        }
                        if (state.isOfflineDraftPreview) {
                            OfflineDocDraftBanner(
                                onRetry = viewModel::reload,
                                onCopy = viewModel::copyOfflineDraft,
                                modifier = Modifier.padding(
                                    horizontal = TTSpacing.lg,
                                    vertical = TTSpacing.sm,
                                ),
                            )
                        } else if (state.requiresFullEditor) {
                            NativeFullEditorRequiredBanner(
                                onOpenFullEditor = onOpenFullEditor?.let { viewModel::requestOpenFullEditor },
                                modifier = Modifier.padding(
                                    horizontal = TTSpacing.lg,
                                    vertical = TTSpacing.sm,
                                ),
                            )
                        }
                        // RecyclerView 嵌入 Compose（附带 ItemTouchHelper 拖拽排序）
                        AndroidView(
                        factory = { ctx ->
                            RecyclerView(ctx).apply {
                                layoutManager = LinearLayoutManager(ctx)
                                this.adapter = adapter
                                setHasFixedSize(false)
                                setRecycledViewPool(RecyclerView.RecycledViewPool().apply {
                                    setMaxRecycledViews(TabDocBlockView.Types.PARAGRAPH, 8)
                                    setMaxRecycledViews(TabDocBlockView.Types.HEADER_ONE, 3)
                                    setMaxRecycledViews(TabDocBlockView.Types.BULLETED, 5)
                                    setMaxRecycledViews(TabDocBlockView.Types.NUMBERED, 5)
                                })
                                itemAnimator = null
                                clipChildren = true
                                clipToPadding = true
                                installBlankAreaTapHandler {
                                    focusManager.clearFocus(force = true)
                                    viewModel.onEditorBackgroundTapped()
                                }

                                val touchCallback = object : ItemTouchHelper.Callback() {
                                    private var dragFrom = -1
                                    private var dragTo = -1

                                    override fun getMovementFlags(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
                                        if (state.requiresFullEditor || state.isReadOnlyByRole ||
                                            state.isOfflineDraftPreview || state.saveState == SaveState.CONFLICT
                                        ) return makeMovementFlags(0, 0)
                                        if (vh.itemViewType == TabDocBlockView.Types.TITLE ||
                                            vh.itemViewType == TabDocBlockView.Types.COMMENTS
                                        ) {
                                            return makeMovementFlags(0, 0)
                                        }
                                        return makeMovementFlags(ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0)
                                    }

                                    override fun onMove(rv: RecyclerView, src: RecyclerView.ViewHolder, tgt: RecyclerView.ViewHolder): Boolean {
                                        val from = src.bindingAdapterPosition
                                        val to = tgt.bindingAdapterPosition
                                        if (from < 0 || to < 0) return false
                                        val fromBlock = DocEditorContentPolicy.documentBlockIndex(
                                            from,
                                            rv.adapter?.itemCount,
                                        ) ?: return false
                                        val toBlock = DocEditorContentPolicy.documentBlockIndex(
                                            to,
                                            rv.adapter?.itemCount,
                                        ) ?: return false
                                        if (dragFrom == -1) dragFrom = fromBlock
                                        dragTo = toBlock
                                        adapter.moveItem(from, to)
                                        return true
                                    }

                                    override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {}

                                    override fun isLongPressDragEnabled() = false

                                    override fun onSelectedChanged(vh: RecyclerView.ViewHolder?, actionState: Int) {
                                        super.onSelectedChanged(vh, actionState)
                                        if (actionState == ItemTouchHelper.ACTION_STATE_DRAG) {
                                            adapter.setDragActive(true)
                                            vh?.itemView?.alpha = 0.7f
                                            vh?.itemView?.elevation = 8f
                                        }
                                    }

                                    override fun clearView(rv: RecyclerView, vh: RecyclerView.ViewHolder) {
                                        super.clearView(rv, vh)
                                        vh.itemView.alpha = 1.0f
                                        vh.itemView.elevation = 0f
                                        adapter.setDragActive(false)
                                        if (dragFrom != -1 && dragTo != -1 && dragFrom != dragTo) {
                                            viewModel.onBlockMoved(dragFrom, dragTo)
                                        }
                                        dragFrom = -1
                                        dragTo = -1
                                    }
                                }
                                val ith = ItemTouchHelper(touchCallback)
                                ith.attachToRecyclerView(this)
                                adapter.itemTouchHelper = ith

                            }
                        },
                            update = { rv ->
                                val pxDensity = rv.resources.displayMetrics.density
                                val bottom = DocCommentImePolicy.recyclerViewBottomPaddingPx(
                                    imeVisible = imeVisible,
                                    imeBottomPx = imeBottomPx,
                                    showFormatToolbar = state.showFormatToolbar,
                                    restingPx = (16f * pxDensity).toInt(),
                                    formatRoomPx = (120f * pxDensity).toInt(),
                                )
                                if (rv.paddingBottom != bottom) {
                                    rv.setPadding(0, 0, 0, bottom)
                                }
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                        )
                    }

                    // 监听 blockViews 变化，驱动 adapter 更新
                    LaunchedEffect(
                        state.title,
                        state.blockViews,
                        state.isSelectionMode,
                        state.requiresFullEditor,
                        state.isPermissionRevoked,
                        state.isReadOnlyByRole,
                        state.saveState,
                        state.commentPresentations,
                        state.documentCommentDraft,
                        state.canCreateComment,
                        state.isPostingComment,
                    ) {
                        adapter.isSelectionMode = state.isSelectionMode
                        adapter.isReadOnly = state.requiresFullEditor || state.isPermissionRevoked ||
                            state.isReadOnlyByRole || state.saveState == SaveState.CONFLICT
                        adapter.commentsUi = DocCommentsFooterUi(
                            presentations = state.commentPresentations,
                            draft = state.documentCommentDraft,
                            canCreate = state.canCreateComment,
                            isPosting = state.isPostingComment,
                        )
                        adapter.update(DocEditorContentPolicy.adapterItems(state.title, state.blockViews))
                    }
                }
            }

            // Slash 菜单 BottomSheet
            if (state.showSlashMenu) {
                DocSlashMenuSheet(
                    isVisible = true,
                    filter = state.slashFilter,
                    onItemSelected = { kind -> viewModel.onSlashItemSelected(kind) },
                    onDismiss = { viewModel.onSlashDismissed() },
                )
            }

            // 块操作菜单 BottomSheet
            if (state.showBlockActionMenu) {
                BlockActionMenuSheet(
                    blockKind = state.actionBlockKind,
                    isFirst = state.actionBlockIsFirst,
                    isLast = state.actionBlockIsLast,
                    isBlockEditable = state.actionBlockEditable,
                    canDeleteWholeBlock = state.actionBlockCanDeleteWholeBlock,
                    onDelete = viewModel::onDeleteBlock,
                    onDuplicate = viewModel::onDuplicateBlock,
                    onCopyText = viewModel::onCopyBlockText,
                    onTurnInto = viewModel::onTurnInto,
                    onMoveUp = viewModel::onMoveBlockUp,
                    onMoveDown = viewModel::onMoveBlockDown,
                    onSelect = {
                        viewModel.enterSelectionMode(state.actionBlockId)
                    },
                    onAddComment = viewModel::startBlockComment,
                    canAddComment = state.canCreateComment,
                    onDismiss = viewModel::dismissBlockAction,
                )
            }

            if (state.showBlockCommentComposer) {
                DocBlockCommentComposerSheet(
                    draft = state.blockCommentDraft,
                    isPosting = state.isPostingComment,
                    onDraftChange = viewModel::updateBlockCommentDraft,
                    onSubmit = viewModel::submitBlockComment,
                    onDismiss = viewModel::dismissBlockCommentComposer,
                )
            }

            // 代码块语言选择 BottomSheet
            if (state.showLanguageSelector) {
                CodeLanguageSelectorSheet(
                    currentLanguage = state.currentCodeLanguage,
                    onSelect = viewModel::onLanguageSelected,
                    onDismiss = viewModel::dismissLanguageSelector,
                )
            }

            // 文字颜色选择 BottomSheet
            if (state.showTextColorPicker) {
                TextColorPickerSheet(
                    currentColor = state.activeTextColor,
                    onSelect = viewModel::onSetTextColor,
                    onDismiss = viewModel::dismissColorPicker,
                )
            }

            // 背景高亮选择 BottomSheet
            if (state.showHighlightPicker) {
                HighlightPickerSheet(
                    currentColor = state.activeHighlight,
                    onSelect = viewModel::onSetHighlight,
                    onDismiss = viewModel::dismissColorPicker,
                )
            }

            // 版本历史 BottomSheet
            if (state.showVersionHistory) {
                VersionHistorySheet(
                    histories = state.versionHistories,
                    isLoading = state.isLoadingHistories,
                    isRestoring = state.isRestoringHistory,
                    onRestore = viewModel::restoreVersion,
                    onDismiss = viewModel::dismissVersionHistory,
                )
            }
            }
        }

        if (!state.requiresFullEditor && !state.isPermissionRevoked && !state.isReadOnlyByRole &&
            state.saveState != SaveState.CONFLICT
        ) {
            Box(
                Modifier
                    .matchParentSize(),
            ) {
                if (state.isSelectionMode) {
                    SelectionToolbar(
                        selectedCount = state.selectedBlockIds.size,
                        onDelete = viewModel::requestDeleteSelectedBlocks,
                        onCopy = viewModel::copySelectedBlocksText,
                        onSelectAll = viewModel::selectAll,
                        onCancel = viewModel::exitSelectionMode,
                        modifier = Modifier.align(Alignment.BottomCenter),
                    )
                } else if (state.showFormatToolbar && imeVisible) {
                    DocFormatToolbar(
                        isVisible = true,
                        activeMarks = state.activeMarks,
                        onToggleMark = viewModel::onToggleFormat,
                        onInsertLink = viewModel::onInsertLink,
                        canUndo = state.canUndo,
                        canRedo = state.canRedo,
                        onUndo = viewModel::undo,
                        onRedo = viewModel::redo,
                        onIndent = viewModel::onIndent,
                        onUnindent = viewModel::onUnindent,
                        onMoreActions = {
                            val focusedId = state.blockViews.find {
                                (it as? TabDocBlockView.Focusable)?.isFocused == true
                            }?.id
                            if (focusedId != null) viewModel.onBlockLongPress(focusedId)
                        },
                        activeTextColor = state.activeTextColor,
                        activeHighlight = state.activeHighlight,
                        onTextColorClick = viewModel::onShowTextColorPicker,
                        onHighlightClick = viewModel::onShowHighlightPicker,
                        modifier = Modifier.align(Alignment.BottomCenter),
                    )
                }
            }
        }
    }

    directMessageResource?.let { resource ->
        ResourceDirectMessageShareSheet(
            resource = resource,
            onDismiss = { directMessageResource = null },
            onSent = { recipientName ->
                directMessageResource = null
                coroutineScope.launch {
                    snackbarHostState.showSnackbar(
                        context.getString(R.string.resource_dm_share_sent, recipientName),
                    )
                }
            },
        )
    }

    shareTarget?.let { target ->
        CloudDocsShareSheet(
            target = target,
            onDismiss = { shareTarget = null },
        )
    }
}

private data class TableCellPreview(
    val blockId: String,
    val row: Int,
    val column: Int,
    val text: String,
    val spans: List<InlineSpan>,
    val rowValues: List<String>,
    val columnValues: List<String>,
    val tableValues: List<List<String>>,
    val readOnlyBlocks: List<TabDocBlockView>,
    val isEditable: Boolean,
    val canInsertRow: Boolean,
    val canInsertColumn: Boolean,
)

private fun tableCellPreviewOf(
    context: Context,
    blockId: String,
    row: Int,
    column: Int,
    table: TableData,
    isEditable: Boolean,
    canModifyStructure: Boolean,
): TableCellPreview? {
    val cell = table.rows.getOrNull(row)?.cells?.getOrNull(column) ?: return null
    fun localizedText(value: TableCell): String =
        TableProjectionLocalization.cellText(context, value)
    return TableCellPreview(
        blockId = blockId,
        row = row,
        column = column,
        text = localizedText(cell),
        spans = cell.spans,
        rowValues = table.rows[row].cells.map(::localizedText),
        columnValues = table.rows.map { tableRow ->
            tableRow.cells.getOrNull(column)?.let(::localizedText).orEmpty()
        },
        tableValues = table.rows.map { tableRow -> tableRow.cells.map(::localizedText) },
        readOnlyBlocks = if (isEditable) {
            emptyList()
        } else {
            BlockViewConverter.toBlockViews(
                ProseMirrorParser.parseTableCellContent(cell.rawNode),
            )
        },
        isEditable = isEditable,
        canInsertRow = canModifyStructure && table.canAddRow,
        canInsertColumn = canModifyStructure && table.canAddColumn,
    )
}

/**
 * 复杂单元格详情复用整篇云文档的原生块渲染器。
 *
 * 这个 RecyclerView 只接收只读 adapter，所有编辑回调都是空实现；因此查看
 * 单元格不会把投影文本写回整篇文档，也不会触发保存或版本推进。
 */
@Composable
private fun ReadOnlyTableCellDocument(
    blocks: List<TabDocBlockView>,
    modifier: Modifier = Modifier,
) {
    val adapter = remember {
        DocBlockAdapter(
            onTextChanged = { _, _, _ -> },
            onEnterPressed = { _, _ -> },
            onEmptyBackspace = {},
            onFocusChanged = {},
            onSlashEvent = { _, _ -> },
            onSelectionChanged = { _, _ -> },
            onCheckChanged = { _, _ -> },
            onCodeTextChanged = { _, _ -> },
            onTitleChanged = {},
            onBlockLongPress = {},
            onLanguageMenuClick = {},
            onBlockClick = {},
            onImagePlaceholderClick = {},
            onTableCellClick = { _, _, _, _, _, _ -> },
            onCopyTable = {},
            onAddTableRow = { _, _ -> },
            onAddTableColumn = { _, _ -> },
        ).also { it.isReadOnly = true }
    }

    DisposableEffect(adapter) {
        onDispose { adapter.destroy() }
    }
    LaunchedEffect(blocks) {
        adapter.isReadOnly = true
        adapter.update(blocks)
    }
    AndroidView(
        factory = { context ->
            RecyclerView(context).apply {
                layoutManager = LinearLayoutManager(context)
                this.adapter = adapter
                itemAnimator = null
                clipToPadding = false
                setPadding(0, 0, 0, 0)
            }
        },
        modifier = modifier.heightIn(min = 120.dp, max = 420.dp),
    )
}

@Composable
private fun TableCellEditorSheet(
    preview: TableCellPreview,
    onDismiss: () -> Unit,
    onTextChanged: (String, List<TabDocMarkup.Mark>) -> Unit,
    onCopy: (String) -> Unit,
    onInsertRowBelow: () -> Unit,
    onInsertColumnRight: () -> Unit,
) {
    var editedText by remember(preview.blockId, preview.row, preview.column) {
        mutableStateOf(preview.text)
    }
    val rowText = preview.rowValues.toMutableList().also { values ->
        if (preview.column in values.indices) values[preview.column] = editedText
    }.joinToString("\t")
    val columnText = preview.columnValues.toMutableList().also { values ->
        if (preview.row in values.indices) values[preview.row] = editedText
    }.joinToString("\n")
    val tableText = preview.tableValues.mapIndexed { rowIndex, row ->
        row.mapIndexed { columnIndex, text ->
            if (preview.isEditable && rowIndex == preview.row && columnIndex == preview.column) {
                editedText
            } else {
                text
            }
        }.joinToString("\t")
    }.joinToString("\n")

    TTFormSheet(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = stringResource(
                    R.string.doc_table_cell_title,
                    preview.row + 1,
                    preview.column + 1,
                ),
                style = TTFonts.subtitleSemibold,
            )
        },
        content = {
            Text(
                text = stringResource(
                    if (preview.isEditable) R.string.doc_table_cell_editable
                    else R.string.doc_table_cell_complex_read_only,
                ),
                style = TTFonts.metaMedium,
                color = if (preview.isEditable) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )

            if (preview.isEditable) {
                key(preview.blockId, preview.row, preview.column) {
                    TableCellRichTextInput(
                        text = preview.text,
                        spans = preview.spans,
                        onValueChange = { value, marks ->
                            editedText = value
                            onTextChanged(value, marks)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 160.dp, max = 360.dp),
                    )
                }
            } else if (preview.readOnlyBlocks.isNotEmpty()) {
                ReadOnlyTableCellDocument(
                    blocks = preview.readOnlyBlocks,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                SelectionContainer {
                    Text(
                        text = preview.text.ifEmpty {
                            stringResource(R.string.doc_table_cell_empty)
                        },
                        style = TTFonts.body,
                        color = if (preview.text.isEmpty()) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 120.dp),
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                    TableCopyButton(
                        label = stringResource(R.string.doc_table_cell_copy),
                        text = editedText,
                        onCopy = onCopy,
                        modifier = Modifier.weight(1f),
                    )
                    TableCopyButton(
                        label = stringResource(R.string.doc_table_row_copy),
                        text = rowText,
                        onCopy = onCopy,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                    TableCopyButton(
                        label = stringResource(R.string.doc_table_column_copy),
                        text = columnText,
                        onCopy = onCopy,
                        modifier = Modifier.weight(1f),
                    )
                    TableCopyButton(
                        label = stringResource(R.string.doc_table_copy),
                        text = tableText,
                        onCopy = onCopy,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            if (preview.canInsertRow || preview.canInsertColumn) {
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                    TableOperationButton(
                        label = stringResource(R.string.doc_table_insert_row_below),
                        enabled = preview.canInsertRow,
                        onClick = {
                            onInsertRowBelow()
                            onDismiss()
                        },
                        modifier = Modifier.weight(1f),
                    )
                    TableOperationButton(
                        label = stringResource(R.string.doc_table_insert_column_right),
                        enabled = preview.canInsertColumn,
                        onClick = {
                            onInsertColumnRight()
                            onDismiss()
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        },
        actions = {
            TextButton(onClick = onDismiss) {
                Text(
                    text = stringResource(R.string.common_close),
                    style = TTFonts.bodyMedium,
                )
            }
        },
    )
}

/**
 * 格子编辑必须复用正文 DocTextInputWidget：OutlinedTextField 只回传 String，
 * 改一字就会把加粗压平。
 */
@Composable
private fun TableCellRichTextInput(
    text: String,
    spans: List<InlineSpan>,
    onValueChange: (String, List<TabDocMarkup.Mark>) -> Unit,
    modifier: Modifier = Modifier,
) {
    val currentOnValueChange by rememberUpdatedState(onValueChange)
    val initialMarks = remember(text, spans) {
        BlockViewConverter.spansToMarks(text, spans)
    }
    AndroidView(
        factory = { context ->
            DocTextInputWidget(context).apply {
                applyTTTypography(TTFonts.Role.BODY)
                TableCellEditorPresentation.applyReadableBodyColor(this)
                gravity = Gravity.TOP or Gravity.START
                minLines = 6
                maxLines = 12
                enableEditMode()
                val watcher = object : TextInputTextWatcher {
                    private var locked = false
                    override fun lock() { locked = true }
                    override fun unlock() { locked = false }
                    override fun beforeTextChanged(
                        s: CharSequence?,
                        start: Int,
                        count: Int,
                        after: Int,
                    ) {}
                    override fun onTextChanged(
                        s: CharSequence?,
                        start: Int,
                        before: Int,
                        count: Int,
                    ) {}
                    override fun afterTextChanged(s: Editable?) {
                        if (locked) return
                        val editable = s ?: return
                        currentOnValueChange(
                            editable.toString(),
                            extractMarksFromSpannable(editable),
                        )
                    }
                }
                addTextChangedListener(watcher)
                pauseTextWatchers {
                    val markup = object : TabDocMarkup {
                        override val body = text
                        override val marks = initialMarks
                    }
                    setText(markup.toSpannable(textColor = currentTextColor))
                }
            }
        },
        modifier = modifier,
    )
}

@Composable
private fun TableCopyButton(
    label: String,
    text: String,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = { onCopy(text) },
        enabled = text.isNotEmpty(),
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
    ) {
        Text(text = label, style = TTFonts.captionMedium)
    }
}

@Composable
private fun TableOperationButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
    ) {
        Text(
            text = label,
            style = TTFonts.captionMedium,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

private fun copyTableText(context: Context, text: String) {
    if (text.isEmpty()) return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("table", text))
    Toast.makeText(context, R.string.doc_block_copied, Toast.LENGTH_SHORT).show()
}

/** 正文项之外的单击只退出编辑态；不拦截滚动，也不吞掉块自身的点击。 */
private fun RecyclerView.installBlankAreaTapHandler(onBlankTap: () -> Unit) {
    val detector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(event: MotionEvent): Boolean = true

            override fun onSingleTapUp(event: MotionEvent): Boolean {
                if (findChildViewUnder(event.x, event.y) != null) return false
                findFocus()?.clearFocus()
                context.getSystemService(InputMethodManager::class.java)
                    ?.hideSoftInputFromWindow(windowToken, 0)
                onBlankTap()
                return true
            }
        },
    )
    addOnItemTouchListener(
        object : RecyclerView.SimpleOnItemTouchListener() {
            override fun onInterceptTouchEvent(recyclerView: RecyclerView, event: MotionEvent): Boolean {
                detector.onTouchEvent(event)
                return false
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VersionHistorySheet(
    histories: List<com.tabtin.mobile.data.model.doc.DocHistoryEntry>,
    isLoading: Boolean,
    isRestoring: Boolean,
    onRestore: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        ) {
            Text(
                stringResource(R.string.doc_version_history),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = 16.dp),
            )

            when {
                isLoading -> {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }
                }
                histories.isEmpty() -> {
                    Text(
                        stringResource(R.string.doc_version_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 32.dp).fillMaxWidth(),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
                else -> {
                    histories.forEach { entry ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = versionHistoryEntryTitle(
                                        entry = entry,
                                        snapshotLabel = stringResource(R.string.doc_version_snapshot),
                                        historyVersionLabel = stringResource(R.string.doc_version_unnamed),
                                    ),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Text(
                                    text = entry.createdAt?.take(16)?.replace("T", " ") ?: "",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            TextButton(
                                onClick = { onRestore(entry.id) },
                                enabled = !isRestoring,
                            ) {
                                Text(stringResource(R.string.doc_version_restore))
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(32.dp))
        }
    }
}

internal fun versionHistoryEntryTitle(
    entry: com.tabtin.mobile.data.model.doc.DocHistoryEntry,
    snapshotLabel: String,
    historyVersionLabel: String,
): String = entry.name.ifBlank {
    when {
        entry.isSnapshot -> snapshotLabel
        !entry.createdAt.isNullOrBlank() -> entry.createdAt.take(16).replace("T", " ")
        else -> historyVersionLabel
    }
}

@Composable
private fun DocFormulaPaintLayer(modifier: Modifier = Modifier) {
    AndroidView(
        factory = { context ->
            DocFormulaPaintView(context).also { DocFormulaPaintHost.attach(it) }
        },
        modifier = modifier.size(360.dp, 180.dp),
        onRelease = { DocFormulaPaintHost.detach(it) },
    )
}

// ── TopBar 组件 ──────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DocEditorTopBar(
    saveState: SaveState,
    moreMenu: DocEditorMoreMenu,
    onBack: () -> Unit,
    onShowHistory: () -> Unit = {},
    onShareLink: (() -> Unit)? = null,
    onSendToDirectMessage: (() -> Unit)? = null,
    onOpenFullEditor: (() -> Unit)? = null,
    onRetrySave: () -> Unit = {},
) {
    TopAppBar(
        title = {},
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = ttColor(TTColors.Surface, TTColors.Dark.Surface),
            navigationIconContentColor = ttColor(TTColors.IconPrimary, TTColors.Dark.IconPrimary),
            actionIconContentColor = ttColor(TTColors.IconPrimary, TTColors.Dark.IconPrimary),
        ),
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.common_back),
                )
            }
        },
        actions = {
            val saveColor = when (saveState) {
                SaveState.IDLE -> ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                SaveState.DIRTY -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
                SaveState.SAVING -> ttColor(TTColors.Primary, TTColors.Dark.Primary)
                SaveState.SAVED -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
                SaveState.FAILED -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
                SaveState.CONFLICT -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
                SaveState.PERMISSION_DENIED -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
            }
            if (DocPageChromePolicy.showsSaveIndicator(saveState) && saveState.labelRes != 0) {
                Text(
                    stringResource(saveState.labelRes),
                    style = MaterialTheme.typography.labelSmall,
                    color = saveColor,
                    modifier = Modifier.padding(end = 4.dp),
                )
            }
            if (DocPageChromePolicy.showsSaveRetry(saveState)) {
                TextButton(onClick = onRetrySave) {
                    Text(stringResource(R.string.common_retry))
                }
            }
            var showMenu by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { showMenu = true }) {
                    Icon(
                        androidx.compose.material.icons.Icons.Default.MoreVert,
                        contentDescription = stringResource(R.string.common_more),
                    )
                }
                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                    if (moreMenu.showShareLink) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.cloud_docs_share_action)) },
                            leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
                            onClick = {
                                showMenu = false
                                onShareLink?.invoke()
                            },
                        )
                    }
                    if (moreMenu.showDirectMessage) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.resource_dm_share_action)) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null) },
                            onClick = {
                                showMenu = false
                                onSendToDirectMessage?.invoke()
                            },
                        )
                    }
                    if (moreMenu.showVersionHistory) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.doc_version_history)) },
                            onClick = {
                                showMenu = false
                                onShowHistory()
                            },
                        )
                    }
                    if (moreMenu.showFullEditor) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.doc_open_full_editor)) },
                            onClick = {
                                showMenu = false
                                onOpenFullEditor?.invoke()
                            },
                        )
                    }
                }
            }
        },
    )
}

@Composable
private fun ConflictDraftBanner(
    message: String,
    onDiscardAndReload: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(
                ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                RoundedCornerShape(TTRadius.md),
            )
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text(
            text = stringResource(R.string.doc_save_conflict_short),
            style = TTFonts.bodyMedium,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Text(
            text = message,
            style = TTFonts.meta,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        TextButton(
            onClick = onDiscardAndReload,
            contentPadding = PaddingValues(0.dp),
        ) {
            Text(
                text = stringResource(R.string.doc_discard_draft_and_reload),
                style = TTFonts.bodyMedium,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
            )
        }
    }
}

@Composable
private fun AgentEditingBanner(modifier: Modifier = Modifier) {
    Text(
        text = stringResource(R.string.doc_agent_editing_banner),
        style = TTFonts.meta,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        modifier = modifier
            .fillMaxWidth()
            .background(
                ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                RoundedCornerShape(TTRadius.md),
            )
            .padding(TTSpacing.lg),
    )
}

@Composable
private fun NativeFullEditorRequiredBanner(
    onOpenFullEditor: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = stringResource(R.string.doc_full_editor_required_title),
            style = TTFonts.subtitleSemibold,
        )
        Text(
            text = stringResource(R.string.doc_full_editor_required_message),
            style = TTFonts.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (onOpenFullEditor != null) {
            Button(onClick = onOpenFullEditor) {
                Text(stringResource(R.string.doc_open_full_editor))
            }
        }
    }
}

@Composable
private fun OfflineDocDraftBanner(
    onRetry: () -> Unit,
    onCopy: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = stringResource(R.string.doc_offline_draft_title),
            style = TTFonts.subtitleSemibold,
        )
        Text(
            text = stringResource(R.string.doc_offline_draft_message),
            style = TTFonts.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            Button(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
            OutlinedButton(onClick = onCopy) {
                Text(stringResource(R.string.doc_copy_local_draft))
            }
        }
    }
}
