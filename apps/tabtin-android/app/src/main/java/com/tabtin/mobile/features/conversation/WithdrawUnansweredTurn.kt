package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * /#9597 未答轮次撤回：判定与 cancel 载荷准备。
 *
 * 用户可见入口只有 Composer Stop（cancelStream）——与 Electron/iOS 一致，
 * 不暴露独立的「撤回」动作：无实质输出时 Stop 顺带抽掉整轮，有输出时只停不撤。
 *
 * 语义对齐 iOS `ConversationProjector.hasSubstantiveAssistantOutput` /
 * `withdrawUnansweredTurn`，以及 Composer Stop 发出的 `chat.cancel` payload
 *（`withdraw_unanswered` / `client_message_id` / `target_content`）。
 * Django `apps/services/common/ws/handlers/chat_cancel.py` 已识别这些字段；
 * 不做额外 HTTP rewind，也不发明新协议。
 *
 * ：`withdraw_applied`（chat.cancel.ok / agent.stream.done 可选字段）门控终态对账——
 * 服务端已物理删除时不得用权威历史把该轮拉回；复判拒绝则正常 reconcile。
 */
internal data class WithdrawCancelRequest(
    val clientMessageId: String,
    val targetContent: String,
)

/**
 * Stop 时是否顺带撤回该轮：仅最新一条普通用户消息，且其后尚无实质助手输出。
 * 避免误撤更早轮次时连后面已答内容一并抽掉。
 */
internal fun evaluateCanWithdrawUnansweredTurn(
    messages: List<ChatMessage>,
    userMessageId: String,
): Boolean {
    val target = messages.firstOrNull { message ->
        message.isUser && (message.id == userMessageId || userMessageId in message.identityKeys)
    } ?: return false
    if (target.isPushNotification || target.isCompactionSummary || target.isInternalContext) {
        return false
    }
    val lastRegularUser = messages.lastOrNull { message ->
        message.isUser &&
            !message.isPushNotification &&
            !message.isCompactionSummary &&
            !message.isInternalContext
    } ?: return false
    val sameTurn = lastRegularUser.id == target.id ||
        target.id in lastRegularUser.identityKeys ||
        lastRegularUser.id in target.identityKeys
    if (!sameTurn) return false
    return !messages.hasSubstantiveAssistantOutput(afterUserMessageId = userMessageId)
}

internal fun List<ChatMessage>.hasSubstantiveAssistantOutput(afterUserMessageId: String): Boolean {
    val userIndex = indexOfLast { message ->
        message.isUser && (
            message.id == afterUserMessageId || afterUserMessageId in message.identityKeys
            )
    }
    if (userIndex < 0) return false
    return drop(userIndex + 1).any { message ->
        message.isAssistant && message.hasSubstantiveAssistantOutput()
    }
}

internal fun ChatMessage.hasSubstantiveAssistantOutput(): Boolean {
    if (!isAssistant) return false
    val blocks = blocksJson.orEmpty()
    if (blocks.any { it.isSubstantiveAssistantBlock() }) return true
    val contentText = content.trim()
    if (contentText.isNotEmpty() && !isTextSummaryPlaceholder(contentText)) return true
    if (agentSteps.orEmpty().any { it.type == StepType.TOOL_CALL }) return true
    return false
}

internal fun resolveWithdrawCancelRequest(message: ChatMessage): WithdrawCancelRequest {
    val clientMessageId = message.canonicalClientEventId?.takeIf { it.isNotBlank() } ?: message.id
    return WithdrawCancelRequest(
        clientMessageId = clientMessageId,
        targetContent = message.displayContent,
    )
}

private fun BlockItem.isSubstantiveAssistantBlock(): Boolean {
    return when (val type = type) {
        null -> false
        "thinking" -> false
        "text" -> {
            val body = (this.text ?: content).orEmpty().trim()
            body.isNotEmpty()
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

/**
 * ：从 `chat.cancel.ok` / `agent.stream.done` payload 读可选 `withdraw_applied`。
 * - true / false：服务端明确结果
 * - null：字段缺失（旧后端）→ 未确认，维持现状对账行为
 */
internal fun parseWithdrawApplied(payload: JsonObject): Boolean? =
    (payload["withdraw_applied"] as? JsonPrimitive)?.booleanOrNull

/** ：仅 `withdraw_applied == true` 时豁免终态对账（防已撤轮次回灌）。 */
internal fun shouldExemptWithdrawnTurnReconcile(withdrawApplied: Boolean?): Boolean =
    withdrawApplied == true

/**
 * ：终态对账用的历史视图。
 * 已确认服务端物理删除时，从权威页中去掉该 user 及其后内容，避免 `replaceWithHistory` 回拉。
 * [exemptWithdrawnClientMessageId] 为 null 时原样返回（含 false / 字段缺失）。
 */
internal fun historyForWithdrawReconcile(
    history: List<ChatMessage>,
    exemptWithdrawnClientMessageId: String?,
): List<ChatMessage> {
    val withdrawnId = exemptWithdrawnClientMessageId?.takeIf { it.isNotBlank() } ?: return history
    return history.excludingWithdrawnTurn(withdrawnId)
}

/**
 * 去掉目标 user 消息及其后的全部时间线（与本地 `withdrawUnansweredTurn` 抽除语义对齐）。
 * 历史里已不存在该 id 时原样返回。
 */
internal fun List<ChatMessage>.excludingWithdrawnTurn(withdrawnClientMessageId: String): List<ChatMessage> {
    val userIndex = indexOfFirst { message ->
        message.isUser && (
            message.id == withdrawnClientMessageId ||
                withdrawnClientMessageId in message.identityKeys ||
                message.canonicalClientEventId == withdrawnClientMessageId
            )
    }
    if (userIndex < 0) return this
    return take(userIndex)
}
