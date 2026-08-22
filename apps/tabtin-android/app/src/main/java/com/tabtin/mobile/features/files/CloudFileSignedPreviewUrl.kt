package com.tabtin.mobile.features.files

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.repository.CloudDriveRepository
import com.tabtin.mobile.features.clouddocs.CloudFileAccessIdentity
import com.tabtin.mobile.features.clouddocs.CloudFileAccessRoute
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.ConcurrentHashMap

@EntryPoint
@InstallIn(SingletonComponent::class)
internal interface CloudFilePreviewEntryPoint {
    fun ossUploadService(): OSSUploadService
    fun cloudDriveRepository(): CloudDriveRepository
}

internal object CloudFileSignedPreviewUrlCache {
    private val urls = ConcurrentHashMap<String, String>()

    fun get(key: String): String? = urls[key]

    fun put(key: String, url: String) {
        if (url.startsWith("http://", ignoreCase = true) ||
            url.startsWith("https://", ignoreCase = true)
        ) {
            urls[key] = url
        }
    }
}

@Composable
internal fun rememberCloudFileSignedPreviewUrl(
    organizationId: String,
    contextItemId: String,
    fileRecordId: String,
): String? {
    val context = LocalContext.current
    val route = CloudFileAccessIdentity.route(organizationId, contextItemId, fileRecordId)
    val cacheKey = CloudFileAccessIdentity.cacheKey(route, contextItemId, fileRecordId)
    var url by remember(cacheKey) { mutableStateOf(cacheKey?.let(CloudFileSignedPreviewUrlCache::get)) }

    LaunchedEffect(cacheKey) {
        if (cacheKey == null || !url.isNullOrBlank()) return@LaunchedEffect
        val resolved = runCatching {
            resolveCloudFileSignedPreviewUrl(
                context = context.applicationContext,
                organizationId = organizationId,
                contextItemId = contextItemId,
                fileRecordId = fileRecordId,
            )
        }.getOrNull()
        if (!resolved.isNullOrBlank()) {
            CloudFileSignedPreviewUrlCache.put(cacheKey, resolved)
            url = resolved
        }
    }
    return url
}

internal suspend fun resolveCloudFileSignedPreviewUrl(
    context: Context,
    organizationId: String,
    contextItemId: String,
    fileRecordId: String,
): String? {
    val accessors = EntryPointAccessors.fromApplication(
        context.applicationContext,
        CloudFilePreviewEntryPoint::class.java,
    )
    return when (CloudFileAccessIdentity.route(organizationId, contextItemId, fileRecordId)) {
        CloudFileAccessRoute.CONTEXT_ITEM ->
            accessors.cloudDriveRepository()
                .getPreviewUrl(organizationId, contextItemId)
                .url
                .takeIf { it.isNotBlank() }
        CloudFileAccessRoute.FILE_RECORD ->
            accessors.ossUploadService()
                .resolveFile(fileRecordId.trim())
                .displayUrl
                .takeIf { it.isNotBlank() }
        CloudFileAccessRoute.MISSING -> null
    }
}
