package com.tabtin.mobile.features.tabchat

import androidx.compose.ui.graphics.Color

/**
 * IM 私信附件文件卡视觉（紧凑横版）：与 Electron [FILE_TYPE_STYLES] 扩展名分色对齐，
 * 移动端改为横版矩形（宽约 252、高约 64），白字 + 右上扩展名徽标 + 右下操作钮。
 */
internal data class ImFileCardStyle(
    val background: Color,
    val badge: String,
)

internal object ImFileCardStyles {
    val CardMaxWidthDp = 252
    val CardMinHeightDp = 64
    val CardCornerRadiusDp = 14
    val ActionSizeDp = 28

    private val Pdf = Color(0xFFEF4444)
    private val Doc = Color(0xFF3B82F6)
    private val Xls = Color(0xFF059669)
    private val Ppt = Color(0xFFF97316)
    private val Md = Color(0xFF475569)
    private val Json = Color(0xFFF59E0B)
    private val Txt = Color(0xFF6B7280)
    private val Unknown = Color(0xFF9CA3AF)
    val Unavailable = Color(0xFF6B7280)

    private val ByExt: Map<String, Pair<Color, String>> = mapOf(
        "doc" to (Doc to "DOC"),
        "docx" to (Doc to "DOCX"),
        "xls" to (Xls to "XLS"),
        "xlsx" to (Xls to "XLSX"),
        "ppt" to (Ppt to "PPT"),
        "pptx" to (Ppt to "PPTX"),
        "pdf" to (Pdf to "PDF"),
        "md" to (Md to "MD"),
        "markdown" to (Md to "MD"),
        "json" to (Json to "JSON"),
        "txt" to (Txt to "TXT"),
    )

    fun styleFor(fileName: String, unavailable: Boolean = false): ImFileCardStyle {
        if (unavailable) {
            val ext = extensionOf(fileName)
            val badge = ByExt[ext]?.second ?: ext.ifEmpty { "FILE" }.uppercase()
            return ImFileCardStyle(background = Unavailable, badge = badge.take(6))
        }
        val ext = extensionOf(fileName)
        val mapped = ByExt[ext]
        return if (mapped != null) {
            ImFileCardStyle(background = mapped.first, badge = mapped.second)
        } else {
            ImFileCardStyle(
                background = Unknown,
                badge = ext.ifEmpty { "?" }.uppercase().take(6),
            )
        }
    }

    fun extensionOf(fileName: String): String {
        val trimmed = fileName.trim()
        val dot = trimmed.lastIndexOf('.')
        if (dot <= 0 || dot >= trimmed.lastIndex) return ""
        return trimmed.substring(dot + 1).lowercase()
    }
}
