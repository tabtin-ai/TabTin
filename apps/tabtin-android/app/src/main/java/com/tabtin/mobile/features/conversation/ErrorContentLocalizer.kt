package com.tabtin.mobile.features.conversation

import android.content.Context
import com.tabtin.mobile.R

/**
 * 将后端返回的 `[error_code] fallback text` 格式消息映射为本地化文案。
 *
 * SYNC: Backend _classify_agent_error() in chat_service.py
 * SYNC: Frontend ERROR_CODE_MAP in MessageBubble.tsx
 */
internal object ErrorContentLocalizer {

    private val ERROR_PATTERN = Regex("""^\[(\w+)\]\s*(.*)$""", RegexOption.DOT_MATCHES_ALL)

    private val ERROR_CODE_MAP: Map<String, Int> = mapOf(
        "device_offline" to R.string.chat_error_device_offline,
        "device_busy" to R.string.chat_error_device_busy,
        "cancelled" to R.string.chat_error_cancelled,
        "context_overflow" to R.string.chat_error_context_overflow,
        "llm_timeout" to R.string.chat_error_llm_timeout,
        "tool_timeout" to R.string.chat_error_tool_timeout,
        "tool_exec" to R.string.chat_error_tool_exec,
        "llm_call" to R.string.chat_error_llm_call,
        "unknown" to R.string.chat_error_unknown,
        "review_required" to R.string.chat_error_review_required,
        "safety_terminated" to R.string.chat_error_safety_terminated,
        "empty_reply" to R.string.chat_error_empty_reply,
        "ask_user" to R.string.chat_error_ask_user,
        "queued" to R.string.chat_error_queued,
        "insufficient_credits" to R.string.chat_billing_insufficient_credits,
        "organization_insufficient_credits" to R.string.chat_billing_organization_insufficient_credits,
        "budget_exceeded" to R.string.chat_billing_budget_exceeded,
        "rate_limited" to R.string.chat_billing_rate_limited,
        "conversation_quota_exceeded" to R.string.chat_billing_conversation_quota_exceeded,
    )

    fun localize(content: String, context: Context): String {
        val trimmed = content.trim()
        if (trimmed.equals("device_offline", ignoreCase = true)) {
            return context.getString(R.string.chat_error_device_offline)
        }
        val match = ERROR_PATTERN.find(trimmed) ?: return trimmed
        val code = match.groupValues[1]
        val fallback = match.groupValues[2].trim()
        val resId = ERROR_CODE_MAP[code] ?: return fallback.ifEmpty { trimmed }
        val localized = context.getString(resId)
        return localized.ifEmpty { fallback.ifEmpty { trimmed } }
    }
}
