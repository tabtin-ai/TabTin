import Foundation
import XCTest
@testable import Tabtin

/// 已读回执 outbox 的失败分类：400/404/409 为永久失败应丢弃毒消息，网络/5xx 保留重试。
@MainActor
final class SessionReadStoreTests: XCTestCase {
    // 与 SessionReadStore.pendingKey / acknowledgedKey 常量保持一致。
    private let pendingKey = "tabtin.pending-session-read-acks.v1"
    private let acknowledgedKey = "tabtin.acknowledged-session-read-acks.v1"

    private var sent: [PendingSessionReadAck]!
    private var errorToThrow: Error?

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: pendingKey)
        UserDefaults.standard.removeObject(forKey: acknowledgedKey)
        sent = []
        errorToThrow = nil
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: pendingKey)
        UserDefaults.standard.removeObject(forKey: acknowledgedKey)
        sent = nil
        errorToThrow = nil
        super.tearDown()
    }

    private func makeStore() -> SessionReadStore {
        SessionReadStore(
            sendReadAck: { [weak self] candidate in
                guard let self else { return }
                self.sent.append(candidate)
                if let error = self.errorToThrow { throw error }
            },
            isAuthenticated: { true },
            registerLogoutHook: { _ in }
        )
    }

    private func makeCandidate(
        sessionId: String = "session-a",
        sequence: Int = 1,
        revision: Int = 1
    ) -> PendingSessionReadAck {
        PendingSessionReadAck(
            sessionId: sessionId,
            throughRunId: "run-a",
            throughSequence: sequence,
            throughRevision: revision,
            mutationId: "mutation-\(sequence)-\(revision)"
        )
    }

    func testNotFoundDropsEntryAndStopsReplaying() async {
        errorToThrow = APIError.serverError(404, nil)
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        XCTAssertEqual(sent.count, 1)

        await store.flush()
        await store.flush()
        XCTAssertEqual(sent.count, 1, "404 为永久失败：条目应被丢弃而不是无限重放")
        XCTAssertNil(UserDefaults.standard.data(forKey: pendingKey))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: acknowledgedKey), "同游标必须本地结算，避免进会话再入队")
    }

    func testStaleReadCursorDropsEntryAndStopsReplaying() async {
        errorToThrow = APIError.serverError(409, "[STALE_READ_CURSOR] 水位游标已过期")
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        XCTAssertEqual(sent.count, 1)

        await store.flush()
        await store.flush()
        XCTAssertEqual(sent.count, 1, "409 STALE_READ_CURSOR 为永久失败：条目应被丢弃而不是无限重放")
        XCTAssertNil(UserDefaults.standard.data(forKey: pendingKey))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: acknowledgedKey))
    }

    func testBadRequestDropsEntryAndStopsReplaying() async {
        errorToThrow = APIError.serverError(400, nil)
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        XCTAssertEqual(sent.count, 1)

        await store.flush()
        XCTAssertEqual(sent.count, 1, "400 为永久失败：条目应被丢弃而不是无限重放")
        XCTAssertNil(UserDefaults.standard.data(forKey: pendingKey))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: acknowledgedKey))
    }

    func testPermanentFailureDoesNotBlockNewerCandidate() async {
        errorToThrow = APIError.serverError(404, nil)
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate(sequence: 1))
        XCTAssertEqual(sent.count, 1)

        errorToThrow = nil
        await store.acknowledgeContentDisplayed(makeCandidate(sequence: 2))
        XCTAssertEqual(sent.count, 2, "毒消息结算后，后续更高水位仍应发送")
    }

    func testPermanentFailureSettlesCursorSoSameWatermarkIsNotResent() async {
        errorToThrow = APIError.serverError(409, "[STALE_READ_CURSOR] 水位游标已过期")
        let store = makeStore()
        let first = makeCandidate(sequence: 4, revision: 4)

        await store.acknowledgeContentDisplayed(first)
        XCTAssertEqual(sent.count, 1)

        errorToThrow = APIError.serverError(409, "[STALE_READ_CURSOR] 水位游标已过期")
        await store.acknowledgeContentDisplayed(
            PendingSessionReadAck(
                sessionId: first.sessionId,
                throughRunId: first.throughRunId,
                throughSequence: first.throughSequence,
                throughRevision: first.throughRevision,
                mutationId: "mutation-retry"
            )
        )
        await store.flush()
        XCTAssertEqual(sent.count, 1, "同一 sequence/revision 换 mutationId 也不得再打网")
    }

    func testNetworkErrorKeepsEntryForRetry() async {
        errorToThrow = APIError.networkError(URLError(.notConnectedToInternet))
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        await store.flush()
        XCTAssertEqual(sent.count, 2, "网络错误为临时失败：条目应保留并在下次 flush 重发")
        XCTAssertNotNil(UserDefaults.standard.data(forKey: pendingKey))
    }

    func testServerError5xxKeepsEntryForRetry() async {
        errorToThrow = APIError.serverError(500, nil)
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        await store.flush()
        XCTAssertEqual(sent.count, 2, "5xx 为临时失败：条目应保留并在下次 flush 重发")
        XCTAssertNotNil(UserDefaults.standard.data(forKey: pendingKey))
    }

    func testSuccessRemovesEntryAndRecordsAcknowledged() async {
        let store = makeStore()

        await store.acknowledgeContentDisplayed(makeCandidate())
        XCTAssertEqual(sent.count, 1)

        await store.flush()
        XCTAssertEqual(sent.count, 1)
        XCTAssertNil(UserDefaults.standard.data(forKey: pendingKey))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: acknowledgedKey))
    }
}
