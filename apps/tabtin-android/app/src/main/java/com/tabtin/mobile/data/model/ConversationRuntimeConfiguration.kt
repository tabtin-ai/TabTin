package com.tabtin.mobile.data.model

/**
 * 一条对话消息可选择的工作方式。
 *
 * 工作方式和审批强度是两个正交的维度。历史的 `yolo`、`study` 都不是当前
 * 发送契约中的工作方式，读取时统一回落为安全的执行模式。
 */
public enum class ConversationAgentMode(public val wireValue: String) {
    ASK("ask"),
    AGENT("agent"),
    PLAN("plan"),
    GROUP("group"),
    ;

    internal companion object {
        fun resolve(rawValue: String?): ConversationAgentMode =
            entries.firstOrNull { it.wireValue == rawValue.normalized() } ?: AGENT

        fun isLegacyYolo(rawValue: String?): Boolean = rawValue.normalized() == "yolo"
    }
}

/** 受控工具操作需要的人类确认强度。 */
public enum class ConversationApprovalMode(public val wireValue: String) {
    ALWAYS_ASK("always_ask"),
    AUTO("auto"),
    FULL_ACCESS("full_access"),
    ;

    internal companion object {
        fun resolve(rawValue: String?): ConversationApprovalMode? =
            entries.firstOrNull { it.wireValue == rawValue.normalized() }
    }

    internal fun clamped(permitsRelaxedApproval: Boolean): ConversationApprovalMode =
        if (permitsRelaxedApproval) this else ALWAYS_ASK
}

/**
 * 发送和本地队列使用的运行配置快照。
 *
 * `normalizedForStorage()` 只处理旧值兼容，保留用户原有偏好；`resolving()`
 * 在实际发送前再依照当前组织权限执行安全夹紧。
 */
public data class ConversationRuntimeConfiguration(
    public val agentMode: ConversationAgentMode = ConversationAgentMode.AGENT,
    public val approvalMode: ConversationApprovalMode = ConversationApprovalMode.ALWAYS_ASK,
) {
    public companion object {
        public fun resolving(
            rawAgentMode: String?,
            rawApprovalMode: String?,
            permitsRelaxedApproval: Boolean,
        ): ConversationRuntimeConfiguration {
            val normalized = normalizedForStorage(
                rawAgentMode = rawAgentMode,
                rawApprovalMode = rawApprovalMode,
            )
            return normalized.copy(
                approvalMode = normalized.approvalMode.clamped(permitsRelaxedApproval),
            )
        }

        public fun normalizedForStorage(
            rawAgentMode: String?,
            rawApprovalMode: String?,
        ): ConversationRuntimeConfiguration {
            val migratedYolo = ConversationAgentMode.isLegacyYolo(rawAgentMode)
            return ConversationRuntimeConfiguration(
                agentMode = ConversationAgentMode.resolve(rawAgentMode),
                approvalMode = ConversationApprovalMode.resolve(rawApprovalMode)
                    ?: if (migratedYolo) ConversationApprovalMode.AUTO
                    else ConversationApprovalMode.ALWAYS_ASK,
            )
        }
    }
}

private fun String?.normalized(): String? =
    this?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
