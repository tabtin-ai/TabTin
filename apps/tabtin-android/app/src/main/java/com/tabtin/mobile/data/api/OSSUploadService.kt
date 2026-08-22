package com.tabtin.mobile.data.api

import android.content.Context
import android.net.Uri
import android.util.Log
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AppError
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.Authenticator
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

/**
 * 直传签名的归属范围。presign、confirm 和离线 confirm 重试必须复用同一个实例，
 * 否则服务端会拒绝把一个范围签出的 object key 确认到另一个范围。
 */
@Serializable
public data class UploadScope(
    val module: String,
    @SerialName("context_type") val contextType: String,
    @SerialName("context_id") val contextId: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("is_public") val isPublic: Boolean,
) {
    init {
        require(module.isNotBlank()) { "Upload scope module is required" }
        require(contextType.isNotBlank()) { "Upload scope contextType is required" }
        require(contextId.isNotBlank()) { "Upload scope contextId is required" }
    }
}

@Serializable
public data class PresignUploadRequest(
    val filename: String,
    val folder: String = "chat/attachments",
    @SerialName("content_type") val contentType: String? = null,
    @SerialName("file_size") val fileSize: Long,
    @SerialName("file_hash") val fileHash: String? = null,
    @SerialName("organization_id") val organizationId: String,
    val module: String,
    @SerialName("context_type") val contextType: String,
    @SerialName("context_id") val contextId: String,
    @SerialName("is_public") val isPublic: Boolean,
)

@Serializable
public data class PresignUploadResponse(
    val instant: Boolean = false,
    @SerialName("object_key") val objectKey: String? = null,
    @SerialName("presigned_url") val presignedUrl: String? = null,
    @SerialName("access_url") val accessUrl: String? = null,
    @SerialName("cdn_url") val cdnUrl: String? = null,
    @SerialName("content_type") val contentType: String? = null,
    @SerialName("file_id") val fileId: String? = null,
    @SerialName("file_name") val fileName: String? = null,
)

@Serializable
public data class ConfirmUploadRequest(
    @SerialName("object_key") val objectKey: String,
    @SerialName("file_name") val fileName: String,
    @SerialName("file_size") val fileSize: Long,
    @SerialName("content_type") val contentType: String,
    @SerialName("file_hash") val fileHash: String? = null,
    val module: String,
    @SerialName("context_type") val contextType: String,
    @SerialName("context_id") val contextId: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("is_public") val isPublic: Boolean,
)

@Serializable
public data class ConfirmUploadResponse(
    @SerialName("file_id") val fileId: String,
    @SerialName("access_url") val accessUrl: String? = null,
    @SerialName("cdn_url") val cdnUrl: String? = null,
    @SerialName("file_name") val fileName: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
)

public data class UploadResult(
    val fileId: String,
    val accessUrl: String,
    val fileName: String,
)

@Serializable
public data class OSSFileAccess(
    @SerialName("file_id") val fileId: String,
    @SerialName("file_name") val fileName: String = "",
    @SerialName("file_size") val fileSize: Long = 0,
    @SerialName("mime_type") val mimeType: String = "",
    @SerialName("access_url") val accessUrl: String = "",
    @SerialName("cdn_url") val cdnUrl: String = "",
    @SerialName("resolved_url") val resolvedUrl: String = "",
) {
    public val displayUrls: List<String>
        get() = listOf(cdnUrl, accessUrl, resolvedUrl)
            .map { it.trim() }
            .filter { it.startsWith("https://", ignoreCase = true) || it.startsWith("http://", ignoreCase = true) }
            .distinct()

    public val displayUrl: String
        get() = displayUrls.firstOrNull().orEmpty()
}

// ---------------------------------------------------------------------------
// Retrofit interface (uses existing auth-injected OkHttpClient)
// ---------------------------------------------------------------------------

@Serializable
public data class DeactivateUsageRequest(
    @SerialName("file_id") val fileId: String,
    val module: String,
    @SerialName("context_type") val contextType: String,
    @SerialName("context_id") val contextId: String,
)

@Serializable
public data class DeactivateUsageResponse(
    val success: Boolean? = null,
    val message: String? = null,
)

public interface OSSApi {
    @POST("services/oss/presign-upload")
    public suspend fun presignUpload(@Body body: PresignUploadRequest): com.tabtin.mobile.data.model.ApiEnvelope<PresignUploadResponse>

    @POST("services/oss/confirm-upload")
    public suspend fun confirmUpload(@Body body: ConfirmUploadRequest): com.tabtin.mobile.data.model.ApiEnvelope<ConfirmUploadResponse>

    @retrofit2.http.GET("services/oss/upload-config")
    public suspend fun getUploadConfig(): com.tabtin.mobile.data.model.ApiEnvelope<com.tabtin.mobile.data.oss.UploadConfigData>

    @POST("services/oss/deactivate-usage")
    public suspend fun deactivateUsage(@Body body: DeactivateUsageRequest): com.tabtin.mobile.data.model.ApiEnvelope<DeactivateUsageResponse>

    @GET("services/oss/files/{fileId}")
    public suspend fun getFile(
        @retrofit2.http.Path("fileId") fileId: String,
    ): com.tabtin.mobile.data.model.ApiEnvelope<OSSFileAccess>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Singleton
public class OSSUploadService @Inject constructor(
    @ApplicationContext private val appContext: Context,
    private val okHttpClient: OkHttpClient,
    retrofit: Retrofit,
) {
    public companion object {
        private const val TAG = "OSSUploadService"
        private const val MAX_PUT_RETRIES = 3
        private const val MIN_WRITE_TIMEOUT_SEC = 60L
        private const val BYTES_PER_SECOND_MIN_BANDWIDTH = 256L * 1024 // 256 KB/s
        private const val STREAM_BUFFER_SIZE = 8 * 1024
        private const val HASH_CHUNK_SIZE = 2 * 1024 * 1024 // 2MB
        private const val HASH_FULL_THRESHOLD = HASH_CHUNK_SIZE.toLong() * 4 // 8MB
        private const val CONFIRM_MAX_RETRIES = 3
        private const val PENDING_CONFIRMS_PREF = "tabtin_oss_pending_confirms"
        // v1 的 confirm body 没有完整的 UploadScope，升级后不能继续重试。
        private const val LEGACY_PENDING_CONFIRMS_KEY = "pending_list"
        private const val PENDING_CONFIRMS_KEY = "pending_list_v2"
        private const val PRESIGN_SCOPE_MISMATCH = "PRESIGN_SCOPE_MISMATCH"
    }

    private val ossApi: OSSApi = retrofit.create(OSSApi::class.java)

    /** Service 自有 scope：用于脱离调用方生命周期的 fire-and-forget 清理（如离开会话后释放 FileUsage）。 */
    private val detachedScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val pendingConfirmPrefs by lazy {
        appContext.getSharedPreferences(PENDING_CONFIRMS_PREF, Context.MODE_PRIVATE).also { prefs ->
            // 不迁移旧队列：它们可能由旧客户端以不完整范围持久化，重试只会制造死循环。
            prefs.edit().remove(LEGACY_PENDING_CONFIRMS_KEY).apply()
        }
    }

    public suspend fun fetchUploadConfigIfNeeded() {
        try {
            val config = try {
                ossApi.getUploadConfig().unwrap()
            } catch (e: AppError.RequestFailed) {
                throw AppError.ActionFailed(ActionLabel.FETCH_CONFIG, e.serverMessage)
            }
            com.tabtin.mobile.data.oss.UploadConfig.applyRemoteConfig(config.presets)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to fetch upload config, using local fallback: ${e.message}")
        }
        retryPendingConfirms()
    }

    /** 按 file_id 经后端权限接口换取当前可用地址，与 Electron IM 附件策略一致。 */
    public suspend fun resolveFile(fileId: String): OSSFileAccess = ossApi.getFile(fileId).unwrap()

    /**
     * 完整的三步直传流程: presign → PUT → confirm。
     * 支持秒传: 如果 presign 返回 instant=true 则跳过 PUT + confirm。
     * 适用于截图等已在内存中的小数据。大文件请使用 [directUploadFromUri]。
     */
    public suspend fun directUpload(
        data: ByteArray,
        fileName: String,
        contentType: String,
        folder: String = "chat/attachments",
        scope: UploadScope,
        onProgress: ((Float) -> Unit)? = null,
    ): UploadResult {
        val hashHex = withContext(Dispatchers.Default) {
            computeFileHash(data)
        }

        val presignResp = presign(
            fileName = fileName,
            folder = folder,
            contentType = contentType,
            fileSize = data.size.toLong(),
            fileHash = hashHex,
            scope = scope,
        )

        if (presignResp.instant) {
            val fid = presignResp.fileId ?: throw AppError.InstantNoFileId
            return UploadResult(
                fileId = fid,
                accessUrl = presignResp.accessUrl ?: presignResp.cdnUrl ?: "",
                fileName = presignResp.fileName ?: fileName,
            )
        }

        val presignedUrl = presignResp.presignedUrl ?: throw AppError.MissingPresignedUrl
        val objectKey = presignResp.objectKey ?: throw AppError.MissingObjectKey

        uploadBytesToOSS(presignedUrl, data, contentType, onProgress)

        val confirmReq = ConfirmUploadRequest(
            objectKey = objectKey,
            fileName = fileName,
            fileSize = data.size.toLong(),
            contentType = contentType,
            fileHash = hashHex,
            module = scope.module,
            contextType = scope.contextType,
            contextId = scope.contextId,
            organizationId = scope.organizationId,
            isPublic = scope.isPublic,
        )
        persistPendingConfirm(confirmReq)

        return try {
            val result = confirm(confirmReq)
            removePendingConfirm(objectKey)
            result
        } catch (e: CancellationException) {
            removePendingConfirm(objectKey)
            throw e
        } catch (e: AppError.PresignScopeMismatch) {
            removePendingConfirm(objectKey)
            throw e
        }
    }

    /**
     * 流式三步直传：presign → PUT (stream) → confirm。
     * 文件不会全量加载到内存，通过流式读取完成 SHA-256 采样 hash 和上传。
     * 适用于大文件（视频、音频等）。
     */
    public suspend fun directUploadFromUri(
        uri: Uri,
        fileSize: Long,
        fileName: String,
        contentType: String,
        folder: String = "chat/attachments",
        scope: UploadScope,
        onProgress: ((Float) -> Unit)? = null,
    ): UploadResult {
        val hashHex = withContext(Dispatchers.IO) {
            computeFileHashFromUri(uri, fileSize)
        }

        val presignResp = presign(
            fileName = fileName,
            folder = folder,
            contentType = contentType,
            fileSize = fileSize,
            fileHash = hashHex,
            scope = scope,
        )

        if (presignResp.instant) {
            val fid = presignResp.fileId ?: throw AppError.InstantNoFileId
            return UploadResult(
                fileId = fid,
                accessUrl = presignResp.accessUrl ?: presignResp.cdnUrl ?: "",
                fileName = presignResp.fileName ?: fileName,
            )
        }

        val presignedUrl = presignResp.presignedUrl ?: throw AppError.MissingPresignedUrl
        val objectKey = presignResp.objectKey ?: throw AppError.MissingObjectKey

        uploadStreamToOSS(presignedUrl, uri, fileSize, contentType, onProgress)

        val confirmReq = ConfirmUploadRequest(
            objectKey = objectKey,
            fileName = fileName,
            fileSize = fileSize,
            contentType = contentType,
            fileHash = hashHex,
            module = scope.module,
            contextType = scope.contextType,
            contextId = scope.contextId,
            organizationId = scope.organizationId,
            isPublic = scope.isPublic,
        )
        persistPendingConfirm(confirmReq)

        return try {
            val result = confirm(confirmReq)
            removePendingConfirm(objectKey)
            result
        } catch (e: CancellationException) {
            removePendingConfirm(objectKey)
            throw e
        } catch (e: AppError.PresignScopeMismatch) {
            removePendingConfirm(objectKey)
            throw e
        }
    }

    /**
     * 流式三步直传：从 File 上传。
     * 内部转换为 file:// Uri 委托给 [directUploadFromUri]。
     */
    public suspend fun directUploadFromFile(
        file: File,
        fileName: String,
        contentType: String,
        folder: String = "chat/attachments",
        scope: UploadScope,
        onProgress: ((Float) -> Unit)? = null,
    ): UploadResult = directUploadFromUri(
        uri = Uri.fromFile(file),
        fileSize = file.length(),
        fileName = fileName,
        contentType = contentType,
        folder = folder,
        scope = scope,
        onProgress = onProgress,
    )

    public suspend fun deactivateUsage(
        fileId: String,
        module: String,
        contextType: String,
        contextId: String,
    ) {
        try {
            ossApi.deactivateUsage(
                DeactivateUsageRequest(
                    fileId = fileId,
                    module = module,
                    contextType = contextType,
                    contextId = contextId,
                )
            )
            Log.d(TAG, "deactivate 成功: fileId=$fileId")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "deactivate 失败: fileId=$fileId, error=${e.message}")
        }
    }

    /**
     * fire-and-forget 释放 upload-stage FileUsage：用于离开会话时清理被放弃的失败 / 在途 pending 附件。
     * 调用方 scope（如 viewModelScope）此刻可能已随页面销毁取消，故在 Service 自有 scope 上执行，
     * 保证 deactivate 不因调用方取消而丢失。[deactivateUsage] 已吞掉网络异常，best-effort。
     */
    public fun deactivateUsageDetached(
        fileId: String,
        module: String,
        contextType: String,
        contextId: String,
    ) {
        if (fileId.isBlank()) return
        detachedScope.launch { deactivateUsage(fileId, module, contextType, contextId) }
    }

    // ── 内部：presign / confirm ─────────────────────────────────

    private suspend fun presign(
        fileName: String,
        folder: String,
        contentType: String,
        fileSize: Long,
        fileHash: String?,
        scope: UploadScope,
    ): PresignUploadResponse = try {
        ossApi.presignUpload(
            PresignUploadRequest(
                filename = fileName,
                folder = folder,
                contentType = contentType,
                fileSize = fileSize,
                fileHash = fileHash,
                organizationId = scope.organizationId,
                module = scope.module,
                contextType = scope.contextType,
                contextId = scope.contextId,
                isPublic = scope.isPublic,
            )
        ).unwrap()
    } catch (e: AppError.RequestFailed) {
        throw AppError.ActionFailed(ActionLabel.GET_PRESIGN, e.serverMessage)
    }

    private suspend fun confirm(request: ConfirmUploadRequest): UploadResult {
        val confirmResp = try {
            ossApi.confirmUpload(request).unwrap()
        } catch (e: AppError.RequestFailed) {
            if (e.errorCode == PRESIGN_SCOPE_MISMATCH) throw AppError.PresignScopeMismatch
            throw AppError.ActionFailed(ActionLabel.CONFIRM_UPLOAD, e.serverMessage)
        }
        return UploadResult(
            fileId = confirmResp.fileId,
            accessUrl = confirmResp.accessUrl ?: confirmResp.cdnUrl ?: "",
            fileName = confirmResp.fileName ?: request.fileName,
        )
    }

    // ── 内部：PUT 上传（ByteArray）──────────────────────────────

    private suspend fun uploadBytesToOSS(
        presignedUrl: String,
        data: ByteArray,
        contentType: String,
        onProgress: ((Float) -> Unit)?,
    ) {
        val mediaType = contentType.toMediaType()
        val body = ProgressRequestBody(data, mediaType, onProgress)
        executePutWithRetry(presignedUrl, body, contentType, data.size.toLong())
    }

    // ── 内部：PUT 上传（Uri 流式）──────────────────────────────

    private suspend fun uploadStreamToOSS(
        presignedUrl: String,
        uri: Uri,
        fileSize: Long,
        contentType: String,
        onProgress: ((Float) -> Unit)?,
    ) {
        val mediaType = contentType.toMediaType()
        val body = StreamingRequestBody(appContext, uri, fileSize, mediaType, onProgress)
        executePutWithRetry(presignedUrl, body, contentType, fileSize)
    }

    // ── 内部：带重试 + 动态超时的 PUT 执行 ──────────────────────

    private suspend fun executePutWithRetry(
        presignedUrl: String,
        body: RequestBody,
        contentType: String,
        fileSize: Long,
    ) {
        val timeoutSec = maxOf(
            MIN_WRITE_TIMEOUT_SEC,
            fileSize / BYTES_PER_SECOND_MIN_BANDWIDTH + 30,
        )

        val plainClient = okHttpClient.newBuilder()
            .apply {
                interceptors().clear()
                authenticator(Authenticator.NONE)
                writeTimeout(timeoutSec, TimeUnit.SECONDS)
                readTimeout(timeoutSec, TimeUnit.SECONDS)
            }
            .build()

        val request = Request.Builder()
            .url(presignedUrl)
            .put(body)
            .header("Content-Type", contentType)
            .build()

        var lastException: Exception? = null
        for (attempt in 0 until MAX_PUT_RETRIES) {
            try {
                withContext(Dispatchers.IO) {
                    plainClient.newCall(request).execute().use { resp ->
                        if (resp.isSuccessful) return@withContext

                        val code = resp.code
                        val errorBody = resp.body.string()
                        Log.e(TAG, "PUT to OSS failed (attempt ${attempt + 1}): $code - $errorBody")

                        if (code in 400..499) {
                            throw AppError.OssPutFailed(code)
                        }
                        throw IOException("OSS PUT failed: HTTP $code")
                    }
                }
                return
            } catch (e: AppError.OssPutFailed) {
                throw e
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastException = e
                Log.w(TAG, "PUT attempt ${attempt + 1}/$MAX_PUT_RETRIES failed: ${e.message}")
                if (attempt < MAX_PUT_RETRIES - 1) {
                    val backoffMs = minOf(1000L * (1L shl attempt), 8000L)
                    delay(backoffMs)
                }
            }
        }
        throw lastException ?: AppError.OssPutFailed(0)
    }

    // ── 内部：SHA-256 采样 Hash（与 Electron computeFileHash 一致） ──

    /**
     * 对内存中的 ByteArray 计算 SHA-256 采样 hash。
     * <= 8MB: 全量; > 8MB: 首 2MB + 尾 2MB + 文件大小 UTF-8 字符串。
     *
     * **W3 Review 2 H3 / Review 3 H2 修复（2026-05-13）**：visibility 从 `private`
     * 改为 `internal` 让 L4 测试 `OSSUploadServiceTest.kt::computeFileHashCrossPlatformTest`
     * 能直接调用生产实现做对账（不只是测试自己复刻一份"自检测试"）。
     * Kotlin `internal` 仅同 module 可见，对外仍封装良好。
     */
    @Suppress("MemberVisibilityCanBePrivate")
    internal fun computeFileHash(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val size = data.size.toLong()

        if (size <= HASH_FULL_THRESHOLD) {
            digest.update(data)
        } else {
            digest.update(data, 0, HASH_CHUNK_SIZE)
            digest.update(data, data.size - HASH_CHUNK_SIZE, HASH_CHUNK_SIZE)
            digest.update(size.toString().toByteArray(Charsets.UTF_8))
        }

        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * 对 Uri 指向的文件计算 SHA-256 采样 hash（流式，不全量加载）。
     * <= 8MB: 全量; > 8MB: 首 2MB + 尾 2MB + 文件大小 UTF-8 字符串。
     */
    private fun computeFileHashFromUri(uri: Uri, fileSize: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(STREAM_BUFFER_SIZE)

        if (fileSize <= HASH_FULL_THRESHOLD) {
            appContext.contentResolver.openInputStream(uri)?.use { stream ->
                var bytesRead: Int
                while (stream.read(buffer).also { bytesRead = it } != -1) {
                    digest.update(buffer, 0, bytesRead)
                }
            } ?: throw AppError.CannotReadFile
        } else {
            appContext.contentResolver.openInputStream(uri)?.use { stream ->
                var remaining = HASH_CHUNK_SIZE
                while (remaining > 0) {
                    val toRead = minOf(buffer.size, remaining)
                    val bytesRead = stream.read(buffer, 0, toRead)
                    if (bytesRead == -1) break
                    digest.update(buffer, 0, bytesRead)
                    remaining -= bytesRead
                }
            } ?: throw AppError.CannotReadFile

            appContext.contentResolver.openInputStream(uri)?.use { stream ->
                var toSkip = fileSize - HASH_CHUNK_SIZE
                while (toSkip > 0) {
                    val skipped = stream.skip(toSkip)
                    if (skipped <= 0) {
                        if (stream.read() == -1) break
                        toSkip--
                    } else {
                        toSkip -= skipped
                    }
                }
                var remaining = HASH_CHUNK_SIZE
                while (remaining > 0) {
                    val toRead = minOf(buffer.size, remaining)
                    val bytesRead = stream.read(buffer, 0, toRead)
                    if (bytesRead == -1) break
                    digest.update(buffer, 0, bytesRead)
                    remaining -= bytesRead
                }
            } ?: throw AppError.CannotReadFile

            digest.update(fileSize.toString().toByteArray(Charsets.UTF_8))
        }

        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // ── Pending Confirm 恢复队列 ──────────────────────────────

    private fun persistPendingConfirm(request: ConfirmUploadRequest) {
        try {
            val queue = loadPendingConfirms().toMutableList()
            queue.add(PendingConfirmEntry(
                request = request,
                createdAt = System.currentTimeMillis().toString(),
            ))
            savePendingConfirms(queue)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to persist pending confirm: ${e.message}")
        }
    }

    private fun removePendingConfirm(objectKey: String) {
        try {
            val queue = loadPendingConfirms().filter { it.request.objectKey != objectKey }
            savePendingConfirms(queue)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove pending confirm: ${e.message}")
        }
    }

    private val pendingConfirmSerializer = ListSerializer(PendingConfirmEntry.serializer())

    private fun loadPendingConfirms(): List<PendingConfirmEntry> {
        val raw = pendingConfirmPrefs.getString(PENDING_CONFIRMS_KEY, null) ?: return emptyList()
        return try {
            Json.decodeFromString(pendingConfirmSerializer, raw)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decode pending confirms: ${e.message}")
            emptyList()
        }
    }

    private fun savePendingConfirms(queue: List<PendingConfirmEntry>) {
        if (queue.isEmpty()) {
            pendingConfirmPrefs.edit().remove(PENDING_CONFIRMS_KEY).apply()
            return
        }
        val raw = Json.encodeToString(pendingConfirmSerializer, queue)
        pendingConfirmPrefs.edit().putString(PENDING_CONFIRMS_KEY, raw).apply()
    }

    public suspend fun retryPendingConfirms() {
        val queue = withContext(Dispatchers.IO) { loadPendingConfirms() }
        if (queue.isEmpty()) return

        Log.i(TAG, "开始重试 ${queue.size} 个待 confirm 项")
        val remaining = mutableListOf<PendingConfirmEntry>()

        for (entry in queue) {
            if (entry.retryCount >= CONFIRM_MAX_RETRIES) {
                Log.w(TAG, "confirm 重试已达上限，放弃: objectKey=${entry.request.objectKey}")
                continue
            }
            try {
                ossApi.confirmUpload(entry.request).unwrap()
                Log.i(TAG, "confirm 重试成功: objectKey=${entry.request.objectKey}")
            } catch (e: CancellationException) {
                remaining.add(entry)
                throw e
            } catch (e: AppError.RequestFailed) {
                if (e.errorCode == PRESIGN_SCOPE_MISMATCH) {
                    Log.w(TAG, "confirm 范围不一致，丢弃待重试项: objectKey=${entry.request.objectKey}")
                } else {
                    remaining.add(entry.copy(retryCount = entry.retryCount + 1))
                    Log.w(TAG, "confirm 重试失败(${entry.retryCount + 1}/$CONFIRM_MAX_RETRIES): ${e.message}")
                }
            } catch (e: Exception) {
                remaining.add(entry.copy(retryCount = entry.retryCount + 1))
                Log.w(TAG, "confirm 重试失败(${entry.retryCount + 1}/$CONFIRM_MAX_RETRIES): ${e.message}")
            }
        }

        withContext(Dispatchers.IO) { savePendingConfirms(remaining) }
    }
}

private class ProgressRequestBody(
    private val data: ByteArray,
    private val mediaType: MediaType,
    private val onProgress: ((Float) -> Unit)?,
) : RequestBody() {

    override fun contentType(): MediaType = mediaType
    override fun contentLength(): Long = data.size.toLong()

    override fun writeTo(sink: BufferedSink) {
        val total = data.size.toLong()
        var written = 0L
        val chunkSize = 8 * 1024

        var offset = 0
        while (offset < data.size) {
            val end = minOf(offset + chunkSize, data.size)
            sink.write(data, offset, end - offset)
            written += (end - offset)
            onProgress?.invoke(written.toFloat() / total.toFloat())
            offset = end
        }
    }
}

/**
 * 流式 RequestBody：从 Uri 逐块读取写入 OkHttp，不将整个文件加载到内存。
 * 每次 writeTo 重新打开 InputStream，支持 OkHttp 重试。
 */
private class StreamingRequestBody(
    private val context: Context,
    private val uri: Uri,
    private val fileSize: Long,
    private val mediaType: MediaType,
    private val onProgress: ((Float) -> Unit)?,
) : RequestBody() {

    override fun contentType(): MediaType = mediaType
    override fun contentLength(): Long = fileSize

    override fun writeTo(sink: BufferedSink) {
        val buffer = ByteArray(8 * 1024)
        var written = 0L
        val stream: InputStream = context.contentResolver.openInputStream(uri)
            ?: throw IOException("Cannot open InputStream for URI: $uri")
        stream.use {
            var bytesRead: Int
            while (it.read(buffer).also { n -> bytesRead = n } != -1) {
                sink.write(buffer, 0, bytesRead)
                written += bytesRead
                if (fileSize > 0) {
                    onProgress?.invoke(written.toFloat() / fileSize.toFloat())
                }
            }
        }
    }
}

@Serializable
private data class PendingConfirmEntry(
    val request: ConfirmUploadRequest,
    @SerialName("retry_count") val retryCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
)
