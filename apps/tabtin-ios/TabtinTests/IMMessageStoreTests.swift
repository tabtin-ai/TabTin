import XCTest
@testable import Tabtin

/// 用 JSON 解码构造 `IMMessage`（其为 Decodable、无 memberwise init），贴近真实后端负载。
private func makeMessage(
    id: Int,
    seq: Int,
    conversationId: String = "conv-1",
    content: String = "hi",
    senderId: String = "user-2",
    replyToId: Int? = nil,
    createdAt: String? = nil,
    clientRequestId: String? = nil
) -> IMMessage {
    var metadata = "{}"
    if let clientRequestId { metadata = "{\"client_request_id\": \"\(clientRequestId)\"}" }
    let createdField = createdAt.map { "\"created_at\": \"\($0)\"," } ?? ""
    let replyToField = replyToId.map(String.init) ?? "null"
    let json = Data("""
    {
      "id": \(id), "seq": \(seq), "conversation_id": "\(conversationId)",
      "sender_id": "\(senderId)", "sender_type": "user", "sender_name": "张三",
      "content": "\(content)", "message_type": 1, "reply_to_id": \(replyToField),
      \(createdField)
      "metadata": \(metadata)
    }
    """.utf8)
    // 测试内解码失败即用例 bug，强解包。
    return try! JSONDecoder().decode(IMMessage.self, from: json)
}

final class IMSessionShareEndpointTests: XCTestCase {
    func testSessionShareMutationsUseDesktopConversationControlPlane() {
        XCTAssertEqual(Endpoints.IM.sessionShares, "/chat/session-shares")
        XCTAssertEqual(Endpoints.IM.sessionShare("share-1"), "/chat/session-shares/share-1")
        XCTAssertEqual(
            Endpoints.IM.sessionShareRevoke("share-1"),
            "/chat/session-shares/share-1/revoke"
        )
        XCTAssertEqual(
            Endpoints.IM.sessionShareRetryDelivery("share-1"),
            "/chat/session-shares/share-1/delivery/retry"
        )
        XCTAssertEqual(
            Endpoints.IM.sessionContinuations,
            "/chat/session-continuations"
        )
        XCTAssertEqual(
            Endpoints.IM.sessionContinuationBatchGet,
            "/chat/session-continuations/batch-get"
        )
        XCTAssertEqual(
            Endpoints.IM.sessionContinuationCreateTask("continuation-1"),
            "/chat/session-continuations/continuation-1/create-task"
        )
    }
}

/// 记录 Phase E 变更调用、可编排成功/失败的假传输。
private final class FakeMutationTransport: IMMessageTransport, @unchecked Sendable {
    var editResult: Result<IMMessage, Error>?
    var recallShouldFail = false
    var pinShouldFail = false
    var pinnedFetchShouldFail = false
    var seedMessages: [IMMessage] = []
    var seedPinnedMessages: [IMMessage] = []
    var suspendPinnedFetch = false
    private var pinnedFetchContinuation: CheckedContinuation<Void, Never>?
    private var pinnedFetchStarted = false
    private(set) var editedContents: [String] = []
    private(set) var recalledIds: [Int] = []
    private(set) var reactionAdds: [String] = []
    private(set) var reactionRemoves: [String] = []
    private(set) var markReadSequences: [Int] = []
    private(set) var markReadCompletions = 0
    var markReadShouldFail = false
    var acknowledgedSequenceOverride: Int?
    var authoritativeClearedSeq = 0
    private(set) var readReceiptCalls: [(String, Int)] = []
    var readReceiptResult = IMMessageReadReceipts(readers: [], unreaders: [])

    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage] { seedMessages }

    func sendMessage(
        conversationId: String, content: String, messageType: Int,
        replyToId: Int?, mentionedUserIds: [String], mentionedAgentIds: [String], mentionAll: Bool, attachment: IMOutgoingAttachment?, clientRequestId: String
    ) async throws -> IMSendMessageResult { throw URLError(.badServerResponse) }

    func editMessage(conversationId: String, messageId: Int, content: String) async throws -> IMMessage {
        editedContents.append(content)
        switch editResult {
        case let .success(msg): return msg
        case let .failure(error): throw error
        case nil: throw URLError(.badServerResponse)
        }
    }

    func recallMessage(conversationId: String, messageId: Int) async throws {
        recalledIds.append(messageId)
        if recallShouldFail { throw URLError(.badServerResponse) }
    }

    func pinMessage(conversationId: String, messageId: Int, pinned: Bool) async throws {
        if pinShouldFail { throw URLError(.badServerResponse) }
    }

    func fetchPinnedMessages(conversationId: String) async throws -> [IMMessage] {
        if pinnedFetchShouldFail { throw URLError(.notConnectedToInternet) }
        if suspendPinnedFetch {
            await withCheckedContinuation { continuation in
                pinnedFetchContinuation = continuation
                // continuation 必须先可恢复，再暴露“已开始”；否则测试线程可能抢先
                // resume 到 nil，随后 fetch 永久悬挂。
                pinnedFetchStarted = true
            }
        }
        return seedPinnedMessages
    }

    func waitUntilPinnedFetchBegins() async {
        while !pinnedFetchStarted { await Task.yield() }
    }

    func resumePinnedFetch() {
        pinnedFetchContinuation?.resume()
        pinnedFetchContinuation = nil
    }

    func addReaction(conversationId: String, messageId: Int, emoji: String) async throws {
        reactionAdds.append(emoji)
    }

    func removeReaction(conversationId: String, messageId: Int, emoji: String) async throws {
        reactionRemoves.append(emoji)
    }

    func markRead(conversationId: String, visibleMessage: IMMessage) async throws -> Int {
        markReadSequences.append(visibleMessage.seq)
        defer { markReadCompletions += 1 }
        if markReadShouldFail { throw URLError(.notConnectedToInternet) }
        return acknowledgedSequenceOverride ?? visibleMessage.seq
    }

    func fetchReadReceipts(conversationId: String, messageId: Int) async throws -> IMMessageReadReceipts {
        readReceiptCalls.append((conversationId, messageId))
        return readReceiptResult
    }

    func clearHistoryAndFetchWatermark(conversationId: String) async throws -> Int {
        authoritativeClearedSeq
    }
}

/// 可编排的假传输：预置分页结果与发送结果，记录调用参数。
/// `sendMessage` 返回轻量 `IMSendMessageResult`（贴近后端 POST 只回 id/seq/created_at 的真实形状）。
private actor FakeTransport: IMMessageTransport {
    nonisolated let isSendAvailable: Bool
    private var pages: [[IMMessage]]
    private var fetchFailureCodes: [URLError.Code?]
    private var fetchFailureError: Error?
    private var sendResult: Result<IMSendMessageResult, Error>
    private var sendDelay: Duration?
    private var sendResultSequenceOffset = 0
    private let historyClearedSeq: Int
    private let suspendFetch: Bool
    private let suspendSend: Bool
    private var fetchContinuations: [CheckedContinuation<Void, Never>] = []
    private var fetchStartedCount = 0
    private var sendContinuation: CheckedContinuation<Void, Never>?
    private var sendStarted = false
    private(set) var fetchCalls: [Int?] = []
    private(set) var sentClientRequestIds: [String] = []
    private(set) var sentMentionedUserIds: [[String]] = []
    private(set) var sentMentionedAgentIds: [[String]] = []
    private(set) var sentAttachments: [IMOutgoingAttachment?] = []
    private(set) var sentCards: [IMOutgoingCard?] = []

    init(
        pages: [[IMMessage]] = [],
        fetchFailureCodes: [URLError.Code?] = [],
        fetchFailureError: Error? = nil,
        sendResult: Result<IMSendMessageResult, Error> = .failure(URLError(.badServerResponse)),
        sendDelay: Duration? = nil,
        historyClearedSeq: Int = 0,
        suspendFetch: Bool = false,
        suspendSend: Bool = false,
        isSendAvailable: Bool = true
    ) {
        self.isSendAvailable = isSendAvailable
        self.pages = pages
        self.fetchFailureCodes = fetchFailureCodes
        self.fetchFailureError = fetchFailureError
        self.sendResult = sendResult
        self.sendDelay = sendDelay
        self.historyClearedSeq = historyClearedSeq
        self.suspendFetch = suspendFetch
        self.suspendSend = suspendSend
    }

    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage] {
        fetchCalls.append(before)
        if suspendFetch {
            fetchStartedCount += 1
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                fetchContinuations.append(continuation)
            }
        }
        if !fetchFailureCodes.isEmpty,
           let code = fetchFailureCodes.removeFirst() {
            throw URLError(
                code,
                userInfo: [
                    NSURLErrorFailingURLStringErrorKey: "https://im-secret.internal.example/messages",
                    NSLocalizedDescriptionKey: "The request to im-secret.internal.example failed.",
                ]
            )
        }
        if let fetchFailureError {
            throw fetchFailureError
        }
        guard !pages.isEmpty else { return [] }
        return pages.removeFirst()
    }

    func fetchHistoryClearedSeq(conversationId: String) async throws -> Int { historyClearedSeq }

    func waitUntilFetchBegins(count: Int = 1) async {
        while fetchStartedCount < count { await Task.yield() }
    }

    func resumeFetch() {
        guard !fetchContinuations.isEmpty else { return }
        fetchContinuations.removeFirst().resume()
    }

    func waitUntilSendBegins() async {
        while !sendStarted { await Task.yield() }
    }

    func resumeSend() {
        sendContinuation?.resume()
        sendContinuation = nil
    }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        sentClientRequestIds.append(clientRequestId)
        sentMentionedUserIds.append(mentionedUserIds)
        sentMentionedAgentIds.append(mentionedAgentIds)
        sentAttachments.append(attachment)
        if suspendSend {
            sendStarted = true
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                sendContinuation = continuation
            }
        }
        if let sendDelay { try? await Task.sleep(for: sendDelay) }
        let result = try sendResult.get()
        defer { sendResultSequenceOffset += 1 }
        return IMSendMessageResult(
            id: result.id + sendResultSequenceOffset,
            seq: result.seq + sendResultSequenceOffset,
            conversationId: result.conversationId,
            createdAt: result.createdAt,
            tabtinMessageId: result.tabtinMessageId
        )
    }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        sentClientRequestIds.append(clientRequestId)
        sentMentionedUserIds.append(mentionedUserIds)
        sentMentionedAgentIds.append(mentionedAgentIds)
        sentAttachments.append(attachment)
        sentCards.append(card)
        if suspendSend {
            sendStarted = true
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                sendContinuation = continuation
            }
        }
        if let sendDelay { try? await Task.sleep(for: sendDelay) }
        let result = try sendResult.get()
        defer { sendResultSequenceOffset += 1 }
        return IMSendMessageResult(
            id: result.id + sendResultSequenceOffset,
            seq: result.seq + sendResultSequenceOffset,
            conversationId: result.conversationId,
            createdAt: result.createdAt,
            tabtinMessageId: result.tabtinMessageId
        )
    }
}

/// 前一次传输失败、后一次成功；用于证明有序发送队列不会被单条失败截断。
private actor FailFirstThenSucceedTransport: IMMessageTransport {
    private(set) var sentClientRequestIds: [String] = []

    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage] { [] }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        sentClientRequestIds.append(clientRequestId)
        if sentClientRequestIds.count == 1 { throw URLError(.notConnectedToInternet) }
        return IMSendMessageResult(id: 92, seq: 92, conversationId: conversationId)
    }
}

/// 模拟「首请求服务端已接受、但客户端超时未收到响应」+ 后端按 client_request_id 幂等：
/// 同一 clientRequestId 第一次抛错（accepted-but-client-failed），再次收到同键则返回已存在消息。
private actor IdempotentFailFirstTransport: IMMessageTransport {
    private let acceptedResult: IMSendMessageResult
    private var acceptedRequestIds: Set<String> = []
    private(set) var seenRequestIds: [String] = []

    init(accepted: IMSendMessageResult) { self.acceptedResult = accepted }

    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage] { [] }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        seenRequestIds.append(clientRequestId)
        if acceptedRequestIds.contains(clientRequestId) {
            return acceptedResult  // 幂等重试：后端返回首请求已写入的那条
        }
        acceptedRequestIds.insert(clientRequestId)  // 服务端已接受
        throw URLError(.timedOut)                    // 但客户端未收到响应
    }
}

@MainActor
private final class RecordingPendingCache: IMPendingMessageCache {
    private var value: [IMPendingMessage] = []

    func pending(scopeId: String, conversationId: String) -> [IMPendingMessage] {
        value.map { item in
            var restored = item
            restored.status = .failed
            restored.errorMessage = nil
            return restored
        }
    }

    func store(scopeId: String, conversationId: String, pending: [IMPendingMessage]) {
        value = pending
    }

    func clear(scopeId: String, conversationId: String) {
        value = []
    }
}

@MainActor
final class IMMessageStoreTests: XCTestCase {
    func testFileSnapshotCacheRestoresRecentMessageSnapshot() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("IMMessageStoreTests.cache.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = IMMessageFileSnapshotCache(directoryURL: directory)
        var message = IMMessage(
            id: 77,
            seq: 77,
            conversationId: "conv-1",
            senderId: "user-2",
            senderName: "张三",
            content: "持久缓存消息",
            messageType: 4,
            hasAttachment: true,
            metadata: IMMessageMetadata(
                kind: "message",
                fileId: "file-77",
                fileName: "pic.png",
                fileSize: 2048,
                fileType: "image/png",
                accessURL: "https://assets.example.com/pic.png"
            )
        )
        message.reactions = ["👍": ["user-2"]]
        message.reactionOrder = ["👍"]
        message.isPinned = true
        message.readReceipt = IMReadReceipt(readCount: 1, recipientCount: 2)

        cache.store(conversationId: "conv-1", messages: [message])

        let restored = await waitForSnapshot(cache: cache, conversationId: "conv-1")
        XCTAssertEqual(restored, [message])
        XCTAssertEqual(restored.first?.metadata?.accessURL, "https://assets.example.com/pic.png")
    }

    func testFileSnapshotCachePreservesForwardedOrigin() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("IMMessageStoreTests.forwarded.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = IMMessageFileSnapshotCache(directoryURL: directory)
        let source = IMForwardedFrom(
            originalMessageId: 12,
            originalConversationId: "conv-source",
            originalConversationName: "产品讨论",
            originalSenderId: "user-2",
            originalSenderName: "小林"
        )
        let message = IMMessage(
            id: 78,
            seq: 78,
            conversationId: "conv-target",
            senderId: "user-1",
            content: "缓存后的转发正文",
            messageType: IMMessageType.text.rawValue,
            metadata: IMMessageMetadata(kind: "message", forwardedFrom: source)
        )

        cache.store(conversationId: "conv-target", messages: [message])

        let restored = await waitForSnapshot(cache: cache, conversationId: "conv-target")
        XCTAssertEqual(restored.first?.metadata?.forwardedFrom, source)
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

    func testReopenedStoreRestoresCachedSnapshotBeforeHistoryReturns() async {
        let cached = makeMessage(id: 88, seq: 88, content: "本地快照")
        let fresh = makeMessage(id: 89, seq: 89, content: "权威历史")
        let cache = IMMessageMemoryCache()
        cache.store(conversationId: "conv-1", messages: [cached])
        let transport = FakeTransport(pages: [[fresh]], suspendFetch: true)

        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport,
            snapshotCache: cache
        )
        store.loadInitial()
        await transport.waitUntilFetchBegins()

        XCTAssertEqual(store.messages.map(\.id), [88], "重进会话首帧应直接显示本地快照")

        await transport.resumeFetch()
        while store.isLoadingHistory { await Task.yield() }
        XCTAssertEqual(store.messages.map(\.id), [88, 89], "权威历史返回后应去重合并收敛")
    }

    func testRefreshLatestSilentlyMergesNewerHistoryWithoutClearingCurrentMessages() async {
        let existing = makeMessage(id: 90, seq: 90, content: "当前详情里的最后一条")
        let latest = makeMessage(id: 91, seq: 91, content: "列表预览已经看到的新消息")
        let transport = FakeTransport(pages: [[existing, latest]])
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)
        store.ingestRealtimeMessage(existing)

        await store.refreshLatestNow()

        XCTAssertEqual(store.messages.map(\.id), [90, 91])
        XCTAssertFalse(store.isLoadingHistory, "补拉最新页不应让已有消息的会话详情退回加载态")
    }

    func testSubscriptionCatchUpWaitsForInitialHistoryThenFetchesAgain() async {
        let first = makeMessage(id: 90, seq: 90, content: "首屏快照")
        let missed = makeMessage(id: 91, seq: 91, content: "订阅前到达")
        let transport = FakeTransport(
            pages: [[first], [first, missed]],
            suspendFetch: true
        )
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)

        store.loadInitial()
        await transport.waitUntilFetchBegins()
        store.refreshLatest()
        await transport.resumeFetch()
        await transport.waitUntilFetchBegins(count: 2)
        await transport.resumeFetch()

        while store.isLoadingHistory { await Task.yield() }
        for _ in 0..<100 where store.messages.map(\.id) != [90, 91] {
            await Task.yield()
        }
        XCTAssertEqual(store.messages.map(\.id), [90, 91])
    }

    func testRefreshLatestDoesNotReopenExhaustedEarlierHistoryWhileRequestIsInFlight() async {
        let local = makeMessage(id: 92, seq: 92, content: "已加载到最早一条")
        let transport = FakeTransport(pages: [[local]], suspendFetch: true)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)
        store.clearLocalHistory(clearedThroughSeq: 0)
        store.ingestRealtimeMessage(local)

        let reconcile = Task { await store.refreshLatestNow() }
        await transport.waitUntilFetchBegins()

        XCTAssertFalse(
            store.hasMoreHistory,
            "静默最新页对账在请求期间也不能把已到底状态重新标成可翻页"
        )

        await transport.resumeFetch()
        await reconcile.value
    }

    func testLoadInitialSortsAscendingAndSetsHasMore() async {
        // 多取一条作为“更早历史仍存在”的哨兵；UI 只保留最新 pageSize 条。
        let page = [
            makeMessage(id: 4, seq: 4),
            makeMessage(id: 1, seq: 1),
            makeMessage(id: 3, seq: 3),
            makeMessage(id: 2, seq: 2),
        ]
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport(pages: [page]), pageSize: 3)
        await store.loadHistory(reset: true)
        XCTAssertEqual(store.messages.map(\.seq), [2, 3, 4])
        XCTAssertTrue(store.hasMoreHistory)
        XCTAssertFalse(store.isLoadingHistory)
    }

    func testLoadInitialSortsByCreatedAtWhenSequenceOrderDiffers() async {
        let page = [
            makeMessage(
                id: 1,
                seq: 1,
                content: "今天的消息",
                createdAt: "2026-08-18T06:00:00Z"
            ),
            makeMessage(
                id: 2,
                seq: 2,
                content: "昨天的消息",
                createdAt: "2026-08-17T23:00:00Z"
            ),
        ]
        let store = IMMessageStore(
            conversationId: "conv-c2c",
            transport: FakeTransport(pages: [page]),
            pageSize: 30
        )

        await store.loadHistory(reset: true)

        XCTAssertEqual(
            store.messages.map(\.id),
            [2, 1],
            "C2C 的 seq 不保证是时间顺序，时间线必须按 createdAt 排列"
        )
    }

    func testMemorySnapshotCacheSortsByCreatedAtWhenSequenceOrderDiffers() {
        let cache = IMMessageMemoryCache(maxMessages: 10)
        let today = makeMessage(
            id: 1,
            seq: 1,
            content: "今天的消息",
            createdAt: "2026-08-18T06:00:00Z"
        )
        let yesterday = makeMessage(
            id: 2,
            seq: 2,
            content: "昨天的消息",
            createdAt: "2026-08-17T23:00:00Z"
        )

        cache.store(conversationId: "conv-1", messages: [today, yesterday])

        XCTAssertEqual(cache.messages(conversationId: "conv-1").map(\.id), [2, 1])
    }

    func testLoadInitialFewerThanPageSizeMeansNoMore() async {
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(pages: [[makeMessage(id: 1, seq: 1)]]),
            pageSize: 30
        )
        await store.loadHistory(reset: true)
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertFalse(store.hasMoreHistory)
    }

    func testInitialHistoryFailureUsesLocalizedNetworkError() async {
        let transport = FakeTransport(fetchFailureCodes: [.notConnectedToInternet])
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        await store.loadHistory(reset: true)

        XCTAssertEqual(store.historyError, L10n.Messages.networkError)
        XCTAssertFalse(store.historyError?.contains("im-secret.internal.example") ?? true)
        XCTAssertFalse(store.historyError?.contains("The request") ?? true)
        XCTAssertFalse(store.isLoadingHistory)
    }

    func testInitialHistoryFailureClosesLoadingWhenStartupFailsBeforeHistoryStarts() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())

        store.markInitialHistoryFailed(URLError(.timedOut))

        XCTAssertTrue(store.hasCompletedInitialHistoryLoad)
        XCTAssertFalse(store.isLoadingHistory)
        XCTAssertEqual(store.historyError, L10n.Messages.networkError)
    }

    func testInitialHistoryFailureSurfacesNonNetworkTransportCode() async {
        let transport = FakeTransport(fetchFailureError: URLError(.resourceUnavailable))
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        await store.loadHistory(reset: true)

        XCTAssertEqual(
            store.historyError,
            L10n.Messages.historyTransportError(code: URLError.Code.resourceUnavailable.rawValue)
        )
        XCTAssertFalse(store.isLoadingHistory)
    }

    func testHistoryPaginationFailureKeepsMessagesAndUsesLocalizedNetworkError() async {
        let page = [
            makeMessage(id: 1, seq: 1),
            makeMessage(id: 2, seq: 2),
        ]
        let transport = FakeTransport(
            pages: [page],
            fetchFailureCodes: [nil, .timedOut]
        )
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 1)
        await store.loadHistory(reset: true)
        XCTAssertTrue(store.hasMoreHistory)

        await store.loadHistory(reset: false)

        XCTAssertEqual(store.messages.map(\.id), [2])
        XCTAssertEqual(store.historyError, L10n.Messages.networkError)
        XCTAssertFalse(store.historyError?.contains("im-secret.internal.example") ?? true)
        XCTAssertFalse(store.historyError?.contains("The request") ?? true)
        XCTAssertFalse(store.isLoadingHistory)
        let calls = await transport.fetchCalls
        XCTAssertEqual(calls, [nil, 2])
    }

    func testLoadInitialKeepsRealtimeMessageArrivingBeforeFetchReturns() async {
        let snapshot = makeMessage(id: 100, seq: 100, content: "首屏快照")
        let realtime = makeMessage(id: 101, seq: 101, content: "订阅后的实时消息")
        let transport = FakeTransport(pages: [[snapshot]], suspendFetch: true)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)

        store.loadInitial()
        await transport.waitUntilFetchBegins()
        store.ingestRealtimeMessage(realtime)

        await transport.resumeFetch()
        while store.isLoadingHistory { await Task.yield() }

        XCTAssertEqual(
            store.messages.map(\.id),
            [100, 101],
            "首屏快照返回不能覆盖订阅后已抵达的实时消息"
        )
    }

    func testColdInitialLoadDoesNotRenderLatestMessageBeforeFullHistoryReturns() async {
        let history = makeMessage(id: 100, seq: 100, content: "首批完整历史")
        let latest = makeMessage(id: 101, seq: 101, content: "实时层提前推送的最新消息")
        let transport = FakeTransport(pages: [[history]], suspendFetch: true)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)

        store.loadInitial()
        await transport.waitUntilFetchBegins()
        store.ingestRealtimeMessage(latest)

        XCTAssertEqual(store.messages.map(\.id), [101])
        XCTAssertFalse(
            store.isInitialHistoryRenderable,
            "冷进入时提前到达的 latest 不能单独成为首屏快照"
        )

        await transport.resumeFetch()
        while store.isLoadingHistory { await Task.yield() }

        XCTAssertEqual(store.messages.map(\.id), [100, 101])
        XCTAssertTrue(store.isInitialHistoryRenderable)
    }

    func testClearLocalHistoryImmediatelyDropsMessagesAndInvalidatesInFlightHistory() async {
        let source = makeMessage(id: 41, seq: 41, content: "清空前的原消息")
        let transport = FakeTransport(pages: [[source]], suspendFetch: true)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 1)
        store.ingestRealtimeMessage(source)

        let loading = Task { await store.loadHistory(reset: true) }
        await transport.waitUntilFetchBegins()
        XCTAssertTrue(store.isLoadingHistory)

        store.clearLocalHistory(clearedThroughSeq: source.seq)
        XCTAssertTrue(store.messages.isEmpty, "清空成功后旧消息应立即消失")
        XCTAssertFalse(store.isLoadingHistory)
        XCTAssertFalse(store.hasMoreHistory)

        store.ingestRealtimeMessage(
            IMMessage(
                id: 42,
                seq: 42,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "实时回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: source.id,
                replyToPreview: IMReplyPreview(
                    content: "消息内容不可用",
                    senderId: "",
                    isUnavailable: true
                )
            )
        )

        await transport.resumeFetch()
        await loading.value

        XCTAssertEqual(store.messages.map(\.id), [42], "清空前在途的历史不得重新写回")
        XCTAssertTrue(store.messages.first?.replyToPreview?.isUnavailable ?? false)
    }

    func testClearLocalHistoryRemovesPinnedSnapshot() async {
        let cache = IMPinnedMessageMemoryCache()
        var pinned = makeMessage(id: 44, seq: 44, content: "清空前的置顶消息")
        pinned.isPinned = true
        pinned.pinStateKnown = true
        cache.storePinnedMessages(conversationId: "conv-1", messages: [pinned])
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(pages: [[]]),
            pinnedSnapshotCache: cache
        )

        store.clearLocalHistory(clearedThroughSeq: pinned.seq)

        XCTAssertTrue(store.pinnedMessages.isEmpty)
        XCTAssertTrue(cache.pinnedMessages(conversationId: "conv-1").isEmpty)
    }

    func testClearLocalHistoryInvalidatesPinnedRefreshAlreadyInFlight() async {
        let transport = FakeMutationTransport()
        var stale = makeMessage(id: 45, seq: 45, content: "清空前的远端置顶")
        stale.isPinned = true
        stale.pinStateKnown = true
        transport.seedPinnedMessages = [stale]
        transport.suspendPinnedFetch = true
        let cache = IMPinnedMessageMemoryCache()
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport,
            pinnedSnapshotCache: cache
        )

        let refresh = Task { await store.refreshPinnedMessages() }
        await transport.waitUntilPinnedFetchBegins()
        store.clearLocalHistory(clearedThroughSeq: stale.seq)
        transport.resumePinnedFetch()
        await refresh.value

        XCTAssertTrue(store.pinnedMessages.isEmpty)
        XCTAssertTrue(cache.pinnedMessages(conversationId: "conv-1").isEmpty)
    }

    func testClearReloadKeepsRealtimeMessageArrivingBeforeFetchReturns() async {
        let stale = makeMessage(id: 41, seq: 41, content: "清空前消息")
        let fresh = makeMessage(id: 43, seq: 43, content: "清空后历史")
        let transport = FakeTransport(pages: [[stale], [fresh]], suspendFetch: true)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, pageSize: 30)

        let staleLoad = Task { await store.loadHistory(reset: true) }
        await transport.waitUntilFetchBegins()
        store.clearLocalHistory(clearedThroughSeq: stale.seq)
        await transport.resumeFetch()
        await staleLoad.value

        let reload = Task { await store.loadHistoryAfterClear() }
        await transport.waitUntilFetchBegins(count: 2)
        let realtime = makeMessage(id: 42, seq: 42, content: "清空后实时消息")
        store.ingestRealtimeMessage(realtime)

        await transport.resumeFetch()
        await reload.value

        XCTAssertEqual(
            store.messages.map(\.id),
            [42, 43],
            "清空后的新重拉不能覆盖期间抵达的实时消息"
        )
    }

    func testClearDropsDelayedRealtimeMessageAtOrBelowClearedSeq() async {
        let cleared = makeMessage(id: 41, seq: 41, content: "清空前消息")
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(pages: [[]])
        )

        store.clearLocalHistory(clearedThroughSeq: cleared.seq)
        store.ingestRealtimeMessage(cleared)
        await store.loadHistoryAfterClear()

        XCTAssertTrue(store.messages.isEmpty, "延迟送达的清空前事件不得被保留式重拉带回界面")
    }

    func testClearHistoryUsesServerWatermarkBeyondLocallyLoadedMessages() async throws {
        let transport = FakeMutationTransport()
        transport.authoritativeClearedSeq = 51
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 41, seq: 41, content: "本地最后一条"))

        try await store.clearHistory()
        store.ingestRealtimeMessage(makeMessage(id: 50, seq: 50, content: "未加载的迟到旧事件"))

        XCTAssertTrue(store.messages.isEmpty)
    }

    func testReopenedStoreLoadsClearedSeqBeforeAcceptingRealtime() async {
        let delayed = makeMessage(id: 41, seq: 41, content: "另一台设备清空前消息")
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(historyClearedSeq: delayed.seq)
        )

        let initialized = await store.initializeHistoryVisibility()
        XCTAssertTrue(initialized)
        store.ingestRealtimeMessage(delayed)

        XCTAssertTrue(store.messages.isEmpty, "重开会话必须先恢复服务端水位，再接收共享实时事件")
    }

    func testLoadMoreUsesOldestIdAsCursorAndPrepends() async {
        let fake = FakeTransport(pages: [
            [makeMessage(id: 9, seq: 9), makeMessage(id: 10, seq: 10), makeMessage(id: 11, seq: 11)],
            [makeMessage(id: 7, seq: 7), makeMessage(id: 8, seq: 8), makeMessage(id: 9, seq: 9)],
        ])
        let store = IMMessageStore(conversationId: "conv-1", transport: fake, pageSize: 2)
        await store.loadHistory(reset: true)
        await store.loadHistory(reset: false)
        XCTAssertEqual(store.messages.map(\.seq), [8, 9, 10, 11])
        let calls = await fake.fetchCalls
        XCTAssertEqual(calls, [nil, 10], "翻页游标应为当前最早消息 id")
    }

    func testSendOptimisticThenConfirmOnSuccess() async {
        // 后端 POST 只回 id/seq/created_at；store 应据本地字段补齐一条完整消息（不再直接解 IMMessage）。
        let saved = IMSendMessageResult(id: 100, seq: 50, conversationId: "conv-1", createdAt: "2026-07-21T00:00:00Z")
        var confirmedForDirectory: [IMMessage] = []
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .success(saved)),
            onMessageConfirmed: { confirmedForDirectory.append($0) }
        )
        store.currentUserId = "me"
        let outcome = await store.performSend(content: "hello")
        XCTAssertEqual(outcome, .succeeded)
        XCTAssertTrue(store.pending.isEmpty, "成功后应清掉乐观态")
        XCTAssertEqual(store.messages.map(\.id), [100])
        let confirmed = try! XCTUnwrap(store.messages.first)
        XCTAssertEqual(confirmed.content, "hello", "本地补齐应带上发送内容")
        XCTAssertEqual(confirmed.senderId, "me", "本地补齐应带上当前用户")
        XCTAssertEqual(confirmed.seq, 50)
        XCTAssertEqual(confirmedForDirectory.map(\.id), [100], "发送成功必须同步推进会话目录摘要")
        XCTAssertEqual(confirmedForDirectory.first?.content, "hello")
    }

    func testSendReplyImmediatelyBuildsPreviewFromVisibleSource() async {
        let saved = IMSendMessageResult(id: 101, seq: 51, conversationId: "conv-1")
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport(sendResult: .success(saved)))
        let source = makeMessage(id: 41, seq: 41, content: "需要回复的原消息", senderId: "peer")
        store.ingestRealtimeMessage(source)

        _ = await store.performSend(content: "收到", replyToId: source.id)

        let sent = try! XCTUnwrap(store.messages.last)
        XCTAssertEqual(sent.replyToId, source.id)
        XCTAssertEqual(sent.replyToPreview?.content, source.content)
        XCTAssertEqual(sent.replyToPreview?.senderId, source.senderId)
        XCTAssertFalse(sent.replyToPreview?.isUnavailable ?? true)
    }

    func testSendFailureMarksPendingFailed() async {
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        )
        let outcome = await store.performSend(content: "oops")
        XCTAssertEqual(outcome, .failedPending)
        XCTAssertEqual(store.pending.count, 1)
        XCTAssertEqual(store.pending.first?.status, .failed)
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testDetailSnapshotRejectsRemovedMemberBeforePendingIsCreated() async {
        let transport = FakeTransport(
            sendResult: .success(IMSendMessageResult(id: 101, seq: 51, conversationId: "conv-read-only"))
        )
        let store = IMMessageStore(conversationId: "conv-read-only", transport: transport)
        store.updateConversationDetail(IMConversationDetail(
            id: "conv-read-only",
            organizationId: "org-1",
            type: IMConversationType.dm.rawValue,
            memberCount: 1
        ))

        let outcome = await store.performSend(content: "不会发出")

        XCTAssertEqual(outcome, .rejectedReadOnly)
        XCTAssertFalse(outcome.didEnqueue)
        XCTAssertTrue(store.pending.isEmpty)
        let sentClientRequestIds = await transport.sentClientRequestIds
        XCTAssertTrue(sentClientRequestIds.isEmpty)
    }

    func testTransportReadOnlyRaceRemovesOptimisticPending() async {
        let store = IMMessageStore(
            conversationId: "conv-race",
            transport: FakeTransport(sendResult: .failure(IMConversationSendError.removedMember))
        )

        let outcome = await store.performSend(content: "竞态消息", clientRequestId: "read-only-race")

        XCTAssertEqual(outcome, .rejectedReadOnly)
        XCTAssertFalse(outcome.didEnqueue)
        XCTAssertTrue(store.pending.isEmpty, "最终成员门禁拒绝后不能留下失败消息")
    }

    func testCardSendKeepsPayloadInTransportPendingAndOptimisticMessage() async {
        let saved = IMSendMessageResult(id: 102, seq: 52, conversationId: "conv-1")
        let fake = FakeTransport(sendResult: .success(saved))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let card = IMOutgoingCard.resource(
            kind: .document,
            resourceId: "doc-42",
            name: "项目方案",
            spaceId: "space-1",
            organizationId: "org-1"
        )

        let outcome = await store.performSend(
            content: card.fallbackContent,
            card: card,
            clientRequestId: "card-request"
        )

        XCTAssertEqual(outcome, .succeeded)
        let sentCards = await fake.sentCards
        XCTAssertEqual(sentCards, [card])
        XCTAssertTrue(store.pending.isEmpty)
        let optimistic = try! XCTUnwrap(store.messages.first)
        XCTAssertTrue(optimistic.hasStructuredCard)
        XCTAssertFalse(optimistic.isPlainText)
        XCTAssertEqual(optimistic.resourceCard?.typedType, .document)
        XCTAssertEqual(optimistic.resourceCard?.resourceId, "doc-42")
    }

    func testFailedCardSendKeepsCardForRetry() async {
        let fake = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let card = IMOutgoingCard.prompt(
            promptText: "整理本周进展\n列出风险和下一步。",
            title: "整理本周进展"
        )

        let outcome = await store.performSend(
            content: card.fallbackContent,
            card: card,
            clientRequestId: "failed-card-request"
        )

        XCTAssertEqual(outcome, .failedPending)
        XCTAssertEqual(store.pending.first?.card, card)
        let sentCards = await fake.sentCards
        XCTAssertEqual(sentCards, [card])
    }

    /// 回归  reviewer 报告：后端 POST 只回 id/seq/conversation_id/created_at（无 sender_id/message_type）。
    /// 发送响应必须解为轻量 `IMSendMessageResult`——若仍强解 `IMMessage`，任意发送会在 201 后解码失败进失败态。
    func testSendResultDecodesRealBackendShape() throws {
        let json = Data("""
        {"id": 42, "seq": 7, "conversation_id": "conv-1", "created_at": "2026-07-21T10:00:00Z"}
        """.utf8)
        let result = try JSONDecoder().decode(IMSendMessageResult.self, from: json)
        XCTAssertEqual(result.id, 42)
        XCTAssertEqual(result.seq, 7)
        XCTAssertEqual(result.conversationId, "conv-1")
        XCTAssertEqual(result.createdAt, "2026-07-21T10:00:00Z")
    }

    /// ：两次不同的用户提交都必须入队，不能用全局单飞吞掉第二条。
    func testConcurrentFreshSendsKeepIndependentPendingIdentities() async {
        let saved = IMSendMessageResult(id: 500, seq: 90, conversationId: "conv-1")
        let transport = FakeTransport(sendResult: .success(saved), sendDelay: .milliseconds(50))
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport
        )
        store.currentUserId = "me"
        async let first = store.performSend(content: "first", clientRequestId: "request-1")
        async let second = store.performSend(content: "second", clientRequestId: "request-2")
        for _ in 0..<50 where store.pending.count < 2 { await Task.yield() }
        // async let 子任务没有词法启动顺序；这里验证两条都保留独立身份，不把调度顺序误当产品契约。
        XCTAssertEqual(Set(store.pending.map(\.content)), Set(["first", "second"]))
        XCTAssertEqual(Set(store.pending.map(\.clientRequestId)), Set(["request-1", "request-2"]))
        let (r1, r2) = await (first, second)
        XCTAssertEqual([r1, r2].filter { $0 == .succeeded }.count, 2)
        let sentClientRequestIds = await transport.sentClientRequestIds
        XCTAssertEqual(Set(sentClientRequestIds), Set(["request-1", "request-2"]))
        XCTAssertEqual(Set(store.messages.map(\.content)), Set(["first", "second"]))
        XCTAssertTrue(store.pending.isEmpty)
    }

    func testComposerEnqueueReturnsBeforeTransportCompletes() async {
        let saved = IMSendMessageResult(id: 601, seq: 101, conversationId: "conv-1")
        let transport = FakeTransport(sendResult: .success(saved), suspendSend: true)
        var enqueuedPreviews: [String] = []
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport,
            onMessageEnqueued: { enqueuedPreviews.append($0) }
        )

        let outcome = store.enqueueSend(content: "offline", clientRequestId: "queued-request")
        XCTAssertEqual(enqueuedPreviews, ["offline"], "返回列表前必须同步拿到乐观摘要，不能等待 POST")
        await transport.waitUntilSendBegins()

        XCTAssertEqual(outcome, .enqueued)
        XCTAssertEqual(store.pending.map(\.clientRequestId), ["queued-request"])
        XCTAssertTrue(store.isSending)
        await transport.resumeSend()
        for _ in 0..<50 where !store.pending.isEmpty { await Task.yield() }
        XCTAssertTrue(store.pending.isEmpty)
    }

    ///  issue 3：composer 仅在内容已入队（成功/失败待重试）后才清理；被单飞拒绝时保留内容。
    /// 该契约由 `IMSendOutcome.didEnqueue` 表达，screen 据此决定是否清空 draft/mentions/附件。
    func testSendOutcomeDidEnqueueGovernsComposerClear() {
        XCTAssertTrue(IMSendOutcome.enqueued.didEnqueue, "已同步创建 pending：可立即清理 composer")
        XCTAssertTrue(IMSendOutcome.succeeded.didEnqueue, "成功：可清理 composer")
        XCTAssertTrue(IMSendOutcome.failedPending.didEnqueue, "已入队为可重试 pending：可清理 composer")
    }

    func testFailedPendingSurvivesStoreRecreationAndRestoresAsRetryableHistory() async {
        let cache = RecordingPendingCache()
        let firstStore = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet))),
            pendingCache: cache,
            cacheScopeId: "user-1"
        )
        let outcome = await firstStore.performSend(content: "offline", clientRequestId: "persisted-request")
        XCTAssertEqual(outcome, .failedPending)

        let restoredStore = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(),
            pendingCache: cache,
            cacheScopeId: "user-1"
        )
        XCTAssertEqual(restoredStore.pending.map(\.content), ["offline"])
        XCTAssertEqual(restoredStore.pending.first?.clientRequestId, "persisted-request")
        XCTAssertEqual(restoredStore.pending.first?.status, .failed)
    }

    func testHistoryRefreshPreservesFailedPendingUntilServerConfirmsIt() async {
        let remote = makeMessage(id: 81, seq: 81, content: "远端历史")
        let transport = FakeTransport(
            pages: [[remote]],
            sendResult: .failure(URLError(.notConnectedToInternet))
        )
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        let outcome = await store.performSend(
            content: "离线失败消息",
            clientRequestId: "failed-history-request"
        )
        XCTAssertEqual(outcome, .failedPending)
        await store.loadHistory(reset: true)

        XCTAssertEqual(store.messages.map(\.content), ["远端历史"])
        XCTAssertEqual(store.pending.map(\.content), ["离线失败消息"])
        XCTAssertEqual(store.pending.first?.status, .failed)
    }

    func testFirstFailedTransportDoesNotBlockTheSecondQueuedMessage() async {
        let transport = FailFirstThenSucceedTransport()
        var now = Date(timeIntervalSince1970: 1.5)
        let store = IMMessageStore(conversationId: "conv-1", transport: transport, now: { now })
        store.currentUserId = "me"

        store.enqueueSend(content: "first", clientRequestId: "request-1")
        now = Date(timeIntervalSince1970: 1.7)
        store.enqueueSend(content: "second", clientRequestId: "request-2")
        for _ in 0..<100 where store.pending.count > 1 { await Task.yield() }

        let sentClientRequestIds = await transport.sentClientRequestIds
        XCTAssertEqual(sentClientRequestIds, ["request-1", "request-2"])
        XCTAssertEqual(store.pending.map(\.content), ["first"])
        XCTAssertEqual(store.pending.first?.status, .failed)
        XCTAssertEqual(store.messages.map(\.content), ["second"])
        XCTAssertEqual(store.messages.first?.createdAt, "1970-01-01T00:00:01.700Z")
    }

    func testTwoQueuedOfflineMessagesBothRemainFailedAndRetryable() async {
        let transport = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        store.enqueueSend(content: "first", clientRequestId: "request-1")
        store.enqueueSend(content: "second", clientRequestId: "request-2")
        for _ in 0..<100 where !store.pending.allSatisfy({ $0.status == .failed }) {
            await Task.yield()
        }

        let sentClientRequestIds = await transport.sentClientRequestIds
        XCTAssertEqual(sentClientRequestIds, ["request-1", "request-2"])
        XCTAssertEqual(store.pending.map(\.content), ["first", "second"])
        XCTAssertTrue(store.pending.allSatisfy { $0.status == .failed })
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testKnownOfflineSendsFailWithoutEnteringRemoteTransport() async {
        let saved = IMSendMessageResult(id: 91, seq: 12, conversationId: "conv-1")
        let transport = FakeTransport(
            sendResult: .success(saved),
            isSendAvailable: false
        )
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        store.enqueueSend(content: "first", clientRequestId: "request-1")
        store.enqueueSend(content: "second", clientRequestId: "request-2")
        for _ in 0..<100 where !store.pending.allSatisfy({ $0.status == .failed }) {
            await Task.yield()
        }

        let sentClientRequestIds = await transport.sentClientRequestIds
        XCTAssertTrue(sentClientRequestIds.isEmpty)
        XCTAssertEqual(store.pending.map(\.content), ["first", "second"])
        XCTAssertTrue(store.pending.allSatisfy { $0.status == .failed })
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testOutOfOrderRealtimeEchoesClearOnlyTheirMatchingFailedPending() async {
        var now = Date(timeIntervalSince1970: 1.5)
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet))),
            now: { now }
        )

        _ = await store.performSend(content: "first", clientRequestId: "request-1")
        now = Date(timeIntervalSince1970: 1.7)
        _ = await store.performSend(content: "second", clientRequestId: "request-2")
        XCTAssertEqual(store.pending.map(\.clientRequestId), ["request-1", "request-2"])

        store.ingestRealtimeMessage(
            makeMessage(id: 92, seq: 92, content: "second", clientRequestId: "request-2")
        )
        XCTAssertEqual(store.pending.map(\.clientRequestId), ["request-1"])
        XCTAssertEqual(store.messages.first?.createdAt, "1970-01-01T00:00:01.700Z")

        store.ingestRealtimeMessage(
            makeMessage(id: 91, seq: 91, content: "first", clientRequestId: "request-1")
        )
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(store.messages.map(\.content), ["first", "second"])
    }

    /// 单飞只拦首发：失败后重试（复用原键 + isRetry）不受在途标记影响。
    func testRetryNotBlockedBySingleFlight() async {
        let accepted = IMSendMessageResult(id: 501, seq: 91, conversationId: "conv-1")
        let fake = IdempotentFailFirstTransport(accepted: accepted)
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let firstOutcome = await store.performSend(content: "once")
        XCTAssertEqual(firstOutcome, .failedPending)
        XCTAssertFalse(store.isSending, "首发失败后单飞标记应复位")
        let failed = try! XCTUnwrap(store.pending.first)
        let retryOutcome = await store.performSend(
            content: failed.content,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )
        XCTAssertEqual(retryOutcome, .succeeded)
        XCTAssertEqual(store.messages.map(\.id), [501])
    }

    func testBackgroundArrivalDoesNotAdvanceReadWaterlineUntilForeground() async {
        // 回归  issue 2：页面留在导航栈时切后台（scenePhase 非 active → leaveConversation），
        // 收到新消息不应推进 read waterline；回到前台（重新 enter）后才 mark-read 到最新。
        let fake = FakeMutationTransport()
        fake.seedMessages = [makeMessage(id: 10, seq: 10, senderId: "peer")]
        let store = IMMessageStore(conversationId: "conv-bg", transport: fake)
        store.currentUserId = "me"
        await store.loadHistory(reset: true)

        // 后台：活动会话未指向本会话（等价于 scenePhase 离开 active 后 leaveConversation）。
        IMConversationStore.shared.leaveConversation("conv-bg")
        store.markReadUpToLatest()
        XCTAssertTrue(fake.markReadSequences.isEmpty, "后台收到消息不应推进 read waterline")

        // 前台：重新登记活动会话后才推进已读到最新消息。
        IMConversationStore.shared.enterConversation("conv-bg")
        store.markReadUpToLatest()
        for _ in 0..<50 where fake.markReadCompletions == 0 { await Task.yield() }
        XCTAssertEqual(fake.markReadSequences, [10], "回到前台应按消息 seq 推进已读")

        IMConversationStore.shared.clear()
    }

    func testMarkReadUsesMessageSequenceInsteadOfMessageIdentifier() async {
        let fake = FakeMutationTransport()
        fake.seedMessages = [makeMessage(
            id: 9001,
            seq: 42,
            conversationId: "conv-seq",
            senderId: "peer"
        )]
        let store = IMMessageStore(conversationId: "conv-seq", transport: fake)
        await store.loadHistory(reset: true)

        IMConversationStore.shared.enterConversation("conv-seq")
        store.markReadUpToLatest()
        for _ in 0..<50 where fake.markReadCompletions == 0 { await Task.yield() }

        XCTAssertEqual(fake.markReadSequences, [42])
        IMConversationStore.shared.clear()
    }

    func testAcknowledgedSequenceSuppressesStaleRefreshBeyondVisibleCache() async {
        let fake = FakeMutationTransport()
        fake.seedMessages = [makeMessage(
            id: 9001,
            seq: 42,
            conversationId: "conv-sdk-waterline",
            senderId: "peer"
        )]
        fake.acknowledgedSequenceOverride = 45
        let store = IMMessageStore(conversationId: "conv-sdk-waterline", transport: fake)
        await store.loadHistory(reset: true)
        let conversations = IMConversationStore.shared
        conversations.prepareOrganizationForTesting("org-1")
        conversations.replaceConversationsForTesting([
            IMConversation(
                id: "conv-sdk-waterline", organizationId: "org-1", spaceId: nil,
                spaceName: "", isTeamSpaceChannel: false,
                isExternal: false,
                type: IMConversationType.group.rawValue, name: "传输水位", avatarUrl: "",
                memberCount: 2, isArchived: false, lastMessageAt: nil,
                lastMessagePreview: "hi", unreadCount: 3, lastMessageSeq: 42,
                createdAt: "", dmPeerUserId: nil, pinned: false, isMuted: false
            )
        ])

        conversations.enterConversation("conv-sdk-waterline")
        store.markReadUpToLatest()
        for _ in 0..<50 where fake.markReadCompletions == 0 { await Task.yield() }
        XCTAssertEqual(fake.markReadCompletions, 1, "测试必须等到成功回调真正完成")

        conversations.leaveConversation("conv-sdk-waterline")
        conversations.beginLoadWindowForTesting()
        conversations.commitLoadForTesting([
            IMConversation(
                id: "conv-sdk-waterline", organizationId: "org-1", spaceId: nil,
                spaceName: "", isTeamSpaceChannel: false,
                isExternal: false,
                type: IMConversationType.group.rawValue, name: "传输水位", avatarUrl: "",
                memberCount: 2, isArchived: false, lastMessageAt: nil,
                lastMessagePreview: "hi", unreadCount: 3, lastMessageSeq: 45,
                createdAt: "", dmPeerUserId: nil, pinned: false, isMuted: false
            )
        ])

        // Fake transport 的 completion 会在 async 返回前递增；Store 随后才把服务端确认水位
        // 写回会话目录。等待最终可观察状态，避免调度器恰好在两步之间切回测试造成偶发失败。
        for _ in 0..<50 where conversations.conversations.first?.unreadCount != 0 {
            await Task.yield()
        }
        XCTAssertEqual(conversations.conversations.first?.unreadCount, 0)
        conversations.clear()
    }

    func testFailedMarkReadDoesNotSuppressUnreadOnRefresh() async {
        let fake = FakeMutationTransport()
        fake.seedMessages = [makeMessage(
            id: 9001,
            seq: 42,
            conversationId: "conv-fail",
            senderId: "peer"
        )]
        fake.markReadShouldFail = true
        let store = IMMessageStore(conversationId: "conv-fail", transport: fake)
        await store.loadHistory(reset: true)
        let conversations = IMConversationStore.shared
        conversations.prepareOrganizationForTesting("org-1")
        conversations.replaceConversationsForTesting([
            IMConversation(
                id: "conv-fail", organizationId: "org-1", spaceId: nil, spaceName: "",
                isTeamSpaceChannel: false, isExternal: false, type: IMConversationType.group.rawValue,
                name: "失败恢复", avatarUrl: "", memberCount: 2, isArchived: false,
                lastMessageAt: nil, lastMessagePreview: "hi", unreadCount: 1,
                lastMessageSeq: 42, createdAt: "", dmPeerUserId: nil,
                pinned: false, isMuted: false
            )
        ])

        conversations.enterConversation("conv-fail")
        store.markReadUpToLatest()
        for _ in 0..<50 where fake.markReadCompletions == 0 { await Task.yield() }
        XCTAssertEqual(fake.markReadCompletions, 1, "测试必须等到失败回调真正完成")
        conversations.leaveConversation("conv-fail")
        conversations.beginLoadWindowForTesting()
        conversations.commitLoadForTesting([
            IMConversation(
                id: "conv-fail", organizationId: "org-1", spaceId: nil, spaceName: "",
                isTeamSpaceChannel: false, isExternal: false, type: IMConversationType.group.rawValue,
                name: "失败恢复", avatarUrl: "", memberCount: 2, isArchived: false,
                lastMessageAt: nil, lastMessagePreview: "hi", unreadCount: 1,
                lastMessageSeq: 42, createdAt: "", dmPeerUserId: nil,
                pinned: false, isMuted: false
            )
        ])

        XCTAssertEqual(conversations.conversations.first?.unreadCount, 1)
        conversations.clear()
    }

    func testRetryReusesClientRequestIdSoAcceptedMessageIsNotDuplicated() async {
        // 首请求服务端已接受但客户端失败；重试复用同一 clientRequestId → 幂等命中，只留一条。
        let accepted = IMSendMessageResult(id: 200, seq: 60, conversationId: "conv-1")
        let fake = IdempotentFailFirstTransport(accepted: accepted)
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        store.currentUserId = "me"

        let firstOutcome = await store.performSend(content: "once")
        XCTAssertEqual(firstOutcome, .failedPending)
        XCTAssertEqual(store.pending.count, 1)
        XCTAssertEqual(store.pending.first?.status, .failed)
        let failed = try! XCTUnwrap(store.pending.first)

        // 走 retry 相同的核心路径：复用原 clientRequestId + isRetry（绕过首发单飞）。
        let retryOutcome = await store.performSend(
            content: failed.content,
            messageType: failed.messageType,
            replyToId: failed.replyToId,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )
        XCTAssertEqual(retryOutcome, .succeeded)
        XCTAssertEqual(store.messages.map(\.id), [200], "重试后应只有一条确认消息")
        XCTAssertTrue(store.pending.isEmpty, "成功后清掉乐观态")

        let ids = await fake.seenRequestIds
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1], "重试必须复用首次的 clientRequestId 作幂等键")
    }

    func testRetryDoesNotAppendDuplicatePending() async {
        // 失败后重试不应新增一行 pending（复用原键、原地复位）。
        let fake = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        _ = await store.performSend(content: "x")
        let failed = try! XCTUnwrap(store.pending.first)
        _ = await store.performSend(
            content: failed.content,
            messageType: failed.messageType,
            replyToId: failed.replyToId,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )
        XCTAssertEqual(store.pending.count, 1, "重试复用同键，pending 不应重复追加")
    }

    func testRetryKeepsPendingAtItsOriginalTimelinePosition() async throws {
        let fake = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        _ = await store.performSend(content: "稍后重试", clientRequestId: "retry-clock")
        let firstAttempt = try XCTUnwrap(store.pending.first?.createdAt)

        try await Task.sleep(for: .milliseconds(20))
        let failed = try XCTUnwrap(store.pending.first)
        _ = await store.performSend(
            content: failed.content,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )

        XCTAssertEqual(try XCTUnwrap(store.pending.first?.createdAt), firstAttempt)
    }

    func testMessageRowsMergePendingAtTheirTimelinePosition() {
        let formatter = ISO8601DateFormatter()
        let first = makeMessage(id: 1, seq: 1, content: "first", createdAt: "2026-08-12T09:00:00Z")
        let second = makeMessage(id: 2, seq: 2, content: "second", createdAt: "2026-08-12T09:02:00Z")
        let pending = IMPendingMessage(
            clientRequestId: "pending-between",
            content: "between",
            messageType: IMMessageType.text.rawValue,
            replyToId: nil,
            mentionedUserIds: [],
            mentionedAgentIds: [],
            mentionAll: false,
            attachment: nil,
            card: nil,
            createdAt: try! XCTUnwrap(formatter.date(from: "2026-08-12T09:01:00Z")),
            errorMessage: "offline",
            status: .failed
        )

        XCTAssertEqual(
            IMChatCollectionController.makeRows(messages: [first, second], pending: [pending], typingActive: false),
            [.message(id: 1), .pending(id: "pending-between"), .message(id: 2)]
        )
    }

    func testMessageRowsKeepFailedPendingBeforeSameSecondServerConfirmation() {
        let pending = IMPendingMessage(
            clientRequestId: "pending-first",
            content: "first",
            messageType: IMMessageType.text.rawValue,
            replyToId: nil,
            mentionedUserIds: [],
            mentionedAgentIds: [],
            mentionAll: false,
            attachment: nil,
            card: nil,
            createdAt: Date(timeIntervalSince1970: 1.5),
            errorMessage: nil,
            status: .failed
        )
        let confirmed = makeMessage(
            id: 2,
            seq: 2,
            content: "second",
            createdAt: "1970-01-01T00:00:01.700Z"
        )

        XCTAssertEqual(
            IMChatCollectionController.makeRows(
                messages: [confirmed],
                pending: [pending],
                typingActive: false
            ),
            [.pending(id: "pending-first"), .message(id: 2)]
        )
    }

    func testMessageRowsKeepPreciseConfirmationBeforeLaterSameSecondPending() {
        let pending = IMPendingMessage(
            clientRequestId: "pending-second",
            content: "second",
            messageType: IMMessageType.text.rawValue,
            replyToId: nil,
            mentionedUserIds: [],
            mentionedAgentIds: [],
            mentionAll: false,
            attachment: nil,
            card: nil,
            createdAt: Date(timeIntervalSince1970: 1.7),
            errorMessage: nil,
            status: .failed
        )
        let confirmed = makeMessage(
            id: 1,
            seq: 1,
            content: "first",
            createdAt: "1970-01-01T00:00:01.200Z"
        )

        XCTAssertEqual(
            IMChatCollectionController.makeRows(
                messages: [confirmed],
                pending: [pending],
                typingActive: false
            ),
            [.message(id: 1), .pending(id: "pending-second")]
        )
    }

    func testMessageRowsPlaceGroupCreationNoticeExactlyOnce() {
        let rows = IMChatCollectionController.makeRows(
            messages: [
                makeMessage(id: 1, seq: 1, createdAt: "2026-08-12T09:00:00Z"),
                makeMessage(id: 2, seq: 2, createdAt: "2026-08-12T09:01:00Z"),
            ],
            pending: [],
            typingActive: false,
            leadingSystemNotice: "群组创建于 2026/8/12 09:00"
        )

        XCTAssertEqual(rows.filter { $0 == .systemNotice }.count, 1)
        XCTAssertEqual(rows.first, .systemNotice)
    }

    func testSendThreadsMentionedAgentIdsToTransport() async {
        // @Agent：mentionedAgentIds 应原样透传给传输面（后端据此触发 Agent 回复）。
        let saved = IMSendMessageResult(id: 300, seq: 70, conversationId: "conv-1")
        let fake = FakeTransport(sendResult: .success(saved))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let outcome = await store.performSend(content: "@助手 帮我看看", mentionedAgentIds: ["agent-9"])
        XCTAssertEqual(outcome, .succeeded)
        let mentions = await fake.sentMentionedAgentIds
        XCTAssertEqual(mentions, [["agent-9"]], "发送应带上 mentioned_agent_ids")
    }

    func testSendThreadsMentionedUserIdsToTransportAndConfirmedMessage() async {
        let saved = IMSendMessageResult(id: 302, seq: 72, conversationId: "conv-1")
        let fake = FakeTransport(sendResult: .success(saved))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let outcome = await store.performSend(content: "@小王 帮忙看下", mentionedUserIds: ["user-9"])
        XCTAssertEqual(outcome, .succeeded)
        let mentions = await fake.sentMentionedUserIds
        XCTAssertEqual(mentions, [["user-9"]])
        XCTAssertEqual(store.messages.first?.metadata?.mentionedUserIds, ["user-9"])
    }

    func testMentionsPersistAcrossRetry() async {
        // 失败重试复用原 pending，@Agent 列表不能丢：重试仍需带同一批 mentioned_agent_ids。
        let fake = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        _ = await store.performSend(content: "@助手 在吗", mentionedAgentIds: ["agent-9"])
        let failed = try! XCTUnwrap(store.pending.first)
        XCTAssertEqual(failed.mentionedAgentIds, ["agent-9"], "pending 应保存 @Agent 列表供重试复用")
        // 走 retry 的核心路径：复用原键 + 原 @Agent 列表（避免 Task 时序不确定）。
        _ = await store.performSend(
            content: failed.content,
            messageType: failed.messageType,
            replyToId: failed.replyToId,
            mentionedAgentIds: failed.mentionedAgentIds,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )
        let mentions = await fake.sentMentionedAgentIds
        XCTAssertEqual(mentions, [["agent-9"], ["agent-9"]], "重试应复用同一批 mentioned_agent_ids")
    }

    func testAttachmentThreadsToTransportAndConfirmedSendClearsPending() async {
        let saved = IMSendMessageResult(id: 301, seq: 71, conversationId: "conv-1")
        let fake = FakeTransport(sendResult: .success(saved))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-000000000001",
            fileName: "photo.jpg",
            fileSize: 1024,
            fileType: "image/jpeg"
        )

        let outcome = await store.performSend(
            content: "图片附言",
            messageType: IMMessageType.image.rawValue,
            attachment: attachment,
            clientRequestId: "attachment-request"
        )

        XCTAssertEqual(outcome, .succeeded)
        XCTAssertTrue(store.pending.isEmpty)
        let attachments = await fake.sentAttachments
        let requestIds = await fake.sentClientRequestIds
        XCTAssertEqual(attachments.compactMap { $0 }, [attachment])
        XCTAssertEqual(requestIds, ["attachment-request"])
    }

    func testAttachmentPersistsAcrossFailureAndRetryWithSameRequestId() async {
        let accepted = IMSendMessageResult(id: 302, seq: 72, conversationId: "conv-1")
        let fake = IdempotentFailFirstTransport(accepted: accepted)
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-000000000002",
            fileName: "report.pdf",
            fileSize: 2048,
            fileType: "application/pdf"
        )

        let first = await store.performSend(
            content: "文件附言",
            messageType: IMMessageType.file.rawValue,
            attachment: attachment,
            clientRequestId: "retry-attachment"
        )
        XCTAssertEqual(first, .failedPending)
        let failed = try! XCTUnwrap(store.pending.first)
        XCTAssertEqual(failed.attachment, attachment)
        XCTAssertNil(failed.errorMessage, "失败态只通过气泡外侧红色重试图标呈现，不持久化底层错误文案")

        let retried = await store.performSend(
            content: failed.content,
            messageType: failed.messageType,
            replyToId: failed.replyToId,
            mentionedAgentIds: failed.mentionedAgentIds,
            attachment: failed.attachment,
            clientRequestId: failed.clientRequestId,
            isRetry: true
        )

        XCTAssertEqual(retried, .succeeded)
        XCTAssertTrue(store.pending.isEmpty)
        let requestIds = await fake.seenRequestIds
        XCTAssertEqual(requestIds, ["retry-attachment", "retry-attachment"])
        XCTAssertEqual(store.messages.map(\.id), [302])
    }

    func testExplicitlyDiscardedFailedAttachmentReleasesUploadStageUsage() async {
        var released: [String] = []
        let fake = FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet)))
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: fake,
            onReleaseAbandonedAttachment: { released.append($0.fileId) }
        )
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-0000000000AB",
            fileName: "photo.png",
            fileSize: 1024,
            fileType: "image/png"
        )

        let outcome = await store.performSend(
            content: "看这张图",
            messageType: IMMessageType.image.rawValue,
            attachment: attachment,
            clientRequestId: "leave-attachment"
        )
        XCTAssertEqual(outcome, .failedPending)
        XCTAssertEqual(store.pending.first?.attachment, attachment, "失败附件应留在 pending 供重试/清理")

        // 只有清空本地历史等显式丢弃动作才调用；普通离开会话必须保留重试所有权。
        store.releaseAbandonedPendingAttachments()
        XCTAssertEqual(released, [attachment.fileId], "离开会话应释放被放弃 pending 附件的 upload-stage usage")
    }

    func testClearLocalHistoryReleasesFailedAttachmentUsage() async {
        var released: [String] = []
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .failure(URLError(.notConnectedToInternet))),
            onReleaseAbandonedAttachment: { released.append($0.fileId) }
        )
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-0000000000EF",
            fileName: "failed.png",
            fileSize: 1024,
            fileType: "image/png"
        )

        let outcome = await store.performSend(
            content: "发送失败附件",
            messageType: IMMessageType.image.rawValue,
            attachment: attachment,
            clientRequestId: "clear-failed-attachment"
        )
        XCTAssertEqual(outcome, .failedPending)
        XCTAssertEqual(store.pending.count, 1)

        store.clearLocalHistory(clearedThroughSeq: 0)

        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(released, [attachment.fileId], "本页内清空也必须释放失败附件的 upload-stage usage")
    }

    func testRealtimeEchoBeforeClearStillReleasesInFlightAttachmentUsage() async {
        var released: [String] = []
        let saved = IMSendMessageResult(id: 501, seq: 99, conversationId: "conv-1")
        let transport = FakeTransport(
            pages: [[]],
            sendResult: .success(saved),
            suspendSend: true
        )
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport,
            onReleaseAbandonedAttachment: { released.append($0.fileId) }
        )
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-0000000000F0",
            fileName: "in-flight.png",
            fileSize: 1024,
            fileType: "image/png"
        )

        let sending = Task {
            await store.performSend(
                content: "在途附件",
                messageType: IMMessageType.image.rawValue,
                attachment: attachment,
                clientRequestId: "clear-in-flight-attachment"
            )
        }
        await transport.waitUntilSendBegins()
        store.ingestRealtimeMessage(
            makeMessage(
                id: saved.id,
                seq: saved.seq,
                content: "在途附件",
                clientRequestId: "clear-in-flight-attachment"
            )
        )
        XCTAssertTrue(store.pending.isEmpty, "实时回声会先收敛展示用 pending")
        XCTAssertEqual(released, [attachment.fileId], "确认回声到达时应立即收敛附件 usage")

        store.clearLocalHistory(clearedThroughSeq: saved.seq)
        await transport.resumeSend()
        let outcome = await sending.value

        XCTAssertEqual(outcome, .discardedAfterClear)
        XCTAssertTrue(store.messages.isEmpty, "清空前已发起的请求不能用 POST 回包复活消息")
        XCTAssertEqual(released, [attachment.fileId], "实时回声先到也不能丢失在途附件 usage 的所有权")
    }

    func testRealtimeEchoReleasesFailedAttachmentUsageExactlyOnce() async {
        var released: [String] = []
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-0000000000F1",
            fileName: "echo-confirmed.png",
            fileSize: 1024,
            fileType: "image/png"
        )
        let requestId = "failed-then-realtime-confirmed"
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .failure(URLError(.timedOut))),
            onReleaseAbandonedAttachment: { released.append($0.fileId) }
        )

        let outcome = await store.performSend(
            content: "HTTP 回包失败",
            messageType: IMMessageType.image.rawValue,
            attachment: attachment,
            clientRequestId: requestId
        )
        XCTAssertEqual(outcome, .failedPending)

        store.ingestRealtimeMessage(
            makeMessage(id: 502, seq: 100, content: "HTTP 回包失败", clientRequestId: requestId)
        )

        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(released, [attachment.fileId])
        store.releaseAbandonedPendingAttachments()
        XCTAssertEqual(released, [attachment.fileId], "确认回声与离开会话不得重复释放")
    }

    func testConfirmedAttachmentReleasesUsageExactlyOnce() async {
        // 成功发送后 store 收敛 request-id 所有权；离开会话不得再重复释放。
        var released: [String] = []
        let saved = IMSendMessageResult(id: 401, seq: 88, conversationId: "conv-1")
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeTransport(sendResult: .success(saved)),
            onReleaseAbandonedAttachment: { released.append($0.fileId) }
        )
        let attachment = IMOutgoingAttachment(
            fileId: "00000000-0000-0000-0000-0000000000CD",
            fileName: "ok.jpg",
            fileSize: 512,
            fileType: "image/jpeg"
        )
        let outcome = await store.performSend(
            content: "已送达",
            messageType: IMMessageType.image.rawValue,
            attachment: attachment,
            clientRequestId: "confirmed-attachment"
        )
        XCTAssertEqual(outcome, .succeeded)
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(released, [attachment.fileId])
        store.releaseAbandonedPendingAttachments()
        XCTAssertEqual(released, [attachment.fileId], "已确认消息的附件 usage 只能释放一次")
    }

    func testRealtimeEchoOfOwnMessageDedupesById() async {
        let saved = IMSendMessageResult(id: 100, seq: 50, conversationId: "conv-1")
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport(sendResult: .success(saved)))
        _ = await store.performSend(content: "hello")
        // chat:{conv} 回声同一条消息（同 id）→ 不应重复。
        store.ingestRealtimeMessage(makeMessage(id: 100, seq: 50, content: "hello"))
        XCTAssertEqual(store.messages.count, 1)
    }

    func testRealtimeEchoClearsFailedPendingByClientRequestId() async {
        let fake = FakeTransport(sendResult: .failure(URLError(.timedOut)))
        let store = IMMessageStore(conversationId: "conv-1", transport: fake)
        let requestId = "realtime-echo-request"

        let outcome = await store.performSend(content: "已被服务端接受", clientRequestId: requestId)
        XCTAssertEqual(outcome, .failedPending)
        XCTAssertEqual(store.pending.count, 1)

        let echo = makeMessage(id: 401, seq: 80, content: "已被服务端接受", clientRequestId: requestId)
        store.ingestRealtimeMessage(echo)
        store.ingestRealtimeMessage(echo)

        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(store.messages.map(\.id), [401])
    }

    func testRealtimeReplyRestoresPreviewFromLoadedSourceMessage() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(
            IMMessage(
                id: 41,
                seq: 41,
                conversationId: "conv-1",
                senderId: "source-sender",
                content: "本地可见的原消息",
                messageType: IMMessageType.text.rawValue
            )
        )
        store.ingestRealtimeMessage(
            IMMessage(
                id: 42,
                seq: 42,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "实时回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 41,
                replyToPreview: IMReplyPreview(
                    content: "消息内容不可用",
                    senderId: "",
                    isUnavailable: true
                )
            )
        )

        let preview = store.messages.last?.replyToPreview
        XCTAssertEqual(preview?.content, "本地可见的原消息")
        XCTAssertEqual(preview?.senderId, "source-sender")
        XCTAssertFalse(preview?.isUnavailable ?? true)
    }

    func testReplyWithMissingPreviewRestoresPreviewFromLoadedSourceMessage() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(
            IMMessage(
                id: 41,
                seq: 41,
                conversationId: "conv-1",
                senderId: "source-sender",
                content: "权威完整消息里的原文",
                messageType: IMMessageType.text.rawValue
            )
        )
        store.ingestRealtimeMessage(
            IMMessage(
                id: 42,
                seq: 42,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "实时回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 41,
                replyToPreview: nil
            )
        )

        let preview = store.messages.last?.replyToPreview
        XCTAssertEqual(preview?.content, "权威完整消息里的原文")
        XCTAssertEqual(preview?.senderId, "source-sender")
        XCTAssertFalse(preview?.isUnavailable ?? true)
    }

    func testRealtimeReplyKeepsUnavailablePreviewWithoutLoadedSourceMessage() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(
            IMMessage(
                id: 42,
                seq: 42,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "实时回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 41,
                replyToPreview: IMReplyPreview(
                    content: "消息内容不可用",
                    senderId: "",
                    isUnavailable: true
                )
            )
        )

        let preview = store.messages.first?.replyToPreview
        XCTAssertEqual(preview?.content, "消息内容不可用")
        XCTAssertTrue(preview?.isUnavailable ?? false)
    }

    func testRealtimeReplyKeepsUnavailablePreviewForDeletedLoadedSourceMessage() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(
            IMMessage(
                id: 41,
                seq: 41,
                conversationId: "conv-1",
                senderId: "source-sender",
                content: "已撤回的原消息",
                messageType: IMMessageType.text.rawValue,
                isDeleted: true
            )
        )
        store.ingestRealtimeMessage(
            IMMessage(
                id: 42,
                seq: 42,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "实时回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 41,
                replyToPreview: IMReplyPreview(
                    content: "消息内容不可用",
                    senderId: "",
                    isUnavailable: true
                )
            )
        )

        let preview = store.messages.last?.replyToPreview
        XCTAssertEqual(preview?.content, "消息内容不可用")
        XCTAssertTrue(preview?.isUnavailable ?? false)
    }

    func testRealtimeInsertAndEditByIdReplaces() async {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "原文"))
        XCTAssertEqual(store.messages.count, 1)
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "改后"))
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.messages.first?.content, "改后")
    }

    func testRealtimeSessionShareEditUpdatesObservableCardCache() throws {
        let shareId = "share-\(UUID().uuidString)"
        let message = try JSONDecoder().decode(IMMessage.self, from: Data("""
        {
          "id": 15, "seq": 15, "conversation_id": "conv-1",
          "sender_id": "owner-1", "sender_type": "user", "sender_name": "拥有者",
          "content": "[任务共享] 示例任务", "message_type": 1,
          "metadata": {
            "card": {
              "type": "session_share", "share_id": "\(shareId)",
              "session_id": "session-1", "session_title": "示例任务",
              "owner_user_id": "owner-1", "grantee_user_id": "grantee-1",
              "can_fork": false, "can_chat": false, "status": "revoked"
            }
          }
        }
        """.utf8))
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())

        store.ingestRealtimeMessage(message)

        XCTAssertEqual(IMCardStatusMemoryCache.sessionShare(id: shareId)?.normalizedStatus, "revoked")
    }

    func testPartialSessionShareRefreshKeepsAuthoritativeOwnerIdentity() {
        let shareId = "share-\(UUID().uuidString)"
        IMCardStatusMemoryCache.putSessionShare(IMSessionShareCard(
            shareId: shareId,
            sessionId: "session-1",
            sessionTitle: "示例任务",
            ownerUserId: "owner-1",
            granteeUserId: "grantee-1",
            canFork: false,
            canChat: false,
            status: "revoked",
            ownerDisplayName: "拥有者",
            granteeDisplayName: "接收者"
        ))

        IMCardStatusMemoryCache.putSessionShare(IMSessionShareCard(
            shareId: shareId,
            sessionId: "session-1",
            sessionTitle: "示例任务",
            ownerUserId: nil,
            granteeUserId: nil,
            canFork: false,
            canChat: false,
            status: "revoked",
            ownerDisplayName: nil,
            granteeDisplayName: nil
        ))

        let cached = IMCardStatusMemoryCache.sessionShare(id: shareId)
        XCTAssertEqual(cached?.ownerUserId, "owner-1")
        XCTAssertEqual(cached?.granteeUserId, "grantee-1")
        XCTAssertEqual(cached?.normalizedStatus, "revoked")
    }

    func testSentHistoricalTaskShareKeepsOwnerActionsWhenSnapshotOmitsOwnerId() {
        XCTAssertTrue(isSessionShareOwner(
            currentUserId: "owner-1",
            ownerUserId: nil,
            isMine: true
        ))
        XCTAssertFalse(isSessionShareOwner(
            currentUserId: "grantee-1",
            ownerUserId: "owner-1",
            isMine: true
        ))
    }

    func testBusinessProjectionRefreshReplacesOriginalCardByMessageRef() throws {
        let messageRef = "33333333-3333-4333-8333-333333333333"
        func decode(id: Int, content: String) throws -> IMMessage {
            try JSONDecoder().decode(IMMessage.self, from: Data("""
            {
              "id": \(id), "seq": \(id), "conversation_id": "conv-1",
              "sender_id": "owner-1", "sender_type": "user",
              "sender_name": "拥有者", "content": "\(content)",
              "message_type": 1,
              "metadata": {"message_ref": "\(messageRef)"}
            }
            """.utf8))
        }
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())

        store.ingestRealtimeMessage(try decode(id: 81, content: "原状态"))
        store.ingestRealtimeMessage(try decode(id: 99, content: "已更新"))

        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.messages.first?.id, 99)
        XCTAssertEqual(store.messages.first?.content, "已更新")
    }

    func testRealtimeDeduplicatesMatchingBackendIdWhenMessageRefsDiffer() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        let original = IMMessage(
            id: 20,
            seq: 20,
            conversationId: "conv-1",
            senderId: "user-1",
            content: "原消息",
            messageType: IMMessageType.text.rawValue,
            metadata: IMMessageMetadata(messageRef: "11111111-1111-4111-8111-111111111111")
        )
        let refreshed = IMMessage(
            id: 20,
            seq: 20,
            conversationId: "conv-1",
            senderId: "user-1",
            content: "刷新后的消息",
            messageType: IMMessageType.text.rawValue,
            metadata: IMMessageMetadata(messageRef: "22222222-2222-4222-8222-222222222222")
        )

        store.ingestRealtimeMessage(original)
        store.ingestRealtimeMessage(refreshed)

        XCTAssertEqual(store.messages.map(\.id), [20])
        XCTAssertEqual(store.messages.first?.content, "刷新后的消息")
    }

    func testRealtimeIgnoresOtherConversation() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.ingestRealtimeMessage(makeMessage(id: 1, seq: 1, conversationId: "conv-OTHER"))
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testApplyRealtimeDecodesEnvelopeEndToEnd() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        let raw = Data("""
        {
          "type": "im.message", "event_id": "e1",
          "data": {
            "id": 7, "seq": 7, "conversation_id": "conv-1", "sender_id": "user-2",
            "sender_type": "user", "sender_name": "张三", "content": "实时",
            "message_type": 1, "reply_to_id": null, "metadata": {}
          }
        }
        """.utf8)
        store.applyRealtime(raw)
        XCTAssertEqual(store.messages.map(\.id), [7])
    }

    func testAgentProjectionStreamFinalAndErrorConvergeByMessageRef() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        func event(_ type: String, _ data: String) -> Data {
            Data("{\"type\":\"\(type)\",\"data\":\(data)}".utf8)
        }

        store.applyRealtime(event(
            "im.agent.message.stream",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-1\",\"agent_session_ref\":\"session-1\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"delta\":\"你\",\"stream_seq\":1,\"created_at\":\"2026-08-22T10:00:00Z\"}"
        ))
        store.applyRealtime(event(
            "im.agent.message.stream",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-1\",\"agent_session_ref\":\"session-1\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"delta\":\"错误重复\",\"stream_seq\":1,\"created_at\":\"2026-08-22T10:00:01Z\"}"
        ))
        store.applyRealtime(event(
            "im.agent.message.stream",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-1\",\"agent_session_ref\":\"session-1\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"delta\":\"好\",\"stream_seq\":3,\"created_at\":\"2026-08-22T10:00:02Z\"}"
        ))
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.messages.first?.content, "你好")
        XCTAssertEqual(store.messages.first?.metadata?.kind, "agent_stream")

        store.applyRealtime(event(
            "im.agent.message.final",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-1\",\"agent_session_ref\":\"session-1\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"content\":\"完整回答\",\"message_type\":1,\"metadata\":{},\"created_at\":\"2026-08-22T10:00:03Z\"}"
        ))
        store.applyRealtime(event(
            "im.agent.message.stream",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-1\",\"agent_session_ref\":\"session-1\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"delta\":\"迟到\",\"stream_seq\":4,\"created_at\":\"2026-08-22T10:00:04Z\"}"
        ))
        XCTAssertEqual(store.messages.first?.content, "完整回答")
        XCTAssertEqual(store.messages.first?.metadata?.kind, "agent_final")

        store.applyRealtime(event(
            "im.agent.message.stream",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-2\",\"agent_session_ref\":\"session-2\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\",\"delta\":\"临时\",\"stream_seq\":1,\"created_at\":\"2026-08-22T10:00:05Z\"}"
        ))
        store.applyRealtime(event(
            "im.agent.message.error",
            "{\"conversation_id\":\"conv-1\",\"message_ref\":\"job-2\",\"agent_session_ref\":\"session-2\",\"sender_id\":\"agent-1\",\"sender_name\":\"研究员\",\"sender_avatar\":\"\"}"
        ))
        XCTAssertFalse(store.messages.contains { $0.metadata?.messageRef == "job-2" })
    }

    func testApplyRealtimeSynchronizesPinnedAndBusinessCardState() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeTransport())
        store.applyRealtime(Data("""
        {"type":"im.message.pinned","data":{"id":8,"seq":8,
         "conversation_id":"conv-1","sender_id":"user-2","content":"重点",
         "message_type":1,"is_pinned":true,"metadata":{}}}
        """.utf8))
        XCTAssertEqual(store.pinnedMessages.map(\.id), [8])

        store.applyRealtime(Data("""
        {"type":"im.message.unpinned","data":{"message_id":8,"conversation_id":"conv-1"}}
        """.utf8))
        XCTAssertTrue(store.pinnedMessages.isEmpty)
        XCTAssertFalse(store.messages.first?.isPinned ?? true)

        store.applyRealtime(Data("""
        {"type":"im.session_share.update","data":{"share_id":"share-1","conversation_id":"conv-1"}}
        """.utf8))
        XCTAssertEqual(store.sessionShareVersions["share-1"], 1)

        store.applyRealtime(Data("""
        {"type":"im.conversation.updated","data":{"conversation_id":"conv-1","name":"新群名"}}
        """.utf8))
        XCTAssertEqual(store.conversationRevision, 1)
    }

    // MARK: - Phase E：编辑 / 撤回 / 表情 / 已读

    func testEditMessageOptimisticThenConfirm() async {
        let transport = FakeMutationTransport()
        transport.editResult = .success(makeMessage(id: 5, seq: 5, content: "改后"))
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "原文"))

        let ok = await store.editMessage(messageId: 5, newContent: "改后")
        XCTAssertTrue(ok)
        XCTAssertEqual(store.messages.first?.content, "改后")
        XCTAssertEqual(transport.editedContents, ["改后"])
    }

    func testEditMessageRefreshesLoadedReplyPreview() async {
        let transport = FakeMutationTransport()
        transport.editResult = .success(makeMessage(id: 5, seq: 5, content: "编辑后的原文"))
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "编辑前的原文"))
        store.ingestRealtimeMessage(
            IMMessage(
                id: 6,
                seq: 6,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 5,
                replyToPreview: IMReplyPreview(content: "编辑前的原文", senderId: "user-1")
            )
        )

        let ok = await store.editMessage(messageId: 5, newContent: "编辑后的原文")

        XCTAssertTrue(ok)
        XCTAssertEqual(store.messages.first(where: { $0.id == 6 })?.replyToPreview?.content, "编辑后的原文")
    }

    func testEditMessageUnchangedContentIsNoop() async {
        let transport = FakeMutationTransport()
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "原文"))

        let ok = await store.editMessage(messageId: 5, newContent: " 原文 ")

        XCTAssertTrue(ok)
        XCTAssertEqual(store.messages.first?.content, "原文")
        XCTAssertNil(store.messages.first?.editedAt)
        XCTAssertEqual(transport.editedContents, [])
    }

    func testEditMessageRollsBackOnFailure() async {
        let transport = FakeMutationTransport()
        transport.editResult = .failure(URLError(.notConnectedToInternet))
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 5, seq: 5, content: "原文"))

        let ok = await store.editMessage(messageId: 5, newContent: "改后")
        XCTAssertFalse(ok)
        XCTAssertEqual(store.messages.first?.content, "原文", "失败应回滚为原文")
        XCTAssertNil(store.messages.first?.editedAt)
    }

    func testRecallMessageOptimisticThenConfirm() async {
        let transport = FakeMutationTransport()
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 8, seq: 8, content: "待撤回"))

        let ok = await store.recallMessage(messageId: 8)
        XCTAssertTrue(ok)
        XCTAssertTrue(store.messages.first?.isDeleted ?? false)
        XCTAssertEqual(store.messages.first?.content, "待撤回")
        XCTAssertEqual(transport.recalledIds, [8])
    }

    func testRecallMessageMakesLoadedReplyPreviewUnavailable() async {
        let transport = FakeMutationTransport()
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 8, seq: 8, content: "不应继续展示"))
        store.ingestRealtimeMessage(
            IMMessage(
                id: 9,
                seq: 9,
                conversationId: "conv-1",
                senderId: "reply-sender",
                content: "回复",
                messageType: IMMessageType.text.rawValue,
                replyToId: 8,
                replyToPreview: IMReplyPreview(content: "不应继续展示", senderId: "user-1")
            )
        )

        let ok = await store.recallMessage(messageId: 8)

        let preview = store.messages.first(where: { $0.id == 9 })?.replyToPreview
        XCTAssertTrue(ok)
        XCTAssertEqual(preview?.content, "消息内容不可用")
        XCTAssertTrue(preview?.isUnavailable ?? false)
    }

    func testRecallMessageRollsBackOnFailure() async {
        let transport = FakeMutationTransport()
        transport.recallShouldFail = true
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        store.ingestRealtimeMessage(makeMessage(id: 8, seq: 8, content: "待撤回"))

        let ok = await store.recallMessage(messageId: 8)
        XCTAssertFalse(ok)
        XCTAssertFalse(store.messages.first?.isDeleted ?? true, "失败应回滚撤回态")
        XCTAssertEqual(store.messages.first?.content, "待撤回")
    }

    func testRealtimeRecallKeepsOwnTextForRecomposeButClearsPeerText() {
        let mineStore = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        mineStore.currentUserId = "me"
        mineStore.ingestRealtimeMessage(makeMessage(id: 8, seq: 8, content: "我的原文", senderId: "me"))
        var recalledMine = makeMessage(id: 8, seq: 8, content: "", senderId: "me")
        recalledMine.isDeleted = true
        mineStore.ingestRealtimeMessage(recalledMine)
        XCTAssertEqual(mineStore.messages.first?.content, "我的原文")

        let peerStore = IMMessageStore(conversationId: "conv-2", transport: FakeMutationTransport())
        peerStore.currentUserId = "me"
        peerStore.ingestRealtimeMessage(makeMessage(
            id: 9,
            seq: 9,
            conversationId: "conv-2",
            content: "对方原文",
            senderId: "peer"
        ))
        var recalledPeer = makeMessage(
            id: 9,
            seq: 9,
            conversationId: "conv-2",
            content: "",
            senderId: "peer"
        )
        recalledPeer.isDeleted = true
        peerStore.ingestRealtimeMessage(recalledPeer)
        XCTAssertEqual(peerStore.messages.first?.content, "")
    }

    func testSilentStateReconcileCanAuthoritativelyClearStalePinnedState() async {
        let remote = makeMessage(id: 9, seq: 9, content: "远端未置顶")
        let transport = FakeMutationTransport()
        transport.seedMessages = [remote]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        var local = makeMessage(id: 9, seq: 9, content: "本地旧置顶")
        local.isPinned = true
        store.ingestRealtimeMessage(local)

        await store.refreshLatestNow()

        XCTAssertFalse(store.messages.first?.isPinned ?? true, "历史页已 enrich 的置顶 false 应覆盖本地旧 true")
    }

    func testSilentStateReconcileCanAuthoritativelyClearStaleReactions() async {
        var remote = makeMessage(id: 10, seq: 10, content: "远端已移除 Reaction")
        remote.reactionStateKnown = true
        let transport = FakeMutationTransport()
        transport.seedMessages = [remote]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        var local = makeMessage(id: 10, seq: 10, content: "本地旧 Reaction")
        local.reactions = ["👍": ["peer"]]
        local.reactionOrder = ["👍"]
        store.ingestRealtimeMessage(local)

        await store.refreshLatestNow()

        XCTAssertTrue(store.messages.first?.reactions.isEmpty ?? false)
        XCTAssertTrue(store.messages.first?.reactionOrder.isEmpty ?? false)
    }

    func testDuplicateUnpinFailureConvergesToAuthoritativeRemoteState() async throws {
        let transport = FakeMutationTransport()
        transport.pinShouldFail = true
        transport.seedMessages = [makeMessage(id: 11, seq: 11, content: "远端已取消置顶")]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        var stale = makeMessage(id: 11, seq: 11, content: "本地旧置顶")
        stale.isPinned = true
        store.ingestRealtimeMessage(stale)

        try await store.pinMessage(messageId: 11, pinned: false)

        XCTAssertFalse(store.messages.first?.isPinned ?? true)
    }

    func testPinnedSnapshotIncludesUnloadedMessagesAndSortsNewestFirst() async {
        let transport = FakeMutationTransport()
        var older = makeMessage(id: 31, seq: 31, content: "较早置顶")
        older.isPinned = true
        var latest = makeMessage(id: 45, seq: 45, content: "最新置顶")
        latest.isPinned = true
        transport.seedPinnedMessages = [older, latest]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)

        await store.refreshPinnedMessages()

        XCTAssertEqual(store.pinnedMessages.map(\.id), [45, 31])
        XCTAssertTrue(store.messages.isEmpty, "置顶列表不应依赖当前历史页已加载")
    }

    func testReopenedStoreRestoresPinnedSnapshotBeforeNetworkRefresh() {
        let cache = IMPinnedMessageMemoryCache()
        var cached = makeMessage(id: 61, seq: 61, content: "缓存置顶")
        cached.isPinned = true
        cached.pinStateKnown = true
        cache.storePinnedMessages(conversationId: "conv-1", messages: [cached])

        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeMutationTransport(),
            pinnedSnapshotCache: cache
        )

        XCTAssertEqual(store.pinnedMessages.map(\.id), [61])
        XCTAssertTrue(store.messages.isEmpty, "完整置顶快照不应依赖最近消息缓存")
    }

    func testAuthoritativeEmptyPinnedSnapshotClearsPersistedSnapshot() async {
        let cache = IMPinnedMessageMemoryCache()
        var stale = makeMessage(id: 62, seq: 62, content: "旧置顶")
        stale.isPinned = true
        stale.pinStateKnown = true
        cache.storePinnedMessages(conversationId: "conv-1", messages: [stale])
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeMutationTransport(),
            pinnedSnapshotCache: cache
        )

        await store.refreshPinnedMessages()

        XCTAssertTrue(store.pinnedMessages.isEmpty)
        XCTAssertTrue(cache.pinnedMessages(conversationId: "conv-1").isEmpty)
    }

    func testPinnedRefreshFailureKeepsCachedSnapshot() async {
        let cache = IMPinnedMessageMemoryCache()
        var cached = makeMessage(id: 65, seq: 65, content: "离线仍展示")
        cached.isPinned = true
        cached.pinStateKnown = true
        cache.storePinnedMessages(conversationId: "conv-1", messages: [cached])
        let transport = FakeMutationTransport()
        transport.pinnedFetchShouldFail = true
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: transport,
            pinnedSnapshotCache: cache
        )

        await store.refreshPinnedMessages()

        XCTAssertEqual(store.pinnedMessages.map(\.id), [65])
        XCTAssertEqual(cache.pinnedMessages(conversationId: "conv-1").map(\.id), [65])
    }

    func testLatePinnedHydrationCannotOverwriteAuthoritativeSnapshot() async {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        await store.refreshPinnedMessages()
        var stale = makeMessage(id: 63, seq: 63, content: "迟到缓存")
        stale.isPinned = true
        stale.pinStateKnown = true

        store.hydratePinnedSnapshotIfNeeded([stale])

        XCTAssertTrue(store.pinnedMessages.isEmpty)
    }

    func testLocalAndRealtimeUnpinImmediatelyRemovePinnedSnapshot() async throws {
        let transport = FakeMutationTransport()
        var first = makeMessage(id: 51, seq: 51, content: "第一条")
        first.isPinned = true
        var second = makeMessage(id: 52, seq: 52, content: "第二条")
        second.isPinned = true
        transport.seedPinnedMessages = [first, second]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        await store.refreshPinnedMessages()

        try await store.pinMessage(messageId: 51, pinned: false)
        XCTAssertEqual(store.pinnedMessages.map(\.id), [52])

        second.isPinned = false
        second.pinStateKnown = true
        store.ingestRealtimeMessage(second)
        XCTAssertTrue(store.pinnedMessages.isEmpty)
    }

    func testLocalPinMutationPersistsPinnedSnapshot() async throws {
        let cache = IMPinnedMessageMemoryCache()
        let store = IMMessageStore(
            conversationId: "conv-1",
            transport: FakeMutationTransport(),
            pinnedSnapshotCache: cache
        )
        store.ingestRealtimeMessage(makeMessage(id: 64, seq: 64, content: "待置顶"))

        try await store.pinMessage(messageId: 64, pinned: true)

        XCTAssertEqual(cache.pinnedMessages(conversationId: "conv-1").map(\.id), [64])
    }

    func testSilentStateReconcileDoesNotResurrectOptimisticallyRecalledMessage() async {
        let transport = FakeMutationTransport()
        transport.seedMessages = [makeMessage(id: 10, seq: 10, content: "旧历史")]
        let store = IMMessageStore(conversationId: "conv-1", transport: transport)
        var recalled = makeMessage(id: 10, seq: 10, content: "已撤回")
        recalled.isDeleted = true
        recalled.content = ""
        store.ingestRealtimeMessage(recalled)

        await store.refreshLatestNow()

        XCTAssertTrue(store.messages.first?.isDeleted ?? false, "本地/实时撤回态不能被旧历史刷回未撤回")
        XCTAssertEqual(store.messages.first?.content, "")
    }

    func testToggleReactionOptimisticAddThenRemoveLocally() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.currentUserId = "me"
        store.ingestRealtimeMessage(makeMessage(id: 3, seq: 3))

        store.toggleReaction(messageId: 3, emoji: "👍")
        XCTAssertEqual(store.messages.first?.reactions["👍"], ["me"], "乐观加入本人")
        // 整条消息应被替换（Equatable 变化），否则 @Observable 嵌套原地改写 UI 不刷。
        let afterAdd = try! XCTUnwrap(store.messages.first)
        XCTAssertNotEqual(afterAdd.reactions, [:])

        store.toggleReaction(messageId: 3, emoji: "👍")
        XCTAssertNil(store.messages.first?.reactions["👍"], "再次点击乐观移除，空列表清键")
        XCTAssertEqual(store.messages.first?.reactions ?? [:], [:])
    }

    func testToggleReactionFallsBackToAuthUserIdWhenUnset() {
        // currentUserId 未注入时不应静默空操作（真机走查曾踩到「点了没反应」）。
        // 此处无法注入 AuthService，只断言空 userId 时跳过且不崩溃；有 userId 时走正常路径。
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.ingestRealtimeMessage(makeMessage(id: 3, seq: 3))
        store.currentUserId = nil
        // 若 AuthService 无当前用户：跳过；有则写入。两种都不崩溃。
        store.toggleReaction(messageId: 3, emoji: "👍")
        // 补注入后应能成功乐观更新。
        store.currentUserId = "me"
        store.toggleReaction(messageId: 3, emoji: "🎉")
        XCTAssertEqual(store.messages.first?.reactions["🎉"], ["me"])
    }

    func testRealtimeReactionMergeIsIdempotent() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.ingestRealtimeMessage(makeMessage(id: 3, seq: 3))

        let add = { (uid: String, emoji: String) in
            self.reactionRaw(messageId: 3, userId: uid, emoji: emoji, added: true)
        }
        store.applyRealtime(add("ua", "👍"))
        store.applyRealtime(add("ua", "👍"))  // 重复到达
        store.applyRealtime(add("ub", "👍"))
        XCTAssertEqual(store.messages.first?.reactions["👍"]?.sorted(), ["ua", "ub"], "同用户不重复计")

        store.applyRealtime(reactionRaw(messageId: 3, userId: "ua", emoji: "👍", added: false))
        XCTAssertEqual(store.messages.first?.reactions["👍"], ["ub"])
    }

    func testRealtimeSnapshotPreservesReplyLinkWhenAddingReaction() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.ingestRealtimeMessage(makeMessage(id: 1, seq: 1, content: "原消息"))
        store.ingestRealtimeMessage(makeMessage(id: 2, seq: 2, content: "回复", replyToId: 1))

        var reactionSnapshot = makeMessage(id: 2, seq: 2, content: "回复")
        reactionSnapshot.reactions = ["👍": ["me"]]
        store.ingestRealtimeMessage(reactionSnapshot)

        let reply = store.messages.first { $0.id == 2 }
        XCTAssertEqual(reply?.replyToId, 1)
        XCTAssertEqual(reply?.reactions["👍"], ["me"])
        XCTAssertEqual(store.messages.count { $0.replyToId == 1 }, 1)
    }

    func testApplyRealtimeEditedReplacesContent() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.ingestRealtimeMessage(makeMessage(id: 6, seq: 6, content: "原"))
        let raw = Data("""
        {"type": "im.message.edited", "data": {
          "id": 6, "seq": 6, "conversation_id": "conv-1", "sender_id": "user-2",
          "sender_type": "user", "sender_name": "张三", "content": "新",
          "message_type": 1, "edited_at": "2026-07-20T10:00:00Z", "metadata": {}}}
        """.utf8)
        store.applyRealtime(raw)
        XCTAssertEqual(store.messages.first?.content, "新")
        XCTAssertTrue(store.messages.first?.isEdited ?? false)
    }

    func testApplyRealtimeDeletedMarksRecalled() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.ingestRealtimeMessage(makeMessage(id: 6, seq: 6, content: "待撤"))
        let raw = Data("""
        {"type": "im.message.deleted", "data": {"message_id": 6, "conversation_id": "conv-1", "sender_id": "user-2"}}
        """.utf8)
        store.applyRealtime(raw)
        XCTAssertTrue(store.messages.first?.isDeleted ?? false)
        XCTAssertEqual(store.messages.first?.content, "")
    }

    func testReadReceiptDrivesIsReadByPeer() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.currentUserId = "me"
        let mine = makeMessage(id: 10, seq: 10, content: "我发的", senderId: "me")
        store.ingestRealtimeMessage(mine)
        XCTAssertFalse(store.isReadByPeer(mine), "对端尚未读")

        let raw = Data("""
        {"type": "im.read.receipt", "data": {"conversation_id": "conv-1", "user_id": "peer",
          "last_read_message_id": 10, "last_read_seq": 10}}
        """.utf8)
        store.applyRealtime(raw)
        XCTAssertTrue(store.isReadByPeer(mine), "对端已读到 seq>=该消息")
    }

    func testReadReceiptAggregateMarksReadWithoutRealtimeEvent() {
        // 对端在我打开会话前已读：列表随消息下发的 read_receipt 聚合(read_count>0)即判已读。
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.currentUserId = "me"
        let json = Data("""
        {"id": 11, "seq": 11, "conversation_id": "conv-1", "sender_id": "me",
         "sender_type": "user", "sender_name": "我", "content": "早发的",
         "message_type": 1, "reply_to_id": null, "metadata": {},
         "read_receipt": {"read_count": 1, "recipient_count": 1}}
        """.utf8)
        let mine = try! JSONDecoder().decode(IMMessage.self, from: json)
        store.ingestRealtimeMessage(mine)
        XCTAssertTrue(store.isReadByPeer(mine), "聚合 read_count>0 即应判为对端已读")
    }

    func testReadProgressMergesAggregateAndRealtimeReceipt() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.currentUserId = "me"
        let json = Data("""
        {"id": 12, "seq": 12, "conversation_id": "conv-1", "sender_id": "me",
         "sender_type": "user", "sender_name": "我", "content": "群聊消息",
         "message_type": 1, "reply_to_id": null, "metadata": {},
         "read_receipt": {"read_count": 1, "recipient_count": 3}}
        """.utf8)
        let mine = try! JSONDecoder().decode(IMMessage.self, from: json)
        store.ingestRealtimeMessage(mine)
        store.applyRealtime(Data("""
        {"type": "im.read.receipt", "data": {"conversation_id": "conv-1", "user_id": "peer-2",
          "last_read_message_id": 12, "last_read_seq": 12}}
        """.utf8))
        store.applyRealtime(Data("""
        {"type": "im.read.receipt", "data": {"conversation_id": "conv-1", "user_id": "peer-3",
          "last_read_message_id": 12, "last_read_seq": 12}}
        """.utf8))

        XCTAssertEqual(store.readProgress(for: mine), IMReadReceipt(readCount: 2, recipientCount: 3))
    }

    func testReadReceiptDetailsDelegateConversationAndMessageId() async throws {
        let transport = FakeMutationTransport()
        let expected = IMMessageReadReceipts(
            readers: [IMReadReceiptMember(userId: "read-1", name: "已读成员", avatar: "")],
            unreaders: [IMReadReceiptMember(userId: "unread-1", name: "未读成员", avatar: "")]
        )
        transport.readReceiptResult = expected
        let store = IMMessageStore(conversationId: "conv-read", transport: transport)

        let actual = try await store.fetchReadReceipts(
            for: makeMessage(id: 42, seq: 42, conversationId: "conv-read", content: "群消息")
        )

        XCTAssertEqual(actual, expected)
        XCTAssertEqual(transport.readReceiptCalls.count, 1)
        XCTAssertEqual(transport.readReceiptCalls.first?.0, "conv-read")
        XCTAssertEqual(transport.readReceiptCalls.first?.1, 42)
    }

    func testTypingEventPopulatesTypingUsersExcludingSelf() {
        let store = IMMessageStore(conversationId: "conv-1", transport: FakeMutationTransport())
        store.currentUserId = "me"
        store.applyRealtime(Data("{\"type\": \"im.typing\", \"user_id\": \"peer\"}".utf8))
        store.applyRealtime(Data("{\"type\": \"im.typing\", \"user_id\": \"me\"}".utf8))
        XCTAssertEqual(store.typingUserIds, ["peer"], "应含对端、排除本人")
    }

    /// 构造一条 reaction 事件的原始信封字节。
    private func reactionRaw(messageId: Int, userId: String, emoji: String, added: Bool) -> Data {
        let type = added ? "im.reaction.added" : "im.reaction.removed"
        return Data("""
        {"type": "\(type)", "data": {"message_id": \(messageId),
          "conversation_id": "conv-1", "user_id": "\(userId)", "emoji": "\(emoji)"}}
        """.utf8)
    }
}
