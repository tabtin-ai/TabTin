import Foundation

/// TabChat 会话级 REST：会话详情（成员）/ 可 @ 的 Agent 搜索 / Agent 执行现场绑定。
///
/// 与 `IMMessageStore` 的消息传输面分离——这里管「会话 / 成员 / Agent」，
/// 抽成协议便于 @ 选择器单测注入假实现（不打真网络）。后端真源：`tabchat/api.py`。
protocol IMConversationServing: Sendable {
    /// 幂等创建或复用与 organization 内人类成员的私信。
    func createOrGetDM(organizationId: String, otherUserId: String) async throws -> String
    /// 幂等创建或复用与外部联系人的私信。
    func createOrGetExternalDM(organizationId: String, externalContactId: String) async throws -> String
    /// 创建群聊。创建者由服务端从当前登录态自动加入，`memberIds` 只传其他成员。
    func createGroup(organizationId: String, name: String, memberIds: [String]) async throws -> String
    func createGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        clientRequestId: String
    ) async throws -> String
    /// 创建包含外部联系人的群聊；两类成员保持独立字段。
    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String]
    ) async throws -> String
    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String],
        clientRequestId: String
    ) async throws -> String
    /// 会话详情（含成员列表，用于判定群聊 / 已在会话的 Agent）。
    func fetchDetail(conversationId: String) async throws -> IMConversationDetail
    /// 搜索 organization 内可 @ 的 Agent（后端只返回本人拥有的启用 bot）。
    func searchAgents(organizationId: String, query: String) async throws -> [IMAgentSummary]
    /// 仅团队频道可用：把选中消息及其回复上下文升级为一次 Agent 问询。
    func createAgentTaskFromMessage(
        conversationId: String,
        messageId: Int,
        agentId: String,
        additionalContext: String
    ) async throws -> IMAgentTaskThreadResult
    /// 加入自己的 Agent，并原子绑定可执行 Workspace；禁止绕过 binding 直接加成员。
    func bindAgent(conversationId: String, agentId: String, workspaceId: String) async throws -> IMConversationAgentBinding
    /// 查看群内 Agent 的执行现场，供已有成员补绑或更换现场。
    func listAgentBindings(conversationId: String) async throws -> [IMConversationAgentBinding]
    func updateAgentBinding(conversationId: String, agentId: String, workspaceId: String) async throws -> IMConversationAgentBinding
    /// Agent 主人解除 binding；后端会同时把该 Agent 移出普通群聊。
    func deleteAgentBinding(conversationId: String, agentId: String) async throws
    /// 群管理员移出并非自己拥有的 Agent。
    func removeAgent(conversationId: String, agentId: String) async throws
    func updateConversationName(conversationId: String, name: String) async throws
    /// 更新群头像；空字符串表示移除。权限由 Django IM 校验。
    func updateConversationAvatar(conversationId: String, avatarUrl: String) async throws
    func toggleMute(conversationId: String) async throws -> Bool
    func addMembers(conversationId: String, memberIds: [String]) async throws -> [String]
    func addExternalMembers(conversationId: String, externalContactIds: [String]) async throws -> [String]
    /// 群管理员移除真人成员；外部联系人同样使用 peer user id。
    func removeMember(conversationId: String, userId: String) async throws
    func leaveConversation(conversationId: String) async throws
    func getResourceCardPreview(cardType: String, resourceId: String) async -> IMResourceCardPreviewResult
    func createResourceAccessRequest(conversationId: String, message: IMMessage, card: IMResourceCard) async throws -> IMResourceAccessRequestInfo
    func approveResourceAccessRequest(id: String) async throws -> IMResourceAccessRequestInfo
    func getSessionShare(id: String) async throws -> IMSessionShareCard
    func listIncomingSessionShares(organizationId: String) async throws -> [IMSessionShareCard]
    func sendSharedChat(
        sessionId: String,
        shareId: String,
        text: String,
        clientMessageId: String
    ) async throws -> IMSharedChatResult
    func getSharedExecutionStatus(sessionId: String, shareId: String) async throws -> IMSharedExecutionStatus
    func getSessionShareV2(id: String) async throws -> IMSessionShareV2Detail
    func acceptSessionShareV2(id: String) async throws -> IMSessionShareV2Detail
    func retrySessionShareV2Delivery(id: String) async throws -> IMSessionShareV2Detail
    func createSessionContinuation(
        sourceSessionId: String,
        recipientUserId: String,
        conversationId: String?,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail
    func getSessionContinuation(id: String) async throws -> IMSessionContinuationDetail
    func createTaskFromSessionContinuation(
        id: String,
        agentId: String,
        workspaceId: String,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail
    func revokeSessionShare(id: String) async throws -> IMSessionShareCard
    func createSessionShare(
        sessionId: String,
        granteeUserId: String,
        canFork: Bool,
        canChat: Bool,
        conversationId: String,
        clientRequestId: String?,
        restoreShareId: String?
    ) async throws -> IMSessionShareCard
    func listShareableSessions(organizationId: String) async throws -> [RecentSession]
}

extension IMConversationServing {
    func createAgentTaskFromMessage(
        conversationId: String,
        messageId: Int,
        agentId: String,
        additionalContext: String
    ) async throws -> IMAgentTaskThreadResult {
        throw URLError(.unsupportedURL)
    }

    func createOrGetDM(organizationId: String, otherUserId: String) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func createOrGetExternalDM(organizationId: String, externalContactId: String) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func createGroup(organizationId: String, name: String, memberIds: [String]) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func createGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        clientRequestId: String
    ) async throws -> String {
        try await createGroup(organizationId: organizationId, name: name, memberIds: memberIds)
    }

    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String]
    ) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String],
        clientRequestId: String
    ) async throws -> String {
        try await createExternalGroup(
            organizationId: organizationId,
            name: name,
            memberIds: memberIds,
            externalContactIds: externalContactIds
        )
    }

    func bindAgent(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        throw URLError(.unsupportedURL)
    }

    func listAgentBindings(conversationId: String) async throws -> [IMConversationAgentBinding] { [] }

    func updateAgentBinding(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        throw URLError(.unsupportedURL)
    }

    func deleteAgentBinding(conversationId: String, agentId: String) async throws {
        throw URLError(.unsupportedURL)
    }

    func removeAgent(conversationId: String, agentId: String) async throws {
        throw URLError(.unsupportedURL)
    }

    func updateConversationName(conversationId: String, name: String) async throws { throw URLError(.unsupportedURL) }
    func updateConversationAvatar(conversationId: String, avatarUrl: String) async throws { throw URLError(.unsupportedURL) }
    func toggleMute(conversationId: String) async throws -> Bool { throw URLError(.unsupportedURL) }
    func addMembers(conversationId: String, memberIds: [String]) async throws -> [String] { throw URLError(.unsupportedURL) }
    func addExternalMembers(conversationId: String, externalContactIds: [String]) async throws -> [String] {
        throw URLError(.unsupportedURL)
    }
    func removeMember(conversationId: String, userId: String) async throws { throw URLError(.unsupportedURL) }
    func leaveConversation(conversationId: String) async throws { throw URLError(.unsupportedURL) }
    func getResourceCardPreview(cardType: String, resourceId: String) async -> IMResourceCardPreviewResult {
        IMResourceCardPreviewResult(status: .error, data: nil)
    }
    func createResourceAccessRequest(conversationId: String, message: IMMessage, card: IMResourceCard) async throws -> IMResourceAccessRequestInfo {
        throw URLError(.unsupportedURL)
    }
    func approveResourceAccessRequest(id: String) async throws -> IMResourceAccessRequestInfo { throw URLError(.unsupportedURL) }
    func getSessionShare(id: String) async throws -> IMSessionShareCard { throw URLError(.unsupportedURL) }
    func listIncomingSessionShares(organizationId: String) async throws -> [IMSessionShareCard] {
        throw URLError(.unsupportedURL)
    }
    func sendSharedChat(
        sessionId: String,
        shareId: String,
        text: String,
        clientMessageId: String
    ) async throws -> IMSharedChatResult { throw URLError(.unsupportedURL) }
    func getSharedExecutionStatus(sessionId: String, shareId: String) async throws -> IMSharedExecutionStatus {
        throw URLError(.unsupportedURL)
    }
    func getSessionShareV2(id: String) async throws -> IMSessionShareV2Detail { throw URLError(.unsupportedURL) }
    func acceptSessionShareV2(id: String) async throws -> IMSessionShareV2Detail { throw URLError(.unsupportedURL) }
    func retrySessionShareV2Delivery(id: String) async throws -> IMSessionShareV2Detail { throw URLError(.unsupportedURL) }
    func createSessionContinuation(
        sourceSessionId: String,
        recipientUserId: String,
        conversationId: String?,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail { throw URLError(.unsupportedURL) }
    func getSessionContinuation(id: String) async throws -> IMSessionContinuationDetail { throw URLError(.unsupportedURL) }
    func createTaskFromSessionContinuation(
        id: String,
        agentId: String,
        workspaceId: String,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail { throw URLError(.unsupportedURL) }
    func revokeSessionShare(id: String) async throws -> IMSessionShareCard { throw URLError(.unsupportedURL) }
    func createSessionShare(
        sessionId: String,
        granteeUserId: String,
        canFork: Bool,
        canChat: Bool,
        conversationId: String,
        clientRequestId: String? = nil,
        restoreShareId: String? = nil
    ) async throws -> IMSessionShareCard {
        throw URLError(.unsupportedURL)
    }
    func listShareableSessions(organizationId: String) async throws -> [RecentSession] { throw URLError(.unsupportedURL) }
}

/// 优先从已加载的会话目录解析 DM；只有本地没有目标时才走幂等创建接口。
///
/// 会话目录已经携带 organization / peer 的稳定映射。把这层解析集中在同一个 seam，
/// 避免头像、名片、通讯录等入口各自无条件支付一次控制面网络往返。
@MainActor
func resolveDirectMessageConversationId(
    conversations: [IMConversation],
    organizationId: String,
    otherUserId: String,
    onRemoteLookup: () -> Void = {},
    createRemote: () async throws -> String
) async throws -> String {
    let normalizedOrganizationId = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedOtherUserId = otherUserId.trimmingCharacters(in: .whitespacesAndNewlines)
    if let localConversationId = conversations.first(where: { conversation in
        conversation.conversationType == .dm
            && !conversation.isArchived
            && conversation.canReceiveMessages
            && conversation.organizationId == normalizedOrganizationId
            && conversation.dmPeerUserId == normalizedOtherUserId
            && !conversation.id.isEmpty
    })?.id {
        return localConversationId
    }

    onRemoteLookup()
    return try await createRemote()
}

/// 默认实现：走统一 `APIClient`（同套 JWT / 401 刷新 / 信封解包）。
struct IMConversationService: IMConversationServing {
    func createOrGetDM(organizationId: String, otherUserId: String) async throws -> String {
        let result: IMCreateDMResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.createDM,
            body: ["organization_id": organizationId, "other_user_id": otherUserId]
        )
        return result.conversationId
    }

    func createOrGetExternalDM(organizationId: String, externalContactId: String) async throws -> String {
        let result: IMCreateDMResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.createDM,
            body: [
                "organization_id": organizationId,
                "external_contact_id": externalContactId,
            ]
        )
        return result.conversationId
    }

    func createGroup(organizationId: String, name: String, memberIds: [String]) async throws -> String {
        try await createGroup(
            organizationId: organizationId,
            name: name,
            memberIds: memberIds,
            clientRequestId: UUID().uuidString
        )
    }

    func createGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        clientRequestId: String
    ) async throws -> String {
        let result: IMCreateGroupResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.createGroup,
            body: [
                "organization_id": organizationId,
                "name": name,
                "member_ids": memberIds,
                "client_request_id": clientRequestId,
            ]
        )
        return result.conversationId
    }

    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String]
    ) async throws -> String {
        try await createExternalGroup(
            organizationId: organizationId,
            name: name,
            memberIds: memberIds,
            externalContactIds: externalContactIds,
            clientRequestId: UUID().uuidString
        )
    }

    func createExternalGroup(
        organizationId: String,
        name: String,
        memberIds: [String],
        externalContactIds: [String],
        clientRequestId: String
    ) async throws -> String {
        let result: IMCreateGroupResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.createGroup,
            body: [
                "organization_id": organizationId,
                "name": name,
                "member_ids": memberIds,
                "external_contact_ids": externalContactIds,
                "client_request_id": clientRequestId,
            ]
        )
        return result.conversationId
    }

    func togglePin(conversationId: String) async throws -> Bool {
        let current = await MainActor.run {
            IMConversationStore.shared.conversations.first(where: { $0.id == conversationId })?.pinned ?? false
        }
        let next = !current
        try await DjangoIMAdapter.shared.pinConversation(conversationId: conversationId, pinned: next)
        return next
    }

    func fetchDetail(conversationId: String) async throws -> IMConversationDetail {
        try await APIClient.shared.request(
            "GET",
            path: Endpoints.IM.conversation(conversationId)
        )
    }

    func searchAgents(organizationId: String, query: String) async throws -> [IMAgentSummary] {
        var params = ["organization_id": organizationId]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { params["q"] = trimmed }
        return try await APIClient.shared.get(path: Endpoints.IM.agentsSearch, query: params)
    }

    func createAgentTaskFromMessage(
        conversationId: String,
        messageId: Int,
        agentId: String,
        additionalContext: String
    ) async throws -> IMAgentTaskThreadResult {
        try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.agentTask(conversationId, messageId),
            body: [
                "agent_id": agentId,
                "additional_context": additionalContext.trimmingCharacters(in: .whitespacesAndNewlines),
            ]
        )
    }

    func bindAgent(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.agentBindings(conversationId),
            body: ["agent_id": agentId, "workspace_id": workspaceId]
        )
    }

    func listAgentBindings(conversationId: String) async throws -> [IMConversationAgentBinding] {
        let result: IMConversationAgentBindingList = try await APIClient.shared.get(
            path: Endpoints.IM.agentBindings(conversationId)
        )
        return result.items
    }

    func updateAgentBinding(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        try await APIClient.shared.request(
            "PATCH",
            path: Endpoints.IM.agentBinding(conversationId, agentId),
            body: ["workspace_id": workspaceId]
        )
    }

    func deleteAgentBinding(conversationId: String, agentId: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.delete(
            path: Endpoints.IM.agentBinding(conversationId, agentId)
        )
    }

    func removeAgent(conversationId: String, agentId: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.delete(
            path: Endpoints.IM.agent(conversationId, agentId)
        )
    }

    func updateConversationName(conversationId: String, name: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.request(
            "PATCH",
            path: Endpoints.IM.conversation(conversationId),
            body: ["name": name]
        )
    }

    func updateConversationAvatar(conversationId: String, avatarUrl: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.request(
            "PATCH",
            path: Endpoints.IM.conversation(conversationId),
            body: ["avatar_url": avatarUrl]
        )
    }

    func toggleMute(conversationId: String) async throws -> Bool {
        let current = await MainActor.run {
            IMConversationStore.shared.conversations.first(where: { $0.id == conversationId })?.isMuted ?? false
        }
        let next = !current
        try await DjangoIMAdapter.shared.setConversationMuted(conversationId: conversationId, muted: next)
        return next
    }

    func addMembers(conversationId: String, memberIds: [String]) async throws -> [String] {
        let result: IMAddMembersResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.members(conversationId),
            body: ["member_ids": memberIds]
        )
        return result.addedUserIds
    }

    func addExternalMembers(conversationId: String, externalContactIds: [String]) async throws -> [String] {
        let result: IMAddMembersResult = try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.members(conversationId),
            body: ["external_contact_ids": externalContactIds]
        )
        return result.addedExternalContactIds
    }

    func removeMember(conversationId: String, userId: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.delete(
            path: Endpoints.IM.member(conversationId, userId)
        )
    }

    func leaveConversation(conversationId: String) async throws {
        try await DjangoIMAdapter.shared.leaveConversation(conversationId: conversationId)
    }

    func getResourceCardPreview(cardType: String, resourceId: String) async -> IMResourceCardPreviewResult {
        do {
            let data: IMResourceCardPreview = try await APIClient.shared.get(
                path: Endpoints.IM.resourceCardPreview,
                query: ["card_type": cardType, "resource_id": resourceId]
            )
            return IMResourceCardPreviewResult(status: .ok, data: data)
        } catch {
            let code = (error as? APIError)?.businessCode
            if code == "403" { return IMResourceCardPreviewResult(status: .forbidden, data: nil) }
            if code == "404" { return IMResourceCardPreviewResult(status: .deleted, data: nil) }
            return IMResourceCardPreviewResult(status: .error, data: nil)
        }
    }

    func createResourceAccessRequest(conversationId: String, message: IMMessage, card: IMResourceCard) async throws -> IMResourceAccessRequestInfo {
        guard let resourceId = card.resourceId?.trimmingCharacters(in: .whitespacesAndNewlines), !resourceId.isEmpty else {
            throw APIError.apiError("资源信息不完整")
        }
        let resourceType: String
        switch card.typedType {
        case .document: resourceType = "document"
        case .table: resourceType = "table"
        default: throw APIError.apiError("不支持的资源类型")
        }
        var body: [String: Any] = [
            "source_conversation_id": conversationId,
            "source_message_id": message.id,
            "resource_type": resourceType,
            "resource_id": resourceId,
        ]
        if let messageRef = message.metadata?.messageRef, !messageRef.isEmpty {
            body["source_message_ref"] = messageRef
        }
        let info: IMResourceAccessRequestInfo = try await APIClient.shared.post(
            path: Endpoints.IM.resourceAccessRequests,
            body: body
        )
        return info
    }

    func approveResourceAccessRequest(id: String) async throws -> IMResourceAccessRequestInfo {
        try await APIClient.shared.post(
            path: Endpoints.IM.resourceAccessRequestApprove(id),
            body: [:]
        )
    }

    func getSessionShare(id: String) async throws -> IMSessionShareCard {
        try await APIClient.shared.get(path: Endpoints.IM.sessionShare(id))
    }

    func listIncomingSessionShares(organizationId: String) async throws -> [IMSessionShareCard] {
        let response: IMSessionShareListResponse = try await APIClient.shared.get(
            path: Endpoints.IM.sessionShares,
            query: [
                "organization_id": organizationId,
                "direction": "incoming",
            ]
        )
        return response.shares
    }

    func sendSharedChat(
        sessionId: String,
        shareId: String,
        text: String,
        clientMessageId: String
    ) async throws -> IMSharedChatResult {
        try await APIClient.shared.post(
            path: Endpoints.IM.sessionShareSharedChat(sessionId),
            body: [
                "text": text,
                "share_id": shareId,
                "client_message_id": clientMessageId,
            ]
        )
    }

    func getSharedExecutionStatus(sessionId: String, shareId: String) async throws -> IMSharedExecutionStatus {
        try await APIClient.shared.get(
            path: Endpoints.IM.sessionShareSharedExecutionStatus(sessionId),
            query: ["share_id": shareId]
        )
    }

    func getSessionShareV2(id: String) async throws -> IMSessionShareV2Detail {
        let response: IMSessionShareV2BatchResponse = try await APIClient.shared.post(
            path: Endpoints.IM.sessionShareBatchGet,
            body: ["object_ids": [id]]
        )
        guard let item = response.items.first(where: { $0.objectId == id }),
              item.ok,
              let detail = item.detail else {
            throw APIError.apiError("共享任务详情不可用")
        }
        return detail
    }

    func acceptSessionShareV2(id: String) async throws -> IMSessionShareV2Detail {
        try await APIClient.shared.post(path: Endpoints.IM.sessionShareAccept(id), body: [:])
    }

    func retrySessionShareV2Delivery(id: String) async throws -> IMSessionShareV2Detail {
        try await APIClient.shared.post(path: Endpoints.IM.sessionShareRetryDelivery(id), body: [:])
    }

    func createSessionContinuation(
        sourceSessionId: String,
        recipientUserId: String,
        conversationId: String?,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail {
        var body: [String: Any] = [
            "source_session_id": sourceSessionId,
            "recipient_user_id": recipientUserId,
            "client_request_id": clientRequestId,
        ]
        if let conversationId, !conversationId.isEmpty {
            body["conversation_id"] = conversationId
        }
        return try await APIClient.shared.post(path: Endpoints.IM.sessionContinuations, body: body)
    }

    func getSessionContinuation(id: String) async throws -> IMSessionContinuationDetail {
        let response: IMSessionContinuationBatchResponse = try await APIClient.shared.post(
            path: Endpoints.IM.sessionContinuationBatchGet,
            body: ["object_ids": [id]]
        )
        guard let item = response.items.first(where: { $0.objectId == id }),
              item.ok,
              let detail = item.detail else {
            throw APIError.apiError("任务续接详情不可用")
        }
        return detail
    }

    func createTaskFromSessionContinuation(
        id: String,
        agentId: String,
        workspaceId: String,
        clientRequestId: String
    ) async throws -> IMSessionContinuationDetail {
        try await APIClient.shared.post(
            path: Endpoints.IM.sessionContinuationCreateTask(id),
            body: [
                "agent_id": agentId,
                "workspace_id": workspaceId,
                "client_request_id": clientRequestId,
            ]
        )
    }

    func revokeSessionShare(id: String) async throws -> IMSessionShareCard {
        try await APIClient.shared.post(path: Endpoints.IM.sessionShareRevoke(id), body: [:])
    }

    func createSessionShare(
        sessionId: String,
        granteeUserId: String,
        canFork: Bool,
        canChat: Bool,
        conversationId: String,
        clientRequestId: String? = nil,
        restoreShareId: String? = nil
    ) async throws -> IMSessionShareCard {
        var body: [String: Any] = [
            "session_id": sessionId,
            "grantee_user_id": granteeUserId,
            "can_fork": canFork,
            "can_chat": canChat,
            "card_contract": restoreShareId == nil ? "session_share_v2" : "session_share",
            "access_mode": canChat ? "collaborate" : canFork ? "fork" : "view",
            "conversation_id": conversationId,
        ]
        if let clientRequestId, !clientRequestId.isEmpty {
            body["client_request_id"] = clientRequestId
        }
        if let restoreShareId, !restoreShareId.isEmpty {
            body["restore_share_id"] = restoreShareId
        }
        return try await APIClient.shared.post(
            path: Endpoints.IM.sessionShares,
            body: body
        )
    }

    func listShareableSessions(organizationId: String) async throws -> [RecentSession] {
        let response: RecentSessionListResponse = try await APIClient.shared.get(
            path: Endpoints.Chat.sessionsAll,
            query: [
                "organization_id": organizationId,
                "status": "active",
                "limit": "80",
                "offset": "0",
            ]
        )
        return response.sessions.filter { !$0.id.isEmpty }
    }
}

/// 对话接力独立领域服务。交接包不是普通消息 metadata 的可变副本；卡片只持有 id，
/// 所有状态与材料权限都以这些端点的实时结果为准。
struct IMHandoffService: Sendable {
    func create(
        conversationId: String,
        goal: String,
        recipientIds: [String],
        references: [(type: String, resourceId: String)]
    ) async throws -> IMHandoffPackage {
        try await APIClient.shared.post(
            path: Endpoints.IM.handoffs,
            body: [
                "conversation_id": conversationId,
                "goal": goal,
                "progress": [],
                "next_steps": [],
                "risks": [],
                "scope": "continuable",
                "recipients": recipientIds,
                "references": references.map { ["ref_type": $0.type, "resource_id": $0.resourceId] },
                "send": true,
            ]
        )
    }

    func fetch(id: String) async throws -> IMHandoffPackage {
        try await APIClient.shared.get(path: Endpoints.IM.handoff(id))
    }

    func act(id: String, action: IMHandoffAction, note: String = "") async throws -> IMHandoffPackage {
        try await APIClient.shared.post(
            path: Endpoints.IM.handoffActions(id),
            body: ["action": action.rawValue, "note": note]
        )
    }

    func revoke(id: String) async throws -> IMHandoffPackage {
        try await APIClient.shared.post(path: Endpoints.IM.handoffRevoke(id), body: [:])
    }

    func takeOver(id: String, agentId: String, workspaceId: String) async throws -> ChatSession {
        try await APIClient.shared.post(
            path: Endpoints.IM.handoffTakeOver(id),
            body: ["agent_id": agentId, "workspace_id": workspaceId]
        )
    }
}

struct IMConversationLabelsResult: Decodable, Sendable, Equatable {
    let conversationId: String
    let labels: [IMConversationLabel]

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case labels
    }
}

protocol IMConversationLabelServing: Sendable {
    func list(organizationId: String) async throws -> [IMConversationLabel]
    func create(organizationId: String, name: String, color: String) async throws -> IMConversationLabel
    func update(labelId: String, name: String, color: String) async throws -> IMConversationLabel
    func delete(labelId: String) async throws
    func add(conversationId: String, labelIds: [String]) async throws -> [IMConversationLabel]
    func remove(conversationId: String, labelId: String) async throws -> [IMConversationLabel]
}

struct IMConversationLabelService: IMConversationLabelServing {
    func list(organizationId: String) async throws -> [IMConversationLabel] {
        try await APIClient.shared.get(
            path: Endpoints.IM.labels,
            query: ["organization_id": organizationId]
        )
    }

    func create(
        organizationId: String,
        name: String,
        color: String
    ) async throws -> IMConversationLabel {
        try await APIClient.shared.post(
            path: Endpoints.IM.labels,
            body: [
                "organization_id": organizationId,
                "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                "color": color,
            ]
        )
    }

    func update(labelId: String, name: String, color: String) async throws -> IMConversationLabel {
        try await APIClient.shared.patch(
            path: Endpoints.IM.label(labelId),
            body: [
                "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                "color": color,
            ]
        )
    }

    func delete(labelId: String) async throws {
        let _: IMEmptyConversationAction = try await APIClient.shared.delete(
            path: Endpoints.IM.label(labelId)
        )
    }

    func add(conversationId: String, labelIds: [String]) async throws -> [IMConversationLabel] {
        let result: IMConversationLabelsResult = try await APIClient.shared.post(
            path: Endpoints.IM.conversationLabels(conversationId),
            body: ["label_ids": labelIds]
        )
        return result.labels
    }

    func remove(conversationId: String, labelId: String) async throws -> [IMConversationLabel] {
        let result: IMConversationLabelsResult = try await APIClient.shared.delete(
            path: Endpoints.IM.conversationLabel(conversationId, labelId)
        )
        return result.labels
    }
}

@MainActor
@Observable
final class IMConversationLabelStore {
    static let shared = IMConversationLabelStore()
    static let systemMentionLabel = IMConversationLabel.systemMention

    private(set) var labels: [IMConversationLabel] = []
    private(set) var organizationId: String?
    private(set) var loadError: String?
    var selectedLabelIds: Set<String> = []

    private let service: any IMConversationLabelServing
    private var loadGeneration = 0

    init(service: any IMConversationLabelServing = IMConversationLabelService()) {
        self.service = service
    }

    func load(organizationId: String) async {
        guard !organizationId.isEmpty else {
            clear()
            return
        }
        if self.organizationId != organizationId {
            self.organizationId = organizationId
            selectedLabelIds = []
            labels = [Self.systemMentionLabel]
            loadGeneration += 1
        }
        let generation = loadGeneration
        do {
            let custom = try await service.list(organizationId: organizationId)
            guard generation == loadGeneration, self.organizationId == organizationId else { return }
            labels = [Self.systemMentionLabel] + custom.filter { $0.id != Self.systemMentionLabel.id }
            selectedLabelIds.formIntersection(Set(labels.map(\.id)))
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            guard generation == loadGeneration else { return }
            loadError = error.localizedDescription
        }
    }

    func clear() {
        loadGeneration += 1
        organizationId = nil
        labels = []
        selectedLabelIds = []
        loadError = nil
    }

    func toggleFilter(_ labelId: String) {
        if selectedLabelIds.contains(labelId) {
            selectedLabelIds.remove(labelId)
        } else {
            selectedLabelIds.insert(labelId)
        }
    }

    func matches(_ conversation: IMConversation) -> Bool {
        selectedLabelIds.isEmpty || selectedLabelIds.isSubset(of: Set(conversation.labels.map(\.id)))
    }

    func create(name: String, color: String) async throws -> IMConversationLabel {
        guard let organizationId else { throw URLError(.badURL) }
        let created = try await service.create(organizationId: organizationId, name: name, color: color)
        labels = [Self.systemMentionLabel] + (labels + [created])
            .filter { !$0.isSystem && $0.id != Self.systemMentionLabel.id }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return created
    }

    func update(labelId: String, name: String, color: String) async throws {
        let updated = try await service.update(labelId: labelId, name: name, color: color)
        labels = labels.map { label in
            label.id == labelId
                ? IMConversationLabel(
                    id: updated.id,
                    name: updated.name,
                    color: updated.color,
                    isSystem: updated.isSystem,
                    conversationCount: label.conversationCount
                )
                : label
        }
        IMConversationStore.shared.replaceLabelMetadata(updated)
    }

    func delete(labelId: String) async throws {
        try await service.delete(labelId: labelId)
        labels.removeAll { $0.id == labelId }
        selectedLabelIds.remove(labelId)
        IMConversationStore.shared.removeLabel(labelId)
    }

    func setAssigned(
        conversationId: String,
        labelId: String,
        assigned: Bool
    ) async throws -> [IMConversationLabel] {
        let updated = assigned
            ? try await service.add(conversationId: conversationId, labelIds: [labelId])
            : try await service.remove(conversationId: conversationId, labelId: labelId)
        IMConversationStore.shared.setLabels(updated, conversationId: conversationId)
        if let organizationId { await load(organizationId: organizationId) }
        return updated
    }

    func applyRealtime(conversationId: String, labels: [IMConversationLabel]) {
        IMConversationStore.shared.setLabels(labels, conversationId: conversationId)
    }
}

/// 置顶接口不需要业务响应体；保留宽松 Decodable 以适配标准 API 信封拆包。
private struct IMEmptyConversationAction: Decodable, Sendable {}
