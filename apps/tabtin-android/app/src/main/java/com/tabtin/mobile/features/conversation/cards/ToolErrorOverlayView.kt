package com.tabtin.mobile.features.conversation.cards

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import org.json.JSONObject

/**
 * **W2 L10**：13 类 file pipeline error_kind → strings_chat.xml `chat_tool_error_*`
 * 中文短文案查表。与 `@tabtin/file-pipeline-errors` SSoT + iOS
 * `ChatToolErrorClassMap.text(for:)` + Electron `chat.json#toolError` 三端同源。
 *
 * 命中返 string resource id；未命中返 null（让 caller 降级到 KeyValuePairs
 * raw 渲染 / LLM 自然语言转述兜底）。
 */
private val FILE_PIPELINE_ERROR_KIND_TO_STRING_RES: Map<String, Int> = mapOf(
    "file_not_found" to R.string.chat_tool_error_file_not_found,
    "file_too_large" to R.string.chat_tool_error_file_too_large,
    "encrypted" to R.string.chat_tool_error_encrypted,
    "corrupted" to R.string.chat_tool_error_corrupted,
    "scanned_pdf" to R.string.chat_tool_error_scanned_pdf,
    "garbled_text_layer" to R.string.chat_tool_error_garbled_text_layer,
    "unsupported_format" to R.string.chat_tool_error_unsupported_format,
    "parse_timeout" to R.string.chat_tool_error_parse_timeout,
    // W2 L10 补 5 类共享 kind（与 13 类完整对齐）
    "permission_denied" to R.string.chat_tool_error_permission_denied,
    "network_failed" to R.string.chat_tool_error_network_failed,
    "invalid_param_format" to R.string.chat_tool_error_invalid_param_format,
    "aborted" to R.string.chat_tool_error_aborted,
    "upstream_error" to R.string.chat_tool_error_upstream_error,
)

/**
 * 把 envelope JSON / 半结构化字符串里的 `error_kind` 抽出来。
 *
 * 支持两种 envelope shape：
 *   - 顶层：`{"error": "...", "error_kind": "scanned_pdf", ...}`
 *   - 嵌套：`{"metadata": {"error_kind": "scanned_pdf"}, ...}`
 *
 * 抽不出来时返 null，caller 走 raw 兜底。
 */
internal fun parseErrorKindFromEnvelope(raw: String?): String? {
    val trimmed = raw?.trim() ?: return null
    if (!trimmed.startsWith("{")) return null
    val obj = try { JSONObject(trimmed) } catch (_: Exception) { return null }
    obj.optString("error_kind", "").takeIf { it.isNotEmpty() }?.let { return it }
    val nested = obj.optJSONObject("metadata") ?: return null
    return nested.optString("error_kind", "").takeIf { it.isNotEmpty() }
}

/**
 * 渲染 file pipeline 错误 overlay。
 *
 * @return true = 命中 i18n 表已渲染；false = 没命中（caller 走原 KeyValuePairs
 *         raw 渲染兜底）
 */
@Composable
internal fun ToolErrorOverlayView(step: AgentStep): Boolean {
    val kind = parseErrorKindFromEnvelope(step.output) ?: return false
    val stringRes = FILE_PIPELINE_ERROR_KIND_TO_STRING_RES[kind] ?: return false
    RenderOverlay(stringRes)
    return true
}

@Composable
private fun RenderOverlay(@StringRes textRes: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.08f))
            .padding(TTSpacing.sm),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Icon(
            imageVector = Icons.Outlined.ErrorOutline,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
        )
        Text(
            text = stringResource(textRes),
            style = TTFonts.captionSemibold,
            color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
        )
    }
}
