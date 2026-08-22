package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget

/** Composer 附件策略：胶囊语音走 [NONE]，不读不清草稿附件引用。 */
public enum class AttachmentPolicy {
    INCLUDE_COMPOSER,
    NONE,
}

/**
 * 统一发送请求。胶囊 PTT 只带 transcript + 冻结 Focus。
 */
public data class ConversationSendRequest(
    val content: String,
    val blocks: List<MessageBlock>? = null,
    val attachmentPolicy: AttachmentPolicy = AttachmentPolicy.INCLUDE_COMPOSER,
    val focus: ConversationFocusContext? = null,
)

/**
 * Composer / 普通 send 入队前解析 Focus：请求已带则沿用（胶囊路径），
 * 否则按当前 Workbench 投影，与胶囊共用 [TaskFocusSnapshot.from]。
 */
public object ComposerFocusFreeze {
    public fun resolveForEnqueue(
        requestFocus: ConversationFocusContext?,
        spaceId: String?,
        target: WorkbenchFocusTarget?,
        workspaceMode: String? = null,
    ): ConversationFocusContext =
        requestFocus ?: TaskFocusSnapshot.from(
            spaceId = spaceId,
            target = target,
            workspaceMode = workspaceMode,
        )
}
