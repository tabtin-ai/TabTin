package com.tabtin.mobile.features.memo

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.memo.AttachmentOut
import com.tabtin.mobile.data.model.memo.CollectionBriefOut
import com.tabtin.mobile.data.model.memo.MemoDetail
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.features.memo.components.MemoColorPicker
import com.tabtin.mobile.features.memo.components.TagChip
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val MAX_TAGS = 10

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemoDetailScreen(
    memoId: String,
    viewModel: TabMemoViewModel,
    onDismiss: () -> Unit,
    backHandlingEnabled: Boolean = true,
) {
    val context = LocalContext.current
    val uiState by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()

    var detail by remember { mutableStateOf<MemoDetail?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var loadFailed by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }

    var editContent by remember { mutableStateOf("") }
    val editTags = remember { mutableStateListOf<String>() }
    var editColor by remember { mutableStateOf("") }
    var newTag by remember { mutableStateOf("") }
    var hasChanges by remember { mutableStateOf(false) }
    var showDiscardConfirm by remember { mutableStateOf(false) }
    var showSaveFailedMessage by remember { mutableStateOf<String?>(null) }
    var showRetagMessage by remember { mutableStateOf<String?>(null) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var isRefreshingTags by remember { mutableStateOf(false) }

    LaunchedEffect(memoId) {
        isLoading = true
        loadFailed = false
        loadError = null
        try {
            val d = viewModel.getMemoDetail(memoId)
            detail = d
            editContent = d.contentMarkdown.ifEmpty { d.contentPlaintext }
            editTags.clear()
            editTags.addAll(d.tags)
            editColor = d.color
        } catch (e: Exception) {
            loadFailed = true
            loadError = e.message
        }
        isLoading = false
    }

    LaunchedEffect(uiState.loadError, uiState.isSaving, uiState.isRetagging) {
        uiState.loadError?.let { msg ->
            showSaveFailedMessage = msg
            viewModel.clearLoadError()
        }
    }

    fun save() {
        if (!hasChanges || uiState.isSaving) return
        scope.launch {
            try {
                viewModel.updateMemo(
                    id = memoId,
                    contentMarkdown = editContent,
                    tags = editTags,
                    color = editColor,
                )
                runCatching { viewModel.getMemoDetail(memoId) }
                    .getOrNull()
                    ?.let { detail = it }
                hasChanges = false
            } catch (_: Exception) {
                // ViewModel 已把可本地化的错误写入 uiState。
            }
        }
    }

    fun retag() {
        if (uiState.isRetagging || isRefreshingTags) return
        scope.launch {
            isRefreshingTags = true
            val previousTags = detail?.aiTags.orEmpty()
            try {
                viewModel.retagMemo(memoId)
                var tagsUpdated = false
                for (attempt in 0 until 8) {
                    delay(3_000)
                    try {
                        val refreshed = viewModel.getMemoDetail(memoId)
                        detail = refreshed
                        if (refreshed.aiTags != previousTags) {
                            tagsUpdated = true
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // 单次查询失败不立即中止，留给后续轮询与最终状态反馈。
                    }
                    if (tagsUpdated) break
                }
                showRetagMessage = context.getString(
                    if (tagsUpdated) R.string.memo_retag_updated else R.string.memo_retag_pending,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // ViewModel 已把可本地化的错误写入 uiState。
            } finally {
                isRefreshingTags = false
            }
        }
    }

    fun addTag() {
        val tag = newTag.trim()
        if (tag.isEmpty() || editTags.contains(tag)) return
        if (editTags.size >= MAX_TAGS) {
            showSaveFailedMessage = context.getString(R.string.memo_max_tags_reached, MAX_TAGS)
            return
        }
        editTags.add(tag)
        newTag = ""
        hasChanges = true
    }

    fun removeTag(tag: String) {
        editTags.remove(tag)
        hasChanges = true
    }

    fun handleDismiss() {
        if (hasChanges) {
            showDiscardConfirm = true
        } else {
            onDismiss()
        }
    }

    BackHandler(enabled = backHandlingEnabled, onBack = ::handleDismiss)

    fun removeFromCollection(col: CollectionBriefOut) {
        scope.launch {
            try {
                viewModel.removeMemoFromCollection(memoId, col.id)
                detail = viewModel.getMemoDetail(memoId)
            } catch (_: Exception) { }
        }
    }

    val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val textTertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val bgSubtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val primary = ttColor(TTColors.Primary, TTColors.Dark.Primary)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.memo_detail)) },
                navigationIcon = {
                    IconButton(onClick = { handleDismiss() }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.common_close))
                    }
                },
                actions = {
                    IconButton(
                        onClick = { retag() },
                        enabled = !uiState.isRetagging && !isRefreshingTags && !uiState.isSaving,
                    ) {
                        if (uiState.isRetagging || isRefreshingTags) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                Icons.Filled.Refresh,
                                contentDescription = stringResource(R.string.memo_retag),
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                    IconButton(
                        onClick = { showDeleteConfirm = true },
                        enabled = !uiState.isSaving && !isRefreshingTags,
                    ) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = stringResource(R.string.memo_delete),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    if (hasChanges) {
                        Button(
                            onClick = { save() },
                            enabled = !uiState.isSaving,
                        ) {
                            if (uiState.isSaving) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                Text(stringResource(R.string.common_save))
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        when {
            isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(TTSpacing.lg))
                        Text(stringResource(R.string.common_loading), color = textSecondary)
                    }
                }
            }
            loadFailed -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(horizontal = TTSpacing.xl),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                    ) {
                        Text(
                            loadError ?: context.getString(R.string.memo_load_failed),
                            color = textSecondary,
                        )
                        Button(onClick = {
                            isLoading = true
                            scope.launch {
                                try {
                                    detail = viewModel.getMemoDetail(memoId)
                                    detail?.let { d ->
                                        editContent = d.contentMarkdown.ifEmpty { d.contentPlaintext }
                                        editTags.clear()
                                        editTags.addAll(d.tags)
                                        editColor = d.color
                                    }
                                    loadFailed = false
                                } catch (e: Exception) {
                                    loadError = e.message
                                }
                                isLoading = false
                            }
                        }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
            }
            detail != null -> {
                val memo = detail!!
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .imePadding()
                        .verticalScroll(rememberScrollState())
                        .padding(TTSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.memo_color), style = TTFonts.caption, color = textSecondary)
                        MemoColorPicker(
                            selectedColor = editColor,
                            circleSize = 24.dp,
                            onSelect = { editColor = it; hasChanges = true },
                        )
                    }

                    OutlinedTextField(
                        value = editContent,
                        onValueChange = { editContent = it; hasChanges = true },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
                        minLines = 8,
                        maxLines = 16,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = primary,
                            unfocusedBorderColor = textTertiary.copy(alpha = 0.5f),
                            focusedContainerColor = bgSubtle.copy(alpha = 0.5f),
                            unfocusedContainerColor = bgSubtle.copy(alpha = 0.5f),
                        ),
                        shape = TTRadius.Shapes.md,
                        textStyle = LocalTextStyle.current.merge(ConversationTypography.body),
                    )

                    if (memo.bookmarkUrl.isNotEmpty()) {
                        BookmarkPreviewSection(memo = memo, bgSubtle = bgSubtle, textColor = textColor, textTertiary = textTertiary)
                    }

                    @OptIn(ExperimentalLayoutApi::class)
                    Column {
                        Text(stringResource(R.string.memo_tags), style = TTFonts.caption, color = textSecondary)
                        Spacer(Modifier.height(TTSpacing.sm))
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            editTags.forEach { tag ->
                                TagChip(text = tag, isAI = false, onRemove = { removeTag(tag) })
                            }
                            memo.aiTags.forEach { tag ->
                                TagChip(text = tag, isAI = true, onRemove = null)
                            }
                        }
                        Spacer(Modifier.height(TTSpacing.sm))
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(TTRadius.Shapes.sm)
                                .background(bgSubtle.copy(alpha = 0.3f))
                                .padding(TTSpacing.sm),
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OutlinedTextField(
                                value = newTag,
                                onValueChange = { newTag = it },
                                modifier = Modifier.weight(1f),
                                placeholder = { Text(stringResource(R.string.memo_add_tag_placeholder), style = TTFonts.caption) },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                                    unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                                    disabledBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                                ),
                            )
                            TextButton(onClick = { addTag() }) {
                                Text(stringResource(R.string.memo_add), color = primary, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }

                    if (memo.collections.isNotEmpty()) {
                        CollectionsSection(
                            collections = memo.collections,
                            onRemove = { removeFromCollection(it) },
                            textColor = textColor,
                            textTertiary = textTertiary,
                            bgSubtle = bgSubtle,
                        )
                    }

                    if (memo.attachments.isNotEmpty()) {
                        AttachmentsSection(
                            attachments = memo.attachments,
                            context = context,
                            textColor = textColor,
                            textTertiary = textTertiary,
                            bgSubtle = bgSubtle,
                        )
                    }

                    HorizontalDivider(color = textTertiary.copy(alpha = 0.3f))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${stringResource(R.string.memo_created_at)} ${RelativeTimeFormatter.format(context, memo.createdAt) ?: memo.createdAt}",
                            style = TTFonts.caption,
                            color = textTertiary,
                        )
                        Text(
                            localizedSource(memo.source, context),
                            style = TTFonts.codeXS,
                            color = textTertiary,
                            modifier = Modifier
                                .clip(TTRadius.Shapes.full)
                                .background(bgSubtle)
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }

    if (showDiscardConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirm = false },
            title = { Text(stringResource(R.string.memo_discard_changes_title)) },
            text = { Text(stringResource(R.string.memo_discard_changes_message)) },
            confirmButton = {
                TextButton(onClick = { showDiscardConfirm = false; onDismiss() }) {
                    Text(stringResource(R.string.memo_discard), color = TTColors.BgCritical)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirm = false }) {
                    Text(stringResource(R.string.memo_continue_editing))
                }
            },
        )
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.memo_delete_confirm_title)) },
            text = { Text(stringResource(R.string.memo_delete_recover_hint)) },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    scope.launch {
                        if (viewModel.trashMemo(memoId)) onDismiss()
                    }
                }) {
                    Text(stringResource(R.string.memo_delete), color = TTColors.BgCritical)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    showSaveFailedMessage?.let { msg ->
        AlertDialog(
            onDismissRequest = { showSaveFailedMessage = null },
            title = { Text(stringResource(R.string.memo_save_failed)) },
            text = { Text(msg) },
            confirmButton = {
                TextButton(onClick = { showSaveFailedMessage = null }) {
                    Text(stringResource(R.string.memo_ok))
                }
            },
        )
    }

    showRetagMessage?.let { msg ->
        AlertDialog(
            onDismissRequest = { showRetagMessage = null },
            title = { Text(stringResource(R.string.memo_tip)) },
            text = { Text(msg) },
            confirmButton = {
                TextButton(onClick = {
                    showRetagMessage = null
                    scope.launch {
                        try {
                            detail = viewModel.getMemoDetail(memoId)
                        } catch (_: Exception) { }
                    }
                }) {
                    Text(stringResource(R.string.memo_ok))
                }
            },
        )
    }
}

@Composable
private fun BookmarkPreviewSection(
    memo: MemoDetail,
    bgSubtle: androidx.compose.ui.graphics.Color,
    textColor: androidx.compose.ui.graphics.Color,
    textTertiary: androidx.compose.ui.graphics.Color,
) {
    Column {
        Text(stringResource(R.string.memo_bookmark), style = TTFonts.caption, color = textTertiary)
        Spacer(Modifier.height(TTSpacing.xs))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .background(bgSubtle.copy(alpha = 0.5f))
                .padding(TTSpacing.sm),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (memo.bookmarkImage.isNotEmpty()) {
                AsyncImage(
                    model = memo.bookmarkImage,
                    contentDescription = null,
                    modifier = Modifier.size(36.dp).clip(TTRadius.Shapes.sm),
                    contentScale = ContentScale.Crop,
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    memo.bookmarkTitle.ifEmpty { memo.bookmarkUrl },
                    style = TTFonts.captionSemibold,
                    color = textColor,
                    maxLines = 1,
                )
                if (memo.bookmarkDescription.isNotEmpty()) {
                    Text(memo.bookmarkDescription, style = TTFonts.caption, color = textTertiary, maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun CollectionsSection(
    collections: List<CollectionBriefOut>,
    onRemove: (CollectionBriefOut) -> Unit,
    textColor: androidx.compose.ui.graphics.Color,
    textTertiary: androidx.compose.ui.graphics.Color,
    bgSubtle: androidx.compose.ui.graphics.Color,
) {
    Column {
        Text(stringResource(R.string.memo_collections), style = TTFonts.caption, color = textTertiary)
        Spacer(Modifier.height(TTSpacing.sm))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            collections.forEach { col ->
                Row(
                    modifier = Modifier
                        .clip(TTRadius.Shapes.full)
                        .background(bgSubtle)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(col.icon.ifEmpty { "📁" }, style = TTFonts.caption)
                    Text(col.title, style = TTFonts.caption, color = textColor)
                    IconButton(
                        onClick = { onRemove(col) },
                        modifier = Modifier.minimumInteractiveComponentSize().size(16.dp),
                    ) {
                        Icon(Icons.Filled.Close, null, tint = textTertiary, modifier = Modifier.size(10.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentsSection(
    attachments: List<AttachmentOut>,
    context: android.content.Context,
    textColor: androidx.compose.ui.graphics.Color,
    textTertiary: androidx.compose.ui.graphics.Color,
    bgSubtle: androidx.compose.ui.graphics.Color,
) {
    Column {
        Text(stringResource(R.string.memo_attachment), style = TTFonts.caption, color = textTertiary)
        Spacer(Modifier.height(TTSpacing.sm))
        attachments.forEach { att ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(TTRadius.Shapes.sm)
                    .background(bgSubtle.copy(alpha = 0.5f))
                    .padding(TTSpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    iconForFileType(att.fileType),
                    style = TTFonts.body,
                    color = textTertiary,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        att.fileName.ifEmpty { context.getString(R.string.memo_attachment) },
                        style = TTFonts.caption,
                        color = textColor,
                        maxLines = 1,
                    )
                    if (att.fileSize > 0) {
                        Text(
                            Formatter.formatFileSize(context, att.fileSize.toLong()),
                            style = TTFonts.codeXS,
                            color = textTertiary,
                        )
                    }
                }
            }
        }
    }
}

private fun iconForFileType(type: String): String = when (type) {
    "image" -> "🖼"
    "video" -> "🎬"
    "audio" -> "🎵"
    else -> "📄"
}

private fun localizedSource(source: String, context: android.content.Context): String = when (source) {
    "voice" -> context.getString(R.string.memo_source_voice)
    "manual" -> context.getString(R.string.memo_source_manual)
    "browser_extension" -> context.getString(R.string.memo_source_browser)
    else -> source
}
