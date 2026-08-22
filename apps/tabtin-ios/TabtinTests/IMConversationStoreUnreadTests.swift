import XCTest
@testable import Tabtin

private struct IMHostLeakingTestError: LocalizedError {
    var errorDescription: String? {
        "The request to im-secret.internal.example timed out."
    }
}

@MainActor
private final class FakeIMConversationDataPlane: IMConversationDataPlane {
    var listError: Error?
    var searchError: Error?
    var conversationChangedListener: (@MainActor @Sendable () -> Void)?
    private(set) var listConversationCalls: [String] = []

    func listConversations(organizationId: String) async throws -> [IMConversation] {
        listConversationCalls.append(organizationId)
        if let listError { throw listError }
        return []
    }

    func searchMessages(organizationId: String, query: String) async throws -> [IMMessageSearchResult] {
        if let searchError { throw searchError }
        return []
    }

    func setConversationChangedListener(_ listener: (@MainActor @Sendable () -> Void)?) {
        conversationChangedListener = listener
    }

    func markConversationRemoved(conversationId: String) {}
    func clearSession() { conversationChangedListener = nil }
}

@MainActor
private final class FakeIMPersonalRealtimeSource: IMPersonalRealtimeSource {
    private(set) var listener: (@MainActor (Data) -> Void)?
    private(set) var connectionAvailableListener: (@MainActor () -> Void)?

    func setPersonalPublicationListener(_ listener: (@MainActor (Data) -> Void)?) {
        self.listener = listener
    }

    func setConnectionAvailableListener(_ listener: (@MainActor () -> Void)?) {
        connectionAvailableListener = listener
    }

    func publish(_ data: Data) {
        listener?(data)
    }

    func restoreConnection() {
        connectionAvailableListener?()
    }
}

@MainActor
final class IMConversationStoreErrorTests: XCTestCase {
    func testSearchFeedbackDistinguishesLoadingFailureAndInactiveQuery() {
        XCTAssertEqual(
            IMConversationSearchFeedback.resolve(
                query: "项目",
                isSearching: true,
                error: nil
            ),
            .loading
        )
        XCTAssertEqual(
            IMConversationSearchFeedback.resolve(
                query: "项目",
                isSearching: false,
                error: L10n.Messages.networkError
            ),
            .failure(L10n.Messages.networkError)
        )
        XCTAssertEqual(
            IMConversationSearchFeedback.resolve(
                query: "   ",
                isSearching: false,
                error: L10n.Messages.networkError
            ),
            .none
        )
    }

    func testReloadMapsTransportDetailsToLocalizedNetworkError() async {
        let dataPlane = FakeIMConversationDataPlane()
        dataPlane.listError = IMHostLeakingTestError()
        let store = IMConversationStore(dataPlane: dataPlane)

        await store.reload(organizationId: "org-1")

        XCTAssertEqual(store.loadError, L10n.Messages.networkError)
        XCTAssertFalse(store.loadError?.contains("im-secret.internal.example") ?? true)
        XCTAssertFalse(store.loadError?.contains("timed out") ?? true)
        XCTAssertFalse(store.isLoading)
    }

    func testMessageSearchMapsTransportDetailsToLocalizedNetworkError() async {
        let dataPlane = FakeIMConversationDataPlane()
        dataPlane.searchError = IMHostLeakingTestError()
        let store = IMConversationStore(dataPlane: dataPlane)

        await store.searchMessages(organizationId: "org-1", query: "项目")

        XCTAssertEqual(store.searchError, L10n.Messages.networkError)
        XCTAssertFalse(store.searchError?.contains("im-secret.internal.example") ?? true)
        XCTAssertFalse(store.searchError?.contains("timed out") ?? true)
        XCTAssertFalse(store.isSearching)
    }
}

/// 会话列表未读清零与旧 realtime 合并算法回归。
@MainActor
final class IMConversationStoreUnreadTests: XCTestCase {
    private func makeConversation(
        id: String,
        unread: Int,
        preview: String = "hi",
        lastSeq: Int = 0,
        organizationId: String = "org-1",
        type: Int = 2,
        peerUserId: String? = nil,
        memberCount: Int = 3,
        labels: [IMConversationLabel] = []
    ) -> IMConversation {
        let peerJSON = peerUserId.map { "\"\($0)\"" } ?? "null"
        let json = Data("""
        {
          "id": "\(id)", "organization_id": "\(organizationId)", "space_id": null,
          "space_name": "", "is_team_space_channel": false, "type": \(type),
          "name": "群", "avatar_url": "", "member_count": \(memberCount), "is_archived": false,
          "last_message_at": "2026-07-20T10:00:00Z",
          "last_message_preview": "\(preview)",
          "unread_count": \(unread),
          "last_message_seq": \(lastSeq),
          "created_at": "2026-07-01T00:00:00Z",
          "dm_peer_user_id": \(peerJSON), "pinned": false, "is_muted": false
        }
        """.utf8)
        var conversation = try! JSONDecoder().decode(IMConversation.self, from: json)
        conversation.labels = labels
        return conversation
    }

    func testPersonalRealtimeSourceFeedsStoreAndIsDetachedOnClear() {
        let realtime = FakeIMPersonalRealtimeSource()
        let store = IMConversationStore(
            dataPlane: FakeIMConversationDataPlane(),
            personalRealtimeSource: realtime
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])

        store.startListeningPersonalForTesting()
        realtime.publish(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 7,
         "message_seq": 7, "sender_id": "u2", "sender_name": "张三", "preview": "实时消息", "mention": false}
        """))

        XCTAssertEqual(store.conversations.first?.unreadCount, 1)
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "实时消息")
        XCTAssertNotNil(realtime.listener)

        realtime.publish(Data("""
        {"type":"im.ai.error","data":{"agent_name":"研究员","reason":"执行现场不可用"}}
        """.utf8))
        XCTAssertEqual(store.personalNotice?.kind, .aiError)
        XCTAssertEqual(store.personalNotice?.agentName, "研究员")
        XCTAssertEqual(store.personalNotice?.reason, "执行现场不可用")

        store.clear()
        XCTAssertNil(realtime.listener)
        XCTAssertNil(store.personalNotice)
    }

    func testPersonalPreviewUpdateRefreshesSubtitleWithoutUnreadIncrement() {
        let realtime = FakeIMPersonalRealtimeSource()
        let store = IMConversationStore(
            dataPlane: FakeIMConversationDataPlane(),
            personalRealtimeSource: realtime
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 3, preview: "旧摘要", lastSeq: 9)
        ])
        store.startListeningPersonalForTesting()

        realtime.publish(Data("""
        {"type":"im.conversation.preview.updated","data":{
          "conversation_id":"c1","organization_id":"org-1",
          "message_id":99,"message_seq":9,"preview":"消息已撤回",
          "last_message_at":"2026-07-20T11:00:00Z"
        }}
        """.utf8))

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "消息已撤回")
        XCTAssertEqual(store.conversations.first?.lastMessageAt, "2026-07-20T11:00:00Z")
        XCTAssertEqual(store.conversations.first?.unreadCount, 3)
    }

    func testPersonalRealtimeAdvancesConversationActivityTime() {
        let realtime = FakeIMPersonalRealtimeSource()
        let store = IMConversationStore(
            dataPlane: FakeIMConversationDataPlane(),
            personalRealtimeSource: realtime
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 0, preview: "旧摘要", lastSeq: 9)
        ])
        store.startListeningPersonalForTesting()

        realtime.publish(unreadEventJSON("""
        {"conversation_id":"c1","organization_id":"org-1","message_id":10,
         "message_seq":10,"preview":"最新摘要",
         "last_message_at":"2026-07-20T11:00:00Z"}
        """))

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "最新摘要")
        XCTAssertEqual(store.conversations.first?.lastMessageAt, "2026-07-20T11:00:00Z")
    }

    func testConnectionRecoveryReloadsConversationDirectory() async {
        let dataPlane = FakeIMConversationDataPlane()
        let realtime = FakeIMPersonalRealtimeSource()
        let store = IMConversationStore(
            dataPlane: dataPlane,
            personalRealtimeSource: realtime
        )
        store.prepareOrganizationForTesting("org-1")
        store.startListeningPersonalForTesting()

        realtime.restoreConnection()
        await Task.yield()

        XCTAssertEqual(dataPlane.listConversationCalls, ["org-1"])
    }

    func testExistingDirectMessageResolvesLocallyWithoutRemoteRequest() async throws {
        var remoteRequests = 0
        let conversations = [
            makeConversation(
                id: "dm-other-org",
                unread: 0,
                organizationId: "org-2",
                type: IMConversationType.dm.rawValue,
                peerUserId: "user-2"
            ),
            makeConversation(
                id: "group-same-peer",
                unread: 0,
                type: IMConversationType.group.rawValue,
                peerUserId: "user-2"
            ),
            makeConversation(
                id: "dm-local",
                unread: 0,
                type: IMConversationType.dm.rawValue,
                peerUserId: "user-2"
            ),
        ]

        let conversationId = try await resolveDirectMessageConversationId(
            conversations: conversations,
            organizationId: "org-1",
            otherUserId: "user-2"
        ) {
            remoteRequests += 1
            return "dm-remote"
        }

        XCTAssertEqual(conversationId, "dm-local")
        XCTAssertEqual(remoteRequests, 0)
    }

    func testMissingDirectMessageFallsBackToRemoteRequest() async throws {
        var remoteRequests = 0

        let conversationId = try await resolveDirectMessageConversationId(
            conversations: [],
            organizationId: "org-1",
            otherUserId: "user-2"
        ) {
            remoteRequests += 1
            return "dm-remote"
        }

        XCTAssertEqual(conversationId, "dm-remote")
        XCTAssertEqual(remoteRequests, 1)
    }

    func testRemovedMemberDirectMessageFallsBackToRemoteRequest() async throws {
        var remoteRequests = 0
        let stale = makeConversation(
            id: "dm-stale",
            unread: 0,
            type: IMConversationType.dm.rawValue,
            peerUserId: "user-2",
            memberCount: 1
        )

        let conversationId = try await resolveDirectMessageConversationId(
            conversations: [stale],
            organizationId: "org-1",
            otherUserId: "user-2"
        ) {
            remoteRequests += 1
            return "dm-restored"
        }

        XCTAssertEqual(conversationId, "dm-restored")
        XCTAssertEqual(remoteRequests, 1)
    }

    func testNewRemoteDirectMessageIsRememberedLocallyForTheNextOpen() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")

        store.rememberDirectMessage(
            conversationId: "dm-created",
            organizationId: "org-1",
            otherUserId: "user-2",
            displayName: "用户二"
        )
        store.rememberDirectMessage(
            conversationId: "dm-created",
            organizationId: "org-1",
            otherUserId: "user-2",
            displayName: "用户二"
        )

        let remembered = try! XCTUnwrap(store.conversations.first)
        XCTAssertEqual(store.conversations.count, 1)
        XCTAssertEqual(remembered.id, "dm-created")
        XCTAssertEqual(remembered.organizationId, "org-1")
        XCTAssertEqual(remembered.conversationType, .dm)
        XCTAssertEqual(remembered.dmPeerUserId, "user-2")
        XCTAssertEqual(remembered.name, "用户二")
    }

    private func unreadEventJSON(_ body: String) -> Data {
        Data("{\"type\": \"im.unread.update\", \"data\": \(body)}".utf8)
    }

    /// `im.conversation.new` 信封：`data` 为会话摘要（同列表项形状，对齐后端 `_serialize_conversation_summary`）。
    private func conversationNewEventJSON(id: String, name: String = "李四", peer: String = "u2", org: String = "org-1") -> Data {
        Data("""
        {"type": "im.conversation.new", "event_id": "cn-1", "data": {
          "id": "\(id)", "organization_id": "\(org)", "space_id": null,
          "space_name": "", "is_team_space_channel": false, "type": 1,
          "name": "\(name)", "avatar_url": "", "member_count": 2, "is_archived": false,
          "last_message_at": "2026-07-21T10:00:00Z", "last_message_preview": "",
          "unread_count": 0, "created_at": "2026-07-21T10:00:00Z",
          "dm_peer_user_id": "\(peer)", "pinned": false, "is_muted": false, "labels": []
        }}
        """.utf8)
    }

    override func tearDown() async throws {
        IMConversationStore.shared.clear()
        try await super.tearDown()
    }

    func testEnterConversationClearsLocalUnread() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 5),
            makeConversation(id: "c2", unread: 2),
        ])
        store.enterConversation("c1")
        XCTAssertEqual(store.conversations.first(where: { $0.id == "c1" })?.unreadCount, 0)
        XCTAssertEqual(store.conversations.first(where: { $0.id == "c2" })?.unreadCount, 2)
        XCTAssertEqual(store.activeConversationId, "c1")
    }

    func testRefreshDoesNotReviveUnreadAfterTransportReadAcknowledgement() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 5, lastSeq: 10, labels: [.systemMention]),
        ])

        let generation = store.captureReadContextGeneration()
        store.acknowledgeRead(conversationId: "c1", throughSeq: 10, contextGeneration: generation)
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting([
            makeConversation(id: "c1", unread: 5, lastSeq: 10, labels: [.systemMention]),
        ])

        XCTAssertEqual(
            store.conversations.first?.unreadCount,
            0,
            "刷新返回同一消息水位的旧快照时，已经读过的消息不得重新显示未读"
        )
        XCTAssertFalse(store.conversations[0].labels.contains { $0.id == IMConversationLabel.systemMention.id })
    }

    func testRefreshKeepsUnreadForMessageBeyondConfirmedReadWaterline() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 5, lastSeq: 10),
        ])

        let generation = store.captureReadContextGeneration()
        store.acknowledgeRead(conversationId: "c1", throughSeq: 10, contextGeneration: generation)
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting([
            makeConversation(id: "c1", unread: 1, lastSeq: 11),
        ])

        XCTAssertEqual(
            store.conversations.first?.unreadCount,
            1,
            "刷新包含更高 seq 的新消息时，已读水位不得吞掉真正的新未读"
        )
    }

    func testMessageBeyondConfirmedReadWaterlineStillBecomesUnread() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 5, lastSeq: 10),
        ])
        let generation = store.captureReadContextGeneration()
        store.acknowledgeRead(conversationId: "c1", throughSeq: 10, contextGeneration: generation)

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1",
         "message_id": 11, "message_seq": 11, "sender_id": "u2",
         "sender_name": "张三", "preview": "真正的新消息", "mention": false}
        """))

        XCTAssertEqual(store.conversations.first?.unreadCount, 1)
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 11)
    }

    func testOrganizationSwitchRejectsLateReadAcknowledgement() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "same-id", unread: 5, lastSeq: 10),
        ])
        let oldGeneration = store.captureReadContextGeneration()

        store.prepareOrganizationForTesting("org-2")
        store.replaceConversationsForTesting([
            makeConversation(
                id: "same-id",
                unread: 3,
                lastSeq: 10,
                organizationId: "org-2"
            ),
        ])
        store.acknowledgeRead(
            conversationId: "same-id",
            throughSeq: 10,
            contextGeneration: oldGeneration
        )

        XCTAssertEqual(store.conversations.first?.unreadCount, 3)
    }

    func testConversationRenameAndMuteSettingsUpdateListImmediately() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "group-1", unread: 0)])

        store.updateConversationName("group-1", name: "新群名")
        store.updateMuteState("group-1", muted: true)

        XCTAssertEqual(store.conversations.count, 1)
        XCTAssertEqual(store.conversations.first?.name, "新群名")
        XCTAssertEqual(store.conversations.first?.isMuted, true)
    }

    func testConversationMembersUseOrganizationDirectoryNameFallback() {
        let detail = IMConversationDetail(
            id: "conv-1",
            organizationId: "org-1",
            type: IMConversationType.group.rawValue,
            members: [IMMember(userId: "user-1")]
        )
        let enriched = IMMemberDisplayPolicy.enrichedDetail(
            detail,
            organizationMembers: [
                OrganizationMember(
                    id: "member-1",
                    userId: "user-1",
                    role: .editor,
                    joinedAt: nil,
                    user: MemberUser(
                        id: "user-1",
                        nickname: "张三",
                        username: "zhangsan",
                        email: nil,
                        phone: nil,
                        avatar: "https://example.test/avatar.png"
                    )
                ),
            ]
        )

        XCTAssertEqual(enriched.members.count, 1)
        XCTAssertEqual(enriched.members.first?.displayName, "张三")
        XCTAssertEqual(enriched.members.first?.username, "zhangsan")
        XCTAssertEqual(enriched.members.first?.avatar, "https://example.test/avatar.png")
    }

    func testConversationMembersTreatUserIdSnapshotAsMissingDisplayName() {
        let detail = IMConversationDetail(
            id: "dm-1",
            organizationId: "org-1",
            type: IMConversationType.dm.rawValue,
            members: [
                IMMember(
                    userId: "user-1",
                    nickname: "user-1",
                    username: "user-1"
                ),
            ]
        )
        let enriched = IMMemberDisplayPolicy.enrichedDetail(
            detail,
            organizationMembers: [
                OrganizationMember(
                    id: "member-1",
                    userId: "user-1",
                    role: .editor,
                    joinedAt: nil,
                    user: MemberUser(
                        id: "user-1",
                        nickname: "张三",
                        username: "zhangsan",
                        email: nil,
                        phone: nil,
                        avatar: nil
                    )
                ),
            ]
        )

        XCTAssertEqual(enriched.members.first?.displayName, "张三")
        XCTAssertEqual(enriched.members.first?.username, "zhangsan")
    }

    func testDirectMessageSettingsNameNeverExposesUserId() {
        let members = [
            IMMember(userId: "current-user", nickname: "我"),
            IMMember(userId: "peer-user-id", nickname: "peer-user-id", username: "peer-user-id"),
        ]
        let organizationMembers = [
            OrganizationMember(
                id: "member-1",
                userId: "peer-user-id",
                role: .editor,
                joinedAt: nil,
                user: MemberUser(
                    id: "peer-user-id",
                    nickname: "张三",
                    username: "zhangsan",
                    email: nil,
                    phone: nil,
                    avatar: nil
                )
            ),
        ]

        XCTAssertEqual(
            IMMemberDisplayPolicy.directMessageDisplayName(
                members: members,
                currentUserId: "current-user",
                peerUserId: "peer-user-id",
                organizationMembers: organizationMembers
            ),
            "张三"
        )
        XCTAssertEqual(
            IMMemberDisplayPolicy.directMessageDisplayName(
                members: members,
                currentUserId: "current-user",
                peerUserId: "peer-user-id",
                organizationMembers: []
            ),
            "私聊"
        )
    }

    func testOrganizationProfileAvatarReplacesStaleIMSnapshot() {
        let detail = IMConversationDetail(
            id: "conv-1",
            organizationId: "org-1",
            type: IMConversationType.group.rawValue,
            members: [
                IMMember(
                    userId: "user-1",
                    avatar: "https://example.test/stale-avatar.png"
                ),
            ]
        )
        let enriched = IMMemberDisplayPolicy.enrichedDetail(
            detail,
            organizationMembers: [
                OrganizationMember(
                    id: "member-1",
                    userId: "user-1",
                    role: .editor,
                    joinedAt: nil,
                    user: MemberUser(
                        id: "user-1",
                        nickname: "张三",
                        username: nil,
                        email: nil,
                        phone: nil,
                        avatar: "https://example.test/current-avatar.png"
                    )
                ),
            ]
        )

        XCTAssertEqual(enriched.members.first?.avatar, "https://example.test/current-avatar.png")
    }

    func testReadReceiptAvatarsUseCurrentOrganizationProfileAndKeepMessageSnapshotFallback() {
        let members = [
            OrganizationMember(
                id: "member-1",
                userId: "user-1",
                role: .editor,
                joinedAt: nil,
                user: MemberUser(
                    id: "user-1",
                    nickname: "最新昵称",
                    username: nil,
                    email: nil,
                    phone: nil,
                    avatar: "https://example.test/current-avatar.png"
                )
            ),
        ]
        let enriched = IMMemberDisplayPolicy.enrichedReadReceipts(
            IMMessageReadReceipts(
                readers: [
                    IMReadReceiptMember(
                        userId: "user-1",
                        name: "旧昵称",
                        avatar: "https://example.test/stale-avatar.png"
                    ),
                ],
                unreaders: [
                    IMReadReceiptMember(
                        userId: "user-2",
                        name: "完整成员快照",
                        avatar: "https://example.test/message-snapshot-avatar.png"
                    ),
                ]
            ),
            organizationMembers: members
        )

        XCTAssertEqual(enriched.readers.first?.name, "最新昵称")
        XCTAssertEqual(enriched.readers.first?.avatar, "https://example.test/current-avatar.png")
        XCTAssertEqual(enriched.unreaders.first?.avatar, "https://example.test/message-snapshot-avatar.png")
    }

    func testDirectMessagePeerNamePrefersExplicitPeerIdWhenCurrentUserIsUnavailable() {
        let detail = IMConversationDetail(
            id: "dm-1",
            organizationId: "org-1",
            type: IMConversationType.dm.rawValue,
            members: [
                IMMember(userId: "me", nickname: "我"),
                IMMember(userId: "peer", nickname: "沈庚涛"),
            ]
        )

        XCTAssertEqual(
            IMMemberDisplayPolicy.directMessagePeerDisplayName(
                in: detail,
                currentUserId: nil,
                preferredPeerUserId: "peer"
            ),
            "沈庚涛"
        )
    }

    func testDirectMessagePeerNameFailsClosedWhenCurrentUserAndPreferredPeerAreUnavailable() {
        let detail = IMConversationDetail(
            id: "dm-1",
            organizationId: "org-1",
            type: IMConversationType.dm.rawValue,
            members: [IMMember(userId: "me", nickname: "我")]
        )

        XCTAssertNil(
            IMMemberDisplayPolicy.directMessagePeerDisplayName(
                in: detail,
                currentUserId: nil,
                preferredPeerUserId: "removed-peer"
            )
        )
    }

    func testMemberDisplayFallbackKeepsRowsDistinguishableWhenDirectoryIsMissing() {
        XCTAssertEqual(
            IMMemberDisplayPolicy.displayName(for: IMMember(userId: "user-123456789")),
            "成员 user-123"
        )
    }

    func testRemovingConversationClearsActiveStateAndListEntry() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "group-1", unread: 3),
            makeConversation(id: "dm-1", unread: 2),
        ])
        store.enterConversation("group-1")

        store.removeConversation("group-1")

        XCTAssertNil(store.activeConversationId)
        XCTAssertEqual(store.conversations.map(\.id), ["dm-1"])
    }

    func testAggregateUnreadSumsNonNegativeCounts() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 2),
            makeConversation(id: "c2", unread: 5),
            makeConversation(id: "c3", unread: -8),
        ])
        XCTAssertEqual(store.aggregateUnreadCount, 7)
    }

    func testAggregateAndRealtimeIncrementSaturateAtIntMax() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: Int.max),
            makeConversation(id: "c2", unread: 1),
        ])

        XCTAssertEqual(store.aggregateUnreadCount, Int.max)

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "message_id": 99, "preview": "饱和"}
        """))
        XCTAssertEqual(store.conversations.first(where: { $0.id == "c1" })?.unreadCount, Int.max)
        XCTAssertEqual(store.aggregateUnreadCount, Int.max)
    }

    func testMarkedReadPersonalEventClearsUnread() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 4)])
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "marked_read": 3, "last_read_seq": 10}
        """))
        XCTAssertEqual(store.conversations.first?.unreadCount, 0)
    }

    func testNewMessageUnreadIncrementsWhenNotActive() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 1, preview: "旧")])
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1",
         "message_id": 99, "message_seq": 99, "sender_id": "u2",
         "sender_name": "张三", "preview": "新消息", "mention": false}
        """))
        XCTAssertEqual(store.conversations.first?.unreadCount, 2)
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "新消息")
        XCTAssertEqual(store.aggregateUnreadCount, 2)
    }

    func testMentionUnreadAddsSystemLabelAndReadRemovesOnlyThatLabel() {
        let custom = IMConversationLabel(id: "custom:priority", name: "Priority")
        let store = IMConversationStore(dataPlane: FakeIMConversationDataPlane())
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 0, labels: [custom])
        ])

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 21,
         "message_seq": 21, "preview": "@你 看一下", "mention": true}
        """))
        XCTAssertEqual(Set(store.conversations[0].labels.map(\.id)), ["custom:priority", "sys:mention"])

        store.enterConversation("c1")
        XCTAssertEqual(store.conversations[0].labels.map(\.id), ["custom:priority"])
    }

    func testBufferedMentionSurvivesUnreadBeforeConversationNew() {
        let store = IMConversationStore(dataPlane: FakeIMConversationDataPlane())
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([])

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-new", "organization_id": "org-1", "message_id": 22,
         "message_seq": 22, "preview": "@你 新会话", "mention": true}
        """))
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-new"))

        XCTAssertTrue(store.conversations[0].labels.contains { $0.id == "sys:mention" })
    }

    func testMentionArrivingDuringLoadSurvivesOlderSnapshotCommit() {
        let store = IMConversationStore(dataPlane: FakeIMConversationDataPlane())
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0, lastSeq: 20)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 21,
         "message_seq": 21, "preview": "@你 窗口内", "mention": true}
        """))
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, lastSeq: 20)])

        XCTAssertTrue(store.conversations[0].labels.contains { $0.id == "sys:mention" })
    }

    func testLatestPreviewUpdateCanReplaceRecalledLastMessageWithoutUnreadIncrement() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 2, preview: "待撤回", lastSeq: 9)])

        store.applyLatestPreviewUpdate(conversationId: "c1", messageSeq: 9, preview: "消息已撤回")

        XCTAssertEqual(store.conversations.first?.unreadCount, 2)
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "消息已撤回")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 9)
    }

    func testRecalledLatestPreviewSurvivesStaleConversationSnapshot() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0, preview: "待撤回", lastSeq: 9)])

        store.applyLatestPreviewUpdate(conversationId: "c1", messageSeq: 9, preview: "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, preview: "待撤回", lastSeq: 9)])

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "消息已撤回")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 9)
    }

    func testRecalledLatestPreviewCanBeRecordedBeforeConversationListLoads() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")

        store.applyLatestPreviewUpdate(conversationId: "c1", messageSeq: 9, preview: "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, preview: "待撤回", lastSeq: 9)])

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "消息已撤回")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 9)
    }

    func testNewerSnapshotReplacesRecalledLatestPreviewOverride() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0, preview: "待撤回", lastSeq: 9)])

        store.applyLatestPreviewUpdate(conversationId: "c1", messageSeq: 9, preview: "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, preview: "新消息", lastSeq: 10)])

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "新消息")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 10)
    }

    func testLatestPreviewUpdateIgnoresOlderRecalledMessage() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0, preview: "最新消息", lastSeq: 10)])

        store.applyLatestPreviewUpdate(conversationId: "c1", messageSeq: 9, preview: "消息已撤回")

        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "最新消息")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 10)
    }

    func testActiveConversationRefreshesPreviewWithoutIncrementingUnread() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 0, preview: "旧摘要", lastSeq: 98)
        ])
        store.enterConversation("c1")
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "message_id": 99, "message_seq": 99,
         "sender_id": "u2", "sender_name": "张三", "preview": "在看", "mention": false}
        """))
        XCTAssertEqual(store.conversations.first?.unreadCount, 0, "前台会话不应再涨未读")
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "在看")
        XCTAssertEqual(store.conversations.first?.lastMessageSeq, 99)
    }

    func testClearResetsConversationDataPlaneListeningSoReloginCanRebind() {
        let dataPlane = FakeIMConversationDataPlane()
        let store = IMConversationStore(dataPlane: dataPlane)
        store.startListeningPersonalForTesting()
        XCTAssertTrue(store.isListeningPersonalForTesting)
        XCTAssertNotNil(dataPlane.conversationChangedListener)

        store.clear()
        XCTAssertFalse(store.isListeningPersonalForTesting, "clear 必须复位监听 flag")
        XCTAssertNil(dataPlane.conversationChangedListener)

        store.startListeningPersonalForTesting()
        XCTAssertTrue(store.isListeningPersonalForTesting, "重登后应能再次进入监听")
        XCTAssertNotNil(dataPlane.conversationChangedListener)
    }

    func testMarkReadAndClearReduceAggregateImmediately() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([
            makeConversation(id: "c1", unread: 4),
            makeConversation(id: "c2", unread: 3),
        ])

        store.clearUnread(conversationId: "c1")
        XCTAssertEqual(store.aggregateUnreadCount, 3)

        store.clear()
        XCTAssertEqual(store.aggregateUnreadCount, 0)
    }

    func testConversationNewInsertsSoBadgeAppearsWithoutManualRefresh() {
        // 回归  issue 2：在线用户收到新 DM 时，im.conversation.new 应把会话插入列表，
        // 随后第一条消息的 im.unread.update 才能命中并让「消息」聚合角标即时出现。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c-old", unread: 0)])

        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-new"))
        XCTAssertEqual(store.conversations.first?.id, "c-new", "新会话应插到列表最前")
        XCTAssertEqual(store.conversations.count, 2)

        // 首条消息未读：此前会因会话不在列表而被丢弃；现在应命中并 +1。
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-new", "organization_id": "org-1",
         "message_id": 1, "message_seq": 1, "sender_id": "u2",
         "sender_name": "李四", "preview": "在吗", "mention": false}
        """))
        XCTAssertEqual(store.conversations.first(where: { $0.id == "c-new" })?.unreadCount, 1)
        XCTAssertEqual(store.conversations.first(where: { $0.id == "c-new" })?.lastMessagePreview, "在吗")
        XCTAssertEqual(store.aggregateUnreadCount, 1)
    }

    func testUnreadBeforeConversationNewIsBufferedAndReplayed() {
        // 回归 ：im.unread.update 与 im.conversation.new 是两条独立 outbox 记录、投递顺序不保证。
        // 若未读先于新会话到达，之前会被直接丢弃、会话插入后停留 unreadCount=0、首条消息漏角标。
        // 现在应缓存未读、在会话插入时回放。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([])

        // 1) 首条消息未读先到（会话还不在列表）——缓存，不落地。
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-new", "organization_id": "org-1",
         "message_id": 1, "message_seq": 1, "sender_id": "u2",
         "sender_name": "李四", "preview": "在吗", "mention": false}
        """))
        XCTAssertTrue(store.conversations.isEmpty, "会话未到达前不应硬插")
        XCTAssertEqual(store.aggregateUnreadCount, 0)

        // 2) 新会话摘要后到——插入时回放缓存的未读。
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-new"))
        XCTAssertEqual(store.conversations.first?.id, "c-new")
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "乱序到达也应保留首条消息未读")
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "在吗")
        XCTAssertEqual(store.aggregateUnreadCount, 1)
    }

    func testBufferedUnreadClearedOnOrganizationSwitch() {
        // 缓存的未读随组织切换清空，避免跨组织串到新组织的会话上。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-a")
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-x", "organization_id": "org-a",
         "message_id": 1, "message_seq": 1, "sender_id": "u2",
         "sender_name": "李四", "preview": "x", "mention": false}
        """))
        store.prepareOrganizationForTesting("org-b")
        // 切到 org-b 后，即便同 id 的会话插入，也不应带上 org-a 缓存的未读。
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-x", org: "org-b"))
        XCTAssertEqual(store.conversations.first?.id, "c-x")
        XCTAssertEqual(store.conversations.first?.unreadCount, 0, "切组织应清空未读缓存")
    }

    func testOutOfOrderUnreadEventsAreBothCounted() {
        // 回归  issue 2：标量 seq 水位会把「先到 seq=10、后到此前未处理的 seq=9」中的 seq=9
        // 误当已计入而丢弃、造成少计。现在两条不同消息各自 +1，乱序也不丢。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])
        func ev(_ seq: Int) -> Data {
            unreadEventJSON("""
            {"conversation_id": "c1", "organization_id": "org-1", "message_id": \(seq),
             "message_seq": \(seq), "sender_id": "u2", "sender_name": "张三",
             "preview": "m\(seq)", "mention": false}
            """)
        }
        store.applyPersonalRealtime(ev(10))
        store.applyPersonalRealtime(ev(9))  // 迟到的更小 seq：仍是一条未读，不得丢弃
        XCTAssertEqual(store.conversations.first?.unreadCount, 2, "乱序两条消息应各计一次")
    }

    func testNonZeroStaleBaselineMergesSnapshotPlusWindowDeltaOnly() {
        // 回归 ：加载在途时，被触碰会话不得保留「完整本地未读」（含陈旧基线），
        // 只应在权威快照上叠加窗口净增量。本地旧 unread=5、对端已读到 0；刷新在途来一条新消息，
        // REST 权威=0（水位=0，未含该消息）→ 最终应为 1（不是 6）。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 5)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 5,
         "message_seq": 5, "sender_id": "u2", "sender_name": "张三", "preview": "窗口内", "mention": false}
        """))
        // 权威快照 unread=0、水位=0：窗口消息 seq=5 > 0 → 净增 1。最终 = 0 + 1 = 1。
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, lastSeq: 0)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "应为快照(0)+窗口净增(1)，不保留陈旧基线 5→6")
    }

    func testOutOfOrderWindowPreviewKeepsHighestSeqNotLastArrived() {
        // 回归 ：加载窗口内 realtime 可乱序到达——先 seq=10（预览 A）、后 seq=9（预览 B）。
        // 快照水位=8（未含 9/10）→ 净增 2；摘要必须停在最高 seq(10) 的 A，不被后到的旧消息 B 退回。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 10,
         "message_seq": 10, "sender_id": "u2", "sender_name": "张三", "preview": "A", "mention": false}
        """))
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 9,
         "message_seq": 9, "sender_id": "u2", "sender_name": "张三", "preview": "B", "mention": false}
        """))
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, preview: "旧", lastSeq: 8)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 2, "两条快照未含消息应各计一次")
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "A", "摘要应停在最高 seq，不被乱序旧消息退回")
    }

    func testWaterlineCoversWindowKeepsSnapshotPreviewNotLastArrived() {
        // 回归  复现原样：加载期间先到 seq=10（A）再到 seq=9（B），快照水位=10（已含二者）。
        // 未读不叠加（都 <= 水位），摘要必须用权威快照（seq=10 的 A），绝不落到后到的旧 B。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 10,
         "message_seq": 10, "sender_id": "u2", "sender_name": "张三", "preview": "A", "mention": false}
        """))
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 9,
         "message_seq": 9, "sender_id": "u2", "sender_name": "张三", "preview": "B", "mention": false}
        """))
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 1, preview: "A", lastSeq: 10)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "窗口消息都 <= 水位，不叠加")
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "A", "摘要用权威快照，不落到后到旧消息 B")
    }

    func testOutOfOrderLivePreviewKeepsHighestSeq() {
        // 稳态（无加载窗口）乱序：先 seq=10（A）后 seq=9（B），摘要应停在 A。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0, preview: "旧")])
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 10,
         "message_seq": 10, "sender_id": "u2", "sender_name": "张三", "preview": "A", "mention": false}
        """))
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 9,
         "message_seq": 9, "sender_id": "u2", "sender_name": "张三", "preview": "B", "mention": false}
        """))
        XCTAssertEqual(store.conversations.first?.unreadCount, 2)
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "A", "乱序稳态摘要不被旧消息退回")
    }

    func testSnapshotBeforePublicationCountsWindowDelta() {
        // snapshot-before-publication：快照水位=4（未含 seq=5 的窗口消息）→ seq=5 计净增。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 5,
         "message_seq": 5, "sender_id": "u2", "sender_name": "张三", "preview": "窗口内", "mention": false}
        """))
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 0, lastSeq: 4)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "快照未含的窗口消息应计净增")
    }

    func testSnapshotIncludesPublicationDoesNotDoubleCount() {
        // snapshot-includes-publication：快照 unread=1、水位=5（已含 seq=5）→ 窗口同一 seq=5 不重复计。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])

        store.beginLoadWindowForTesting()
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 5,
         "message_seq": 5, "sender_id": "u2", "sender_name": "张三", "preview": "窗口内", "mention": false}
        """))
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 1, lastSeq: 5)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "快照已含该消息，窗口不得重复 +1")
    }

    func testQuietWindowSnapshotIsAuthoritativeForUntouchedConversation() {
        // 未被触碰的会话（加载窗口内无并发事件）以权威快照为准，不叠加历史本地值。
        // 使用独立 Store，避免 shared Store 在同组其他已读测试留下的 read waterline
        // 把本用例的权威快照清零，造成与测试顺序相关的假失败。
        let store = IMConversationStore(dataPlane: FakeIMConversationDataPlane())
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 5)])

        store.beginLoadWindowForTesting()
        // 窗口内无事件。快照权威值为 2。
        store.commitLoadForTesting([makeConversation(id: "c1", unread: 2)])
        XCTAssertEqual(store.conversations.first?.unreadCount, 2, "未触碰会话以权威快照为准")
    }

    func testActiveConsumedMessageIsNotRepublishedAsUnreadAfterLeave() {
        // 回归 ：前台（active）收到 message_id=42 已消费；离开后 Centrifugo 重投 42 不得冒伪未读。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])
        store.enterConversation("c1")
        let ev = unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 42,
         "message_seq": 42, "sender_id": "u2", "sender_name": "张三", "preview": "hi", "mention": false}
        """)
        store.applyPersonalRealtime(ev)                 // 前台消费：清零 + 登记 message_id
        XCTAssertEqual(store.conversations.first?.unreadCount, 0)
        store.leaveConversation("c1")
        store.applyPersonalRealtime(ev)                 // 离开后重投同一 message_id
        XCTAssertEqual(store.conversations.first?.unreadCount, 0, "已消费的消息重投不得冒伪未读")
    }

    func testDuplicatePublicationForExistingConversationDoesNotDoubleCount() {
        // 回归 ：Centrifugo 重连/重投同一 message_id，已有会话不得重复 +1。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])
        let ev = unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1", "message_id": 42,
         "message_seq": 42, "sender_id": "u2", "sender_name": "张三", "preview": "hi", "mention": false}
        """)
        store.applyPersonalRealtime(ev)
        store.applyPersonalRealtime(ev)  // 重投同一 message_id
        store.applyPersonalRealtime(ev)
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "重复投递同一消息只计一次")
    }

    func testMarkedReadClearsBufferedUnknownUnreadBeforeConversationNew() {
        // 回归 ：unknown unread -> marked_read -> conversation.new。
        // 未知会话未读先到被缓冲；随后另一端已读 marked_read 到达（会话仍未插入，clearUnread 无效）；
        // 已读应清掉缓冲，避免延迟的 conversation.new 把已读消息回放成未读。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([])

        // 1) 未知会话未读先到 → 缓冲。
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-new", "organization_id": "org-1", "message_id": 1,
         "message_seq": 1, "sender_id": "u2", "sender_name": "李四", "preview": "在吗", "mention": false}
        """))
        // 2) 另一端已读的 marked_read 到达（会话尚未插入）。
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c-new", "marked_read": 1, "last_read_seq": 1}
        """))
        // 3) 延迟的 conversation.new 插入：不得把已读消息回放成未读。
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-new"))
        XCTAssertEqual(store.conversations.first?.id, "c-new")
        XCTAssertEqual(store.conversations.first?.unreadCount, 0, "已读回写应清掉缓冲，不回放为未读")
        XCTAssertEqual(store.aggregateUnreadCount, 0)
    }

    func testBufferedUnknownUnreadDedupsByMessageId() {
        // 未知会话未读缓冲按 messageId 去重：同一条消息重复投递（重连）不得把缓冲变成 2。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([])
        let ev = unreadEventJSON("""
        {"conversation_id": "c-new", "organization_id": "org-1", "message_id": 3,
         "message_seq": 3, "sender_id": "u2", "sender_name": "李四", "preview": "在吗", "mention": false}
        """)
        store.applyPersonalRealtime(ev)
        store.applyPersonalRealtime(ev)  // 重复投递同一 messageId
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c-new"))
        XCTAssertEqual(store.conversations.first { $0.id == "c-new" }?.unreadCount, 1, "重复缓冲同一消息只计一次")
    }

    func testConversationNewIsIdempotentForExistingConversation() {
        let store = IMConversationStore.shared
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 3)])
        store.applyPersonalRealtime(conversationNewEventJSON(id: "c1"))
        XCTAssertEqual(store.conversations.count, 1, "已存在会话不应重复插入")
        XCTAssertEqual(store.conversations.first?.unreadCount, 3, "已存在会话不应被摘要覆盖未读")
    }

    func testCrossOrganizationEventsDoNotPolluteCurrentOrgListOrUnread() {
        // 回归 ：personal:{user} 是用户级频道、跨组织共用。用户当前停在 org-a，
        // org-b 新建含该用户的 DM 时，im.conversation.new / im.unread.update 携带 org-b，
        // 不得插入 org-a 列表、不得计入 org-a 聚合角标。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-a")
        store.replaceConversationsForTesting([makeConversation(id: "a1", unread: 2)])

        // org-b 的新会话摘要不应插入当前（org-a）列表。
        store.applyPersonalRealtime(conversationNewEventJSON(id: "b1", org: "org-b"))
        XCTAssertFalse(store.conversations.contains { $0.id == "b1" }, "非当前组织的新会话不应插入列表")
        XCTAssertEqual(store.conversations.count, 1)

        // org-b 的新消息未读不应计入当前组织聚合角标。
        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "b1", "organization_id": "org-b",
         "message_id": 1, "message_seq": 1, "sender_id": "u9",
         "sender_name": "跨组织", "preview": "hi", "mention": false}
        """))
        XCTAssertFalse(store.conversations.contains { $0.id == "b1" }, "跨组织未读不应把会话带进列表")
        XCTAssertEqual(store.aggregateUnreadCount, 2, "跨组织未读不得计入当前组织聚合角标")
    }

    func testExternalConversationUsesParticipantDirectoryForRealtimeFiltering() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-peer")
        store.replaceConversationsForTesting([])

        store.applyPersonalRealtime(Data("""
        {"type": "im.conversation.new", "event_id": "external-new", "data": {
          "id": "external-1", "organization_id": "org-host",
          "participant_organization_id": "org-peer", "directory_scope_id": "org-peer",
          "space_id": null, "space_name": "", "is_team_space_channel": false,
          "is_external": true, "type": 2, "name": "跨组织协作", "avatar_url": "",
          "member_count": 2, "is_archived": false,
          "last_message_at": "2026-08-20T10:00:00Z", "last_message_preview": "",
          "unread_count": 0, "last_message_seq": 0,
          "created_at": "2026-08-20T10:00:00Z", "dm_peer_user_id": null,
          "pinned": false, "is_muted": false, "can_send": true
        }}
        """.utf8))
        XCTAssertEqual(store.conversations.map(\.id), ["external-1"])

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "external-1", "organization_id": "org-host",
         "directory_scope_id": "org-peer", "message_id": 9, "message_seq": 9,
         "sender_id": "owner", "sender_name": "发起人", "preview": "进展", "mention": false}
        """))

        XCTAssertEqual(store.conversations.first?.unreadCount, 1)
        XCTAssertEqual(store.conversations.first?.lastMessagePreview, "进展")
    }

    func testProfileUpdateRefreshesDirectMessageSnapshotAndRevision() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        var directMessage = makeConversation(
            id: "dm-1",
            unread: 0,
            type: IMConversationType.dm.rawValue,
            peerUserId: "user-2",
            memberCount: 2
        )
        directMessage.name = "旧昵称"
        directMessage.avatarUrl = "https://cdn.example/old.png"
        store.replaceConversationsForTesting([directMessage])
        let previousRevision = store.profileRevision

        store.applyPersonalRealtime(Data("""
        {"type":"im.user.profile.updated","data":{"id":"user-2","nickname":"新昵称","username":"alice","avatar":"https://cdn.example/new.png","avatar_version":"8","revision":8}}
        """.utf8))

        XCTAssertEqual(store.conversations.first?.name, "新昵称")
        XCTAssertEqual(store.conversations.first?.avatarUrl, "https://cdn.example/new.png")
        XCTAssertEqual(store.profileRevision, previousRevision + 1)
    }

    func testBackgroundedConversationKeepsUnreadInList() {
        // 回归 ：页面留在导航栈时按 Home/锁屏 → scenePhase 非 active → leaveConversation。
        // 此后收到该会话新消息，列表未读应照常出现（不被当作正在阅读而清零）。
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 0)])
        store.enterConversation("c1")   // 前台进入（乐观清零）
        store.leaveConversation("c1")   // 模拟切后台：注销活动会话

        store.applyPersonalRealtime(unreadEventJSON("""
        {"conversation_id": "c1", "organization_id": "org-1",
         "message_id": 5, "message_seq": 5, "sender_id": "u2",
         "sender_name": "张三", "preview": "后台来消息", "mention": false}
        """))
        XCTAssertEqual(store.conversations.first?.unreadCount, 1, "后台收到消息应保留未读")
        XCTAssertEqual(store.aggregateUnreadCount, 1)
    }

    func testOrganizationSwitchClearsOldUnreadSynchronously() {
        let store = IMConversationStore.shared
        store.prepareOrganizationForTesting("org-a")
        store.replaceConversationsForTesting([makeConversation(id: "c1", unread: 6)])
        store.enterConversation("c1")

        store.prepareOrganizationForTesting("org-b")

        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertEqual(store.aggregateUnreadCount, 0)
        XCTAssertNil(store.activeConversationId)
    }
}

final class RecentSectionUnreadBadgeTests: XCTestCase {
    func testUnreadBadgeTextBelongsOnlyToMessagesAndCapsAt99Plus() {
        let cases: [(unreadCount: Int, expectedText: String?)] = [
            (0, nil),
            (7, "7"),
            (42, "42"),
            (99, "99"),
            (100, "99+"),
            (Int.max, "99+"),
        ]

        for testCase in cases {
            XCTAssertNil(
                RecentSection.conversations.unreadBadgeText(unreadCount: testCase.unreadCount)
            )
            XCTAssertEqual(
                RecentSection.messages.unreadBadgeText(unreadCount: testCase.unreadCount),
                testCase.expectedText
            )
            XCTAssertNil(
                RecentSection.contacts.unreadBadgeText(unreadCount: testCase.unreadCount)
            )
        }
    }

    func testVoiceOverUnreadDescriptionBelongsOnlyToMessagesAndKeepsExactCount() {
        let unreadCount = 100

        XCTAssertEqual(
            RecentSection.conversations.accessibilityLabel(unreadCount: unreadCount),
            RecentSection.conversations.title
        )
        XCTAssertEqual(
            RecentSection.messages.accessibilityLabel(unreadCount: unreadCount),
            "\(RecentSection.messages.title)，100 条未读"
        )
        XCTAssertEqual(
            RecentSection.contacts.accessibilityLabel(unreadCount: unreadCount),
            RecentSection.contacts.title
        )
    }
}
