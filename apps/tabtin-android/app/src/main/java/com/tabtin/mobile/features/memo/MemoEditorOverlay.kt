package com.tabtin.mobile.features.memo

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.features.memo.components.MemoColorPicker
import com.tabtin.mobile.features.memo.components.TagChip
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

private const val DRAFT_PREFIX = "com.tabtin.memo.zenDraft"
private const val DRAFT_DEBOUNCE_MS = 800L
private const val MAX_TAGS = 10
private val URL_PATTERN = Regex("""https?://[^\s\p{Pi}\p{Pf}\p{Pe}\p{Po}"']+(?<![.,;:!?])""")

// ─── 草稿持久化 ────────────────────────────────────────────

private data class MemoDraft(
    val content: String,
    val color: String,
    val tags: List<String>,
) {
    val isEmpty: Boolean
        get() = content.trim().isEmpty() && tags.isEmpty()
}

private fun SharedPreferences.saveDraft(draft: MemoDraft) {
    if (draft.isEmpty) {
        edit().remove("${DRAFT_PREFIX}.content").remove("${DRAFT_PREFIX}.color").remove("${DRAFT_PREFIX}.tags").apply()
        return
    }
    edit()
        .putString("${DRAFT_PREFIX}.content", draft.content)
        .putString("${DRAFT_PREFIX}.color", draft.color)
        .putString("${DRAFT_PREFIX}.tags", draft.tags.joinToString("\u0001"))
        .apply()
}

private fun SharedPreferences.loadDraft(): MemoDraft? {
    val content = getString("${DRAFT_PREFIX}.content", null) ?: ""
    val color = getString("${DRAFT_PREFIX}.color", null) ?: ""
    val tagsStr = getString("${DRAFT_PREFIX}.tags", null) ?: ""
    val tags = if (tagsStr.isEmpty()) emptyList() else tagsStr.split("\u0001").filter { it.isNotEmpty() }
    return MemoDraft(content, color, tags).takeIf { !it.isEmpty }
}

private fun SharedPreferences.clearDraft() {
    edit().remove("${DRAFT_PREFIX}.content").remove("${DRAFT_PREFIX}.color").remove("${DRAFT_PREFIX}.tags").apply()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemoEditorOverlay(
    isPresented: Boolean,
    viewModel: TabMemoViewModel,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("tabtin_memo", Context.MODE_PRIVATE) }
    val uiState by viewModel.uiState.collectAsState()
    val sheetState = rememberTTSheetState()

    var content by remember { mutableStateOf("") }
    var selectedColor by remember { mutableStateOf("") }
    val tags = remember { mutableStateListOf<String>() }
    var newTag by remember { mutableStateOf("") }
    var showColorPicker by remember { mutableStateOf(false) }
    var showTagInput by remember { mutableStateOf(false) }
    var bookmarkPreview by remember { mutableStateOf<com.tabtin.mobile.data.model.memo.BookmarkPreview?>(null) }
    var isLoadingBookmark by remember { mutableStateOf(false) }
    var showDiscardConfirm by remember { mutableStateOf(false) }
    var showError by remember { mutableStateOf<String?>(null) }
    var errorIsSaveBusy by remember { mutableStateOf(false) }
    var showSuccessFlash by remember { mutableStateOf(false) }
    var pendingImageUri by remember { mutableStateOf<Uri?>(null) }
    var pendingImageName by remember { mutableStateOf("image.jpg") }
    var pendingImageType by remember { mutableStateOf("image/jpeg") }
    var pendingImageSize by remember { mutableStateOf(0L) }

    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        pendingImageUri = uri
        val resolver = context.contentResolver
        pendingImageType = resolver.getType(uri) ?: "image/jpeg"
        pendingImageName = "image.jpg"
        pendingImageSize = 0L
        resolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIdx >= 0) {
                    pendingImageName = cursor.getString(nameIdx)?.takeIf { it.isNotBlank() }
                        ?: pendingImageName
                }
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIdx >= 0) {
                    pendingImageSize = cursor.getLong(sizeIdx).coerceAtLeast(0L)
                }
            }
        }
        if (pendingImageSize <= 0L) {
            runCatching {
                resolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                    pendingImageSize = afd.length.coerceAtLeast(0L)
                }
            }
        }
    }

    LaunchedEffect(isPresented) {
        if (isPresented) {
            prefs.loadDraft()?.let { draft ->
                content = draft.content
                selectedColor = draft.color
                tags.clear()
                tags.addAll(draft.tags)
            }
        } else {
            pendingImageUri = null
        }
    }

    val tagsSnapshot = tags.toList()
    LaunchedEffect(content, selectedColor, tagsSnapshot) {
        if (!isPresented) return@LaunchedEffect
        delay(DRAFT_DEBOUNCE_MS)
        prefs.saveDraft(MemoDraft(content, selectedColor, tagsSnapshot))
    }

    LaunchedEffect(content) {
        val match = URL_PATTERN.find(content)
        if (match == null) {
            bookmarkPreview = null
            return@LaunchedEffect
        }
        val url = match.value
        if (bookmarkPreview?.url == url) return@LaunchedEffect
        isLoadingBookmark = true
        try {
            bookmarkPreview = viewModel.fetchBookmarkPreview(url)
        } catch (_: Exception) {
            bookmarkPreview = null
        }
        isLoadingBookmark = false
    }

    LaunchedEffect(uiState.loadError) {
        uiState.loadError?.let { msg ->
            showError = msg
            errorIsSaveBusy = uiState.createSaveBusy
            viewModel.clearLoadError()
        }
    }

    LaunchedEffect(uiState.attachmentUploadError) {
        uiState.attachmentUploadError?.let { msg ->
            showError = msg
            errorIsSaveBusy = false
        }
    }

    var wasBusyCreating by remember { mutableStateOf(false) }
    LaunchedEffect(
        uiState.isCreating,
        uiState.isUploadingAttachment,
        uiState.pendingAttachmentMemoId,
        uiState.attachmentUploadError,
        showError,
    ) {
        val busy = uiState.isCreating || uiState.isUploadingAttachment
        val attachmentRetryPending =
            uiState.pendingAttachmentMemoId != null || uiState.attachmentUploadError != null
        if (wasBusyCreating && !busy && !attachmentRetryPending && showError == null) {
            prefs.clearDraft()
            pendingImageUri = null
            viewModel.clearPendingAttachmentRetry()
            showSuccessFlash = true
            delay(400)
            showSuccessFlash = false
            onDismiss()
            onCreated()
        }
        wasBusyCreating = busy
    }

    if (!isPresented) return

    fun hasContent(): Boolean =
        content.trim().isNotEmpty() || bookmarkPreview != null || tags.isNotEmpty() ||
            pendingImageUri != null

    fun canSubmit(): Boolean =
        !uiState.isCreating &&
            !uiState.isUploadingAttachment &&
            uiState.pendingAttachmentMemoId == null &&
            (content.trim().isNotEmpty() || bookmarkPreview != null)

    fun dismissWithCheck() {
        if (uiState.isCreating || uiState.isUploadingAttachment) return
        if (hasContent() || uiState.pendingAttachmentMemoId != null) {
            showDiscardConfirm = true
        } else {
            prefs.clearDraft()
            pendingImageUri = null
            viewModel.clearPendingAttachmentRetry()
            onDismiss()
        }
    }

    fun doSubmit() {
        if (!canSubmit()) return
        if (uiState.pendingAttachmentMemoId != null) return
        val trimmed = content.trim()
        val bmUrl = bookmarkPreview?.url ?: ""
        val image = pendingImageUri
        if (image != null) {
            viewModel.createMemoWithOptionalImage(
                contentMarkdown = trimmed,
                tags = tags,
                color = selectedColor,
                bookmarkUrl = bmUrl,
                imageUri = image,
                imageFileName = pendingImageName,
                imageContentType = pendingImageType,
                imageFileSize = pendingImageSize,
            )
        } else {
            viewModel.createMemo(
                contentMarkdown = trimmed,
                tags = tags,
                color = selectedColor,
                bookmarkUrl = bmUrl,
            )
        }
    }

    fun retryAttachment() {
        val image = pendingImageUri ?: return
        viewModel.retryPendingImageAttachment(
            imageUri = image,
            imageFileName = pendingImageName,
            imageContentType = pendingImageType,
            imageFileSize = pendingImageSize,
        )
    }

    fun addTag() {
        val tag = newTag.trim()
        if (tag.isEmpty() || tags.contains(tag)) return
        if (tags.size >= MAX_TAGS) return
        tags.add(tag)
        newTag = ""
    }

    TTBottomSheet(
        onDismissRequest = { dismissWithCheck() },
        sheetState = sheetState,
        dragHandle = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = TTSpacing.sm, bottom = TTSpacing.xs),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp, 4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.3f)),
                )
            }
        },
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
        val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
        val textTertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        val bgSubtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
        val primary = ttColor(TTColors.Primary, TTColors.Dark.Primary)

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = TTSpacing.xxxl),
        ) {
            Column(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .heightIn(max = 280.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = TTSpacing.lg),
            ) {
                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp, max = 200.dp),
                    placeholder = { Text(stringResource(R.string.memo_write_thoughts), color = textTertiary.copy(alpha = 0.5f)) },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                    ),
                )

                if (isLoadingBookmark) {
                    Row(
                        modifier = Modifier.padding(vertical = TTSpacing.sm),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Text(
                            stringResource(R.string.memo_fetching_link_info),
                            style = TTFonts.caption,
                            color = textTertiary,
                        )
                    }
                }

                bookmarkPreview?.let { preview ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(TTRadius.Shapes.sm)
                            .background(bgSubtle.copy(alpha = 0.5f))
                            .padding(TTSpacing.sm)
                            .padding(bottom = TTSpacing.sm),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (preview.image.isNotEmpty()) {
                            AsyncImage(
                                model = preview.image,
                                contentDescription = null,
                                modifier = Modifier.size(32.dp).clip(TTRadius.Shapes.sm),
                                contentScale = ContentScale.Crop,
                            )
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                preview.title.ifEmpty { preview.url },
                                style = TTFonts.captionSemibold,
                                color = textColor,
                                maxLines = 1,
                            )
                            if (preview.title.isNotEmpty()) {
                                Text(preview.url, style = TTFonts.caption, color = textTertiary, maxLines = 1)
                            }
                        }
                        IconButton(onClick = { bookmarkPreview = null }) {
                            Icon(Icons.Filled.Close, null, tint = textTertiary, modifier = Modifier.size(16.dp))
                        }
                    }
                }

                if (tags.isNotEmpty()) {
                    @OptIn(ExperimentalLayoutApi::class)
                    FlowRow(
                        modifier = Modifier.padding(bottom = TTSpacing.sm),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        tags.forEach { tag ->
                            TagChip(text = tag, isAI = false, onRemove = { tags.remove(tag) })
                        }
                    }
                }

                if (showTagInput) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = TTSpacing.sm),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Tag, null, tint = textTertiary, modifier = Modifier.size(14.dp))
                        OutlinedTextField(
                            value = newTag,
                            onValueChange = { newTag = it },
                            modifier = Modifier.weight(1f),
                            placeholder = { Text(stringResource(R.string.memo_tag_input_placeholder), style = TTFonts.caption) },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                                unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                            ),
                        )
                        if (tags.size < MAX_TAGS && newTag.trim().isNotEmpty()) {
                            TextButton(onClick = { addTag() }) {
                                Text(stringResource(R.string.memo_add), color = primary, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                            }
                        } else if (tags.size >= MAX_TAGS) {
                            Text(stringResource(R.string.memo_tags_full), style = TTFonts.caption, color = textTertiary)
                        }
                    }
                }
            }

            if (showColorPicker) {
                HorizontalDivider(color = textTertiary.copy(alpha = 0.2f))
                MemoColorPicker(
                    selectedColor = selectedColor,
                    circleSize = 24.dp,
                    onSelect = { selectedColor = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.sm)
                        .padding(horizontal = TTSpacing.lg),
                )
            }

            pendingImageUri?.let { uri ->
                Text(
                    text = when {
                        uiState.isUploadingAttachment -> stringResource(R.string.memo_pending_image)
                        uiState.pendingAttachmentMemoId != null ->
                            stringResource(R.string.memo_attachment_failed_keep_body)
                        else -> stringResource(R.string.memo_pending_image)
                    },
                    color = if (uiState.attachmentUploadError != null) {
                        TTColors.BgCritical
                    } else {
                        textTertiary
                    },
                    style = TTFonts.caption,
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
                Row(
                    modifier = Modifier
                        .padding(horizontal = TTSpacing.lg)
                        .padding(bottom = TTSpacing.sm),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AsyncImage(
                        model = uri,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(64.dp)
                            .clip(RoundedCornerShape(TTRadius.sm)),
                    )
                    if (uiState.isUploadingAttachment) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else if (
                        uiState.pendingAttachmentMemoId != null &&
                        uiState.attachmentUploadError != null
                    ) {
                        TextButton(onClick = { retryAttachment() }) {
                            Text(stringResource(R.string.memo_attachment_retry))
                        }
                    }
                }
            }

            HorizontalDivider(color = textTertiary.copy(alpha = 0.3f))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = { dismissWithCheck() },
                    enabled = !uiState.isCreating && !uiState.isUploadingAttachment,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.memo_close_editor),
                        tint = textTertiary,
                        modifier = Modifier.size(20.dp),
                    )
                }

                IconButton(
                    onClick = { showColorPicker = !showColorPicker; if (showColorPicker) showTagInput = false },
                ) {
                    com.tabtin.mobile.data.model.memo.MemoColor.from(selectedColor)?.let { mc ->
                        Box(
                            modifier = Modifier
                                .size(20.dp)
                                .clip(CircleShape)
                                .background(mc.displayColor),
                        )
                    } ?: Icon(
                        Icons.Filled.Palette,
                        contentDescription = stringResource(R.string.memo_select_color),
                        tint = if (showColorPicker) primary else textTertiary,
                    )
                }

                IconButton(
                    onClick = {
                        showTagInput = !showTagInput
                        if (showTagInput) showColorPicker = false
                    },
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Filled.Tag,
                            contentDescription = stringResource(R.string.memo_add_tag),
                            tint = if (showTagInput) primary else textTertiary,
                            modifier = Modifier.size(20.dp),
                        )
                        if (tags.isNotEmpty()) {
                            Text(
                                "${tags.size}",
                                style = TTFonts.codeXSSemibold,
                                color = primary,
                            )
                        }
                    }
                }

                IconButton(
                    onClick = {
                        imagePicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                        )
                    },
                    enabled = !uiState.isCreating,
                ) {
                    Icon(
                        Icons.Filled.Image,
                        contentDescription = stringResource(R.string.memo_add_image),
                        tint = if (pendingImageUri != null) primary else textTertiary,
                    )
                }

                Spacer(Modifier.weight(1f))

                Text(
                    "${content.length}",
                    style = TTFonts.caption,
                    color = textTertiary.copy(alpha = 0.5f),
                )

                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(
                            if (canSubmit()) primary
                            else primary.copy(alpha = 0.3f)
                        )
                        .clickable(enabled = canSubmit()) { doSubmit() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (uiState.isCreating || uiState.isUploadingAttachment) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = androidx.compose.ui.graphics.Color.White,
                        )
                    } else {
                        Icon(
                            Icons.Filled.Check,
                            contentDescription = stringResource(R.string.memo_send),
                            tint = androidx.compose.ui.graphics.Color.White,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }

            if (showSuccessFlash) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .background(TTColors.BgSuccess.copy(alpha = 0.2f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        tint = TTColors.BgSuccess,
                        modifier = Modifier.size(36.dp),
                    )
                }
            }
        }
    }

    if (showDiscardConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirm = false },
            title = { Text(stringResource(R.string.memo_discard_draft_title)) },
            text = { Text(stringResource(R.string.memo_discard_draft_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showDiscardConfirm = false
                    prefs.clearDraft()
                    pendingImageUri = null
                    viewModel.clearPendingAttachmentRetry()
                    onDismiss()
                }) {
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

    showError?.let { msg ->
        val attachmentRetry =
            uiState.pendingAttachmentMemoId != null && uiState.attachmentUploadError != null
        AlertDialog(
            onDismissRequest = { showError = null; errorIsSaveBusy = false },
            title = {
                Text(
                    stringResource(
                        when {
                            errorIsSaveBusy -> R.string.memo_save_busy
                            attachmentRetry -> R.string.memo_attachment_upload_failed
                            else -> R.string.memo_send_failed
                        },
                    ),
                )
            },
            text = { Text(msg) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showError = null
                        errorIsSaveBusy = false
                        if (attachmentRetry) retryAttachment() else doSubmit()
                    },
                ) {
                    Text(
                        stringResource(
                            if (attachmentRetry) R.string.memo_attachment_retry
                            else R.string.common_retry,
                        ),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showError = null; errorIsSaveBusy = false }) {
                    Text(stringResource(R.string.memo_ok))
                }
            },
        )
    }
}
