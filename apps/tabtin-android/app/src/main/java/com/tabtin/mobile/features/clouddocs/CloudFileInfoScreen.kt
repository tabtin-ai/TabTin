package com.tabtin.mobile.features.clouddocs

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.features.conversation.ChatFilePreviewDialog
import com.tabtin.mobile.features.files.CloudDriveAppHomeViewModel
import com.tabtin.mobile.features.files.CloudDriveFileCategory
import com.tabtin.mobile.features.files.CloudDriveFilePresentation
import com.tabtin.mobile.features.files.CloudDriveResourceArtwork
import com.tabtin.mobile.features.files.TabFilesCollaboratorsSheet
import com.tabtin.mobile.features.files.cloudDriveRedesignPalette
import com.tabtin.mobile.features.files.cloudDriveSafePreviewText
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * TabFiles 详情：签名 URL 预览 / 下载；不信任 metadata 里的长期 URL。
 * 页面结构和 iOS `CloudFileDetailScreen` 对齐：预览卡 + 可用操作 + 文件信息。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudFileInfoScreen(
    info: CloudFileInfo,
    organizationId: String = info.organizationId.orEmpty(),
    onBack: () -> Unit,
    viewModel: CloudFileDetailViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val palette = cloudDriveRedesignPalette()
    val state by viewModel.uiState.collectAsState()
    var internalPreviewUrl by remember { mutableStateOf<String?>(null) }
    var showCollaborators by remember { mutableStateOf(false) }
    var showTrashConfirm by remember { mutableStateOf(false) }
    val resolvedOrgId = organizationId.ifBlank { info.organizationId.orEmpty() }
    val contextItemId = info.contextItemId
    val fileRecordId = info.resourceId
    val canRequestSignedUrl = contextItemId.isNotBlank() || fileRecordId.isNotBlank()

    LaunchedEffect(resolvedOrgId, contextItemId, fileRecordId) {
        viewModel.load(
            organizationId = resolvedOrgId,
            contextItemId = contextItemId,
            fileRecordId = fileRecordId,
            fallbackMime = info.mimeType,
            fallbackName = info.fileName,
            fallbackSize = info.fileSizeBytes,
        )
    }

    val displayName = state.fileName?.takeIf { it.isNotBlank() } ?: info.fileName
    val mimeType = state.mimeType ?: info.mimeType
    val category = CloudDriveFilePresentation.classify(
        itemType = "tabfiles",
        fileName = displayName,
        mimeType = mimeType,
    )
    val fileSize = state.fileSizeBytes ?: info.fileSizeBytes
    val previewUrl = state.previewUrl?.takeIf { it.isNotBlank() }
    val downloadUrl = state.downloadUrl?.takeIf { it.isNotBlank() }
    val shareableUrl = downloadUrl ?: previewUrl
    val metadata = CloudFileDetailPresentation.metadata(
        mimeType = mimeType,
        typeLabel = info.typeLabel,
        sizeBytes = fileSize,
        spaceName = info.spaceName,
        organizationCloudLabel = stringResource(R.string.cloud_file_org_cloud),
    )
    val actions = CloudFileDetailPresentation.actions(
        canPreview = state.canInlinePreview,
        hasShareableLink = !shareableUrl.isNullOrBlank(),
        canManageCollaborators = info.canShare && fileRecordId.isNotBlank(),
        canTrash = info.canTrash && fileRecordId.isNotBlank(),
    )

    Scaffold(
        containerColor = palette.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                title = {
                    Text(
                        text = displayName,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            item {
                CloudFileDetailHeader(
                    displayName = displayName,
                    preview = info.preview,
                    category = category,
                    previewUrl = previewUrl,
                    isLoading = state.isLoadingPreview,
                    errorMessage = state.errorMessage,
                )
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    Text(
                        text = stringResource(R.string.cloud_file_available_actions),
                        style = TTFonts.bodySemibold,
                        color = palette.textPrimary,
                    )
                    if (state.isLoadingPreview) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp))
                    }
                    actions.forEach { action ->
                        CloudFileDetailActionButton(
                            action = action,
                            enabled = canRequestSignedUrl && !state.isLoadingDownload && !state.isTrashing,
                            loading = when (action) {
                                CloudFileDetailAction.DOWNLOAD -> state.isLoadingDownload
                                CloudFileDetailAction.TRASH -> state.isTrashing
                                else -> false
                            },
                            onClick = {
                                when (action) {
                                    CloudFileDetailAction.PREVIEW ->
                                        previewUrl?.let { internalPreviewUrl = it }
                                    CloudFileDetailAction.OPEN_EXTERNALLY ->
                                        previewUrl?.let {
                                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it)))
                                        }
                                    CloudFileDetailAction.DOWNLOAD ->
                                        viewModel.fetchDownloadUrl(
                                            resolvedOrgId,
                                            contextItemId,
                                            fileRecordId,
                                        ) { url ->
                                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                        }
                                    CloudFileDetailAction.COPY_LINK ->
                                        shareableUrl?.let { copyText(context, "TabFiles URL", it) }
                                            ?: viewModel.fetchDownloadUrl(
                                                resolvedOrgId,
                                                contextItemId,
                                                fileRecordId,
                                            ) { url -> copyText(context, "TabFiles URL", url) }
                                    CloudFileDetailAction.SHARE ->
                                        shareableUrl?.let { shareText(context, displayName, it) }
                                            ?: viewModel.fetchDownloadUrl(
                                                resolvedOrgId,
                                                contextItemId,
                                                fileRecordId,
                                            ) { url -> shareText(context, displayName, url) }
                                    CloudFileDetailAction.COLLABORATORS -> showCollaborators = true
                                    CloudFileDetailAction.TRASH -> showTrashConfirm = true
                                }
                            },
                        )
                    }
                }
            }
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(TTRadius.sm))
                        .background(palette.surfaceSoft)
                        .padding(TTSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(
                        text = stringResource(R.string.cloud_file_info),
                        style = TTFonts.bodySemibold,
                        color = palette.textPrimary,
                    )
                    FileInfoRow(stringResource(R.string.cloud_file_type), metadata.mimeType)
                    metadata.sizeBytes?.let {
                        FileInfoRow(
                            stringResource(R.string.cloud_file_size),
                            Formatter.formatFileSize(context, it),
                        )
                    }
                    FileInfoRow(stringResource(R.string.cloud_file_location), metadata.location)
                }
            }
        }
    }

    internalPreviewUrl?.let { url ->
        ChatFilePreviewDialog(
            fileUrl = url,
            filename = displayName,
            mimeType = mimeType,
            onDismiss = { internalPreviewUrl = null },
        )
    }
    if (showCollaborators) {
        TabFilesCollaboratorsSheet(
            organizationId = resolvedOrgId,
            fileRecordId = fileRecordId,
            fileTitle = displayName,
            viewModel = hiltViewModel<CloudDriveAppHomeViewModel>(),
            onDismiss = { showCollaborators = false },
        )
    }
    if (showTrashConfirm) {
        AlertDialog(
            onDismissRequest = { showTrashConfirm = false },
            title = { Text(stringResource(R.string.cloud_drive_trash_confirm_title)) },
            text = { Text(stringResource(R.string.cloud_drive_trash_confirm_body, displayName)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showTrashConfirm = false
                        viewModel.trashFile(resolvedOrgId, fileRecordId, onBack)
                    },
                ) {
                    Text(stringResource(R.string.cloud_drive_trash))
                }
            },
            dismissButton = {
                TextButton(onClick = { showTrashConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun CloudFileDetailHeader(
    displayName: String,
    preview: String?,
    category: CloudDriveFileCategory,
    previewUrl: String?,
    isLoading: Boolean,
    errorMessage: String?,
) {
    val palette = cloudDriveRedesignPalette()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(palette.surfaceSoft)
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        if (CloudFileDetailPresentation.showsLiveImage(category) && !previewUrl.isNullOrBlank()) {
            AsyncImage(
                model = previewUrl,
                contentDescription = displayName,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(220.dp)
                    .clip(RoundedCornerShape(TTRadius.sm)),
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(if (CloudFileDetailPresentation.showsLiveImage(category)) 220.dp else 72.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (isLoading && CloudFileDetailPresentation.showsLiveImage(category)) {
                    CircularProgressIndicator(modifier = Modifier.size(28.dp))
                } else {
                    CloudDriveResourceArtwork(category = category, size = 48.dp)
                }
            }
        }
        Text(
            text = displayName,
            style = TTFonts.subtitleSemibold,
            color = palette.textPrimary,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        cloudDriveSafePreviewText(preview)?.let {
            Text(
                text = it,
                style = TTFonts.meta,
                color = palette.textSecondary,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!errorMessage.isNullOrBlank() && !CloudFileDetailPresentation.showsLiveImage(category)) {
            Text(
                text = errorMessage,
                style = TTFonts.caption,
                color = palette.textSecondary,
            )
        }
    }
}

@Composable
private fun CloudFileDetailActionButton(
    action: CloudFileDetailAction,
    enabled: Boolean,
    loading: Boolean,
    onClick: () -> Unit,
) {
    val palette = cloudDriveRedesignPalette()
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(TTRadius.sm),
    ) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = action.icon,
                    contentDescription = null,
                    tint = if (action == CloudFileDetailAction.TRASH) {
                        palette.textSecondary
                    } else {
                        palette.accent
                    },
                )
                Text(
                    text = stringResource(action.labelRes),
                    color = palette.textPrimary,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

private val CloudFileDetailAction.icon: ImageVector
    get() = when (this) {
        CloudFileDetailAction.PREVIEW -> Icons.Default.Visibility
        CloudFileDetailAction.OPEN_EXTERNALLY -> Icons.AutoMirrored.Filled.OpenInNew
        CloudFileDetailAction.DOWNLOAD -> Icons.Default.Download
        CloudFileDetailAction.COPY_LINK -> Icons.Default.ContentCopy
        CloudFileDetailAction.SHARE -> Icons.Default.Share
        CloudFileDetailAction.COLLABORATORS -> Icons.Default.People
        CloudFileDetailAction.TRASH -> Icons.Default.Delete
    }

private val CloudFileDetailAction.labelRes: Int
    get() = when (this) {
        CloudFileDetailAction.PREVIEW -> R.string.cloud_file_preview
        CloudFileDetailAction.OPEN_EXTERNALLY -> R.string.cloud_file_open_externally
        CloudFileDetailAction.DOWNLOAD -> R.string.cloud_drive_download
        CloudFileDetailAction.COPY_LINK -> R.string.cloud_copy_link
        CloudFileDetailAction.SHARE -> R.string.common_share
        CloudFileDetailAction.COLLABORATORS -> R.string.cloud_drive_manage_collaborators
        CloudFileDetailAction.TRASH -> R.string.cloud_drive_trash
    }

public data class CloudFileInfo(
    /** ContextItemID — 签名下载 / 访问上报用。 */
    val contextItemId: String,
    val organizationId: String? = null,
    /** FileRecordID（TabFiles resource_id）。 */
    val resourceId: String,
    val spaceId: String?,
    val spaceName: String?,
    val fileName: String,
    val preview: String?,
    val mimeType: String?,
    val typeLabel: String,
    val fileSizeBytes: Long?,
    /** @deprecated 不再信任 metadata URL；保留仅作迁移兼容。 */
    val fileUrl: String? = null,
    val canShare: Boolean = false,
    val canTrash: Boolean = false,
)

@Composable
private fun FileInfoRow(label: String, value: String) {
    val palette = cloudDriveRedesignPalette()
    Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        Text(
            text = label,
            style = TTFonts.captionMedium,
            color = palette.textTertiary,
            modifier = Modifier.width(88.dp),
        )
        Text(
            text = value,
            style = TTFonts.meta,
            color = palette.textPrimary,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun copyText(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun shareText(context: Context, title: String, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, null))
}
