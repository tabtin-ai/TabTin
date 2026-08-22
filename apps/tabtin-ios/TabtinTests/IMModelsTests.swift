import XCTest
@testable import Tabtin

/// TabChat IM 模型解码测试：锁定字段与后端 `tabchat.schemas` 的映射。
final class IMModelsTests: XCTestCase {
    func testGroupCreationRetryReusesRequestIdentityUntilIntentChanges() {
        let first = resolveIMGroupCreationAttempt(
            previous: nil,
            organizationId: "org-1",
            name: "项目群",
            memberIds: ["user-b", "user-a"],
            externalContactIds: ["contact-1"],
            requestIdFactory: { "request-1" }
        )
        let retry = resolveIMGroupCreationAttempt(
            previous: first,
            organizationId: "org-1",
            name: "项目群",
            memberIds: ["user-a", "user-b"],
            externalContactIds: ["contact-1"],
            requestIdFactory: { "request-2" }
        )
        let changed = resolveIMGroupCreationAttempt(
            previous: retry,
            organizationId: "org-1",
            name: "项目群（新）",
            memberIds: ["user-a", "user-b"],
            externalContactIds: ["contact-1"],
            requestIdFactory: { "request-3" }
        )

        XCTAssertEqual(retry.clientRequestId, "request-1")
        XCTAssertEqual(retry.memberIds, ["user-a", "user-b"])
        XCTAssertEqual(changed.clientRequestId, "request-3")
    }

    @MainActor
    func testConversationLabelStoreExposesSystemFilterAndUsesANDSemantics() async throws {
        let service = IMConversationLabelServiceStub(labels: [
            IMConversationLabel(id: "label-a", name: "客户"),
            IMConversationLabel(id: "label-b", name: "跟进"),
        ])
        let store = IMConversationLabelStore(service: service)
        await store.load(organizationId: "org-1")
        XCTAssertEqual(store.labels.first?.id, "sys:mention")
        XCTAssertTrue(store.labels.first?.isSystem == true)

        let conversation = try JSONDecoder().decode(IMConversation.self, from: Data("""
        {
          "id":"conv-1","organization_id":"org-1","space_id":null,"space_name":"",
          "is_team_space_channel":false,"type":2,"name":"群聊","avatar_url":"",
          "member_count":2,"is_archived":false,"last_message_at":null,
          "last_message_preview":"","unread_count":0,"created_at":"2026-08-20T00:00:00Z",
          "dm_peer_user_id":null,"pinned":false,"is_muted":false,
          "labels":[{"id":"label-a","name":"客户"},{"id":"label-b","name":"跟进"}]
        }
        """.utf8))

        store.selectedLabelIds = ["label-a", "label-b"]
        XCTAssertTrue(store.matches(conversation))
        store.selectedLabelIds.insert("label-c")
        XCTAssertFalse(store.matches(conversation))
    }

    func testAgentTaskThreadDecodesExecutionAndProjectScopesSeparately() throws {
        let json = Data("""
        {
          "session_id": "session-1",
          "thread_id": "thread-1",
          "space_id": "project-1",
          "workspace_id": "workspace-1",
          "organization_id": "org-1",
          "title": "Agent 问询",
          "default_prompt": "source context",
          "source_message_ids": [42, 43]
        }
        """.utf8)

        let result = try JSONDecoder().decode(IMAgentTaskThreadResult.self, from: json)

        XCTAssertEqual(result.sessionId, "session-1")
        XCTAssertEqual(result.projectId, "project-1")
        XCTAssertEqual(result.workspaceId, "workspace-1")
        XCTAssertEqual(result.sourceMessageIds, [42, 43])
    }

    func testShortMessageListDoesNotRequestEarlierHistoryDuringBounce() {
        XCTAssertFalse(
            IMEarlierHistoryLoadPolicy.shouldRequest(
                hasScrollableContent: false,
                distanceFromTop: 0,
                threshold: 120,
                isUserInteracting: true,
                isArmed: true
            )
        )
    }

    func testScrollableMessageListRequestsEarlierHistoryAtTopDuringUserScroll() {
        XCTAssertTrue(
            IMEarlierHistoryLoadPolicy.shouldRequest(
                hasScrollableContent: true,
                distanceFromTop: 80,
                threshold: 120,
                isUserInteracting: true,
                isArmed: true
            )
        )
    }

    func testEarlierHistoryRetryOnlyAppearsForFailedPagination() {
        XCTAssertEqual(
            IMEarlierHistoryRetryPolicy.errorMessage(
                historyError: L10n.Messages.networkError,
                messageCount: 5,
                hasMoreHistory: true,
                isLoadingHistory: false
            ),
            L10n.Messages.networkError
        )
        XCTAssertNil(
            IMEarlierHistoryRetryPolicy.errorMessage(
                historyError: L10n.Messages.networkError,
                messageCount: 0,
                hasMoreHistory: true,
                isLoadingHistory: false
            )
        )
        XCTAssertNil(
            IMEarlierHistoryRetryPolicy.errorMessage(
                historyError: L10n.Messages.networkError,
                messageCount: 5,
                hasMoreHistory: true,
                isLoadingHistory: true
            )
        )
    }

    func testConversationDecodesBackendPayload() throws {
        let json = Data("""
        {
          "id": "conv-1",
          "organization_id": "org-1",
          "space_id": null,
          "space_name": "",
          "is_team_space_channel": false,
          "is_external": true,
          "type": 2,
          "name": "项目群",
          "avatar_url": "",
          "member_count": 3,
          "is_archived": false,
          "last_message_at": "2026-07-20T10:00:00+00:00",
          "last_message_preview": "在吗",
          "unread_count": 5,
          "created_at": "2026-07-01T00:00:00+00:00",
          "dm_peer_user_id": null,
          "pinned": true,
          "is_muted": false,
          "labels": [{"id": "l1", "name": "重要", "color": "#ff0000"}]
        }
        """.utf8)

        let conv = try JSONDecoder().decode(IMConversation.self, from: json)
        XCTAssertEqual(conv.id, "conv-1")
        XCTAssertEqual(conv.organizationId, "org-1")
        XCTAssertNil(conv.spaceId)
        XCTAssertEqual(conv.type, 2)
        XCTAssertEqual(conv.conversationType, .group)
        XCTAssertEqual(conv.name, "项目群")
        XCTAssertEqual(conv.memberCount, 3)
        XCTAssertEqual(conv.lastMessagePreview, "在吗")
        XCTAssertEqual(conv.unreadCount, 5)
        XCTAssertTrue(conv.isExternal)
        XCTAssertTrue(conv.pinned)
        XCTAssertFalse(conv.isMuted)
        XCTAssertEqual(conv.labels.map(\.id), ["l1"])
        XCTAssertEqual(conv.labels.first?.name, "重要")
        XCTAssertEqual(conv.labels.first?.conversationCount, 0)
    }

    func testDMConversationType() throws {
        let json = Data("""
        {
          "id": "dm-1", "organization_id": "org-1", "space_id": null,
          "space_name": "", "is_team_space_channel": false, "type": 1,
          "name": "张三", "avatar_url": "", "member_count": 2, "is_archived": false,
          "last_message_at": null, "last_message_preview": "", "unread_count": 0,
          "created_at": "2026-07-01T00:00:00+00:00", "dm_peer_user_id": "user-2",
          "pinned": false, "is_muted": false
        }
        """.utf8)

        let conv = try JSONDecoder().decode(IMConversation.self, from: json)
        XCTAssertEqual(conv.conversationType, .dm)
        XCTAssertEqual(conv.dmPeerUserId, "user-2")
        XCTAssertNil(conv.lastMessageAt)
        XCTAssertEqual(conv.unreadCount, 0)
        XCTAssertFalse(conv.isExternal, "旧会话目录缺少 is_external 时必须保持可解码")
    }

    func testRemovedMemberDirectMessageIsReadOnlyAndFilteredFromForwardTargets() throws {
        let staleJSON = Data("""
        {
          "id": "dm-stale", "organization_id": "org-1", "space_id": null,
          "space_name": "", "is_team_space_channel": false, "type": 1,
          "name": "旧成员", "avatar_url": "", "member_count": 1, "is_archived": false,
          "last_message_at": null, "last_message_preview": "历史", "unread_count": 0,
          "created_at": "2026-07-01T00:00:00Z", "dm_peer_user_id": "user-2",
          "pinned": false, "is_muted": false
        }
        """.utf8)
        let activeJSON = Data("""
        {
          "id": "group-active", "organization_id": "org-1", "space_id": null,
          "space_name": "", "is_team_space_channel": false, "type": 2,
          "name": "群聊", "avatar_url": "", "member_count": 3, "is_archived": false,
          "last_message_at": null, "last_message_preview": "", "unread_count": 0,
          "created_at": "2026-07-01T00:00:00Z", "dm_peer_user_id": null,
          "pinned": false, "is_muted": false
        }
        """.utf8)
        let stale = try JSONDecoder().decode(IMConversation.self, from: staleJSON)
        let active = try JSONDecoder().decode(IMConversation.self, from: activeJSON)

        XCTAssertTrue(stale.isRemovedMemberDirectMessage)
        XCTAssertFalse(stale.canReceiveMessages)
        XCTAssertEqual(imForwardTargets([stale, active], excluding: "source").map(\.id), ["group-active"])
    }

    func testConversationListDecodes() throws {
        let list = try JSONDecoder().decode([IMConversation].self, from: Data("[]".utf8))
        XCTAssertTrue(list.isEmpty)
    }

    func testIncomingSessionShareListDefaultsToEmptyWhenServerOmitsShares() throws {
        let response = try JSONDecoder().decode(
            IMSessionShareListResponse.self,
            from: Data("{}".utf8)
        )
        XCTAssertTrue(response.shares.isEmpty)
    }

    func testMessageListContentKeyDifferentiatesConversations() {
        let first = IMMessageListContentKey(
            conversationId: "dm-first", messages: [], pending: [], typingActive: false, peerReadWaterline: 0,
            initialHistoryReady: false
        )
        let second = IMMessageListContentKey(
            conversationId: "dm-second", messages: [], pending: [], typingActive: false, peerReadWaterline: 0,
            initialHistoryReady: false
        )

        XCTAssertNotEqual(first, second)
    }

    func testInitialScrollIgnoresEmptyListPadding() {
        XCTAssertFalse(
            IMMessageListInitialScrollPolicy.hasRenderableContent(
                messageCount: 0,
                pendingCount: 0,
                typingActive: false
            )
        )
        XCTAssertTrue(
            IMMessageListInitialScrollPolicy.hasRenderableContent(
                messageCount: 1,
                pendingCount: 0,
                typingActive: false
            )
        )
    }

    func testMessageListProjectionKeepsLatestContentForDuplicateIdentifier() {
        let original = IMMessage(
            id: 20,
            seq: 20,
            conversationId: "conv-1",
            senderId: "user-1",
            content: "原消息",
            messageType: IMMessageType.text.rawValue
        )
        let refreshed = IMMessage(
            id: 20,
            seq: 20,
            conversationId: "conv-1",
            senderId: "user-1",
            content: "刷新后的消息",
            messageType: IMMessageType.text.rawValue
        )

        let projected = IMMessageListProjection.uniqueMessages([original, refreshed])

        XCTAssertEqual(projected.map(\.id), [20])
        XCTAssertEqual(projected.first?.content, "刷新后的消息")
    }

    func testConversationDoesNotShowEmptyStateBeforeInitialHistoryCompletes() {
        XCTAssertFalse(
            IMConversationInitialPresentation.shouldShowEmptyState(
                messageCount: 0,
                pendingCount: 0,
                hasCompletedInitialHistoryLoad: false,
                isLoadingHistory: false
            )
        )
        XCTAssertTrue(
            IMConversationInitialPresentation.shouldShowEmptyState(
                messageCount: 0,
                pendingCount: 0,
                hasCompletedInitialHistoryLoad: true,
                isLoadingHistory: false
            )
        )
    }

    @MainActor
    func testPersistentIMMessageCachePreservesResourceCardPayload() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("IMModelsTests.cardCache.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = IMMessageFileSnapshotCache(maxMessages: 10, directoryURL: directory)
        let message = IMMessage(
            id: 20,
            seq: 20,
            conversationId: "conv-card",
            senderId: "u1",
            content: "[文档] 方案",
            messageType: IMMessageType.text.rawValue,
            metadata: IMMessageMetadata(
                card: IMResourceCard(type: "document", name: "方案", resourceId: "doc-1")
            )
        )

        cache.store(conversationId: "conv-card", messages: [message])

        let restored = await waitForSnapshot(cache: cache, conversationId: "conv-card").first
        XCTAssertEqual(restored?.resourceCard?.resourceId, "doc-1")
        XCTAssertEqual(restored?.resourceCard?.displayName, "方案")
    }

    private func waitForSnapshot(
        cache: IMMessageFileSnapshotCache,
        conversationId: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async -> [IMMessage] {
        for _ in 0..<100 {
            let messages = await cache.messagesAsync(conversationId: conversationId)
            if !messages.isEmpty { return messages }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for IM message snapshot", file: file, line: line)
        return []
    }

    /// 会话置顶由 Django IM 管理，不再依赖传输层会话身份。
    func testConversationPinContract() throws {
        let response = try JSONDecoder().decode(
            IMConversationPinResult.self,
            from: Data(#"{"pinned":true}"#.utf8)
        )

        XCTAssertTrue(response.pinned)
        XCTAssertEqual(Endpoints.IM.pin("conv-1"), "/im/conversations/conv-1/pin")
        XCTAssertEqual(djangoIMConversationPinBody(true)["pinned"] as? Bool, true)
        XCTAssertEqual(djangoIMConversationMuteBody(false)["muted"] as? Bool, false)
    }

    func testExplicitMessageMutableStateDecodesAsAuthoritative() throws {
        let message = try JSONDecoder().decode(
            IMMessage.self,
            from: Data(#"""
            {
                "id": 7,
                "seq": 7,
                "conversation_id": "conv-1",
                "sender_id": "user-2",
                "content": "hello",
                "message_type": 1,
                "is_pinned": false,
                "reactions": {}
            }
            """#.utf8)
        )

        XCTAssertTrue(message.pinStateKnown)
        XCTAssertTrue(message.reactionStateKnown)
    }

    func testOmittedMessageMutableStateRemainsUnknownForLegacyPayloads() throws {
        let message = try JSONDecoder().decode(
            IMMessage.self,
            from: Data(#"""
            {
                "id": 8,
                "seq": 8,
                "conversation_id": "conv-1",
                "sender_id": "user-2",
                "content": "legacy",
                "message_type": 1
            }
            """#.utf8)
        )

        XCTAssertFalse(message.pinStateKnown)
        XCTAssertFalse(message.reactionStateKnown)
    }

    /// 新建私聊/群聊与桌面端共用 Django IM 契约。
    func testCreateConversationRoutesThroughDjangoIM() throws {
        XCTAssertEqual(Endpoints.IM.createDM, "/im/conversations/dm")
        XCTAssertEqual(Endpoints.IM.createGroup, "/im/conversations/group")
        XCTAssertFalse(Endpoints.IM.createDM.contains("/im/v2/"))
        XCTAssertFalse(Endpoints.IM.createGroup.contains("/im/v2/"))

        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tabtin/Core/IM/IMConversationService.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let productionService = try XCTUnwrap(
            source.components(separatedBy: "struct IMConversationService: IMConversationServing").last
        )

        XCTAssertTrue(
            productionService.contains("\"external_contact_id\": externalContactId"),
            "生产会话服务必须把外部联系人身份交给 Django DM 契约"
        )
        XCTAssertTrue(
            productionService.contains("\"client_request_id\": clientRequestId"),
            "创建群聊必须使用调用方持有的幂等键，确保同一意图重试不会重复建群"
        )
    }

    /// 交接创建不能只留一个未挂载的 Sheet；长按消息必须能进入真实 Django handoff 流程。
    func testHandoffComposerIsReachableFromMessageActions() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tabtin/Features/TabChat/IMConversationScreen.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("@State private var handoffSourceMessage: IMMessage?"))
        XCTAssertTrue(source.contains(".sheet(item: $handoffSourceMessage)"))
        XCTAssertTrue(source.contains("IMHandoffComposerSheet("))
        XCTAssertTrue(source.contains("Label(\"整理为交接\", systemImage: \"arrow.left.arrow.right\")"))
    }

    /// 外部联系人列表、邀请与消息数据面共用 Django IM 路由。
    func testExternalContactRoutesThroughDjangoIM() {
        XCTAssertEqual(Endpoints.IM.externalContacts, "/im/external-contacts")
        XCTAssertEqual(Endpoints.IM.discoverExternalContact, "/im/external-contacts/discover")
        XCTAssertEqual(Endpoints.IM.externalContactInvitations, "/im/external-contact-invitations")
        XCTAssertEqual(Endpoints.IM.acceptExternalContact, "/im/external-contacts/accept")
        XCTAssertEqual(Endpoints.IM.externalContact("contact-1"), "/im/external-contacts/contact-1")
        XCTAssertEqual(Endpoints.IM.externalContactInvitation("invite-1"), "/im/external-contact-invitations/invite-1")
        XCTAssertFalse(Endpoints.IM.externalContacts.contains("/im/v2/"))
    }

    /// 回归：消息首页必须和会话目录一起激活外部联系人目录。
    /// 否则用户停留在消息页时只会请求 conversation-catalog，通讯录入口看起来像标题，
    /// 外部联系人接口始终为 0 次请求，最终只看得到外部群、看不到外部联系人。
    func testMessagesTabPreloadsExternalContactDirectory() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tabtin/Features/Messages/MessagesTabRoot.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(
            source.contains("await externalContactStore.reload(organizationId: organizationId)"),
            "消息首页进入组织时必须触发外部联系人目录加载"
        )
    }

    /// 冷启动会恢复到上次停留的一级 Tab；若直接恢复到消息首页，它必须自行建立
    /// Centrifugo 通道，不能依赖用户先进入任务页或某个会话详情。
    func testMessagesTabConnectsPersonalRealtimeChannel() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tabtin/Features/Messages/MessagesTabRoot.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(
            source.contains("CentrifugoClient.shared.connect()"),
            "消息首页恢复组织时必须主动建立个人实时通道"
        )
    }

    @MainActor
    func testExternalContactDirectoryKeepsFriendsAndResolvesPeerProfile() async {
        let friend = ExternalContact(
            contactId: "contact-friend",
            organizationId: "org-a",
            peerOrganizationId: "org-b",
            peerUserId: "peer-friend",
            displayName: "外部联系人甲",
            avatarURL: "https://example.com/friend.png",
            relationship: "friend",
            suspendedReason: nil,
            isRestorable: false,
            updatedAt: "2026-08-17T00:00:00Z",
            peerOrganizationName: "外部团队"
        )
        let pending = ExternalContact(
            contactId: "contact-pending",
            organizationId: "org-a",
            peerOrganizationId: "org-c",
            peerUserId: "peer-pending",
            displayName: "待确认联系人",
            avatarURL: "",
            relationship: "pending",
            suspendedReason: nil,
            isRestorable: false,
            updatedAt: "2026-08-17T00:00:00Z",
            peerOrganizationName: "另一个团队"
        )
        let store = ExternalContactDirectoryStore { organizationId in
            XCTAssertEqual(organizationId, "org-a")
            return [pending, friend]
        }

        await store.reload(organizationId: "org-a")

        XCTAssertEqual(store.contacts, [friend])
        XCTAssertEqual(store.contact(peerUserId: "peer-friend")?.displayName, "外部联系人甲")
        XCTAssertNil(store.loadError)
    }

    /// 回归：tabchat 信封 `code` 是整数 200（与 auth 的字符串 code 分叉），
    /// 必须能经 `ApiEnvelope` 正常解包——否则会话列表在真实后端永远解码失败。
    /// 覆盖此前只测裸对象/裸数组、绕过信封的盲区。
    func testConversationListDecodesThroughEnvelopeWithIntCode() throws {
        let json = Data("""
        {
          "success": true,
          "code": 200,
          "message": "ok",
          "data": [
            {
              "id": "conv-1", "organization_id": "org-1", "space_id": null,
              "space_name": "", "is_team_space_channel": false, "type": 1,
              "name": "张三", "avatar_url": "", "member_count": 2, "is_archived": false,
              "last_message_at": null, "last_message_preview": "", "unread_count": 0,
              "created_at": "2026-07-01T00:00:00+00:00", "dm_peer_user_id": "user-2",
              "pinned": false, "is_muted": false
            }
          ]
        }
        """.utf8)

        let envelope = try JSONDecoder().decode(ApiEnvelope<[IMConversation]>.self, from: json)
        XCTAssertTrue(envelope.success)
        XCTAssertEqual(envelope.code, "200")
        XCTAssertEqual(envelope.data?.count, 1)
        XCTAssertEqual(envelope.data?.first?.id, "conv-1")
    }

    /// 回归：创建群聊额度耗尽时，后端会把业务错误详情放在
    /// `data.error_code`，该对象不是成功态 `IMCreateGroupResult`。
    /// 错误信封必须跳过成功数据解码，并保留可供 UI 分流的业务码。
    func testCreateGroupQuotaErrorEnvelopePreservesBusinessError() throws {
        let message = "当前套餐群组额度已用完，请升级套餐或购买群组扩容包。"
        let json = Data("""
        {
          "success": false,
          "message": "\(message)",
          "data": {
            "error_code": "ENTITLEMENT_GROUP_LIMIT_EXCEEDED"
          },
          "code": 403
        }
        """.utf8)

        let envelope = try JSONDecoder().decode(ApiEnvelope<IMCreateGroupResult>.self, from: json)

        XCTAssertFalse(envelope.success)
        XCTAssertNil(envelope.data)
        XCTAssertEqual(envelope.code, "ENTITLEMENT_GROUP_LIMIT_EXCEEDED")
        XCTAssertEqual(envelope.message, message)
    }

    func testCreateGroupQuotaHTTPErrorPreservesNestedBusinessCode() {
        let message = "当前套餐群组额度已用完，请升级套餐或购买群组扩容包。"
        let json = Data("""
        {
          "success": false,
          "message": "\(message)",
          "data": {
            "error_code": "ENTITLEMENT_GROUP_LIMIT_EXCEEDED"
          },
          "code": 403
        }
        """.utf8)

        let error = APIClient.responseError(statusCode: 403, data: json)

        XCTAssertEqual(error.businessCode, "ENTITLEMENT_GROUP_LIMIT_EXCEEDED")
        XCTAssertTrue(error.localizedDescription.contains(message))
    }

    func testCreateGroupQuotaErrorUsesFriendlyPresentation() {
        let error = APIError.apiErrorWithCode(
            code: "ENTITLEMENT_GROUP_LIMIT_EXCEEDED",
            message: "当前套餐群组额度已用完，请升级套餐或购买群组扩容包。"
        )

        let presentation = IMCreateGroupErrorPresentation.resolve(error)

        XCTAssertEqual(presentation, .quotaExceeded)
        XCTAssertFalse(presentation.localizedMessage.contains("ENTITLEMENT_"))
        XCTAssertFalse(presentation.localizedMessage.contains("数据解析失败"))
    }

    // MARK: - IMMessage（Phase B）

    /// 消息解码：锁定 `_serialize_message` 字段映射，含实际多下发的
    /// `sender_type` / `is_pinned` / `edited_at` 与 `metadata.client_request_id`。
    func testMessageDecodesBackendPayload() throws {
        let json = Data("""
        {
          "id": 101, "seq": 45, "conversation_id": "conv-1", "sender_id": "user-2",
          "sender_type": "user", "sender_name": "张三", "content": "在吗",
          "message_type": 1, "reply_to_id": 99,
          "reply_to_preview": {"content": "上一句", "sender_id": "user-3"},
          "has_attachment": false, "metadata": {"client_request_id": "req-abc"},
          "created_at": "2026-07-20T10:00:00+00:00", "is_deleted": false,
          "edited_at": null, "is_pinned": false,
          "reactions": {"👍": ["user-2", "user-3"]}
        }
        """.utf8)

        let msg = try JSONDecoder().decode(IMMessage.self, from: json)
        XCTAssertEqual(msg.id, 101)
        XCTAssertEqual(msg.seq, 45)
        XCTAssertEqual(msg.conversationId, "conv-1")
        XCTAssertEqual(msg.senderId, "user-2")
        XCTAssertEqual(msg.senderName, "张三")
        XCTAssertEqual(msg.typedMessageType, .text)
        XCTAssertFalse(msg.isFromAgent)
        XCTAssertEqual(msg.replyToId, 99)
        XCTAssertEqual(msg.replyToPreview?.senderId, "user-3")
        XCTAssertEqual(msg.metadata?.clientRequestId, "req-abc")
        XCTAssertEqual(msg.reactions["👍"], ["user-2", "user-3"])
    }

    /// Agent 发的消息 + 后端漏发若干可选字段（sender_name/has_attachment/reactions 缺省）时容错解码。
    func testMessageToleratesMissingOptionalFields() throws {
        let json = Data("""
        {
          "id": 7, "seq": 1, "conversation_id": "c", "sender_id": "agent-9",
          "sender_type": "agent", "content": "已完成", "message_type": 1,
          "reply_to_id": null, "metadata": {}
        }
        """.utf8)

        let msg = try JSONDecoder().decode(IMMessage.self, from: json)
        XCTAssertTrue(msg.isFromAgent)
        XCTAssertEqual(msg.senderName, "")
        XCTAssertFalse(msg.hasAttachment)
        XCTAssertNil(msg.replyToId)
        XCTAssertTrue(msg.reactions.isEmpty)
        XCTAssertNil(msg.metadata?.clientRequestId)
    }

    // MARK: - IMConversationDetail / IMMember（Phase B）

    func testConversationDetailWithMembersDecodes() throws {
        let json = Data("""
        {
          "id": "conv-1", "organization_id": "org-1", "space_id": null, "space_name": "",
          "is_team_space_channel": false, "type": 2, "name": "项目群", "avatar_url": "",
          "dm_hash": null, "member_count": 2, "is_archived": false,
          "last_message_at": null, "last_message_preview": "", "created_by": "user-1",
          "created_at": "2026-07-01T00:00:00+00:00",
          "members": [
            {"member_type": "user", "user_id": "user-1", "nickname": "我", "username": "me",
             "avatar": "", "role": 1, "is_muted": false, "pinned": false, "joined_at": null},
            {"member_type": "agent", "agent_id": "agent-9", "nickname": "助手", "username": "",
             "avatar": "", "role": 0, "is_muted": false, "pinned": false, "joined_at": null}
          ],
          "labels": [], "has_unread_mention": true
        }
        """.utf8)

        let detail = try JSONDecoder().decode(IMConversationDetail.self, from: json)
        XCTAssertEqual(detail.conversationType, .group)
        XCTAssertEqual(detail.members.count, 2)
        XCTAssertEqual(detail.members[0].id, "user:user-1")
        XCTAssertEqual(detail.members[0].displayName, "我")
        XCTAssertEqual(detail.members[1].typedMemberType, .agent)
        XCTAssertEqual(detail.members[1].id, "agent:agent-9")
        XCTAssertTrue(detail.hasUnreadMention)
        XCTAssertFalse(detail.isExternal, "旧响应缺少 is_external 时必须保持可解码")
    }

    func testConversationDetailDecodesExternalGroupFlag() throws {
        let json = Data("""
        {
          "id": "external-group", "organization_id": "org-1", "type": 2,
          "is_external": true
        }
        """.utf8)

        let detail = try JSONDecoder().decode(IMConversationDetail.self, from: json)
        XCTAssertTrue(detail.isExternal)
    }

    func testMemberDecodesExternalAndAgentOwnershipMetadata() throws {
        let json = Data("""
        {
          "member_type": "agent", "agent_id": "agent-1",
          "owner_user_id": "owner-1", "owner_display_name": "沈庚涛",
          "is_execution_online": true, "is_external": true,
          "organization_name": "外部组织"
        }
        """.utf8)

        let member = try JSONDecoder().decode(IMMember.self, from: json)

        XCTAssertEqual(member.ownerUserId, "owner-1")
        XCTAssertEqual(member.ownerDisplayName, "沈庚涛")
        XCTAssertEqual(member.isExecutionOnline, true)
        XCTAssertTrue(member.isExternal)
        XCTAssertEqual(member.organizationName, "外部组织")
    }

    func testExternalConversationDecodesDirectoryScopeAndServerSendGate() throws {
        let json = Data("""
        {
          "id": "external-group", "organization_id": "org-host",
          "participant_organization_id": "org-peer", "directory_scope_id": "org-peer",
          "is_external": true, "type": 2, "name": "跨组织协作", "avatar_url": "",
          "member_count": 3, "is_archived": false, "last_message_at": null,
          "last_message_preview": "", "unread_count": 0, "last_message_seq": 0,
          "created_at": "2026-08-20T00:00:00Z", "dm_peer_user_id": null,
          "pinned": false, "is_muted": false, "can_send": false,
          "space_id": null, "space_name": "", "is_team_space_channel": false
        }
        """.utf8)

        let conversation = try JSONDecoder().decode(IMConversation.self, from: json)

        XCTAssertEqual(conversation.organizationId, "org-host")
        XCTAssertEqual(conversation.directoryOrganizationId, "org-peer")
        XCTAssertFalse(conversation.canReceiveMessages)
        XCTAssertTrue(isIMConversationReadOnly(snapshot: conversation, detail: nil))
    }

    func testResourceCardDecodesAuthoritativeNavigationFields() throws {
        let json = Data("""
        {
          "id": 8, "seq": 8, "conversation_id": "conv-1", "sender_id": "user-2",
          "sender_type": "user", "content": "", "message_type": 1,
          "metadata": {"card": {
            "type": "document", "name": "项目说明",
            "resource_id": "10000000-0000-0000-0000-000000000001",
            "space_id": "20000000-0000-0000-0000-000000000002",
            "organization_id": "30000000-0000-0000-0000-000000000003",
            "hint_carrier_app_id": "tabdoc"
          }}
        }
        """.utf8)

        let message = try JSONDecoder().decode(IMMessage.self, from: json)
        let card = try XCTUnwrap(message.resourceCard)
        XCTAssertEqual(card.typedType, .document)
        XCTAssertEqual(card.resourceId, "10000000-0000-0000-0000-000000000001")
        XCTAssertEqual(card.spaceId, "20000000-0000-0000-0000-000000000002")
        XCTAssertEqual(card.organizationId, "30000000-0000-0000-0000-000000000003")
        XCTAssertEqual(card.hintCarrierAppId, "tabdoc")
    }

    func testWorkspaceCardsKeepSpaceIdentityAndRejectMissingLocators() throws {
        let workspace = try JSONDecoder().decode(IMMessage.self, from: Data(
            #"{"id":81,"seq":81,"conversation_id":"conv-1","sender_id":"user-1","message_type":1,"metadata":{"card":{"type":"space","space_id":" workspace-1 ","name":"研发 Workspace","icon":"🚀"}}}"#.utf8
        ))
        let agentWorkspace = try JSONDecoder().decode(IMMessage.self, from: Data(
            #"{"id":82,"seq":82,"conversation_id":"conv-1","sender_id":"user-1","message_type":1,"metadata":{"card":{"type":"agent_space","space_id":"workspace-2","name":"数据助手"}}}"#.utf8
        ))
        let missingSpaceId = try JSONDecoder().decode(IMMessage.self, from: Data(
            #"{"id":83,"seq":83,"conversation_id":"conv-1","sender_id":"user-1","message_type":1,"metadata":{"card":{"type":"space","space_id":"   ","name":"损坏卡片"}}}"#.utf8
        ))

        XCTAssertEqual(workspace.resourceCard?.spaceCard?.spaceId, "workspace-1")
        XCTAssertEqual(workspace.resourceCard?.spaceCard?.displayName, "研发 Workspace")
        XCTAssertEqual(workspace.resourceCard?.spaceCard?.icon, "🚀")
        XCTAssertEqual(agentWorkspace.resourceCard?.typedType, .agentSpace)
        XCTAssertEqual(agentWorkspace.resourceCard?.spaceCard?.spaceId, "workspace-2")
        let forwardableWorkspace = try XCTUnwrap(workspace.forwardableCard)
        XCTAssertEqual(forwardableWorkspace.kind, .space)
        XCTAssertEqual(forwardableWorkspace.requestPayload()["space_id"] as? String, "workspace-1")
        XCTAssertEqual(forwardableWorkspace.localCard.displayName, "研发 Workspace")
        XCTAssertEqual(forwardableWorkspace.localCard.icon, "🚀")
        XCTAssertTrue(workspace.canForward)
        XCTAssertTrue(missingSpaceId.hasStructuredCard)
        XCTAssertNil(missingSpaceId.resourceCard)
        XCTAssertNil(missingSpaceId.forwardableCard)
        XCTAssertFalse(missingSpaceId.canForward)
    }

    func testResourceCardOpenTargetSupportsOrganizationOnlyAndHistoricalCards() throws {
        let organizationOnly = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"document","resource_id":"doc-1","organization_id":"org-card","space_id":null}"#.utf8)
        )
        let organizationOnlyTarget = try XCTUnwrap(
            organizationOnly.resolveOpenTarget(conversationOrganizationId: "org-conversation")
        )
        XCTAssertEqual(organizationOnlyTarget.resourceType, "tabdoc")
        XCTAssertEqual(organizationOnlyTarget.organizationId, "org-card")
        XCTAssertNil(organizationOnlyTarget.spaceId)

        let historical = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"table","resource_id":"table-1","space_id":"space-1"}"#.utf8)
        )
        let historicalTarget = try XCTUnwrap(
            historical.resolveOpenTarget(conversationOrganizationId: "org-conversation")
        )
        XCTAssertEqual(historicalTarget.resourceType, "tabdata")
        XCTAssertEqual(historicalTarget.organizationId, "org-conversation")
        XCTAssertEqual(historicalTarget.spaceId, "space-1")

        let authoritativePreview = IMResourceCardPreview(
            name: "权威文档",
            spaceId: nil,
            organizationId: "org-preview",
            currentUserRole: "viewer",
            description: nil,
            previewTable: nil
        )
        let previewTarget = try XCTUnwrap(
            historical.resolveOpenTarget(
                conversationOrganizationId: "org-conversation",
                preview: authoritativePreview
            )
        )
        XCTAssertEqual(previewTarget.organizationId, "org-preview")
        XCTAssertNil(previewTarget.spaceId)

        let incompletePreview = IMResourceCardPreview(
            name: "缺少组织的预览",
            spaceId: "space-preview",
            organizationId: " ",
            currentUserRole: "viewer",
            description: nil,
            previewTable: nil
        )
        let legacyTarget = try XCTUnwrap(
            historical.resolveOpenTarget(
                conversationOrganizationId: "org-conversation",
                preview: incompletePreview
            )
        )
        XCTAssertEqual(legacyTarget.organizationId, "org-conversation")
        XCTAssertEqual(legacyTarget.spaceId, "space-1")

        let incomplete = try JSONDecoder().decode(
            IMResourceCard.self,
            from: Data(#"{"type":"document","organization_id":"org-card"}"#.utf8)
        )
        XCTAssertNil(incomplete.resolveOpenTarget(conversationOrganizationId: "org-conversation"))
    }

    func testConversationActivationRetainsOrganizationAcrossDirectoryReload() {
        XCTAssertEqual(
            resolveIMConversationActivationOrganizationId(
                initialOrganizationId: "org-before-reload",
                currentOrganizationId: nil
            ),
            "org-before-reload"
        )
        XCTAssertEqual(
            resolveIMConversationActivationOrganizationId(
                initialOrganizationId: "org-before-reload",
                currentOrganizationId: "org-after-reload"
            ),
            "org-after-reload"
        )
        XCTAssertEqual(
            resolveIMConversationActivationOrganizationId(
                initialOrganizationId: nil,
                currentOrganizationId: "org-after-reload"
            ),
            "org-after-reload"
        )
        XCTAssertNil(
            resolveIMConversationActivationOrganizationId(
                initialOrganizationId: "  ",
                currentOrganizationId: nil
            )
        )
    }

    func testPromptCardRemainsStructuredAndExposesReusableInstruction() throws {
        let message = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 9, "seq": 9, "conversation_id": "conv-1", "sender_id": "user-2",
          "content": "[指令] 整理本周进展", "message_type": 1,
          "metadata": {"card": {
            "type": "prompt", "title": "整理本周进展",
            "prompt_text": "整理本周进展\\n列出风险和下一步。", "prompt_version": 1
          }}
        }
        """.utf8))

        XCTAssertTrue(message.hasStructuredCard)
        XCTAssertFalse(message.isPlainText)
        XCTAssertEqual(message.promptCard?.displayTitle, "整理本周进展")
        XCTAssertEqual(message.promptCard?.promptText, "整理本周进展\n列出风险和下一步。")
    }

    func testForwardableCardsKeepTheirStructuredPayload() throws {
        let table = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 20, "seq": 20, "conversation_id": "conv-1", "sender_id": "user-2",
          "content": "[表格] 项目任务清单", "message_type": 1,
          "metadata": {"card": {
            "type": "table", "resource_id": "table-1", "name": "项目任务清单",
            "space_id": "space-1", "organization_id": "org-1"
          }}
        }
        """.utf8))
        let contact = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 21, "seq": 21, "conversation_id": "conv-1", "sender_id": "user-2",
          "content": "[名片] 童俊芳", "message_type": 1,
          "metadata": {"card": {
            "type": "contact", "user_id": "user-3", "name": "童俊芳",
            "username": "tongjunfang", "avatar": "https://example.com/avatar.png"
          }}
        }
        """.utf8))

        XCTAssertEqual(table.forwardableCard?.kind, .table)
        XCTAssertEqual(table.forwardableCard?.requestPayload()["resource_id"] as? String, "table-1")
        XCTAssertEqual(contact.forwardableCard?.kind, .contact)
        XCTAssertEqual(contact.forwardableCard?.requestPayload()["user_id"] as? String, "user-3")
    }

    func testForwardedMessageDecodesOriginWithoutMakingMetadataFragile() throws {
        let forwarded = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 27, "seq": 27, "conversation_id": "conv-target", "sender_id": "user-1",
          "content": "来自原消息的正文", "message_type": 1,
          "metadata": {
            "client_request_id": "request-27",
            "forwarded_from": {
              "original_message_id": 12,
              "original_conversation_id": "conv-source",
              "original_conversation_name": "产品讨论",
              "original_sender_id": "user-2",
              "original_sender_name": "小林"
            }
          }
        }
        """.utf8))

        XCTAssertEqual(forwarded.metadata?.clientRequestId, "request-27")
        XCTAssertEqual(forwarded.metadata?.forwardedFrom?.originalMessageId, 12)
        XCTAssertEqual(forwarded.metadata?.forwardedFrom?.originalConversationId, "conv-source")
        XCTAssertEqual(forwarded.metadata?.forwardedFrom?.originalConversationName, "产品讨论")
        XCTAssertEqual(forwarded.metadata?.forwardedFrom?.originalSenderId, "user-2")
        XCTAssertEqual(forwarded.metadata?.forwardedFrom?.originalSenderName, "小林")

        let malformed = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 28, "seq": 28, "conversation_id": "conv-target", "sender_id": "user-1",
          "content": "普通正文", "message_type": 1,
          "metadata": {"client_request_id": "request-28", "forwarded_from": ["bad"]}
        }
        """.utf8))

        XCTAssertEqual(malformed.metadata?.clientRequestId, "request-28")
        XCTAssertNil(malformed.metadata?.forwardedFrom)
    }

    func testForwardSourcePresentationShowsOthersAndHidesSelf() {
        let other = IMForwardedFrom(originalSenderId: "user-2", originalSenderName: " 小林 ")
        let mine = IMForwardedFrom(originalSenderId: "user-1", originalSenderName: "我")

        XCTAssertEqual(
            IMForwardSourcePresentation.text(for: other, currentUserId: "user-1"),
            "转发自 小林"
        )
        XCTAssertNil(IMForwardSourcePresentation.text(for: mine, currentUserId: "user-1"))
        XCTAssertNil(IMForwardSourcePresentation.text(for: nil, currentUserId: "user-1"))
        XCTAssertEqual(
            IMForwardSourcePresentation.text(
                for: IMForwardedFrom(originalSenderName: "离线成员"),
                currentUserId: "user-1"
            ),
            "转发自 离线成员"
        )
    }

    func testRestrictedAndUnknownCardsNeverProduceForwardPayload() throws {
        let sessionShareV2 = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {"id":22,"seq":22,"conversation_id":"conv-1","sender_id":"user-2",
         "message_type":1,"content":"[共享任务] 新任务",
         "metadata":{"card":{"type":"session_share_v2","object_id":"share-1"}}}
        """.utf8))
        let unknown = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {"id":23,"seq":23,"conversation_id":"conv-1","sender_id":"user-2",
         "message_type":1,"content":"[未知卡片]",
         "metadata":{"card":{"type":"future_card","object_id":"object-1"}}}
        """.utf8))

        XCTAssertTrue(sessionShareV2.isForwardRestrictedCard)
        XCTAssertNil(sessionShareV2.forwardableCard)
        XCTAssertNil(unknown.forwardableCard)
        XCTAssertFalse(sessionShareV2.canForward)
        XCTAssertFalse(unknown.canForward)
    }

    func testSessionShareV2DecodesCollaborationSnapshot() throws {
        let message = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 24, "seq": 24, "conversation_id": "conv-1", "sender_id": "user-1",
          "content": "[共享任务] 创建表格和文档", "message_type": 1,
          "metadata": {"card": {
            "type": "session_share_v2", "schema_version": 1, "version": 3,
            "object_id": "share-24", "title_snapshot": "创建表格和文档",
            "sender_id": "user-1", "recipient_id": "user-2"
          }}
        }
        """.utf8))

        let card = try XCTUnwrap(message.sessionShareV2Card)
        XCTAssertEqual(card.objectId, "share-24")
        XCTAssertEqual(card.title, "创建表格和文档")
        XCTAssertEqual(card.senderId, "user-1")
        XCTAssertEqual(card.recipientId, "user-2")
        XCTAssertEqual(card.version, 3)
        XCTAssertTrue(message.isForwardRestrictedCard)
        XCTAssertNil(message.sessionShareCard)
        XCTAssertNil(message.forwardableCard)
    }

    func testSessionContinuationDecodesOnlyLocatorSnapshot() throws {
        let message = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 27, "seq": 27, "conversation_id": "conv-1", "sender_id": "user-1",
          "content": "[任务续接] 创建表格和文档", "message_type": 1,
          "metadata": {"card": {
            "type": "session_continuation", "schema_version": 1, "version": 4,
            "object_id": "continuation-27", "title_snapshot": "创建表格和文档",
            "sender_id": "user-1", "recipient_id": "user-2",
            "frozen_context": [{"role":"user","content":"must not decode"}]
          }}
        }
        """.utf8))

        let card = try XCTUnwrap(message.sessionContinuationCard)
        XCTAssertEqual(card.objectId, "continuation-27")
        XCTAssertEqual(card.title, "创建表格和文档")
        XCTAssertEqual(card.version, 4)
        XCTAssertTrue(message.isForwardRestrictedCard)
        XCTAssertNil(message.forwardableCard)
    }

    func testSessionContinuationDetailDecodesCreatedTarget() throws {
        let detail = try JSONDecoder().decode(IMSessionContinuationDetail.self, from: Data("""
        {
          "object_id": "continuation-27", "version": 5, "role": "recipient",
          "title_snapshot": "创建表格和文档", "context_status": "truncated",
          "snapshot_turn_count": 18, "resource_status": "partial",
          "resources": [
            {"label":"需求文档","unavailable":true,"reason":"需要原资源权限"},
            {"label":"公开资料"}
          ],
          "delivery_status": "confirmed", "creation_status": "created",
          "linked_session_id": "session-new", "target_workspace_id": "workspace-1",
          "organization_id": "org-1", "eligibility": {"can_create": true, "reason": ""},
          "created_at": "2026-08-17T00:00:00Z", "updated_at": "2026-08-17T00:01:00Z"
        }
        """.utf8))

        XCTAssertEqual(detail.linkedSessionId, "session-new")
        XCTAssertEqual(detail.targetWorkspaceId, "workspace-1")
        XCTAssertEqual(detail.snapshotTurnCount, 18)
        XCTAssertEqual(detail.resources.first?.unavailable, true)
        XCTAssertEqual(detail.resources.last?.unavailable, false)
    }

    func testSessionShareV2DetailProjectsToExistingSharedSessionViewerCard() throws {
        let detail = try JSONDecoder().decode(IMSessionShareV2Detail.self, from: Data("""
        {
          "id": "share-24", "session_id": "session-1", "session_title": "创建表格和文档",
          "owner_user_id": "user-1", "grantee_user_id": "user-2",
          "can_fork": true, "can_chat": false, "status": "active",
          "owner_display_name": "沈庾涛", "grantee_display_name": "Alex",
          "card_contract": "session_share_v2", "version": 4,
          "role": "recipient", "phase": "activeView", "access_mode": "fork",
          "actions": {"can_join": false, "can_open": true, "can_stop": false, "can_restore": false, "can_change_access": false}
        }
        """.utf8))

        let card = detail.cardSnapshot

        XCTAssertEqual(card.shareId, "share-24")
        XCTAssertEqual(card.sessionId, "session-1")
        XCTAssertEqual(card.displayTitle, "创建表格和文档")
        XCTAssertEqual(card.ownerUserId, "user-1")
        XCTAssertEqual(card.granteeUserId, "user-2")
        XCTAssertTrue(card.canFork)
        XCTAssertEqual(card.normalizedStatus, "active")
        XCTAssertEqual(detail.actions?.canOpen, true)
    }

    func testSessionShareV2DetailAcceptsNullSessionIdBeforeJoinAndAfterStop() throws {
        let detail = try JSONDecoder().decode(IMSessionShareV2Detail.self, from: Data("""
        {
          "id": "share-stopped", "session_id": null, "session_title": "测试桩体",
          "owner_user_id": "user-1", "grantee_user_id": "user-2",
          "can_fork": false, "can_chat": false, "status": "revoked",
          "card_contract": "session_share_v2", "version": 4,
          "role": "recipient", "phase": "stopped", "access_mode": "view",
          "actions": {"can_join": false, "can_open": false, "can_stop": false, "can_restore": false, "can_change_access": false}
        }
        """.utf8))

        XCTAssertNil(detail.sessionId)
        XCTAssertEqual(detail.phase, "stopped")
        XCTAssertEqual(detail.cardSnapshot.normalizedStatus, "revoked")
        XCTAssertEqual(detail.cardSnapshot.sessionId, "")
    }

    @MainActor
    func testCardDetailRequestCoalescerKeepsRequestAliveAfterFirstObserverCancels() async throws {
        let coalescer = IMCardDetailRequestCoalescer<String>()
        let probe = IMCardDetailRequestProbe()

        let firstObserver = Task {
            await coalescer.load(key: "session-share:1") {
                await probe.load()
            }
        }
        await probe.waitUntilStarted()
        firstObserver.cancel()

        let secondObserver = Task {
            await coalescer.load(key: "session-share:1") {
                await probe.load()
            }
        }
        await Task.yield()

        let countBeforeFinish = await probe.requestCount
        XCTAssertEqual(countBeforeFinish, 1)
        await probe.finish(with: "detail")
        let firstValue = try await firstObserver.value.get()
        let secondValue = try await secondObserver.value.get()
        let finalCount = await probe.requestCount
        XCTAssertEqual(firstValue, "detail")
        XCTAssertEqual(secondValue, "detail")
        XCTAssertEqual(finalCount, 1)
    }

    @MainActor
    func testCardDetailCacheRejectsResponsesOlderThanMessageSnapshot() throws {
        let suffix = UUID().uuidString
        let shareId = "share-\(suffix)"
        let continuationId = "continuation-\(suffix)"
        let newerShare = try JSONDecoder().decode(IMSessionShareV2Detail.self, from: Data("""
        {
          "id": "\(shareId)", "session_id": "session-new", "session_title": "新版任务",
          "owner_user_id": "user-1", "grantee_user_id": "user-2",
          "can_fork": true, "can_chat": false, "status": "active",
          "card_contract": "session_share_v2", "version": 5,
          "role": "recipient", "phase": "activeView", "access_mode": "fork",
          "actions": {"can_join": false, "can_open": true, "can_stop": false, "can_restore": false, "can_change_access": false}
        }
        """.utf8))
        let olderShare = try JSONDecoder().decode(IMSessionShareV2Detail.self, from: Data("""
        {
          "id": "\(shareId)", "session_id": null, "session_title": "旧版任务",
          "owner_user_id": "user-1", "grantee_user_id": "user-2",
          "can_fork": false, "can_chat": false, "status": "revoked",
          "card_contract": "session_share_v2", "version": 4,
          "role": "recipient", "phase": "stopped", "access_mode": "view",
          "actions": {"can_join": false, "can_open": false, "can_stop": false, "can_restore": false, "can_change_access": false}
        }
        """.utf8))
        let newerContinuation = try JSONDecoder().decode(IMSessionContinuationDetail.self, from: Data("""
        {
          "object_id": "\(continuationId)", "version": 7, "role": "recipient",
          "title_snapshot": "新版续接", "context_status": "complete", "snapshot_turn_count": 8,
          "resource_status": "available", "resources": [], "delivery_status": "confirmed",
          "creation_status": "created", "linked_session_id": "session-new",
          "target_workspace_id": "workspace-1", "organization_id": "org-1",
          "eligibility": {"can_create": true, "reason": ""},
          "created_at": "2026-08-17T00:00:00Z", "updated_at": "2026-08-17T00:01:00Z"
        }
        """.utf8))
        let olderContinuation = try JSONDecoder().decode(IMSessionContinuationDetail.self, from: Data("""
        {
          "object_id": "\(continuationId)", "version": 6, "role": "recipient",
          "title_snapshot": "旧版续接", "context_status": "complete", "snapshot_turn_count": 8,
          "resource_status": "available", "resources": [], "delivery_status": "confirmed",
          "creation_status": "pending", "linked_session_id": null,
          "target_workspace_id": null, "organization_id": "org-1",
          "eligibility": {"can_create": true, "reason": ""},
          "created_at": "2026-08-17T00:00:00Z", "updated_at": "2026-08-17T00:00:30Z"
        }
        """.utf8))

        IMCardStatusMemoryCache.putSessionShareV2Detail(newerShare)
        IMCardStatusMemoryCache.putSessionShareV2Detail(olderShare)
        IMCardStatusMemoryCache.putSessionContinuationDetail(newerContinuation)
        IMCardStatusMemoryCache.putSessionContinuationDetail(olderContinuation)

        XCTAssertEqual(
            IMCardStatusMemoryCache.sessionShareV2Detail(id: shareId, minimumVersion: 5)?.sessionTitle,
            "新版任务"
        )
        XCTAssertNil(IMCardStatusMemoryCache.sessionShareV2Detail(id: shareId, minimumVersion: 6))
        XCTAssertEqual(
            IMCardStatusMemoryCache.sessionContinuationDetail(id: continuationId, minimumVersion: 7)?.creationStatus,
            "created"
        )
        XCTAssertNil(
            IMCardStatusMemoryCache.sessionContinuationDetail(id: continuationId, minimumVersion: 8)
        )
    }

    func testSessionShareV2RejectsFutureSchemaAndIncompleteSnapshots() throws {
        let futureSchema = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 25, "seq": 25, "conversation_id": "conv-1", "sender_id": "user-1",
          "content": "[共享任务] 新协议", "message_type": 1,
          "metadata": {"card": {
            "type": "session_share_v2", "schema_version": 2, "version": 1,
            "object_id": "share-25", "title_snapshot": "新协议",
            "sender_id": "user-1", "recipient_id": "user-2"
          }}
        }
        """.utf8))
        let missingRecipient = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 26, "seq": 26, "conversation_id": "conv-1", "sender_id": "user-1",
          "content": "[共享任务] 缺少参与人", "message_type": 1,
          "metadata": {"card": {
            "type": "session_share_v2", "schema_version": 1, "version": 1,
            "object_id": "share-26", "title_snapshot": "缺少参与人",
            "sender_id": "user-1"
          }}
        }
        """.utf8))

        XCTAssertNil(futureSchema.sessionShareV2Card)
        XCTAssertTrue(futureSchema.hasStructuredCard)
        XCTAssertNil(missingRecipient.sessionShareV2Card)
        XCTAssertTrue(missingRecipient.hasStructuredCard)
    }

    func testUnknownAndMalformedCardsNeverBecomePlainText() throws {
        let unknown = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {"id":10,"seq":10,"conversation_id":"conv-1","sender_id":"user-2","content":"[交接]","message_type":1,
         "metadata":{"card":{"type":"handoff","scope":"private"}}}
        """.utf8))
        let malformed = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {"id":11,"seq":11,"conversation_id":"conv-1","sender_id":"user-2","content":"[卡片]","message_type":1,
         "metadata":{"card":["not","an","object"]}}
        """.utf8))

        XCTAssertTrue(unknown.hasStructuredCard)
        XCTAssertEqual(unknown.metadata?.cardType, "handoff")
        XCTAssertNil(unknown.resourceCard)
        XCTAssertFalse(unknown.isPlainText)
        XCTAssertTrue(unknown.isForwardRestrictedCard)

        XCTAssertTrue(malformed.hasStructuredCard)
        XCTAssertNil(malformed.metadata?.cardType)
        XCTAssertNil(malformed.resourceCard)
        XCTAssertFalse(malformed.isPlainText)
        XCTAssertFalse(malformed.isForwardRestrictedCard)
    }

    func testCreateDMResultDecodesConversationId() throws {
        let result = try JSONDecoder().decode(
            IMCreateDMResult.self,
            from: Data(#"{"conversation_id":"dm-123"}"#.utf8)
        )
        XCTAssertEqual(result.conversationId, "dm-123")
    }

    func testCreateGroupResultDecodesConversationId() throws {
        let result = try JSONDecoder().decode(
            IMCreateGroupResult.self,
            from: Data(#"{"conversation_id":"group-123"}"#.utf8)
        )
        XCTAssertEqual(result.conversationId, "group-123")
    }

    // MARK: - IMEventDecoder（Phase B）

    func testDecodeMessageEvent() throws {
        let raw = Data("""
        {
          "type": "im.message", "event_id": "evt-1",
          "data": {
            "id": 5, "seq": 2, "conversation_id": "conv-1", "sender_id": "user-2",
            "sender_type": "user", "sender_name": "张三", "content": "hi",
            "message_type": 1, "reply_to_id": null, "metadata": {}
          }
        }
        """.utf8)

        guard case let .message(msg) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("应解出 .message")
        }
        XCTAssertEqual(msg.id, 5)
        XCTAssertEqual(msg.content, "hi")
    }

    func testDecodeUnreadUpdateEvent() throws {
        let raw = Data("""
        {
          "type": "im.unread.update", "event_id": "evt-2",
          "data": {
            "conversation_id": "conv-1", "organization_id": "org-1",
            "message_id": 12, "message_seq": 3, "sender_id": "user-2",
            "sender_name": "张三", "preview": "新消息", "mention": true
          }
        }
        """.utf8)

        guard case let .unreadUpdate(update) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("应解出 .unreadUpdate")
        }
        XCTAssertEqual(update.conversationId, "conv-1")
        XCTAssertEqual(update.messageSeq, 3)
        XCTAssertTrue(update.mention)
    }

    func testDecodeConversationNewEvent() throws {
        // 回归  issue 2：im.conversation.new 需解成 .conversationNew，data 为会话摘要（同列表项形状）。
        let raw = Data("""
        {
          "type": "im.conversation.new", "event_id": "cn-1",
          "data": {
            "id": "conv-9", "organization_id": "org-1", "space_id": null,
            "space_name": "", "is_team_space_channel": false, "type": 1,
            "name": "李四", "avatar_url": "", "member_count": 2, "is_archived": false,
            "last_message_at": "2026-07-21T10:00:00Z", "last_message_preview": "",
            "unread_count": 0, "created_at": "2026-07-21T10:00:00Z",
            "dm_peer_user_id": "u2", "pinned": false, "is_muted": false, "labels": []
          }
        }
        """.utf8)

        guard case let .conversationNew(conversation) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("应解出 .conversationNew")
        }
        XCTAssertEqual(conversation.id, "conv-9")
        XCTAssertEqual(conversation.name, "李四")
        XCTAssertEqual(conversation.type, IMConversationType.dm.rawValue)
    }

    func testDecodeConversationLabelsUpdatedEvent() throws {
        let raw = Data("""
        {
          "type": "im.conversation.labels.updated",
          "data": {
            "conversation_id": "conv-1",
            "labels": [
              {"id": "label-1", "name": "重要", "color": "#ef4444", "is_system": false}
            ]
          }
        }
        """.utf8)

        guard case let .conversationLabelsUpdated(conversationId, labels) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("应解出 .conversationLabelsUpdated")
        }
        XCTAssertEqual(conversationId, "conv-1")
        XCTAssertEqual(labels.map(\.id), ["label-1"])
        XCTAssertEqual(labels.first?.name, "重要")
    }

    func testDecodeTypingEventReadsTopLevelUserId() throws {
        let raw = Data(#"{"type": "im.typing", "user_id": "user-2"}"#.utf8)
        guard case let .typing(userId) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("应解出 .typing")
        }
        XCTAssertEqual(userId, "user-2")
    }

    func testDecodeUnknownEventKeepsType() throws {
        let raw = Data(#"{"type": "im.future.capability", "event_id": "e", "data": {}}"#.utf8)
        guard case let .unknown(type) = try XCTUnwrap(IMEventDecoder.decode(raw)) else {
            return XCTFail("未处理类型应落 .unknown")
        }
        XCTAssertEqual(type, "im.future.capability")
    }

    func testDecodeGarbageReturnsNil() {
        XCTAssertNil(IMEventDecoder.decode(Data("not json".utf8)))
        XCTAssertNil(IMEventDecoder.decode(Data("{}".utf8)))
    }

    func testHandoffCardUsesBackendGoalSnapshotAndStaysStructured() throws {
        let message = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 301, "seq": 88, "conversation_id": "conv-1", "sender_id": "user-1",
          "content": "[交接] 完成上线检查", "message_type": 1,
          "metadata": {"card": {
            "type": "handoff", "handoff_id": "handoff-1", "goal": "完成上线检查",
            "scope": "continuable", "initiator_type": "user", "initiator_id": "user-1"
          }}
        }
        """.utf8))

        let card = try XCTUnwrap(message.metadata?.card)
        XCTAssertTrue(card.isHandoff)
        XCTAssertEqual(card.handoffId, "handoff-1")
        XCTAssertEqual(card.goalSnapshot, "完成上线检查")
        XCTAssertTrue(message.hasStructuredCard)
        XCTAssertTrue(message.isForwardRestrictedCard)
        XCTAssertFalse(message.isPlainText)
    }

    func testHandoffPackageDecodesRecipientsReferencesAndFrozenTranscript() throws {
        let package = try JSONDecoder().decode(IMHandoffPackage.self, from: Data("""
        {
          "id": "handoff-1", "conversation_id": "conv-1", "organization_id": "org-1",
          "initiator_type": "user", "initiator_user_id": "user-1", "initiator_agent_id": null,
          "goal": "继续完成上线", "progress": [{"text": "接口已完成"}],
          "next_steps": [{"text": "跑回归", "checked": false}],
          "risks": [{"text": "发布窗口较短", "high_risk": true}],
          "scope": "continuable", "status": "sent", "version": 2, "card_message_id": 301,
          "recipients": [{"user_id": "user-2", "agent_id": null, "state": "viewed", "note": "", "state_changed_at": null}],
          "references": [{
            "id": "ref-1", "ref_type": "chat_session", "resource_id": "session-1",
            "title": "排查发布问题", "summary": "Agent 会话 · 2 条",
            "source_link": {"session_id": "session-1"}, "accessible": true, "denied_reason": null,
            "frozen_snapshot": {"title": "排查发布问题", "message_count": 2, "truncated": false,
              "turns": [{"role": "user", "text": "检查发布", "attachments": [{
                "type": "file", "file_id": "file-1", "filename": "checklist.txt", "mime_type": "text/plain", "size": 12
              }]}]}
          }]
        }
        """.utf8))

        XCTAssertEqual(package.nextSteps.first?.text, "跑回归")
        XCTAssertEqual(package.risks.first?.highRisk, true)
        XCTAssertEqual(package.recipients.first?.state, "viewed")
        XCTAssertEqual(package.references.first?.frozenSnapshot?.turns.first?.attachments.first?.fileId, "file-1")
    }

    func testOSSFileAccessDecodesFreshSignedURLForFrozenAttachment() throws {
        let access = try JSONDecoder().decode(OSSFileAccess.self, from: Data("""
        {"file_id":"file-1","file_name":"checklist.txt","file_size":12,
         "mime_type":"text/plain","resolved_url":"https://example.invalid/signed?token=fresh"}
        """.utf8))

        XCTAssertEqual(access.fileId, "file-1")
        XCTAssertEqual(access.fileSize, 12)
        XCTAssertTrue(access.resolvedUrl.contains("token=fresh"))
        XCTAssertEqual(access.displayUrl, "https://example.invalid/signed?token=fresh")
    }

    func testOSSFileAccessPrefersCDNDisplayURL() throws {
        let access = try JSONDecoder().decode(OSSFileAccess.self, from: Data("""
        {"file_id":"file-1","file_name":"image.png","file_size":8,
         "mime_type":"image/png",
         "access_url":"https://assets.example.com/image.png",
         "cdn_url":"https://assets.example.com/cdn-image.png",
         "resolved_url":"https://example-assets.oss-cn-shanghai.aliyuncs.com/image.png"}
        """.utf8))

        XCTAssertEqual(access.displayUrl, "https://assets.example.com/cdn-image.png")
    }

    @MainActor
    func testResourceAccessEventUpdatesCardPreviewCache() throws {
        let resourceId = "doc-\(UUID().uuidString)"
        let card = IMResourceCard(type: "document", name: "权限文档", resourceId: resourceId)
        IMCardStatusMemoryCache.putResourcePreview(
            IMResourceCardPreviewResult(
                status: .ok,
                data: IMResourceCardPreview(
                    name: "旧标题",
                    spaceId: "space-1",
                    organizationId: "org-1",
                    currentUserRole: "viewer",
                    description: nil,
                    previewTable: nil
                )
            ),
            for: card
        )
        IMCardStatusMemoryCache.markResourceAccessRequested(for: card)

        let changed = try JSONDecoder().decode(WSEnvelope.self, from: Data("""
        {
          "v": 1,
          "type": "resource_access_changed",
          "request_id": "evt-1",
          "ts": 1,
          "device_id": "server",
          "role": "server",
          "payload": {},
          "_topic": "context.sync.user.user-1",
          "resource_type": "tabdoc",
          "resource_id": "\(resourceId)",
          "space_id": "space-1",
          "organization_id": "org-1"
        }
        """.utf8))

        XCTAssertEqual(changed.payloadString("resource_type"), "tabdoc")
        XCTAssertEqual(changed.payloadString("resource_id"), resourceId)

        IMCardStatusMemoryCache.handleResourceAccessEvent(changed)
        XCTAssertNil(IMCardStatusMemoryCache.resourcePreview(for: card))
        XCTAssertFalse(IMCardStatusMemoryCache.hasRequestedResourceAccess(for: card))

        let revoked = try JSONDecoder().decode(WSEnvelope.self, from: Data("""
        {
          "v": 1,
          "type": "resource_access_revoked",
          "request_id": "evt-2",
          "ts": 1,
          "device_id": "server",
          "role": "server",
          "payload": {},
          "_topic": "context.sync.user.user-1",
          "resource_type": "tabdoc",
          "resource_id": "\(resourceId)"
        }
        """.utf8))

        IMCardStatusMemoryCache.handleResourceAccessEvent(revoked)
        XCTAssertEqual(IMCardStatusMemoryCache.resourcePreview(for: card)?.status, .forbidden)
    }

    @MainActor
    func testResourcePreviewCachePublishesImmediateCardUpdateWithoutReloadLoop() {
        let resourceId = "table-\(UUID().uuidString)"
        let card = IMResourceCard(type: "table", name: "实时表格", resourceId: resourceId)
        var notificationCount = 0
        var shouldRefresh: Bool?
        let observer = NotificationCenter.default.addObserver(
            forName: .imResourceCardStatusDidChange,
            object: nil,
            queue: nil
        ) { notification in
            guard notification.userInfo?["resourceKey"] as? String == "table:\(resourceId)" else { return }
            notificationCount += 1
            shouldRefresh = notification.userInfo?["shouldRefresh"] as? Bool
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        IMCardStatusMemoryCache.putResourcePreview(
            IMResourceCardPreviewResult(status: .forbidden, data: nil),
            for: card
        )

        XCTAssertEqual(notificationCount, 1)
        XCTAssertEqual(shouldRefresh, false)
    }
}

private actor IMConversationLabelServiceStub: IMConversationLabelServing {
    let labels: [IMConversationLabel]

    init(labels: [IMConversationLabel]) {
        self.labels = labels
    }

    func list(organizationId: String) async throws -> [IMConversationLabel] { labels }

    func create(organizationId: String, name: String, color: String) async throws -> IMConversationLabel {
        IMConversationLabel(id: "created", name: name, color: color)
    }

    func update(labelId: String, name: String, color: String) async throws -> IMConversationLabel {
        IMConversationLabel(id: labelId, name: name, color: color)
    }

    func delete(labelId: String) async throws {}

    func add(conversationId: String, labelIds: [String]) async throws -> [IMConversationLabel] { labels }

    func remove(conversationId: String, labelId: String) async throws -> [IMConversationLabel] { [] }
}

private actor IMCardDetailRequestProbe {
    private(set) var requestCount = 0
    private var continuations: [CheckedContinuation<String, Never>] = []

    func load() async -> String {
        requestCount += 1
        return await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func waitUntilStarted() async {
        while requestCount == 0 {
            await Task.yield()
        }
    }

    func finish(with value: String) {
        let waiting = continuations
        continuations.removeAll()
        for continuation in waiting {
            continuation.resume(returning: value)
        }
    }
}
