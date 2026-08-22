package com.tabtin.mobile.data.im

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import com.tabtin.mobile.data.model.ChatSession
import javax.inject.Inject
import javax.inject.Singleton

/**
 * TabChat 会话级 REST：会话详情（成员）/ 可 @ 的 Agent 搜索 / Agent 执行现场绑定 / 附件下载 URL。
 *
 * 与 [ImMessageStore] 的消息传输面分离——这里管「会话 / 成员 / Agent / 附件」，
 * 抽成接口便于 @ 选择器单测注入假实现。对齐 iOS `IMConversationService.swift`。
 */
public interface ImConversationServing {
    /** 幂等创建或复用与 organization 内人类成员的私信。 */
    public suspend fun createOrGetDM(organizationId: String, otherUserId: String): String

    /** 幂等创建或复用与外部联系人的私信。 */
    public suspend fun createOrGetExternalDM(organizationId: String, externalContactId: String): String {
        throw UnsupportedOperationException("External IM is not supported by this implementation")
    }

    /** 创建群聊，成员列表不含当前用户。 */
    public suspend fun createGroup(
        organizationId: String,
        name: String,
        memberIds: List<String>,
        clientRequestId: String,
    ): String

    /** 创建包含外部联系人的群聊；两类成员保持独立字段。 */
    public suspend fun createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: List<String>,
        externalContactIds: List<String>,
        clientRequestId: String,
    ): String {
        throw UnsupportedOperationException("External IM is not supported by this implementation")
    }

    /** 会话详情（含成员列表，用于判定群聊 / 已在会话的 Agent）。 */
    public suspend fun fetchDetail(conversationId: String): ImConversationDetail

    /** 搜索 organization 内可 @ 的 Agent（后端只返回本人拥有的启用 bot）。 */
    public suspend fun searchAgents(organizationId: String, query: String): List<ImAgentSummary>

    /** 仅团队频道可用：把选中消息及其回复上下文升级为一次 Agent 问询。 */
    public suspend fun createAgentTaskFromMessage(
        conversationId: String,
        messageId: Int,
        agentId: String,
        additionalContext: String,
    ): ImAgentTaskThreadResult {
        throw UnsupportedOperationException("Agent task from message is not supported by this implementation")
    }

    /** 加入自己的 Agent，并原子绑定可执行 Workspace；禁止绕过 binding 直接加成员。 */
    public suspend fun bindAgent(
        conversationId: String,
        agentId: String,
        workspaceId: String,
    ): ImConversationAgentBinding

    public suspend fun listAgentBindings(conversationId: String): List<ImConversationAgentBinding>

    public suspend fun updateAgentBinding(
        conversationId: String,
        agentId: String,
        workspaceId: String,
    ): ImConversationAgentBinding

    /** Agent 主人解除 binding；后端会同时把该 Agent 移出普通群聊。 */
    public suspend fun deleteAgentBinding(conversationId: String, agentId: String)

    /** 群管理员移出任意 Agent；用于管理并非自己拥有的 Agent。 */
    public suspend fun removeAgent(conversationId: String, agentId: String)

    public suspend fun renameConversation(conversationId: String, name: String)

    public suspend fun addMembers(conversationId: String, memberIds: List<String>): List<String>

    public suspend fun addExternalMembers(conversationId: String, externalContactIds: List<String>): List<String> {
        throw UnsupportedOperationException("External IM is not supported by this implementation")
    }

    /** 群管理员移除真人成员；外部联系人在 REST 契约中同样以 peer user id 标识。 */
    public suspend fun removeMember(conversationId: String, userId: String)

    public suspend fun leaveConversation(conversationId: String, userId: String)

    public suspend fun attachmentUrl(conversationId: String, messageId: Int): ImAttachmentUrl

    public suspend fun updateConversationAvatar(conversationId: String, avatarUrl: String)
}

public suspend fun resolveDirectMessageConversationId(
    conversations: List<ImConversation>,
    organizationId: String,
    otherUserId: String,
    onRemoteLookup: () -> Unit = {},
    createRemote: suspend () -> String,
): String {
    val local = conversations.firstOrNull {
        it.type == ImConversationType.DM &&
            !it.isArchived &&
            it.canReceiveMessages &&
            it.organizationId == organizationId.trim() &&
            it.dmPeerUserId == otherUserId.trim() &&
            it.id.isNotBlank()
    }
    if (local != null) return local.id
    onRemoteLookup()
    return createRemote()
}

@Singleton
public class ImConversationService @Inject constructor(
    private val domainApi: ImApi,
) : ImConversationServing {
    override suspend fun createOrGetDM(organizationId: String, otherUserId: String): String =
        domainApi.createDM(CreateDMBody(organizationId, otherUserId)).unwrap().conversationId

    override suspend fun createOrGetExternalDM(organizationId: String, externalContactId: String): String =
        domainApi.createDM(
            CreateDMBody(
                organizationId = organizationId,
                externalContactId = externalContactId,
            ),
        ).unwrap().conversationId

    override suspend fun createGroup(
        organizationId: String,
        name: String,
        memberIds: List<String>,
        clientRequestId: String,
    ): String = domainApi.createGroup(
        CreateGroupBody(organizationId, name, memberIds, clientRequestId),
    ).unwrap().conversationId

    override suspend fun createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: List<String>,
        externalContactIds: List<String>,
        clientRequestId: String,
    ): String = domainApi.createGroup(
        CreateGroupBody(
            organizationId = organizationId,
            name = name,
            memberIds = memberIds,
            clientRequestId = clientRequestId,
            externalContactIds = externalContactIds,
        ),
    ).unwrap().conversationId

    override suspend fun fetchDetail(conversationId: String): ImConversationDetail =
        domainApi.getConversationDetail(conversationId).unwrap()

    override suspend fun searchAgents(organizationId: String, query: String): List<ImAgentSummary> =
        domainApi.searchAgents(organizationId, query.trim().takeIf { it.isNotEmpty() }).unwrap()

    override suspend fun createAgentTaskFromMessage(
        conversationId: String,
        messageId: Int,
        agentId: String,
        additionalContext: String,
    ): ImAgentTaskThreadResult = domainApi.createAgentTaskFromMessage(
        conversationId,
        messageId,
        CreateAgentTaskFromMessageBody(agentId, additionalContext.trim()),
    ).unwrap()

    override suspend fun bindAgent(
        conversationId: String,
        agentId: String,
        workspaceId: String,
    ): ImConversationAgentBinding = domainApi.bindAgent(
        conversationId,
        BindConversationAgentBody(agentId, workspaceId),
    ).unwrap()

    override suspend fun listAgentBindings(conversationId: String): List<ImConversationAgentBinding> =
        domainApi.listAgentBindings(conversationId).unwrap().items

    override suspend fun updateAgentBinding(
        conversationId: String,
        agentId: String,
        workspaceId: String,
    ): ImConversationAgentBinding = domainApi.updateAgentBinding(
        conversationId,
        agentId,
        UpdateConversationAgentBindingBody(workspaceId),
    ).unwrap()

    override suspend fun deleteAgentBinding(conversationId: String, agentId: String) {
        domainApi.deleteAgentBinding(conversationId, agentId).requireSuccess()
    }

    override suspend fun removeAgent(conversationId: String, agentId: String) {
        domainApi.removeAgent(conversationId, agentId).requireSuccess()
    }

    override suspend fun renameConversation(conversationId: String, name: String) {
        domainApi.updateConversation(conversationId, UpdateConversationBody(name = name)).requireSuccess()
    }

    override suspend fun addMembers(conversationId: String, memberIds: List<String>): List<String> =
        domainApi.addMembers(conversationId, AddMembersBody(memberIds)).unwrap().addedUserIds

    override suspend fun addExternalMembers(
        conversationId: String,
        externalContactIds: List<String>,
    ): List<String> = domainApi.addMembers(
        conversationId,
        AddMembersBody(externalContactIds = externalContactIds),
    ).unwrap().addedExternalContactIds

    override suspend fun removeMember(conversationId: String, userId: String) {
        domainApi.removeMember(conversationId, userId).requireSuccess()
    }

    override suspend fun leaveConversation(conversationId: String, userId: String) {
        domainApi.leaveConversation(conversationId).requireSuccess()
    }

    override suspend fun attachmentUrl(conversationId: String, messageId: Int): ImAttachmentUrl =
        domainApi.attachmentUrl(conversationId, messageId).unwrap()

    override suspend fun updateConversationAvatar(conversationId: String, avatarUrl: String) {
        domainApi.updateConversation(
            conversationId,
            UpdateConversationBody(avatarUrl = avatarUrl),
        ).requireSuccess()
    }
}

@Serializable
public data class ImConversationLabelsResult(
    @SerialName("conversation_id") val conversationId: String = "",
    val labels: List<ImConversationLabel> = emptyList(),
)

/** Per-user 会话标签控制面；与消息传输完全独立。 */
@Singleton
public class ImConversationLabelRepository @Inject constructor(
    private val domainApi: ImApi,
) {
    public suspend fun list(organizationId: String): List<ImConversationLabel> =
        domainApi.listLabels(organizationId).unwrap()

    public suspend fun create(
        organizationId: String,
        name: String,
        color: String = "#6b7280",
    ): ImConversationLabel = domainApi.createLabel(
        CreateConversationLabelBody(organizationId, name.trim(), color),
    ).unwrap()

    public suspend fun update(labelId: String, name: String?, color: String?): ImConversationLabel =
        domainApi.updateLabel(labelId, UpdateConversationLabelBody(name?.trim(), color)).unwrap()

    public suspend fun delete(labelId: String) {
        domainApi.deleteLabel(labelId).requireSuccess()
    }

    public suspend fun labelsForConversation(conversationId: String): List<ImConversationLabel> =
        domainApi.getConversationLabels(conversationId).unwrap()

    public suspend fun addToConversation(
        conversationId: String,
        labelIds: List<String>,
    ): List<ImConversationLabel> = domainApi.addConversationLabels(
        conversationId,
        AddConversationLabelsBody(labelIds),
    ).unwrap().labels

    public suspend fun removeFromConversation(
        conversationId: String,
        labelId: String,
    ): List<ImConversationLabel> = domainApi.removeConversationLabel(conversationId, labelId).unwrap().labels
}

/** 对话接力控制面；调用方只学习领域动作，不感知 Retrofit 路径或响应信封。 */
public class ImHandoffRepository(
    private val domainApi: ImApi,
) {
    public suspend fun create(
        conversationId: String,
        goal: String,
        recipientIds: List<String>,
        references: List<ImHandoffReferenceRequest>,
    ): ImHandoffPackage = domainApi.createHandoff(
        ImHandoffCreateRequest(
            conversationId = conversationId,
            goal = goal.trim().ifEmpty { "上下文交接" },
            recipients = recipientIds.distinct().sorted(),
            references = references,
        ),
    ).unwrap()

    public suspend fun get(handoffId: String): ImHandoffPackage =
        domainApi.getHandoff(handoffId).unwrap()

    public suspend fun act(
        handoffId: String,
        action: String,
        note: String = "",
    ): ImHandoffPackage = domainApi.actOnHandoff(
        handoffId,
        ImHandoffActionRequest(action = action, note = note.trim()),
    ).unwrap()

    public suspend fun revoke(handoffId: String): ImHandoffPackage =
        domainApi.revokeHandoff(handoffId).unwrap()

    public suspend fun takeOver(
        handoffId: String,
        agentId: String,
        workspaceId: String,
    ): ChatSession = domainApi.takeOverHandoff(
        handoffId,
        ImHandoffTakeOverRequest(agentId = agentId, workspaceId = workspaceId),
    ).unwrap()
}
