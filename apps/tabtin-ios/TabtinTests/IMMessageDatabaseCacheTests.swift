import XCTest
@preconcurrency import SwiftData
@testable import Tabtin

@MainActor
final class IMMessageDatabaseCacheTests: XCTestCase {
    func testHumanReadReceiptProjectionUsesDomainUserIdsAndExcludesRemovedMembers() {
        let userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        let removedUserId = "22222222-2222-4222-8222-222222222222"

        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 2),
            detail: IMMessageReadReceipts(
                readers: [IMReadReceiptMember(userId: removedUserId, name: "已移除成员", avatar: "")],
                unreaders: [IMReadReceiptMember(userId: userId, name: "当前成员", avatar: "")]
            ),
            members: [
                IMMember(userId: "me"),
                IMMember(
                    userId: userId,
                    nickname: "当前成员"
                ),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.detail?.readers, [])
        XCTAssertEqual(projection.detail?.unreaders.map(\.userId), [userId])
        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 0, recipientCount: 1))
    }

    func testDirectMessageReadPresentationKeepsUnreadIndicator() {
        XCTAssertNil(dmReadProgress(isMine: false, isReadByPeer: true))
        XCTAssertEqual(
            dmReadProgress(isMine: true, isReadByPeer: false),
            IMReadReceipt(readCount: 0, recipientCount: 1)
        )
        XCTAssertEqual(
            dmReadProgress(isMine: true, isReadByPeer: true),
            IMReadReceipt(readCount: 1, recipientCount: 1)
        )
    }

    func testGroupReadPresentationFallsBackToHumanRecipientCount() {
        XCTAssertNil(
            groupReadProgress(
                isMine: false,
                progress: nil,
                fallbackRecipientCount: 2
            )
        )
        XCTAssertEqual(
            groupReadProgress(
                isMine: true,
                progress: nil,
                fallbackRecipientCount: 2
            ),
            IMReadReceipt(readCount: 0, recipientCount: 2)
        )
        XCTAssertEqual(
            groupReadProgress(
                isMine: true,
                progress: IMReadReceipt(readCount: 5, recipientCount: 3),
                fallbackRecipientCount: 2
            ),
            IMReadReceipt(readCount: 2, recipientCount: 2)
        )
    }

    func testHumanReadReceiptProjectionFiltersAgentsFromDetailsAndCounts() {
        let agentId = "56922c34-4337-4bc7-ae63-748b5d6b514a"
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 2, recipientCount: 4),
            detail: IMMessageReadReceipts(
                readers: [
                    IMReadReceiptMember(userId: "human-1", name: "甲", avatar: ""),
                    IMReadReceiptMember(userId: agentId, name: "AI", avatar: ""),
                ],
                unreaders: [
                    IMReadReceiptMember(userId: "human-2", name: "乙", avatar: ""),
                    IMReadReceiptMember(userId: "me", name: "我", avatar: ""),
                ]
            ),
            members: [
                IMMember(userId: "me", nickname: "我"),
                IMMember(userId: "human-1", nickname: "甲"),
                IMMember(userId: "human-2", nickname: "乙"),
                IMMember(
                    memberType: IMMemberType.agent.rawValue,
                    agentId: agentId,
                    nickname: "AI"
                ),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 1, recipientCount: 2))
        XCTAssertEqual(projection.detail?.readers.map(\.userId), ["human-1"])
        XCTAssertEqual(projection.detail?.unreaders.map(\.userId), ["human-2"])
    }

    func testHumanReadReceiptProjectionTrustsExplicitUserTypeBeforeLegacyPrefixFallback() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 2),
            detail: IMMessageReadReceipts(
                readers: [IMReadReceiptMember(userId: "a_human", name: "真人", avatar: "")],
                unreaders: [IMReadReceiptMember(userId: "a_legacy_agent", name: "AI", avatar: "")]
            ),
            members: [
                IMMember(userId: "me", nickname: "我"),
                IMMember(memberType: IMMemberType.user.rawValue, userId: "a_human", nickname: "真人"),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 1, recipientCount: 1))
        XCTAssertEqual(projection.detail?.readers.map(\.userId), ["a_human"])
        XCTAssertEqual(projection.detail?.unreaders, [])
    }

    func testHumanReadReceiptProjectionNeverRaisesProviderRecipientSubsetToFullMemberCount() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 2),
            detail: nil,
            members: [
                IMMember(userId: "me"),
                IMMember(userId: "human-1"),
                IMMember(userId: "human-2"),
                IMMember(userId: "human-3"),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 0, recipientCount: 2))
    }

    func testHumanReadReceiptProjectionHidesRawCountsUntilMemberSnapshotLoads() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 2),
            detail: nil,
            members: [],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertNil(projection.progress, "没有真人成员快照时不能展示可能包含 Agent 的腾讯原始人数")
    }

    func testHumanReadReceiptProjectionMapsDomainMembersAndExcludesRemovedAccounts() {
        let currentUserId = "11111111-1111-4111-8111-111111111111"
        let currentHumanId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        let removedReaderId = "22222222-2222-4222-8222-222222222222"
        let removedUnreaderId = "33333333-3333-4333-8333-333333333333"
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 2, recipientCount: 3),
            detail: IMMessageReadReceipts(
                readers: [
                    IMReadReceiptMember(userId: currentHumanId, name: "当前成员", avatar: ""),
                    IMReadReceiptMember(userId: removedReaderId, name: "已移除读者", avatar: ""),
                ],
                unreaders: [
                    IMReadReceiptMember(userId: removedUnreaderId, name: "已移除未读者", avatar: ""),
                ]
            ),
            members: [
                IMMember(
                    userId: currentUserId
                ),
                IMMember(
                    userId: currentHumanId,
                    nickname: "当前成员"
                ),
            ],
            currentUserId: currentUserId,
            senderId: currentUserId
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 1, recipientCount: 1))
        XCTAssertEqual(projection.detail?.readers.map(\.userId), [currentHumanId])
        XCTAssertEqual(projection.detail?.unreaders, [])
    }

    func testHumanReadReceiptProjectionKeepsRecipientsButWaitsForReaderIdentitiesAfterAgentAdded() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 2),
            detail: nil,
            members: [
                IMMember(userId: "11111111-1111-4111-8111-111111111111"),
                IMMember(userId: "22222222-2222-4222-8222-222222222222"),
                IMMember(userId: "33333333-3333-4333-8333-333333333333"),
                IMMember(
                    memberType: IMMemberType.agent.rawValue,
                    agentId: "56922c34-4337-4bc7-ae63-748b5d6b514a"
                ),
            ],
            currentUserId: "11111111-1111-4111-8111-111111111111",
            senderId: "11111111-1111-4111-8111-111111111111"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 0, recipientCount: 2))
    }

    func testHumanReadReceiptProjectionCapsRecipientsWithoutDoubleCountingAgentIdentities() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 0, recipientCount: 3),
            detail: nil,
            members: [
                IMMember(userId: "me"),
                IMMember(userId: "human-1"),
                IMMember(userId: "human-2"),
                IMMember(
                    memberType: IMMemberType.agent.rawValue,
                    userId: "a_provider-agent",
                    agentId: "agent-domain-id"
                ),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 0, recipientCount: 2))
    }

    func testHumanReadReceiptProjectionDoesNotCountUnknownReadersBeforeDetailArrives() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 1, recipientCount: 3),
            detail: nil,
            members: [
                IMMember(userId: "me"),
                IMMember(userId: "human-1"),
                IMMember(userId: "human-2"),
                IMMember(memberType: IMMemberType.agent.rawValue, agentId: "agent-1"),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 0, recipientCount: 2))
    }

    func testHumanReadReceiptProjectionCountsOnlyConfirmedReadersFromPartialDetail() {
        let projection = IMHumanReadReceiptPolicy.project(
            progress: IMReadReceipt(readCount: 2, recipientCount: 3),
            detail: IMMessageReadReceipts(
                readers: [IMReadReceiptMember(userId: "human-1", name: "甲", avatar: "")],
                unreaders: []
            ),
            members: [
                IMMember(userId: "me"),
                IMMember(userId: "human-1"),
                IMMember(userId: "human-2"),
                IMMember(memberType: IMMemberType.agent.rawValue, agentId: "agent-1"),
            ],
            currentUserId: "me",
            senderId: "me"
        )

        XCTAssertEqual(projection.progress, IMReadReceipt(readCount: 1, recipientCount: 2))
    }

    func testDatabaseRestoresMessagesAndMonotonicReadWaterlines() async {
        let cache = IMMessageDatabaseCache(isStoredInMemoryOnly: true)
        var message = IMMessage(
            id: 42,
            seq: 42,
            conversationId: "conv-db",
            senderId: "me",
            content: "数据库快照",
            messageType: IMMessageType.text.rawValue
        )
        message.readReceipt = IMReadReceipt(readCount: 1, recipientCount: 1)

        cache.store(scopeId: "user-a", conversationId: "conv-db", messages: [message])
        cache.advanceReadWaterline(
            scopeId: "user-a",
            conversationId: "conv-db",
            readerId: "peer",
            seq: 42
        )
        cache.advanceReadWaterline(
            scopeId: "user-a",
            conversationId: "conv-db",
            readerId: "peer",
            seq: 21
        )

        let restored = await waitForMessages(cache)
        let waterlines = await waitForWaterlines(cache)
        let otherUserMessages = await cache.messagesAsync(scopeId: "user-b", conversationId: "conv-db")
        let otherUserWaterlines = await cache.readWaterlinesAsync(scopeId: "user-b", conversationId: "conv-db")

        XCTAssertEqual(restored, [message])
        XCTAssertEqual(waterlines["peer"], 42, "已读水位只能前进，旧状态不能覆盖新状态")
        XCTAssertEqual(otherUserMessages, [], "消息缓存必须按账号隔离")
        XCTAssertEqual(otherUserWaterlines, [:], "已读水位必须按账号隔离")
    }

    func testDatabaseRestoresCompletePinnedSnapshotAndAuthoritativeEmptyClearsIt() async {
        let cache = IMMessageDatabaseCache(isStoredInMemoryOnly: true)
        var pinned = IMMessage(
            id: 84,
            seq: 84,
            conversationId: "conv-pinned",
            senderId: "peer",
            content: "较早但仍置顶的消息",
            messageType: IMMessageType.text.rawValue
        )
        pinned.isPinned = true
        pinned.pinStateKnown = true

        cache.storePinnedMessages(
            scopeId: "user-a",
            conversationId: "conv-pinned",
            messages: [pinned]
        )
        let restored = await waitForPinnedMessages(cache)
        let otherUser = await cache.pinnedMessagesAsync(
            scopeId: "user-b",
            conversationId: "conv-pinned"
        )

        XCTAssertEqual(restored, [pinned])
        XCTAssertTrue(otherUser.isEmpty, "置顶缓存必须按账号隔离")

        cache.storePinnedMessages(
            scopeId: "user-a",
            conversationId: "conv-pinned",
            messages: []
        )
        for _ in 0..<100 {
            if await cache.pinnedMessagesAsync(scopeId: "user-a", conversationId: "conv-pinned").isEmpty {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for authoritative empty pinned snapshot")
    }

    func testPinnedDatabaseRejectsOlderWriteArrivingAfterClear() async throws {
        let schema = Schema([
            CachedIMDatabaseMessage.self,
            CachedIMPinnedMessage.self,
            CachedIMReadWaterline.self,
        ])
        let configuration = ModelConfiguration(
            "TabTinIMPinnedRevisionTest",
            schema: schema,
            isStoredInMemoryOnly: true,
            allowsSave: true
        )
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let worker = IMMessageDatabaseWorker(modelContainer: container)
        var stale = IMMessage(
            id: 85,
            seq: 85,
            conversationId: "conv-pinned",
            senderId: "peer",
            content: "迟到的旧置顶",
            messageType: IMMessageType.text.rawValue
        )
        stale.isPinned = true
        stale.pinStateKnown = true

        await worker.storePinnedMessages(
            scopeId: "user-a",
            conversationId: "conv-pinned",
            messages: [],
            generation: 0,
            revision: 2
        )
        await worker.storePinnedMessages(
            scopeId: "user-a",
            conversationId: "conv-pinned",
            messages: [stale],
            generation: 0,
            revision: 1
        )

        let restored = await worker.pinnedMessages(
            scopeId: "user-a",
            conversationId: "conv-pinned"
        )
        XCTAssertTrue(restored.isEmpty, "清空后的旧持久化任务不得复活置顶快照")
    }

    func testMessageDatabaseRejectsOlderWriteArrivingAfterClear() async throws {
        let schema = Schema([
            CachedIMDatabaseMessage.self,
            CachedIMPinnedMessage.self,
            CachedIMReadWaterline.self,
        ])
        let configuration = ModelConfiguration(
            "TabTinIMMessageRevisionTest",
            schema: schema,
            isStoredInMemoryOnly: true,
            allowsSave: true
        )
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let worker = IMMessageDatabaseWorker(modelContainer: container)
        let stale = IMMessage(
            id: 86,
            seq: 86,
            conversationId: "conv-message",
            senderId: "peer",
            content: "迟到的旧消息",
            messageType: IMMessageType.text.rawValue
        )

        await worker.clear(
            scopeId: "user-a",
            conversationId: "conv-message",
            revision: 2
        )
        await worker.store(
            scopeId: "user-a",
            conversationId: "conv-message",
            messages: [stale],
            messageLimit: 100,
            conversationLimit: 50,
            generation: 0,
            revision: 1
        )

        let restored = await worker.messages(
            scopeId: "user-a",
            conversationId: "conv-message",
            limit: 100
        )
        XCTAssertTrue(restored.isEmpty, "清空后的旧持久化任务不得复活普通消息快照")
    }

    private func waitForMessages(_ cache: IMMessageDatabaseCache) async -> [IMMessage] {
        for _ in 0..<100 {
            let messages = await cache.messagesAsync(scopeId: "user-a", conversationId: "conv-db")
            if !messages.isEmpty { return messages }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for database message snapshot")
        return []
    }

    private func waitForWaterlines(_ cache: IMMessageDatabaseCache) async -> [String: Int] {
        for _ in 0..<100 {
            let waterlines = await cache.readWaterlinesAsync(scopeId: "user-a", conversationId: "conv-db")
            if !waterlines.isEmpty { return waterlines }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for database read waterlines")
        return [:]
    }

    private func waitForPinnedMessages(_ cache: IMMessageDatabaseCache) async -> [IMMessage] {
        for _ in 0..<100 {
            let messages = await cache.pinnedMessagesAsync(
                scopeId: "user-a",
                conversationId: "conv-pinned"
            )
            if !messages.isEmpty { return messages }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for database pinned snapshot")
        return []
    }
}
