package com.tabtin.mobile.features.conversation

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.oss.UploadConfig
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.AttachmentType
import com.tabtin.mobile.data.model.ChatAttachment
import com.tabtin.mobile.data.model.MessageBlock
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class ChatAttachmentManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val ossUploadService: OSSUploadService,
) {
    public companion object {
        private const val TAG = "ChatAttachmentManager"
    }

    private val _attachments = MutableStateFlow<List<ChatAttachment>>(emptyList())
    public val attachments: StateFlow<List<ChatAttachment>> = _attachments.asStateFlow()

    private val uploadJobs = ConcurrentHashMap<String, Job>()
    private val uploadSemaphore = Semaphore(UploadConfig.MAX_CONCURRENT_UPLOADS)
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var currentSessionId: String? = null

    /** 当前 composer 的签名范围；上传任务启动时复制到协程，后续不会再读取全局组织状态。 */
    @Volatile
    private var currentUploadScope: UploadScope? = null

    public fun bindSession(sessionId: String, organizationId: String?) {
        bindSession(
            sessionId = sessionId,
            uploadScope = organizationId
                ?.takeIf { it.isNotBlank() }
                ?.let {
                    UploadScope(
                        module = "chat",
                        contextType = "message",
                        contextId = sessionId,
                        organizationId = it,
                        isPublic = false,
                    )
                },
        )
    }

    /** IM 等调用方可注入自己的不可变 usage 契约；清理时复用同一 scope。 */
    public fun bindSession(sessionId: String, uploadScope: UploadScope?) {
        val current = currentSessionId
        if (current != null && current != sessionId) {
            clear()
        }
        currentSessionId = sessionId
        currentUploadScope = uploadScope
    }

    public val hasAttachments: Boolean get() = _attachments.value.isNotEmpty()
    public val hasReadyAttachments: Boolean get() = _attachments.value.any { it.status == AttachmentStatus.READY }
    public val isUploading: Boolean get() = _attachments.value.any { it.status == AttachmentStatus.UPLOADING }
    public val allReady: Boolean get() = _attachments.value.isNotEmpty() && _attachments.value.all { it.status == AttachmentStatus.READY }
    internal val hasUploadScope: Boolean get() = currentUploadScope != null

    public sealed class AddResult {
        public data class Success(val id: String) : AddResult()
        public data class Error(val error: AppError) : AddResult()
    }

    public fun addAttachment(uri: Uri, scope: CoroutineScope): AddResult {
        val uploadScope = currentUploadScope ?: return AddResult.Error(AppError.NoOrganization)
        if (_attachments.value.size >= UploadConfig.MAX_ATTACHMENTS) {
            return AddResult.Error(AppError.AttachmentLimit(UploadConfig.MAX_ATTACHMENTS))
        }

        val info = resolveFileInfo(uri)
            ?: return AddResult.Error(AppError.CannotReadFileInfo)

        if (!UploadConfig.ALL_ACCEPTED_TYPES.contains(info.mimeType)) {
            return AddResult.Error(AppError.UnsupportedFileType(info.mimeType))
        }

        val maxSize = UploadConfig.maxSizeFor(info.mimeType)
        if (info.size > maxSize) {
            val maxMB = maxSize / 1024 / 1024
            return AddResult.Error(AppError.FileTooLarge(maxMB))
        }

        val type = if (UploadConfig.isImageType(info.mimeType)) AttachmentType.IMAGE else AttachmentType.FILE
        val attachment = ChatAttachment(
            id = UUID.randomUUID().toString(),
            uri = uri,
            filename = info.name,
            mimeType = info.mimeType,
            size = info.size,
            type = type,
        )

        _attachments.update { it + attachment }

        val job = scope.launch { uploadSingle(attachment, uploadScope) }
        uploadJobs[attachment.id] = job
        return AddResult.Success(attachment.id)
    }

    public fun removeAttachment(id: String) {
        removeAttachment(id, deactivateUploaded = true)
    }

    private fun removeAttachment(id: String, deactivateUploaded: Boolean) {
        uploadJobs.remove(id)?.cancel()
        val removed = _attachments.value.find { it.id == id }
        _attachments.update { list -> list.filter { it.id != id } }
        if (
            deactivateUploaded &&
            removed != null &&
            removed.status == AttachmentStatus.READY &&
            !removed.fileId.isNullOrEmpty()
        ) {
            val cleanupScopeSnapshot = currentUploadScope
            cleanupScope.launch {
                ossUploadService.deactivateUsage(
                    fileId = removed.fileId,
                    module = cleanupScopeSnapshot?.module ?: "chat",
                    contextType = cleanupScopeSnapshot?.contextType ?: "message",
                    contextId = cleanupScopeSnapshot?.contextId ?: currentSessionId.orEmpty(),
                )
            }
        }
    }

    /** Remove only the captured composer snapshot; newer draft items stay intact. */
    public fun removeAttachments(ids: Set<String>, deactivateUploaded: Boolean = true) {
        ids.forEach { removeAttachment(it, deactivateUploaded) }
    }

    public fun buildBlocks(): List<MessageBlock> {
        return _attachments.value
            .filter { it.status == AttachmentStatus.READY && it.fileId != null }
            .map { att ->
                MessageBlock(
                    type = if (att.type == AttachmentType.IMAGE) "image" else "file",
                    fileId = att.fileId,
                    filename = att.filename,
                    mimeType = att.mimeType,
                    size = att.size,
                    url = att.remoteUrl,
                )
            }
    }

    public fun clear() {
        uploadJobs.values.forEach { it.cancel() }
        uploadJobs.clear()
        val readyAttachments = _attachments.value.filter {
            it.status == AttachmentStatus.READY && !it.fileId.isNullOrEmpty()
        }
        val sessionId = currentSessionId
        val cleanupScopeSnapshot = currentUploadScope
        _attachments.value = emptyList()
        currentSessionId = null
        currentUploadScope = null
        cleanupCameraCache()
        if (readyAttachments.isNotEmpty()) {
            cleanupScope.launch {
                for (att in readyAttachments) {
                    ossUploadService.deactivateUsage(
                        fileId = att.fileId!!,
                        module = cleanupScopeSnapshot?.module ?: "chat",
                        contextType = cleanupScopeSnapshot?.contextType ?: "message",
                        contextId = cleanupScopeSnapshot?.contextId ?: sessionId.orEmpty(),
                    )
                }
            }
        }
    }

    private fun cleanupCameraCache() {
        cleanupScope.launch {
            try {
                File(context.cacheDir, "camera").listFiles()?.forEach { it.delete() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) { }
        }
    }

    public fun retryFailed(scope: CoroutineScope) {
        val uploadScope = currentUploadScope ?: return
        _attachments.value.filter { it.status == AttachmentStatus.ERROR }.forEach { att ->
            updateAttachment(att.id) { it.copy(status = AttachmentStatus.PENDING, error = null, progress = 0f) }
            val job = scope.launch { uploadSingle(att, uploadScope) }
            uploadJobs[att.id] = job
        }
    }

    public fun retrySingle(id: String, scope: CoroutineScope) {
        val uploadScope = currentUploadScope ?: return
        val att = _attachments.value.find { it.id == id && it.status == AttachmentStatus.ERROR } ?: return
        updateAttachment(id) { it.copy(status = AttachmentStatus.PENDING, error = null, progress = 0f) }
        val job = scope.launch { uploadSingle(att, uploadScope) }
        uploadJobs[id] = job
    }

    private suspend fun uploadSingle(attachment: ChatAttachment, uploadScope: UploadScope) {
        uploadSemaphore.acquire()
        try {
            updateAttachment(attachment.id) { it.copy(status = AttachmentStatus.UPLOADING, progress = 0f) }

            var lastProgress = 0f
            val progressCallback: (Float) -> Unit = { progress ->
                if (progress - lastProgress >= 0.01f || progress >= 1f) {
                    lastProgress = progress
                    updateAttachment(attachment.id) { it.copy(progress = progress) }
                }
            }

            val result = if (attachment.type == AttachmentType.IMAGE) {
                val (data, effectiveMime) = withContext(Dispatchers.IO) { readAndPrepareImageData(attachment) }
                if (effectiveMime != attachment.mimeType) {
                    updateAttachment(attachment.id) { it.copy(mimeType = effectiveMime) }
                }
                ossUploadService.directUpload(
                    data = data,
                    fileName = attachment.filename,
                    contentType = effectiveMime,
                    scope = uploadScope,
                    onProgress = progressCallback,
                )
            } else {
                ossUploadService.directUploadFromUri(
                    uri = attachment.uri,
                    fileSize = attachment.size,
                    fileName = attachment.filename,
                    contentType = attachment.mimeType,
                    scope = uploadScope,
                    onProgress = progressCallback,
                )
            }

            if (result.accessUrl.isBlank()) {
                Log.w(TAG, "Upload returned empty accessUrl: ${attachment.filename}")
            }
            updateAttachment(attachment.id) {
                it.copy(
                    status = AttachmentStatus.READY,
                    progress = 1f,
                    fileId = result.fileId,
                    remoteUrl = result.accessUrl.ifBlank { null },
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Upload failed: ${attachment.filename}", e)
            val errorMsg = if (e is AppError) e.message else (e.localizedMessage ?: "")
            updateAttachment(attachment.id) {
                it.copy(status = AttachmentStatus.ERROR, error = errorMsg)
            }
        } finally {
            uploadSemaphore.release()
        }
    }

    private data class PreparedData(val data: ByteArray, val mimeType: String)

    private fun readAndPrepareImageData(attachment: ChatAttachment): PreparedData {
        val raw = context.contentResolver.openInputStream(attachment.uri)?.use { it.readBytes() }
            ?: throw AppError.CannotReadFile

        if (UploadConfig.SKIP_COMPRESSION_MIMES.contains(attachment.mimeType)) {
            return PreparedData(raw, attachment.mimeType)
        }

        val compressed = compressImage(raw, attachment.mimeType)
        return if (compressed != null) {
            val outputMime = if (attachment.mimeType == "image/png") "image/png" else "image/jpeg"
            PreparedData(compressed, outputMime)
        } else {
            PreparedData(raw, attachment.mimeType)
        }
    }

    private fun compressImage(raw: ByteArray, mimeType: String): ByteArray? {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, opts)

        val w = opts.outWidth
        val h = opts.outHeight
        if (w <= 0 || h <= 0) return null

        if (w <= UploadConfig.IMAGE_MAX_DIMENSION && h <= UploadConfig.IMAGE_MAX_DIMENSION) {
            if (mimeType == "image/png") return raw
            return recompressJpeg(raw)
        }

        val scale = maxOf(w.toFloat() / UploadConfig.IMAGE_MAX_DIMENSION, h.toFloat() / UploadConfig.IMAGE_MAX_DIMENSION)
        val sampleSize = Integer.highestOneBit(scale.toInt().coerceAtLeast(1))

        val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, decodeOpts)
            ?: return null

        val targetW = (w / scale).toInt()
        val targetH = (h / scale).toInt()
        val scaled = Bitmap.createScaledBitmap(bitmap, targetW, targetH, true)

        val out = ByteArrayOutputStream()
        val format = if (mimeType == "image/png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        val quality = if (mimeType == "image/png") 100 else UploadConfig.JPEG_QUALITY
        scaled.compress(format, quality, out)

        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()

        return out.toByteArray()
    }

    private fun recompressJpeg(raw: ByteArray): ByteArray {
        val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: return raw
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, UploadConfig.JPEG_QUALITY, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun updateAttachment(id: String, update: (ChatAttachment) -> ChatAttachment) {
        _attachments.update { list ->
            list.map { if (it.id == id) update(it) else it }
        }
    }

    private data class FileInfo(val name: String, val mimeType: String, val size: Long)

    private fun resolveFileInfo(uri: Uri): FileInfo? {
        var name = "unknown"
        var size = 0L

        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: "unknown"
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
            }
        }

        if (size == 0L) {
            try {
                context.contentResolver.openFileDescriptor(uri, "r")?.use { fd ->
                    size = fd.statSize
                }
            } catch (_: Exception) { }
        }

        if (size == 0L) {
            try {
                context.contentResolver.openInputStream(uri)?.use { stream ->
                    size = stream.available().toLong()
                }
            } catch (_: Exception) { }
        }

        val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
        if (size <= 0L) return null

        return FileInfo(name, mimeType, size)
    }
}
