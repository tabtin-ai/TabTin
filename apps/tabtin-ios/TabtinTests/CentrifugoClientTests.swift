import XCTest
@testable import Tabtin

/// 线程安全的 token 序列：每次 next() 返回下一个值（末位吸收），供注入的 tokenProvider 模拟
/// 「首连 → 刷新后重连」拿到不同 token。
private actor TokenSequence {
    private let values: [String]
    private var index = 0
    private(set) var forceRefreshCalls: [Bool] = []

    init(_ values: [String]) { self.values = values }

    func next(forceRefresh: Bool) -> String {
        forceRefreshCalls.append(forceRefresh)
        defer { index = Swift.min(index + 1, values.count - 1) }
        return values[index]
    }
}

private actor OptionalTokenSequence {
    private let values: [String?]
    private var index = 0
    private(set) var callCount = 0

    init(_ values: [String?]) { self.values = values }

    func next() -> String? {
        callCount += 1
        defer { index = Swift.min(index + 1, values.count - 1) }
        return values[index]
    }
}

final class CentrifugoClientTests: XCTestCase {
    func testPersonalChannelFormat() {
        XCTAssertEqual(CentrifugoClient.personalChannel(userId: "u-1"), "personal:u-1")
        XCTAssertEqual(CentrifugoClient.personalChannel(userId: ""), "personal:")
    }

    func testChatChannelFormat() {
        XCTAssertEqual(CentrifugoClient.chatChannel(conversationId: "conv-1"), "chat:conv-1")
        XCTAssertEqual(CentrifugoClient.chatConversationId(channel: "chat:conv-1"), "conv-1")
        XCTAssertNil(CentrifugoClient.chatConversationId(channel: "chat:"))
        XCTAssertNil(CentrifugoClient.chatConversationId(channel: "personal:user-1"))
    }

    func testCatchUpAvailabilityFollowsConfirmedPersonalAndChatSubscriptions() {
        XCTAssertEqual(
            CentrifugoClient.subscriptionAvailability(channel: "personal:user-1"),
            .personal
        )
        XCTAssertEqual(
            CentrifugoClient.subscriptionAvailability(channel: "chat:conv-1"),
            .chat(conversationId: "conv-1")
        )
        XCTAssertNil(CentrifugoClient.subscriptionAvailability(channel: "personal:"))
        XCTAssertNil(CentrifugoClient.subscriptionAvailability(channel: "other:user-1"))
    }

    func testReconnectDelayKeepsRetryingAfterFormerAttemptLimit() {
        XCTAssertEqual(CentrifugoClient.reconnectDelay(attempt: 1), 0.5)
        XCTAssertEqual(CentrifugoClient.reconnectDelay(attempt: 11), 20.0)
        XCTAssertEqual(CentrifugoClient.reconnectDelay(attempt: 50), 20.0)
    }

    @MainActor
    func testTransientMissingTokenKeepsRetrying() async {
        let tokens = OptionalTokenSequence([nil, nil])
        let client = CentrifugoClient(
            tokenProvider: { _ in await tokens.next() },
            userIdProvider: { "authenticated-user" }
        )

        client.connect()
        // 首次凭据重试会退避 500ms。等待“第二次实际取凭据”这个行为信号，
        // 不把断言绑在 800ms 的模拟器墙钟边界上；共享模拟器偶发主线程繁忙时，
        // 原断言会在重试任务刚开始、tokenProvider 尚未执行前误报。
        let deadline = ContinuousClock.now + .seconds(5)
        while await tokens.callCount < 2, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        client.disconnect()

        let callCount = await tokens.callCount
        XCTAssertGreaterThanOrEqual(callCount, 2)
    }

    /// Connect data 必须是 `{"token": <jwt>}`，对齐后端 Connect Proxy 的 `data.token` 契约。
    func testMakeConnectDataCarriesTokenUnderDataKey() throws {
        let data = try XCTUnwrap(CentrifugoClient.makeConnectData(token: "jwt-abc"))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["token"] as? String, "jwt-abc")
    }

    /// 回归：重连时构造的 Connect data 必须携带**刷新后的最新** token，而非首连时那份旧 token。
    /// 这是 review 指出的核心风险——SwiftCentrifuge 的 config.data 静态、tokenGetter 只刷
    /// protocol token（后端不读），若不每次重取 token，重连必带过期凭据被拒。
    @MainActor
    func testResolveConnectDataUsesLatestTokenOnEachConnect() async throws {
        let tokens = TokenSequence(["old-token", "new-token"])
        let client = CentrifugoClient(tokenProvider: { forceRefresh in
            await tokens.next(forceRefresh: forceRefresh)
        })

        // await 不能放进 XCTUnwrap 的 autoclosure（不支持并发），先取值再解包。
        let firstData = await client.resolveConnectData(forceRefresh: false)
        let first = try XCTUnwrap(firstData)
        let firstToken = (try JSONSerialization.jsonObject(with: first) as? [String: Any])?["token"] as? String
        XCTAssertEqual(firstToken, "old-token", "首连应使用当前 token")

        let secondData = await client.resolveConnectData(forceRefresh: true)
        let second = try XCTUnwrap(secondData)
        let secondToken = (try JSONSerialization.jsonObject(with: second) as? [String: Any])?["token"] as? String
        XCTAssertEqual(secondToken, "new-token", "重连必须携带刷新后的最新 token，而非首连时的旧 token")

        // 且 forceRefresh 语义被透传：首连不强刷、重连强刷。
        let calls = await tokens.forceRefreshCalls
        XCTAssertEqual(calls, [false, true])
    }

    /// 无有效凭据时不构造 data（调用方据此放弃连接，不会用空 token 触发 4001 循环）。
    @MainActor
    func testResolveConnectDataNilWhenNoToken() async {
        let client = CentrifugoClient(tokenProvider: { _ in nil })
        let data = await client.resolveConnectData(forceRefresh: false)
        XCTAssertNil(data)
    }

    /// 回归：personal 频道订阅的 userId 只能来自**内部鉴权态**（当前登录用户），不接受外部传入。
    /// review 指出外部传 userId 可越权订阅他人 `personal:<other>` 频道；`connect()` 已去参，
    /// userId 走内部 `resolveUserId()` 解析。这里断言解析结果即注入的登录用户、并据此拼出本人频道。
    @MainActor
    func testConnectResolvesUserIdFromAuthenticatedSession() async {
        let client = CentrifugoClient(
            tokenProvider: { _ in "jwt" },
            userIdProvider: { "authenticated-user" }
        )
        let userId = await client.resolveUserId()
        XCTAssertEqual(userId, "authenticated-user", "userId 必须来自内部鉴权态而非外部传入")
        XCTAssertEqual(
            CentrifugoClient.personalChannel(userId: userId ?? ""),
            "personal:authenticated-user",
            "只订阅当前登录用户本人的 personal 频道"
        )
    }

    /// 未登录（鉴权态无当前用户）时解析不出 userId，`establishConnection` 会据此放弃连接，
    /// 不会订阅任何 personal 频道。
    @MainActor
    func testResolveUserIdNilWhenUnauthenticated() async {
        let client = CentrifugoClient(tokenProvider: { _ in "jwt" }, userIdProvider: { nil })
        let userId = await client.resolveUserId()
        XCTAssertNil(userId)
    }
}
