package com.tabtin.mobile.data.model

import java.util.UUID

/**
 * 已有会话的模型选择只认服务端 Session 快照；组织目录只负责提供可发送的候选项。
 *
 * `current_model_id` 是当前会话下一轮的明确选择，`default_model_id` 是服务端为该
 * 会话冻结的回退。两者都不存在或已不在可发送目录中时，才使用组织默认模型。
 */
internal fun resolveConversationChatModel(
    session: ChatSession?,
    availableModels: List<LlmModel>,
    catalogDefaultModelId: String?,
): LlmModel? {
    val sendableModels = availableModels.filter(LlmModel::isSendableChatModel)
    val preferredIds = listOf(
        session?.currentModelId,
        session?.defaultModelId,
        catalogDefaultModelId,
    )
    return preferredIds
        .asSequence()
        .mapNotNull { preferredId ->
            preferredId?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { id -> sendableModels.firstOrNull { it.id == id } }
        }
        .firstOrNull()
        ?: sendableModels.firstOrNull()
}

internal fun LlmModel.isSendableChatModel(): Boolean = try {
    UUID.fromString(id.trim())
    true
} catch (_: IllegalArgumentException) {
    false
}
