package com.tabtin.mobile.features.files

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.features.clouddocs.CloudFileInfo
import com.tabtin.mobile.features.clouddocs.CloudFileInfoScreen
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing

/** 云盘内打开文档 / 多维表 Web 承载的请求。 */
public data class CloudDriveWebOpenRequest(
    val resourceType: String,
    val resourceId: String,
    val title: String,
)

/**
 * Workbench 内嵌的 Organization 云盘 App 首页壳。
 * 文档 / 表格走既有 Web 承载；tabfiles 走签名 URL 详情。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudDriveAppHomeScreen(
    organizationId: String,
    organizationName: String = "",
    appTitle: String = "",
    backHandlingEnabled: Boolean = true,
    onBack: () -> Unit,
    onDismiss: () -> Unit,
    onOpenWebResource: (CloudDriveWebOpenRequest) -> Unit,
    /** 仅从任务对话工作台进入时非空；深链 / 通知为空。 */
    activeConversationSink: ((ResourceReference) -> Unit)? = null,
    /** false：宽屏 EMBEDDED 等已有宿主层时不再套 Modal，避免挡胶囊。 */
    wrapInModalSheet: Boolean = true,
    viewModel: CloudDriveAppHomeViewModel = hiltViewModel(),
) {
    BackHandler(enabled = backHandlingEnabled, onBack = onBack)
    var pendingFile by remember { mutableStateOf<CloudFileInfo?>(null) }
    val context = LocalContext.current

    val multiPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris: List<Uri> ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val picked = uris.mapNotNull { uri ->
            resolvePickedFile(context, uri)
        }
        if (picked.isNotEmpty()) {
            viewModel.uploadFiles(picked)
        }
    }

    LaunchedEffect(viewModel) {
        viewModel.openCreated.collect { created ->
            onOpenWebResource(
                CloudDriveWebOpenRequest(
                    resourceType = created.resourceType,
                    resourceId = created.resourceId,
                    title = created.title,
                ),
            )
        }
    }

    LaunchedEffect(viewModel) {
        viewModel.pendingOpenResource.collect { row ->
            openCloudDriveResource(
                row = row,
                organizationId = organizationId,
                onOpenWeb = onOpenWebResource,
                onOpenFile = { pendingFile = it },
            )
        }
    }

    pendingFile?.let { info ->
        CloudFileInfoScreen(
            info = info,
            organizationId = organizationId,
            onBack = { pendingFile = null },
        )
        return
    }

    val body: @Composable () -> Unit = {
        CloudDriveAppHomeContent(
            viewModel = viewModel,
            organizationId = organizationId,
            organizationName = organizationName,
            appTitle = appTitle,
            onBack = onBack,
            onOpenResource = { row ->
                openCloudDriveResource(
                    row = row,
                    organizationId = organizationId,
                    onOpenWeb = onOpenWebResource,
                    onOpenFile = { pendingFile = it },
                )
            },
            onPickFiles = { multiPicker.launch(arrayOf("*/*")) },
            activeConversationSink = activeConversationSink,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxSize()
                .padding(bottom = TTSpacing.xxxl),
        )
    }
    if (wrapInModalSheet) {
        val sheetState = rememberTTSheetState()
        TTBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
        ) {
            body()
        }
    } else {
        body()
    }
}

internal fun openCloudDriveResource(
    row: CloudDriveResourceRow,
    organizationId: String,
    onOpenWeb: (CloudDriveWebOpenRequest) -> Unit,
    onOpenFile: (CloudFileInfo) -> Unit,
) {
    when (row.normalizedType) {
        "tabdoc", "tabdata" -> {
            onOpenWeb(
                CloudDriveWebOpenRequest(
                    resourceType = row.normalizedType,
                    resourceId = row.resourceId,
                    title = row.displayTitle,
                ),
            )
        }
        "tabfiles" -> {
            onOpenFile(
                CloudFileInfo(
                    contextItemId = row.contextItemId,
                    organizationId = organizationId.ifBlank { row.organizationId.orEmpty() },
                    resourceId = row.fileRecordId ?: row.resourceId,
                    spaceId = row.spaceId,
                    spaceName = row.spaceName,
                    fileName = row.displayTitle,
                    preview = row.preview,
                    mimeType = row.mimeType,
                    typeLabel = "TabFiles",
                    fileSizeBytes = row.fileSizeBytes,
                    fileUrl = null,
                    canShare = row.canShare != false,
                    canTrash = row.canTrash != false,
                ),
            )
        }
        else -> Unit
    }
}

private fun resolvePickedFile(
    context: android.content.Context,
    uri: Uri,
): CloudDrivePickedFile? {
    val resolver = context.contentResolver
    var fileName = "file"
    var fileSize = 0L
    resolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIdx >= 0) {
                fileName = cursor.getString(nameIdx)?.takeIf { it.isNotBlank() } ?: fileName
            }
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeIdx >= 0) {
                fileSize = cursor.getLong(sizeIdx).coerceAtLeast(0L)
            }
        }
    }
    if (fileSize <= 0L) {
        runCatching {
            resolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                fileSize = afd.length.coerceAtLeast(0L)
            }
        }
    }
    if (fileSize <= 0L) return null
    val contentType = resolver.getType(uri) ?: "application/octet-stream"
    return CloudDrivePickedFile(
        uri = uri,
        fileName = fileName,
        contentType = contentType,
        fileSize = fileSize,
    )
}
