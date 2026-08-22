package com.tabtin.mobile.data.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalSerializationApi::class)
@Serializable
public data class ChatMessage(
    val id: String,
    val role: String,
    val content: String = "",
    @SerialName("sender_user_id") val senderUserId: String? = null,
    @SerialName("sender_display_name") val senderDisplayName: String? = null,
    // W4.5 第二波 P0-2 升级（2026-05-12，三视角 Review 暴露）：Django 自 W4c 起后端
    // schema 把字段重命名为 `content_blocks_json`（对齐 ChatMessage Model 真字段名），
    // 但 Android 仍只解码 `blocks_json` ——拉历史 API 时 `blocksJson` 一直是 null，
    // 富内容卡片在 `richContentBlocks` filter 处只能拿到空列表，**isRichContent 修
    // 双字面量识别也救不了**。@JsonNames 同时接受新旧字段名（kotlinx.serialization
    // 1.6+ 实验 API，老 cache / 旧后端兼容）。
    @SerialName("content_blocks_json")
    @JsonNames("content_blocks_json", "blocks_json")
    val blocksJson: List<BlockItem>? = null,
    @SerialName("agent_type") val agentType: String? = null,
    /** `agent_id` 是每条 assistant 回复实际执行者的历史事实，不从会话当前 Agent 推断。 */
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("agent_run_id") val agentRunId: String? = null,
    @SerialName("subagent_run_id") val subagentRunId: String? = null,
    @SerialName("message_kind") val messageKind: String? = null,
    @SerialName("has_artifacts") val hasArtifacts: Boolean = false,
    @SerialName("checkpoint_record") val checkpointRecord: CheckpointRecord? = null,
    @SerialName("error_category") val errorCategory: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
    @SerialName("error_class") val errorClass: String? = null,
    @SerialName("suggested_action") val suggestedAction: String? = null,
    @SerialName("client_event_id")
    @JsonNames("client_event_id")
    val clientEventId: String? = null,
    val metadata: Map<String, kotlinx.serialization.json.JsonElement>? = null,
    @kotlinx.serialization.Transient val isStreaming: Boolean = false,
    @kotlinx.serialization.Transient val agentSteps: List<AgentStep>? = null,
    @kotlinx.serialization.Transient val reasoning: String? = null,
    @kotlinx.serialization.Transient val persistedId: String? = null,
    @kotlinx.serialization.Transient val serverId: String? = null,
    @kotlinx.serialization.Transient val stopReason: String? = null,
    @kotlinx.serialization.Transient val errorMessage: String? = null,
    @kotlinx.serialization.Transient val planProposal: PlanProposal? = null,
    @kotlinx.serialization.Transient val modeSwitchProposal: ModeSwitchProposal? = null,
    @kotlinx.serialization.Transient val proposalResolved: Boolean = false,
) {
    val isUser: Boolean get() = role == "user"
    val isAssistant: Boolean get() = role == "assistant"
    /** 系统通知（system_notice 等）的判定，对齐 iOS `ChatMessage.isSystem` */
    val isSystem: Boolean get() = role == "system"
    /**
     * Agent 切换事件仍保留在服务端审计记录中，但它只描述会话配置变化，重复展示在
     * 对话时间线会与逐消息 Agent 身份冲突。兼容早期还没有 system_fact 的历史文案。
     */
    val isAgentSwitchAudit: Boolean
        get() = isSystem && (
            metadataString("system_fact") == "agent_switched" ||
                displayContent == "切换当前 Agent" ||
                displayContent.startsWith("Agent 已切换成")
            )
    val isSubagentTranscript: Boolean get() = !subagentRunId.isNullOrBlank()
    /**
     * 仅供模型的内部 Context（环境快照 / Agent Profile / System Prompt）可落库以维持跨轮历史，但绝不能
     * 作为用户消息出现在时间线。老缓存可能没有 `message_kind`，因此同时以 wrapper 兜底。
     *
     * 压缩检查点（`compaction_summary`）**不是**内部上下文：进时间线，以 pill 展示
     *（见 [isCompactionSummary]），禁止当用户气泡渲染摘要正文。
     */
    val isInternalContext: Boolean
        get() = metadataBoolean("share_briefing") ||
            metadataBoolean("share_contract") ||
            isInternalContextMessage(messageKind, null) ||
            ((isUser || isSystem) && isInternalContextMessage(null, displayContent))

    /** 对齐 Electron `isPushNotificationMessage`：后台任务完成唤起下一轮的伪用户消息。 */
    val isPushNotification: Boolean
        get() = (isUser || isSystem) && PushNotificationVisibility.isPushNotification(
            triggeredBy = metadataString("triggered_by"),
            text = displayContent,
        )

    /** 纯子代理完成通知：桌面 fold 进聚合卡，主时间线整条抑制。 */
    val shouldHidePushNotification: Boolean
        get() = (isUser || isSystem) && PushNotificationVisibility.shouldHideFromTimeline(
            triggeredBy = metadataString("triggered_by"),
            text = displayContent,
        )

    /** 对齐 Electron `isCompactionSummaryPresentation`：居中 History pill，不渲染摘要正文。 */
    val isCompactionSummary: Boolean
        get() = isCompactionSummaryPresentation(messageKind, displayContent)

    /** 后台完成通知展示摘要（解析失败时回落正文，绝不当用户气泡）。 */
    val pushNotificationSummary: String
        get() = PushNotificationVisibility.displaySummary(
            triggeredBy = metadataString("triggered_by"),
            text = displayContent,
        )
    val effectiveId: String get() = persistedId ?: serverId ?: id
    val canonicalClientEventId: String?
        get() = firstNonBlank(
            clientEventId,
            metadataString("client_message_id"),
            metadataString("client_event_id"),
            id.takeIf { isUser && serverId == null && persistedId == null },
        )
    val sourceClientEventId: String?
        get() = metadataString("source_client_event_id")
    val identityKeys: Set<String>
        get() = buildSet {
            addNonBlank(id)
            addNonBlank(serverId)
            addNonBlank(persistedId)
            addNonBlank(effectiveId)
            addNonBlank(canonicalClientEventId)
            addNonBlank(metadataString("client_message_id"))
            addNonBlank(metadataString("client_event_id"))
        }

    val displayContent: String
        get() {
            textContentFromBlocks?.let { return it }
            // `content` 是后端为会话列表派生的摘要。纯 image/file/rich_content 消息会
            // 带 `[富内容]` 等占位；有内容块时不能把它当作用户可见正文。
            if (!blocksJson.isNullOrEmpty() && isTextSummaryPlaceholder(content)) return ""
            return content
        }

    private val textContentFromBlocks: String?
        get() = blocksJson
            ?.asSequence()
            ?.filter { it.type == "text" }
            ?.mapNotNull { it.text ?: it.content }
            ?.filter { it.isNotBlank() }
            ?.joinToString("\n")
            ?.takeIf { it.isNotBlank() }

    val imageAttachments: List<BlockItem>
        get() = blocksJson?.filter { it.type == "image" && !it.url.isNullOrEmpty() } ?: emptyList()

    val fileAttachments: List<BlockItem>
        get() = blocksJson?.filter { it.type == "file" && !it.url.isNullOrEmpty() } ?: emptyList()

    val richContentBlocks: List<BlockItem>
        get() = blocksJson
            ?.asSequence()
            ?.filter { it.isRichContent }
            ?.map { it.normalizedRichContent() }
            ?.toList()
            ?: emptyList()

    private fun metadataString(key: String): String? = try {
        metadata?.get(key)?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun metadataBoolean(key: String): Boolean = try {
        metadata?.get(key)?.jsonPrimitive?.contentOrNull == "true"
    } catch (_: IllegalArgumentException) {
        false
    }

    internal companion object {
        private val INTERNAL_CONTEXT_MESSAGE_KINDS = setOf(
            "environment_context",
            "agent_profile_context",
            "system_prompt_context",
            "external_archive_context",
        )
        private val INTERNAL_CONTEXT_CONTENT_PREFIXES = setOf(
            "<context type=\"environment\"",
            "<context type='environment'",
            "<context type=\"agent-profile\"",
            "<context type='agent-profile'",
            "<context type=\"external-archive\"",
            "<context type='external-archive'",
            "<identity",
        )
        /** 与 Electron `compactionSummaryPresentation` / agent-runtime wrapper 同文 marker。 */
        private const val COMPACTION_SUMMARY_HEADER = "[对话摘要]"
        private const val COMPACTION_SUMMARY_END = "[摘要结束]"

        internal fun isInternalContextMessage(messageKind: String?, content: String?): Boolean {
            if (messageKind in INTERNAL_CONTEXT_MESSAGE_KINDS) return true
            val normalized = content?.trimStart().orEmpty()
            return INTERNAL_CONTEXT_CONTENT_PREFIXES.any(normalized::startsWith)
        }

        /** 对齐 Electron `compactionSummaryPresentation.ts`。 */
        internal fun isCompactionSummaryPresentation(messageKind: String?, content: String?): Boolean {
            if (messageKind == "compaction_summary") return true
            val normalized = content.orEmpty()
            return normalized.contains(COMPACTION_SUMMARY_HEADER) &&
                normalized.contains(COMPACTION_SUMMARY_END)
        }

        // 与 Django `derive_text_summary`、iOS `MessageHistoryMapper` 对齐。
        private val TEXT_SUMMARY_PLACEHOLDERS = setOf("[工具调用]", "[富内容]", "[思考中]")

        private fun isTextSummaryPlaceholder(content: String): Boolean =
            content.trim() in TEXT_SUMMARY_PLACEHOLDERS

        private fun firstNonBlank(vararg values: String?): String? =
            values.firstOrNull { !it.isNullOrBlank() }

        private fun MutableSet<String>.addNonBlank(value: String?) {
            if (!value.isNullOrBlank()) add(value)
        }
    }
}
