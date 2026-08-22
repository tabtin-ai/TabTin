import Foundation
import os
import SwiftCentrifuge

enum CentrifugoError: Error {
    case notAuthenticated
}

enum CentrifugoSubscriptionAvailability: Equatable {
    case personal
    case chat(conversationId: String)
}

/// TabChat IM 实时通道客户端（Phase A）。
///
/// 封装 `SwiftCentrifuge`，但**完全接管连接生命周期**（不依赖 SDK 的自动重连语义）：
/// 后端 Connect Proxy 只从连接请求的 `data.token` 读凭据（见
/// `apps/tabtin_django/apps/tabchat/centrifugo_proxy.py`），且对 token/session 失效返回
/// `4001-4009` 段 disconnect code——Centrifugo 把这些码标为 `reconnect=true`，SDK 会拿着
/// 首连时那份**静态**的 `config.data` 无限自动重连（token 过期后必然循环失败）。而
/// `SwiftCentrifuge` 0.9.0 没有 centrifuge-js 的 `getData` 动态回调，`config.data` 一旦
/// 设定即固定，`tokenGetter` 只刷新 protocol token（`req.token`，后端不读）。
///
/// 因此这里的策略是：每次（重）连接都**重新取 token → 构造新 `data` → 重建 client**；
/// SDK 一旦想自己重连（`onConnecting`）或 terminal 断开（`onDisconnected`），立即打断并
/// 由本类持续退避自管重连，token 类断开强制刷新 token。
///
/// 命名注意：本类 `CentrifugoClient` 对应产品侧 Centrifugo；SDK 类型为 `CentrifugeClient`。
@MainActor
@Observable
final class CentrifugoClient {
    static let shared = CentrifugoClient()

    enum ConnectionState: Sendable {
        case disconnected
        case connecting
        case connected
    }

    private(set) var state: ConnectionState = .disconnected

    /// personal 频道收到的原始发布负载（Phase A 透传 JSON bytes；Phase B 再解析为 IM 事件）。
    private var personalPublicationListener: (@MainActor (Data) -> Void)?
    private var connectionAvailableListener: (@MainActor () -> Void)?

    /// `chat:{conversationId}` 频道收到的原始发布负载（conversationId, 原始 JSON bytes）。
    /// 进入会话详情 `subscribeChat`、退出 `unsubscribeChat`；调用方用 `IMEventDecoder` 解析。
    var onChatPublication: (@MainActor (_ conversationId: String, _ data: Data) -> Void)?

    /// 会话级监听：导航栈中的父会话与新 push 的私信可同时保留各自 realtime 状态。
    private var chatPublicationListeners: [String: @MainActor (Data) -> Void] = [:]
    private var chatConnectionAvailableListeners: [String: @MainActor () -> Void] = [:]

    /// 每次（重）连接前异步取 access token；`forceRefresh=true` 时强制刷新（token 失效重连用）。
    /// 默认接 `APIClient` 的凭据入口（内部单飞刷新）；测试可注入。
    private let tokenProvider: @Sendable (_ forceRefresh: Bool) async -> String?

    /// 每次（重）连接前取**当前登录用户** id。personal 频道只能订阅本人频道，userId 由本类从
    /// 鉴权态内部解析，不接受外部传入（防越权订阅他人频道）。默认读 `AuthService`，测试可注入。
    private let userIdProvider: @Sendable () async -> String?

    private var client: CentrifugeClient?
    private var personalSubscription: CentrifugeSubscription?
    /// 期望订阅的会话频道（conversationId 集合）——跨重连保留，(重)连时逐个重新订阅。
    private var desiredChatConversationIds: Set<String> = []
    /// 绑定当前 client 的会话频道订阅；teardown 随 client 作废，desired 集合不变。
    private var chatSubscriptions: [String: CentrifugeSubscription] = [:]
    private var delegateAdapter: CentrifugoDelegateAdapter?
    private var connectTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    private var isManualDisconnect = false
    /// 标记「本类刚发起的这次连接」，用于区分我方 connect 触发的首个 `onConnecting`
    /// 与 SDK 自发重连触发的 `onConnecting`。
    private var managedConnectInFlight = false
    /// 连接代次：区分当前 client 与已废弃 client 的迟到回调（避免旧连接事件干扰状态机）。
    /// 用 Int 而非 client 引用比较，规避把非 Sendable 的 `CentrifugeClient` 跨 actor 传递。
    private var connectionGeneration = 0
    private var reconnectAttempt = 0

    /// 后端 connect proxy 对 token/session 失效返回的 disconnect code（重连需强制刷新 token）。
    private static let tokenFailureCodes: Set<UInt32> = [4001, 4002, 4003, 4004, 4005, 4007, 4008, 4009]

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "CentrifugoClient")

    init(
        tokenProvider: @escaping @Sendable (_ forceRefresh: Bool) async -> String? = { forceRefresh in
            if case let .ready(credential) = await APIClient.shared.embeddedWebCredential(forceRefresh: forceRefresh) {
                return credential.accessToken
            }
            return nil
        },
        userIdProvider: @escaping @Sendable () async -> String? = {
            await MainActor.run { AuthService.shared.currentUser?.id }
        }
    ) {
        self.tokenProvider = tokenProvider
        self.userIdProvider = userIdProvider
    }

    nonisolated static func personalChannel(userId: String) -> String {
        "personal:\(userId)"
    }

    nonisolated static func chatChannel(conversationId: String) -> String {
        "chat:\(conversationId)"
    }

    nonisolated static func chatConversationId(channel: String) -> String? {
        guard channel.hasPrefix(chatChannelPrefix) else { return nil }
        let conversationId = String(channel.dropFirst(chatChannelPrefix.count))
        return conversationId.isEmpty ? nil : conversationId
    }

    nonisolated static func subscriptionAvailability(
        channel: String
    ) -> CentrifugoSubscriptionAvailability? {
        if let conversationId = chatConversationId(channel: channel) {
            return .chat(conversationId: conversationId)
        }
        let personalPrefix = personalChannel(userId: "")
        guard channel.hasPrefix(personalPrefix) else { return nil }
        let userId = String(channel.dropFirst(personalPrefix.count))
        return userId.isEmpty ? nil : .personal
    }

    nonisolated static func reconnectDelay(attempt: Int) -> Double {
        min(20.0, 0.5 * pow(1.5, Double(max(0, attempt - 1))))
    }

    /// 频道前缀，供 publication 按频道路由（personal vs chat）。
    private nonisolated static let chatChannelPrefix = "chat:"

    // MARK: - Connect data（对齐后端 Connect Proxy 的 data.token 契约）

    /// 构造 Connect 请求携带的 data —— 后端 centrifugo_proxy 只从 `data.token` 读凭据，
    /// SDK 的 protocol token（`config.token`）后端不读，故凭据必须走 data。
    nonisolated static func makeConnectData(token: String) -> Data? {
        try? JSONSerialization.data(withJSONObject: ["token": token])
    }

    /// 解析本次连接应携带的 data：每次都重新取 token（可强刷），保证（重）连不带过期 token。
    func resolveConnectData(forceRefresh: Bool) async -> Data? {
        guard let token = await tokenProvider(forceRefresh) else { return nil }
        return Self.makeConnectData(token: token)
    }

    /// 解析本次连接应订阅的用户 id（当前登录用户）。personal 频道只订本人，userId 由本类内部
    /// 从鉴权态解析，不接受外部传入——防越权订阅他人频道。
    func resolveUserId() async -> String? {
        await userIdProvider()
    }

    // MARK: - 生命周期

    /// 连接并订阅**当前登录用户**的个人频道。userId 由本类从鉴权态内部解析，不接受外部传入
    /// （防越权订阅他人频道）。重复调用（已在连接/重连/已连）直接忽略。
    func connect() {
        DiagnosticRecorder.captureWebSocket(channel: "centrifugo", phase: "connect")
        guard connectTask == nil, reconnectTask == nil, client == nil else { return }
        isManualDisconnect = false
        reconnectAttempt = 0
        connectTask = Task { @MainActor [weak self] in
            await self?.establishConnection(forceRefresh: false)
            self?.connectTask = nil
        }
    }

    func disconnect() {
        DiagnosticRecorder.captureWebSocket(channel: "centrifugo", phase: "close", result: "manual")
        isManualDisconnect = true
        connectTask?.cancel(); connectTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
        teardownClient()
        desiredChatConversationIds.removeAll()
        chatPublicationListeners.removeAll()
        chatConnectionAvailableListeners.removeAll()
        state = .disconnected
    }

    func setChatPublicationListener(
        conversationId: String,
        listener: (@MainActor (Data) -> Void)?
    ) {
        guard !conversationId.isEmpty else { return }
        chatPublicationListeners[conversationId] = listener
    }

    func setChatConnectionAvailableListener(
        conversationId: String,
        listener: (@MainActor () -> Void)?
    ) {
        guard !conversationId.isEmpty else { return }
        chatConnectionAvailableListeners[conversationId] = listener
    }

    /// 进入会话详情：订阅该会话的 `chat:{conv}` 频道。已连接则立即订阅，否则记录待订、
    /// 下次（重）连时一并订阅。重复订阅同一会话是幂等的。
    func subscribeChat(conversationId: String) {
        guard !conversationId.isEmpty else { return }
        DiagnosticRecorder.captureWebSocket(channel: "centrifugo", phase: "subscribe", messageType: "chat")
        desiredChatConversationIds.insert(conversationId)
        installChatSubscription(conversationId: conversationId)
    }

    /// 向 `chat:{conv}` publish 一条负载（typing 用）。后端 publish proxy 白名单只放行
    /// `im.typing`，且要求 subscriber 是会话成员；未订阅该会话 / 未连接则静默丢弃（typing
    /// 是尽力而为的提示，丢了无副作用）。
    ///
    /// SwiftCentrifuge 的 publish completion 在 client `syncQueue` 回调；completion 必须在
    /// **nonisolated** 上下文创建，否则 Swift 6 会给 closure 标 @MainActor，后台回调即崩。
    func publishToChat(conversationId: String, payload: [String: Any]) {
        guard let sub = chatSubscriptions[conversationId] else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "send",
            messageType: "im.typing",
            payloadBytes: data.count
        )
        Self.performChatPublish(sub: sub, conversationId: conversationId, data: data)
    }

    /// 在 nonisolated 上下文发起 publish，保证 SDK 后台 completion 不会踩 MainActor 断言。
    private nonisolated static func performChatPublish(
        sub: CentrifugeSubscription,
        conversationId: String,
        data: Data
    ) {
        sub.publish(data: data) { result in
            if case let .failure(error) = result {
                logChatPublishFailure(conversationId: conversationId, error: error)
            }
        }
    }

    /// 非 MainActor、不捕获 `self`——供 Centrifugo SDK 后台 queue 回调安全打日志。
    private nonisolated static func logChatPublishFailure(conversationId: String, error: Error) {
        Logger(subsystem: "com.tabtin.mobile", category: "CentrifugoClient")
            .debug("chat publish failed conv=\(conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
    }

    /// 退出会话详情：退订并移除该会话频道（保留连接与 personal 订阅）。
    func unsubscribeChat(conversationId: String) {
        DiagnosticRecorder.captureWebSocket(channel: "centrifugo", phase: "unsubscribe", messageType: "chat")
        desiredChatConversationIds.remove(conversationId)
        guard let sub = chatSubscriptions.removeValue(forKey: conversationId) else { return }
        sub.unsubscribe()
        client?.removeSubscription(sub)
    }

    /// 在当前 client 上创建并订阅一个会话频道（幂等：无 client / 已存在则跳过）。
    private func installChatSubscription(conversationId: String) {
        guard let client, let adapter = delegateAdapter, chatSubscriptions[conversationId] == nil else { return }
        do {
            let sub = try client.newSubscription(
                channel: Self.chatChannel(conversationId: conversationId),
                delegate: adapter
            )
            chatSubscriptions[conversationId] = sub
            sub.subscribe()
        } catch {
            logger.error("chat subscription failed conv=\(conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    private func establishConnection(forceRefresh: Bool) async {
        guard !isManualDisconnect else { return }
        state = .connecting

        // personal 频道只订阅当前登录用户——每次（重）连都重取，用户切换后自然指向新用户。
        guard let userId = await resolveUserId() else {
            logger.warning("no authenticated user; scheduling reconnect")
            scheduleCredentialRetry(forceRefresh: false)
            return
        }
        guard !isManualDisconnect else { return }

        guard let data = await resolveConnectData(forceRefresh: forceRefresh) else {
            logger.warning("no access token available; scheduling reconnect")
            scheduleCredentialRetry(forceRefresh: true)
            return
        }
        guard !isManualDisconnect else { return }

        teardownClient()  // 换 client 前拆旧的；旧 client 的迟到事件由 generation 挡掉

        connectionGeneration += 1
        let generation = connectionGeneration
        let adapter = CentrifugoDelegateAdapter(owner: self, generation: generation)
        delegateAdapter = adapter

        // 不设 token/tokenGetter：后端不读 protocol token，凭据只走 data。
        // 使用系统 URLSessionWebSocketTask，避开 SwiftCentrifuge 旧 Starscream/CFStream
        // 在断开重连时可能与已排队的 stream event 发生释放竞态。
        let config = CentrifugeClientConfig(data: data, useNativeWebSocket: true)
        let centrifuge = CentrifugeClient(
            endpoint: AppConfig.centrifugoWSURL,
            config: config,
            delegate: adapter
        )
        client = centrifuge

        do {
            let sub = try centrifuge.newSubscription(
                channel: Self.personalChannel(userId: userId),
                delegate: adapter
            )
            personalSubscription = sub
            sub.subscribe()
        } catch {
            logger.error("personal subscription failed: \(String(describing: error), privacy: .public)")
        }

        // 重新订阅进入过、尚未退出的会话频道（跨重连恢复）。
        for conversationId in desiredChatConversationIds {
            installChatSubscription(conversationId: conversationId)
        }

        managedConnectInFlight = true
        centrifuge.connect()
    }

    /// 登录恢复与 token 单飞存在短暂窗口时，凭据可能暂时取不到。这不是手动断开，不能
    /// 把连接永久留在 disconnected；继续走同一套有上限退避，凭据恢复后自动追平目录。
    private func scheduleCredentialRetry(forceRefresh: Bool) {
        state = .disconnected
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "reconnect_scheduled",
            result: "credential_unavailable",
            attempt: reconnectAttempt + 1
        )
        scheduleReconnect(forceRefresh: forceRefresh)
    }

    /// 拆掉当前 client 并使其后续回调失效（递增 generation）。幂等。
    private func teardownClient() {
        connectionGeneration += 1
        personalSubscription = nil
        chatSubscriptions.removeAll()  // 订阅绑定旧 client；desired 集合保留供重连恢复
        let old = client
        client = nil
        delegateAdapter = nil
        old?.disconnect()  // 触发的 onDisconnected 带旧 generation，会被守卫挡掉
    }

    /// 持续自管重连；退避封顶后保持低频尝试，网络恢复时无需用户重启 App。
    private func scheduleReconnect(forceRefresh: Bool) {
        guard !isManualDisconnect, reconnectTask == nil else { return }
        teardownClient()  // 打断 SDK 自身的自动重连（它会用旧静态 data）
        reconnectAttempt += 1
        let delay = Self.reconnectDelay(attempt: reconnectAttempt)
        state = .connecting
        let attempt = reconnectAttempt
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, !self.isManualDisconnect else { return }
            self.reconnectTask = nil
            self.logger.info("Centrifugo reconnect attempt \(attempt)")
            await self.establishConnection(forceRefresh: forceRefresh)
        }
    }

    // MARK: - Adapter 回调（均带 generation，MainActor 执行）

    fileprivate func handleConnected(generation: Int) {
        guard generation == connectionGeneration else { return }
        managedConnectInFlight = false
        reconnectAttempt = 0
        state = .connected
        DiagnosticRecorder.captureWebSocket(channel: "centrifugo", phase: "open", result: "succeeded")
        logger.info("Centrifugo connected")
    }

    fileprivate func handleConnecting(generation: Int, code: UInt32, reason: String) {
        guard generation == connectionGeneration else { return }
        if managedConnectInFlight {
            // 本类刚发起的这次连接正常进入 connecting。
            managedConnectInFlight = false
            state = .connecting
            return
        }
        // 连过之后 SDK 想自己重连（会带旧静态 data）→ 完全接管。
        logger.info("intercept SDK auto-reconnect code=\(code) reason=\(reason, privacy: .public)")
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "reconnect_scheduled",
            closeCode: Int(code),
            attempt: reconnectAttempt + 1
        )
        scheduleReconnect(forceRefresh: Self.tokenFailureCodes.contains(code))
    }

    fileprivate func handleDisconnected(generation: Int, code: UInt32, reason: String) {
        guard generation == connectionGeneration else { return }
        logger.info("Centrifugo disconnected code=\(code) reason=\(reason, privacy: .public)")
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "close",
            result: isManualDisconnect ? "manual" : "unexpected",
            closeCode: Int(code)
        )
        if isManualDisconnect {
            state = .disconnected
            return
        }
        // server terminal 断开（reconnect=false）→ 自管重连。
        scheduleReconnect(forceRefresh: Self.tokenFailureCodes.contains(code))
    }

    fileprivate func handleError(generation: Int, message: String) {
        guard generation == connectionGeneration else { return }
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "error",
            result: "failed",
            errorClass: "CentrifugoError"
        )
        logger.error("Centrifugo error: \(message, privacy: .public)")
    }

    fileprivate func handleSubscribed(generation: Int, channel: String) {
        guard generation == connectionGeneration else { return }
        guard let availability = Self.subscriptionAvailability(channel: channel) else { return }
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "subscribed",
            messageType: availability == .personal ? "personal" : "chat",
            result: "succeeded"
        )
        logger.info("Centrifugo subscribed: \(channel, privacy: .public)")
        switch availability {
        case .personal:
            connectionAvailableListener?()
        case let .chat(conversationId):
            chatConnectionAvailableListeners[conversationId]?()
        }
    }

    /// 按频道路由 publication：`chat:{conv}` → 会话回调（带 conversationId）；其余（personal）
    /// → personal 回调。原始 bytes 透传，解析交给 `IMEventDecoder`。
    fileprivate func handlePublication(generation: Int, channel: String, data: Data) {
        guard generation == connectionGeneration else { return }
        DiagnosticRecorder.captureWebSocket(
            channel: "centrifugo",
            phase: "receive",
            messageType: channel.hasPrefix(Self.chatChannelPrefix) ? "chat_publication" : "personal_publication",
            payloadBytes: data.count,
            result: "succeeded"
        )
        if channel.hasPrefix(Self.chatChannelPrefix) {
            let conversationId = String(channel.dropFirst(Self.chatChannelPrefix.count))
            chatPublicationListeners[conversationId]?(data)
            onChatPublication?(conversationId, data)
        } else {
            personalPublicationListener?(data)
        }
    }
}

extension CentrifugoClient: IMPersonalRealtimeSource {
    func setPersonalPublicationListener(_ listener: (@MainActor (Data) -> Void)?) {
        personalPublicationListener = listener
    }

    func setConnectionAvailableListener(_ listener: (@MainActor () -> Void)?) {
        connectionAvailableListener = listener
    }
}

/// SDK delegate 在自身 syncQueue（非主线程）回调；本 adapter 把事件带 `generation` 统一 hop
/// 到 MainActor 交给 `CentrifugoClient`，隔离 SDK 线程模型与 `@Observable` 状态。
/// 每次重建 client 都新建一个 adapter（带新 generation），旧 adapter 的迟到回调因 generation
/// 不匹配被 owner 忽略。
final class CentrifugoDelegateAdapter: CentrifugeClientDelegate, CentrifugeSubscriptionDelegate, @unchecked Sendable {
    weak var owner: CentrifugoClient?
    let generation: Int

    init(owner: CentrifugoClient, generation: Int) {
        self.owner = owner
        self.generation = generation
    }

    // MARK: CentrifugeClientDelegate

    func onConnected(_ client: CentrifugeClient, _ event: CentrifugeConnectedEvent) {
        let gen = generation
        Task { @MainActor [weak owner] in owner?.handleConnected(generation: gen) }
    }

    func onConnecting(_ client: CentrifugeClient, _ event: CentrifugeConnectingEvent) {
        let gen = generation
        let code = event.code
        let reason = event.reason
        Task { @MainActor [weak owner] in owner?.handleConnecting(generation: gen, code: code, reason: reason) }
    }

    func onDisconnected(_ client: CentrifugeClient, _ event: CentrifugeDisconnectedEvent) {
        let gen = generation
        let code = event.code
        let reason = event.reason
        Task { @MainActor [weak owner] in owner?.handleDisconnected(generation: gen, code: code, reason: reason) }
    }

    func onError(_ client: CentrifugeClient, _ event: CentrifugeErrorEvent) {
        let gen = generation
        let message = event.error.localizedDescription
        Task { @MainActor [weak owner] in owner?.handleError(generation: gen, message: message) }
    }

    // MARK: CentrifugeSubscriptionDelegate

    func onSubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscribedEvent) {
        let gen = generation
        let channel = sub.channel
        Task { @MainActor [weak owner] in owner?.handleSubscribed(generation: gen, channel: channel) }
    }

    func onError(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscriptionErrorEvent) {
        let gen = generation
        let message = event.error.localizedDescription
        Task { @MainActor [weak owner] in owner?.handleError(generation: gen, message: message) }
    }

    func onPublication(_ sub: CentrifugeSubscription, _ event: CentrifugePublicationEvent) {
        let gen = generation
        let channel = sub.channel
        let data = event.data
        Task { @MainActor [weak owner] in owner?.handlePublication(generation: gen, channel: channel, data: data) }
    }
}
