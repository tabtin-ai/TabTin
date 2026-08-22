package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepType
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 *  / Electron ：助手消息「已中断」判定与空壳隐藏。
 *
 * 用户主动 Stop 是中性事件——有实质内容时挂灰色「已中断」徽标；无实质内容时整行隐藏。
 * SYNC: apps/tabtin-electron/.../assistantInterrupt.ts
 * SYNC: apps/tabtin-electron/.../emptyInterruptedAssistant.ts
 * SYNC: apps/tabtin-ios/.../AssistantErrorCard.swift isNeutralInterruption / isRuntimeAbortDiagnostic
 */
internal fun isAssistantInterruptedMessage(message: ChatMessage): Boolean {
    if (!message.isAssistant) return false
    if (message.stopReason.equals("aborted", ignoreCase = true)) return true
    if (message.errorClass.equals("ABORT", ignoreCase = true)) return true
    if (message.errorCategory.equals("aborted", ignoreCase = true)) return true
    if (message.errorCode.equals("aborted", ignoreCase = true) ||
        message.errorCode.equals("cancelled", ignoreCase = true)
    ) {
        return true
    }
    val meta = message.metadata ?: return false
    return metaPrimitiveEquals(meta, "errorClass", "ABORT") ||
        metaPrimitiveEquals(meta, "error_class", "ABORT") ||
        metaBoolTrue(meta, "aborted")
}

/**
 * 中性中断：应挂灰色「已中断」徽标，而不是 Warning 错误卡。
 */
internal fun isNeutralInterruption(message: ChatMessage): Boolean =
    isAssistantInterruptedMessage(message)

internal fun isRuntimeAbortDiagnostic(text: String?): Boolean {
    val value = text?.trim()?.lowercase().orEmpty()
    if (value.isEmpty()) return false
    return value == "run aborted by user." ||
        value == "run aborted by user" ||
        value == "conversation aborted" ||
        value == "aborted" ||
        value == "cancelled" ||
        value == "canceled" ||
        value == "对话已中止"
}

/**
 * 助手是否已有实质输出（可见正文 / tool / 富内容）。
 * runtime 英文兜底诊断文案不算实质内容。
 */
internal fun assistantMessageHasSubstance(message: ChatMessage): Boolean {
    if (!message.isAssistant) return false
    if (message.agentSteps.orEmpty().any { it.type == StepType.TOOL_CALL }) return true
    val blocks = message.blocksJson.orEmpty()
    if (blocks.any { it.isInterruptSubstantialBlock() }) return true
    val contentText = message.content.trim()
    if (contentText.isNotEmpty() &&
        !isRuntimeAbortDiagnostic(contentText) &&
        !isTextSummaryPlaceholder(contentText)
    ) {
        return true
    }
    val display = message.displayContent.trim()
    return display.isNotEmpty() &&
        !isRuntimeAbortDiagnostic(display) &&
        !isTextSummaryPlaceholder(display)
}

/**
 * 空的已中断 assistant 壳：不占时间线。
 * 承载非 ABORT 终态错误卡的空壳不可隐藏（否则账单/LLM 失败会空白）。
 */
internal fun isEmptyInterruptedAssistantShell(message: ChatMessage): Boolean {
    if (!message.isAssistant) return false
    if (assistantMessageHasSubstance(message)) return false
    if (carriesVisibleTerminalError(message)) return false
    return isAssistantInterruptedMessage(message)
}

private fun carriesVisibleTerminalError(message: ChatMessage): Boolean {
    val errorClass = message.errorClass
        ?: message.metadataStringLocal("errorClass")
        ?: message.metadataStringLocal("error_class")
    if (!errorClass.isNullOrBlank() && !errorClass.equals("ABORT", ignoreCase = true)) {
        return true
    }
    return message.metadataStringLocal("isErrorMessage").equals("true", ignoreCase = true) &&
        !errorClass.equals("ABORT", ignoreCase = true)
}

private fun BlockItem.isInterruptSubstantialBlock(): Boolean {
    return when (val type = type) {
        null -> false
        "thinking" -> false
        "text" -> {
            val body = (text ?: content).orEmpty().trim()
            body.isNotEmpty() && !isRuntimeAbortDiagnostic(body)
        }
        "tool_use",
        "tool_call",
        "tool_result",
        "server_tool_use",
        "mcp_tool_use",
        "mcp_tool_result",
        "rich_content",
        "tabtin_rich_content",
        "image",
        "file",
        "attachment",
        "context_ref",
        -> true
        else -> isRichContent || type.endsWith("_tool_result")
    }
}

private fun isTextSummaryPlaceholder(content: String): Boolean =
    content.trim() in setOf("[工具调用]", "[富内容]", "[思考中]")

private fun metaPrimitiveEquals(
    metadata: Map<String, kotlinx.serialization.json.JsonElement>,
    key: String,
    expected: String,
): Boolean {
    val value = metadata[key] as? JsonPrimitive ?: return false
    return value.contentOrNull?.equals(expected, ignoreCase = true) == true
}

private fun metaBoolTrue(
    metadata: Map<String, kotlinx.serialization.json.JsonElement>,
    key: String,
): Boolean {
    val value = metadata[key] as? JsonPrimitive ?: return false
    return value.booleanOrNull == true ||
        value.contentOrNull.equals("true", ignoreCase = true)
}

private fun ChatMessage.metadataStringLocal(key: String): String? {
    val value = metadata?.get(key) as? JsonPrimitive ?: return null
    return value.contentOrNull?.takeIf { it.isNotBlank() }
}
