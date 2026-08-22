package com.tabtin.mobile.data.oss

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ---------------------------------------------------------------------------
// 统一上传配置（后端下发 + 本地 fallback）
// ---------------------------------------------------------------------------

public object UploadConfig {
    public const val MAX_ATTACHMENTS: Int = 10
    public const val MAX_CONCURRENT_UPLOADS: Int = 3

    // 图片压缩参数
    public const val IMAGE_MAX_DIMENSION: Int = 2048
    public const val JPEG_QUALITY: Int = 80
    public const val CAMERA_JPEG_QUALITY: Int = 95
    public val SKIP_COMPRESSION_MIMES: Set<String> = setOf("image/gif", "image/svg+xml")

    @Volatile
    public var MAX_IMAGE_SIZE: Long = 20L * 1024 * 1024
        private set

    @Volatile
    public var MAX_FILE_SIZE: Long = 50L * 1024 * 1024
        private set

    @Volatile
    public var MAX_MEDIA_SIZE: Long = 200L * 1024 * 1024
        private set

    @Volatile
    public var ACCEPTED_IMAGE_TYPES: Set<String> = setOf(
        "image/jpeg", "image/jpg", "image/png", "image/gif",
        "image/webp", "image/bmp", "image/avif", "image/svg+xml",
        "image/heic", "image/heif", "image/apng", "image/tiff",
    )
        private set

    @Volatile
    public var ACCEPTED_FILE_TYPES: Set<String> = setOf(
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain", "text/csv", "text/markdown", "text/x-markdown",
        "application/json",
    )
        private set

    @Volatile
    public var ACCEPTED_MEDIA_TYPES: Set<String> = setOf(
        "video/mp4", "video/webm", "video/quicktime",
        "audio/mpeg", "audio/wav", "audio/mp3", "audio/ogg", "audio/webm",
    )
        private set

    public val ALL_ACCEPTED_TYPES: Set<String> get() = ACCEPTED_IMAGE_TYPES + ACCEPTED_FILE_TYPES + ACCEPTED_MEDIA_TYPES

    public fun isImageType(mime: String): Boolean = ACCEPTED_IMAGE_TYPES.contains(mime)
    public fun isMediaType(mime: String): Boolean = ACCEPTED_MEDIA_TYPES.contains(mime)

    public enum class FileCategory {
        PDF, WORD, EXCEL, PPT, IMAGE, AUDIO, VIDEO, ARCHIVE, TEXT, OTHER
    }

    public fun fileCategory(mime: String?, ext: String? = null): FileCategory {
        val m = (mime ?: "").lowercase()
        val e = (ext ?: "").lowercase()

        return when {
            m == "application/pdf" || e == "pdf" -> FileCategory.PDF
            "word" in m || "wordprocessingml" in m || e == "doc" || e == "docx" -> FileCategory.WORD
            "sheet" in m || "excel" in m || "spreadsheetml" in m || e == "xls" || e == "xlsx" || e == "csv" -> FileCategory.EXCEL
            "presentation" in m || "powerpoint" in m || "presentationml" in m || e == "ppt" || e == "pptx" -> FileCategory.PPT
            m.startsWith("image/") -> FileCategory.IMAGE
            m.startsWith("audio/") || e in setOf("mp3", "m4a", "wav", "ogg", "flac", "aac", "caf", "opus", "weba") -> FileCategory.AUDIO
            m.startsWith("video/") || e in setOf("mp4", "mov", "m4v", "avi", "mkv", "webm") -> FileCategory.VIDEO
            m.startsWith("text/") || m == "application/json" || e == "md" || e == "json" -> FileCategory.TEXT
            e in setOf("zip", "rar", "7z", "tar", "gz") || "zip" in m -> FileCategory.ARCHIVE
            else -> FileCategory.OTHER
        }
    }

    public fun maxSizeFor(mime: String): Long = when {
        isImageType(mime) -> MAX_IMAGE_SIZE
        isMediaType(mime) -> MAX_MEDIA_SIZE
        else -> MAX_FILE_SIZE
    }

    public fun formatFileSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${"%.1f".format(bytes / 1024.0)} KB"
        bytes < 1024 * 1024 * 1024 -> "${"%.1f".format(bytes / (1024.0 * 1024.0))} MB"
        else -> "${"%.1f".format(bytes / (1024.0 * 1024.0 * 1024.0))} GB"
    }

    @Volatile
    private var fetched = false
    private val configLock = Any()

    public fun applyRemoteConfig(presets: Map<String, UploadPresetDTO>) {
        if (fetched) return
        synchronized(configLock) {
            if (fetched) return
            presets["IMAGE"]?.let { p ->
                MAX_IMAGE_SIZE = p.maxSize.toLong()
                p.accept?.let { ACCEPTED_IMAGE_TYPES = it.toSet() }
            }
            presets["FILE"]?.let { p -> MAX_FILE_SIZE = p.maxSize.toLong() }
            presets["DOCUMENT"]?.let { p ->
                p.accept?.let { ACCEPTED_FILE_TYPES = it.toSet() }
            }
            presets["MEDIA"]?.let { p ->
                MAX_MEDIA_SIZE = p.maxSize.toLong()
                p.accept?.let { ACCEPTED_MEDIA_TYPES = it.toSet() }
            }
            fetched = true
        }
    }
}

// ---------------------------------------------------------------------------
// Upload Config API DTOs
// ---------------------------------------------------------------------------

@Serializable
public data class UploadPresetDTO(
    val maxSize: Int,
    val accept: List<String>? = null,
)

@Serializable
public data class UploadConfigData(
    val presets: Map<String, UploadPresetDTO>,
    @SerialName("allowed_extensions")
    val allowedExtensions: List<String>? = null,
    @SerialName("max_file_size")
    val maxFileSize: Long? = null,
)
