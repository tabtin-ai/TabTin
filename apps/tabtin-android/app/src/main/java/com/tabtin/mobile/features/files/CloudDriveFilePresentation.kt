package com.tabtin.mobile.features.files

/** 云盘普通文件的展示分类；不包含 Compose 类型，便于列表与预览共用并做 JVM 单测。 */
internal enum class CloudDriveFileCategory {
    CLOUD_DOCUMENT,
    CLOUD_TABLE,
    IMAGE,
    PDF,
    DOCUMENT,
    SPREADSHEET,
    PRESENTATION,
    TEXT,
    AUDIO,
    VIDEO,
    ARCHIVE,
    GENERIC,
}

internal object CloudDriveFilePresentation {
    fun classify(
        itemType: String?,
        fileName: String?,
        mimeType: String?,
    ): CloudDriveFileCategory {
        when (itemType?.trim()?.lowercase()) {
            "tabdoc", "doc", "document" -> return CloudDriveFileCategory.CLOUD_DOCUMENT
            "tabdata", "table" -> return CloudDriveFileCategory.CLOUD_TABLE
        }

        classifyMime(mimeType)?.let { return it }
        return classifyExtension(fileName)
    }

    private fun classifyMime(rawMimeType: String?): CloudDriveFileCategory? {
        val mimeType = rawMimeType
            ?.substringBefore(';')
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.isNotEmpty() }
            ?: return null

        if (mimeType.startsWith("image/")) return CloudDriveFileCategory.IMAGE
        if (mimeType.startsWith("audio/")) return CloudDriveFileCategory.AUDIO
        if (mimeType.startsWith("video/")) return CloudDriveFileCategory.VIDEO

        return when (mimeType) {
            "application/pdf" -> CloudDriveFileCategory.PDF
            "application/msword",
            "application/rtf",
            "application/vnd.apple.pages",
            "application/vnd.oasis.opendocument.text",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            -> CloudDriveFileCategory.DOCUMENT
            "text/csv",
            "application/csv",
            "application/vnd.ms-excel",
            "application/vnd.apple.numbers",
            "application/vnd.oasis.opendocument.spreadsheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            -> CloudDriveFileCategory.SPREADSHEET
            "application/vnd.ms-powerpoint",
            "application/vnd.apple.keynote",
            "application/vnd.oasis.opendocument.presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            -> CloudDriveFileCategory.PRESENTATION
            "application/zip",
            "application/x-zip-compressed",
            "application/gzip",
            "application/x-gzip",
            "application/x-rar-compressed",
            "application/vnd.rar",
            "application/x-7z-compressed",
            "application/x-tar",
            "application/x-bzip",
            "application/x-bzip2",
            "application/x-compressed-tar",
            "application/x-xz",
            -> CloudDriveFileCategory.ARCHIVE
            "application/json",
            "application/ld+json",
            "application/xml",
            "application/javascript",
            "application/x-javascript",
            "application/x-httpd-php",
            "application/x-sh",
            "application/x-yaml",
            "application/sql",
            -> CloudDriveFileCategory.TEXT
            else -> if (mimeType.startsWith("text/")) CloudDriveFileCategory.TEXT else null
        }
    }

    private fun classifyExtension(fileName: String?): CloudDriveFileCategory {
        val extension = fileName
            ?.substringAfterLast('.', missingDelimiterValue = "")
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.isNotEmpty() }
            ?: return CloudDriveFileCategory.GENERIC

        return when (extension) {
            "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "avif" ->
                CloudDriveFileCategory.IMAGE
            "pdf" -> CloudDriveFileCategory.PDF
            "doc", "docx", "pages", "rtf", "odt" -> CloudDriveFileCategory.DOCUMENT
            "xls", "xlsx", "csv", "tsv", "ods", "numbers" -> CloudDriveFileCategory.SPREADSHEET
            "ppt", "pptx", "key", "odp" -> CloudDriveFileCategory.PRESENTATION
            "txt", "md", "markdown", "json", "jsonl", "code", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
            "log", "html", "htm", "css", "scss", "js", "jsx", "ts", "tsx", "kt", "kts", "java", "py",
            "rb", "go", "rs", "swift", "c", "cc", "h", "cpp", "hpp", "sh", "bash", "zsh", "sql",
            -> CloudDriveFileCategory.TEXT
            "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus" -> CloudDriveFileCategory.AUDIO
            "mp4", "m4v", "mov", "webm", "avi", "mkv", "mpeg", "mpg" -> CloudDriveFileCategory.VIDEO
            "zip", "rar", "7z", "tar", "gz", "tgz", "bz", "bz2", "xz" -> CloudDriveFileCategory.ARCHIVE
            else -> CloudDriveFileCategory.GENERIC
        }
    }
}

/**
 * 列表 preview 可能是下载地址。轻预览只展示已有文本摘要，不把 URL 当正文，也不触发资源请求。
 */
internal fun cloudDriveSafePreviewText(rawPreview: String?): String? {
    val preview = rawPreview?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val lower = preview.lowercase()
    return preview.takeUnless {
        lower.startsWith("http://") ||
            lower.startsWith("https://") ||
            lower.startsWith("//") ||
            lower.startsWith("data:") ||
            lower.startsWith("blob:")
    }
}

internal data class CloudDriveTablePreviewContent(
    val fieldNames: List<String>,
    val previewText: String?,
)

internal fun cloudDriveTablePreviewContent(
    fieldNames: List<String> = emptyList(),
    preview: String?,
): CloudDriveTablePreviewContent {
    val visibleFields = fieldNames.mapNotNull { it.trim().takeIf(String::isNotEmpty) }.take(3)
    val visiblePreview = cloudDriveSafePreviewText(preview)
    if (visibleFields.isNotEmpty() || visiblePreview?.contains('|') != true) {
        return CloudDriveTablePreviewContent(visibleFields, visiblePreview)
    }
    val inferredFields = visiblePreview.split('|')
        .mapNotNull { part ->
            part.replace(Regex("\\s*/?\\.{3}\\s*$"), "").trim().takeIf(String::isNotEmpty)
        }
        .take(3)
    return if (inferredFields.size >= 2) {
        CloudDriveTablePreviewContent(inferredFields, null)
    } else {
        CloudDriveTablePreviewContent(emptyList(), visiblePreview)
    }
}
