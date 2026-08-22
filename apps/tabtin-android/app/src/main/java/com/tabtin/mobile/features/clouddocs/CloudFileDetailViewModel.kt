package com.tabtin.mobile.features.clouddocs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.api.OSSFileAccess
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.files.CloudFilePreviewPolicy
import com.tabtin.mobile.data.repository.CloudDriveRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

public data class CloudFileDetailUiState(
    val isLoadingPreview: Boolean = false,
    val isLoadingDownload: Boolean = false,
    val previewUrl: String? = null,
    val downloadUrl: String? = null,
    val mimeType: String? = null,
    val fileName: String? = null,
    val fileSizeBytes: Long? = null,
    val previewEligible: Boolean = false,
    val mimePreviewSafe: Boolean = false,
    val isTrashing: Boolean = false,
    val errorMessage: String? = null,
) {
    public val canInlinePreview: Boolean
        get() = previewEligible &&
            mimePreviewSafe &&
            CloudFilePreviewPolicy.isInlinePreviewSafe(mimeType) &&
            !previewUrl.isNullOrBlank()
}

@HiltViewModel
public class CloudFileDetailViewModel @Inject constructor(
    private val repository: CloudDriveRepository,
    private val ossUploadService: OSSUploadService,
) : ViewModel() {
    private val _uiState = MutableStateFlow(CloudFileDetailUiState())
    public val uiState: StateFlow<CloudFileDetailUiState> = _uiState.asStateFlow()

    private var boundAccessKey: String? = null

    public fun load(
        organizationId: String,
        contextItemId: String,
        fileRecordId: String = "",
        fallbackMime: String? = null,
        fallbackName: String? = null,
        fallbackSize: Long? = null,
    ) {
        val route = CloudFileAccessIdentity.route(organizationId, contextItemId, fileRecordId)
        val accessKey = CloudFileAccessIdentity.cacheKey(route, contextItemId, fileRecordId)
        if (route == CloudFileAccessRoute.MISSING || accessKey == null) {
            _uiState.update {
                it.copy(errorMessage = "缺少组织或文件标识，无法获取签名链接")
            }
            return
        }
        if (boundAccessKey == accessKey && !_uiState.value.previewUrl.isNullOrBlank()) {
            return
        }
        boundAccessKey = accessKey
        _uiState.update {
            it.copy(
                isLoadingPreview = true,
                errorMessage = null,
                mimeType = fallbackMime,
                fileName = fallbackName,
                fileSizeBytes = fallbackSize,
            )
        }
        viewModelScope.launch {
            when (route) {
                CloudFileAccessRoute.FILE_RECORD -> {
                    runCatching {
                        ossUploadService.resolveFile(fileRecordId.trim())
                    }.onSuccess { access ->
                        applyOssAccess(access, fallbackMime, fallbackName, fallbackSize)
                    }.onFailure { error ->
                        _uiState.update {
                            it.copy(
                                isLoadingPreview = false,
                                errorMessage = error.message ?: "预览链接获取失败",
                            )
                        }
                    }
                }
                CloudFileAccessRoute.CONTEXT_ITEM -> {
                    runCatching {
                        repository.recordAccess(contextItemId)
                    }
                    runCatching {
                        repository.getPreviewUrl(organizationId, contextItemId)
                    }.onSuccess { response ->
                        _uiState.update {
                            it.copy(
                                isLoadingPreview = false,
                                previewUrl = response.url.takeIf { url -> url.isNotBlank() },
                                mimeType = response.mimeType ?: fallbackMime,
                                fileName = response.fileName.ifBlank { fallbackName },
                                fileSizeBytes = response.fileSize ?: fallbackSize,
                                previewEligible = response.previewEligible,
                                mimePreviewSafe = response.mimePreviewSafe,
                                errorMessage = null,
                            )
                        }
                    }.onFailure { error ->
                        _uiState.update {
                            it.copy(
                                isLoadingPreview = false,
                                errorMessage = error.message ?: "预览链接获取失败",
                            )
                        }
                    }
                }
                CloudFileAccessRoute.MISSING -> Unit
            }
        }
    }

    public fun fetchDownloadUrl(
        organizationId: String,
        contextItemId: String,
        fileRecordId: String = "",
        onReady: (String) -> Unit,
    ) {
        val route = CloudFileAccessIdentity.route(organizationId, contextItemId, fileRecordId)
        val existingUrl = _uiState.value.downloadUrl
        if (route == CloudFileAccessRoute.FILE_RECORD && !existingUrl.isNullOrBlank()) {
            onReady(existingUrl)
            return
        }
        if (route == CloudFileAccessRoute.MISSING) return
        _uiState.update { it.copy(isLoadingDownload = true) }
        viewModelScope.launch {
            when (route) {
                CloudFileAccessRoute.FILE_RECORD -> {
                    runCatching {
                        ossUploadService.resolveFile(fileRecordId.trim())
                    }.onSuccess { access ->
                        applyOssAccess(
                            access,
                            fallbackMime = _uiState.value.mimeType,
                            fallbackName = _uiState.value.fileName,
                            fallbackSize = _uiState.value.fileSizeBytes,
                        )
                        access.displayUrl.takeIf { it.isNotBlank() }?.let(onReady)
                    }.onFailure { error ->
                        _uiState.update {
                            it.copy(
                                isLoadingDownload = false,
                                errorMessage = error.message ?: "下载链接获取失败",
                            )
                        }
                    }
                }
                CloudFileAccessRoute.CONTEXT_ITEM -> {
                    runCatching {
                        repository.getDownloadUrl(organizationId, contextItemId)
                    }.onSuccess { response ->
                        val url = response.url
                        _uiState.update {
                            it.copy(
                                isLoadingDownload = false,
                                downloadUrl = url.takeIf { value -> value.isNotBlank() },
                                mimeType = response.mimeType ?: it.mimeType,
                                fileName = response.fileName.ifBlank { it.fileName },
                                fileSizeBytes = response.fileSize ?: it.fileSizeBytes,
                            )
                        }
                        if (url.isNotBlank()) onReady(url)
                    }.onFailure { error ->
                        _uiState.update {
                            it.copy(
                                isLoadingDownload = false,
                                errorMessage = error.message ?: "下载链接获取失败",
                            )
                        }
                    }
                }
                CloudFileAccessRoute.MISSING -> Unit
            }
        }
    }

    public fun trashFile(
        organizationId: String,
        fileRecordId: String,
        onDone: () -> Unit,
    ) {
        if (fileRecordId.isBlank() || organizationId.isBlank()) return
        _uiState.update { it.copy(isTrashing = true, errorMessage = null) }
        viewModelScope.launch {
            runCatching {
                repository.trashTabFile(
                    organizationId = organizationId,
                    fileRecordId = fileRecordId,
                )
            }.onSuccess {
                _uiState.update { it.copy(isTrashing = false) }
                onDone()
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        isTrashing = false,
                        errorMessage = error.message ?: "移入回收站失败",
                    )
                }
            }
        }
    }

    private fun applyOssAccess(
        access: OSSFileAccess,
        fallbackMime: String?,
        fallbackName: String?,
        fallbackSize: Long?,
    ) {
        val url = access.displayUrl.takeIf { it.isNotBlank() }
        val mime = access.mimeType.ifBlank { fallbackMime }
        _uiState.update {
            it.copy(
                isLoadingPreview = false,
                isLoadingDownload = false,
                previewUrl = url,
                downloadUrl = url,
                mimeType = mime,
                fileName = access.fileName.ifBlank { fallbackName ?: it.fileName },
                fileSizeBytes = access.fileSize.takeIf { size -> size > 0L } ?: fallbackSize ?: it.fileSizeBytes,
                previewEligible = url != null,
                mimePreviewSafe = CloudFilePreviewPolicy.isInlinePreviewSafe(mime),
                errorMessage = if (url == null) "无法获取签名链接" else null,
            )
        }
    }
}
