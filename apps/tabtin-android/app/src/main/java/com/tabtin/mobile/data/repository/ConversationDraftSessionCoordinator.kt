package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationDraftBlock
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationDraftSnapshot
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.Space
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** 首发前由 UI 收集、但不含任何 UI 状态的输入。 */
public data class ConversationDraftInput(
    val scope: ConversationDraftScope,
    val agentId: String,
    val text: String,
    val modelId: String? = null,
    val runtimeConfiguration: ConversationRuntimeConfiguration = ConversationRuntimeConfiguration(),
    /** 首发前冻结的上下文档位；写入 draft 后由 prepareSession flush。 */
    val contextTierId: String? = null,
    /** 首发前冻结的思考强度；写入 draft 后由 prepareSession flush。 */
    val thinkingMode: String? = null,
    val blocks: List<MessageBlock> = emptyList(),
)

/** 首发会话已幂等创建，首条消息仍由 ConversationViewModel 的持久队列负责入队。 */
public data class PreparedConversationDraft(
    val draft: ConversationDraftSnapshot,
    val session: ChatSession,
)

/**
 * 把「保存本地草稿 → 幂等建 Session → 记录 pending Session」收敛为一次事务。
 *
 * 这不是消息发送器：成功返回只代表 Session 已有稳定身份。调用方必须把
 * [PreparedConversationDraft.draft] 交给会话页，在首条消息安全写入 Room 队列后再消费草稿。
 */
@Singleton
public class ConversationDraftSessionCoordinator @Inject constructor(
    private val draftStore: ConversationDraftStore,
    private val chatRepository: ChatRepository,
    private val llmRepository: LlmRepository,
) {
    public suspend fun prepareSession(
        executionSpace: Space,
        input: ConversationDraftInput,
    ): PreparedConversationDraft {
        validateScopeForSpace(executionSpace, input.scope)
        require(input.agentId.isNotBlank()) { "请先选择可用的 AI 分身" }

        val existing = draftStore.load(input.scope)
        val frozenTier = input.contextTierId?.trim()?.takeIf { it.isNotEmpty() }
        val frozenThinking = input.thinkingMode?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        val draft = when {
            existing?.pendingSessionId != null -> {
                // 已有 pending Session 时仍允许补写运行设置（用户可能在恢复窗口改过）。
                if (frozenTier != null || frozenThinking != null) {
                    draftStore.save(
                        existing.copy(
                            contextTierId = frozenTier ?: existing.contextTierId,
                            thinkingMode = frozenThinking ?: existing.thinkingMode,
                        ),
                    )
                } else {
                    existing
                }
            }
            existing != null -> {
                val modelId = input.modelId?.takeIf(::isUuid) ?: existing.modelId
                val incomingBlocks = input.blocks.mapNotNull(ConversationDraftBlock::fromMessageBlock)
                draftStore.save(
                    existing.copy(
                        text = input.text,
                        agentId = input.agentId,
                        modelId = modelId,
                        agentMode = input.runtimeConfiguration.agentMode.wireValue,
                        approvalMode = input.runtimeConfiguration.approvalMode.wireValue,
                        contextTierId = frozenTier ?: existing.contextTierId,
                        thinkingMode = frozenThinking ?: existing.thinkingMode,
                        // 恢复后的全局 Compose 目前只展示正文，无法反向重建资源 chip。
                        // 文本未变且调用方未带新 block 时保留此前已冻结的上下文；一旦用户
                        // 改写正文，空 block 明确表示其选择了新的首发内容。
                        blocks = if (incomingBlocks.isEmpty() && input.text == existing.text) {
                            existing.blocks
                        } else {
                            incomingBlocks
                        },
                    ),
                )
            }
            else -> {
                val modelId = input.modelId?.takeIf(::isUuid)
                    ?: resolveDefaultModelId(input.scope.organizationId)
                    ?: throw IllegalStateException("没有可用模型：请在管理后台配置并激活聊天模型后重试。")
                draftStore.save(
                    ConversationDraftSnapshot(
                        scope = input.scope,
                        text = input.text,
                        agentId = input.agentId,
                        modelId = modelId,
                        agentMode = input.runtimeConfiguration.agentMode.wireValue,
                        approvalMode = input.runtimeConfiguration.approvalMode.wireValue,
                        contextTierId = frozenTier,
                        thinkingMode = frozenThinking,
                        blocks = input.blocks.mapNotNull(ConversationDraftBlock::fromMessageBlock),
                    ),
                )
            }
        }

        // 先前进程若在 pendingSessionId 落盘前退出，draftId 本身仍是稳定 UUID，重试会
        // 得到同一条服务端 Session；不会产生第二条空会话。
        // ：若冻结配置已漂移导致 CONFLICT，轮换 draftId 后再建一次。
        val (effectiveDraft, session) = createSessionRecoveringConflict(
            executionSpace = executionSpace,
            draft = draft,
        )
        // 草稿冻结的上下文长度 / 思考强度：建 session 后立刻写入（send 仍不带这些字段）。
        effectiveDraft.contextTierId?.trim()?.takeIf { it.isNotEmpty() }?.let { tierId ->
            runCatching { chatRepository.switchContextTier(session.id, tierId) }
        }
        effectiveDraft.thinkingMode?.trim()?.takeIf { it.isNotEmpty() }?.let { mode ->
            runCatching {
                chatRepository.updateModelParams(
                    sessionId = session.id,
                    thinkingMode = mode,
                    preserving = session.modelParamOverrides,
                )
            }
        }
        val pendingDraft = draftStore.markPendingSession(
            scope = effectiveDraft.scope,
            draftId = effectiveDraft.draftId,
            sessionId = session.id,
        ) ?: effectiveDraft.copy(pendingSessionId = session.id)
        return PreparedConversationDraft(draft = pendingDraft, session = session)
    }

    private suspend fun createSessionRecoveringConflict(
        executionSpace: Space,
        draft: ConversationDraftSnapshot,
    ): Pair<ConversationDraftSnapshot, ChatSession> {
        val runtimeConfiguration = ConversationRuntimeConfiguration.normalizedForStorage(
            rawAgentMode = draft.agentMode,
            rawApprovalMode = draft.approvalMode,
        )
        return try {
            val session = chatRepository.createSession(
                space = executionSpace,
                agentId = draft.agentId,
                projectId = draft.scope.projectId,
                sessionId = draft.pendingSessionId ?: draft.draftId,
                modelId = draft.modelId,
                runtimeConfiguration = runtimeConfiguration,
            )
            draft to session
        } catch (error: Throwable) {
            if (!isSessionCreateConflict(error)) throw error
            val rotated = draftStore.rotateDraftIdentity(draft.scope, draft.draftId)
                ?: throw error
            val session = chatRepository.createSession(
                space = executionSpace,
                agentId = rotated.agentId,
                projectId = rotated.scope.projectId,
                sessionId = rotated.draftId,
                modelId = rotated.modelId,
                runtimeConfiguration = ConversationRuntimeConfiguration.normalizedForStorage(
                    rawAgentMode = rotated.agentMode,
                    rawApprovalMode = rotated.approvalMode,
                ),
            )
            rotated to session
        }
    }

    private fun isSessionCreateConflict(error: Throwable): Boolean {
        val code = when (error) {
            is AppError.RequestFailed -> error.errorCode
            else -> null
        }
        if (code.equals("CONFLICT", ignoreCase = true)) return true
        val message = when (error) {
            is AppError.RequestFailed -> error.serverMessage
            is AppError.ActionFailed -> error.serverMessage
            else -> error.message
        }.orEmpty()
        return message.contains("[CONFLICT]") || message.contains("创建配置不一致")
    }

    private suspend fun resolveDefaultModelId(organizationId: String): String? {
        if (organizationId.isBlank()) return null
        val catalog = llmRepository.getChatCatalog(organizationId)
        val sendable = catalog.models.filter { model -> isUuid(model.id) }
        return catalog.defaultModelId?.takeIf(::isUuid)?.takeIf { defaultId ->
            sendable.any { it.id == defaultId }
        } ?: sendable.firstOrNull()?.id
    }

    private fun validateScopeForSpace(space: Space, scope: ConversationDraftScope) {
        require(scope.isValid()) { "请先选择有效的执行 Workspace" }
        val workspaceId = when {
            space.isExecutionSpace -> space.id
            else -> space.executionSpaceId?.takeIf { it.isNotBlank() }
        }
        require(workspaceId == scope.workspaceId) { "草稿范围与当前执行 Workspace 不一致" }
        require(space.organizationId == scope.organizationId) { "草稿范围与当前 Organization 不一致" }
    }

    private fun isUuid(value: String): Boolean = try {
        UUID.fromString(value.trim())
        true
    } catch (_: IllegalArgumentException) {
        false
    }
}
