import Foundation
import os

/// 单条 WS Gateway 连接（role=mobile，纯聊天/观测端）。Phase 0 骨架。
///
/// 职责：连接生命周期、`auth` 握手、`subscribe` 同步、收包循环、心跳、指数退避重连。
/// 下行 envelope 通过 `onEnvelope` 抛给上层（StreamManager / billing / tracker 消费方随后续 Phase 落）。
///
/// **D5 边界**：mobile 不注册为可被控设备，不订阅 `agent.action.*` / `device.*`，
/// capabilities 收敛为聊天/观测类（agent.stream / billing.events / tracker.events …）。
///
/// **续传（Phase 问题3-A）**：跟踪 `lastEventId`（Redis Stream event_id，过 StreamEventIdValidator
/// + ms 时间戳语义检查），重连 / 冷启动 auth.ok 后发 `resume {last_event_id}` 回补 buffer 错过的事件，
/// 处理 `resume.ok` 的 next_cursor 分页与 `connection.resume_hint`。cursor 持久化到 UserDefaults，
/// 显式 disconnect（登出/切团队）时清空。刻意不含 HITL ack 登记表、billing 解析——随对应 Phase 落地。
///
/// P2.1b 起补「请求-应答」能力：`sendRequest` 按 `request_id` 单飞关联 ok/nak/error，
/// `ensureConnected` / `subscribeAndWait` 供 ConversationViewModel 发消息前的连接/订阅前置。

/// 请求-应答结果（移植自 tabtin-ios WebSocketService.AckResult，按 request_id 关联）。
/// ok 的 payload 用 `[String: AnyCodable]`（AnyCodable 为 @unchecked Sendable），整体 Sendable，
/// 可安全经 CheckedContinuation 跨挂起点 resume。调用方用 `["k"]?.stringValue` 等取值。
enum AckResult: Sendable {
    case ok(payload: [String: AnyCodable])
    case nak(
        code: String,
        message: String,
        category: String?,
        retryable: Bool,
        delivery: String?,
        executionState: String?,
        messageId: String?,
        clientEventId: String?
    )
    case timeout
    case disconnected
}

struct NakEnvelopeFields: Equatable {
    let code: String
    let message: String
    let category: String?
    let retryable: Bool
    let delivery: String?
    let executionState: String?
    let messageId: String?
    let clientEventId: String?
}

@MainActor @Observable
final class RealtimeGateway {
    static let shared = RealtimeGateway()

    private(set) var state: WSConnectionState = .disconnected

    struct Credentials: Sendable {
        let accessToken: String
        let organizationId: String
        let deviceId: String
        /// mobile 能力白名单（聊天/观测）。D5：不含 device.* / agent.action.* 被控能力。
        let capabilities: [String]
    }

    /// Phase 1 Auth 注入：提供连接凭据；返回 nil 表示未登录 → 不连接。
    var credentialsProvider: (@MainActor () -> Credentials?)?
    /// 下行 envelope 多监听者（按 key 注册）：聊天流 runner、会话旁观者（观察者镜像）等可并存。
    /// 旧的单回调 `onEnvelope` 改为 keyed listeners——同一会话「主动发送（runner）」与
    /// 「被动旁观（observer）」需同时收同一份下行（对齐旧 iOS onEnvelope(key:) / Electron addListener）。
    private var envelopeListeners: [String: @MainActor (WSEnvelope) -> Void] = [:]

    /// 注册下行监听者（同 key 覆盖）。dispatch 顺序无关：各监听者相互独立、自行去重/过滤。
    func addEnvelopeListener(key: String, _ handler: @escaping @MainActor (WSEnvelope) -> Void) {
        envelopeListeners[key] = handler
    }

    func removeEnvelopeListener(key: String) {
        envelopeListeners.removeValue(forKey: key)
    }

    private func dispatchEnvelope(_ env: WSEnvelope) {
        for handler in envelopeListeners.values { handler(env) }
    }
    /// 连接断开、进入重连时触发（每次 scheduleReconnect 都会调，消费方需自去重）。
    /// 供 ConversationViewModel 在流进行中挂起超时、提示「重连中」。
    var onConnectionDropped: (@MainActor () -> Void)?
    /// 重连并重新 auth.ok 成功时触发（仅重连路径，首次连接不触发）。
    var onReconnected: (@MainActor () -> Void)?
    private var reconnectListeners: [String: @MainActor () -> Void] = [:]

    func addReconnectListener(key: String, _ handler: @escaping @MainActor () -> Void) {
        reconnectListeners[key] = handler
    }

    func removeReconnectListener(key: String) {
        reconnectListeners.removeValue(forKey: key)
    }

    private func dispatchReconnected() {
        onReconnected?()
        for handler in reconnectListeners.values { handler() }
    }

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "Realtime")
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveLoop: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var authTimeoutTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    private var isAuthenticated = false
    private var deviceId = ""
    private var organizationId = ""
    private var desiredTopics: Set<String> = []
    private var desiredTopicContexts: [String: [String: Any]] = [:]
    private var subscribedTopics: Set<String> = []
    private var deferredUnsubscribeTasks: [String: Task<Void, Never>] = [:]
    private var reconnectAttempt = 0
    /// 后台挂起态：socket 主动关闭但 cursor / desiredTopics 保留，前台恢复时按「重连」续上。
    private var suspendedForBackground = false
    private var backgroundSuspendTask: Task<Void, Never>?
    /// 进入后台后宽限多久才真正断开（避免快速切换 App 误断）。前台在此之前回来则取消。
    private let backgroundGraceSeconds: TimeInterval = 30

    // MARK: resume / 续传 cursor（Redis Stream event_id，非 _seq）
    /// 最近收到的合法 stream event_id（`<ms>-<n>` 形态）。重连 / 冷启动后作为 resume cursor
    /// 让后端从 Redis Stream buffer 回补订阅期间错过的事件（buffer 上限 5000 条 / 1h）。
    private var lastEventId: String?
    /// resume.ok 分页轮次，防 next_cursor 死循环。
    private var resumePaginationCount = 0
    private var lastCursorPersistAt: Date = .distantPast

    // MARK: 请求-应答 / 连接 / 订阅 等待登记表（均仅 @MainActor 读写）

    private struct PendingAck {
        let okType: String
        let nakType: String
        let continuation: CheckedContinuation<AckResult, Never>
        let timeoutTask: Task<Void, Never>
    }
    /// key = 完整 request_id（UUID）。single-fire：removeValue 抢占成功者负责 resume。
    private var pendingAcks: [String: PendingAck] = [:]
    /// key = 一次性 waitId。auth.ok / 断连 / 超时三方竞争 removeValue。
    private var pendingConnections: [String: CheckedContinuation<Bool, Never>] = [:]
    /// key = topics.sorted().joined(",")。subscribe.ok / 断连 / 超时竞争。
    private var pendingSubscriptions: [String: CheckedContinuation<Bool, Never>] = [:]
    /// subscribe request_id → topic 集合 key，用于 error 回包即时结束等待。
    private var subscriptionRequestKeys: [String: String] = [:]
    private var subscriptionTimeouts: [String: Task<Void, Never>] = [:]

    private let pingInterval: TimeInterval = 40
    /// 对齐 Electron `ws-gateway-client`：出站空闲超过此时长才发应用层 ping。
    private let healthCheckInterval: TimeInterval = 10
    private let outboundPingInterval: TimeInterval = 50
    private var lastOutboundAt = Date()
    private var lastProtocolPingAt = Date()
    private let authTimeoutSeconds: TimeInterval = 14
    private let baseReconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 15
    private let reconnectFactor: Double = 1.5
    private let maxReconnectAttempts = 20
    private let maxResumePaginationRounds = 10
    private let cursorPersistThrottle: TimeInterval = 1.5
    private let lastEventIdDefaultsKey = "tabtin.ws.lastEventId"

    private init() { restoreCursor() }

    // MARK: - Public API

    func connect() {
        guard state == .disconnected || state == .reconnectGaveUp else { return }
        reconnectAttempt = 0
        performConnect()
    }

    /// 显式断开（登出 / 切团队）。区别于自动重连：会清掉 resume cursor，
    /// 因为切团队后 topic 不同、登出后会话失效，旧 cursor 已无意义。
    func disconnect() {
        DiagnosticRecorder.captureWebSocket(channel: "gateway", phase: "close", result: "manual")
        backgroundSuspendTask?.cancel()
        backgroundSuspendTask = nil
        suspendedForBackground = false
        cancelAllTasks()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isAuthenticated = false
        desiredTopics.removeAll()
        desiredTopicContexts.removeAll()
        subscribedTopics.removeAll()
        cancelAllDeferredUnsubscribes()
        failAllPending()
        clearCursor()
        state = .disconnected
    }

    // MARK: - App 前后台（问题3-C）

    /// 进入后台：起宽限计时，到点才真正挂起 socket（前台在此之前回来则取消，省去快速切 App 的断连）。
    /// 同时立刻上报 app_state=background——服务端据此解除推送在线抑制，
    /// 不等宽限断连 + presence TTL 过期，用户刚锁屏就能收到审批/完成推送。
    func enterBackground() {
        notifyAppState("background")
        backgroundSuspendTask?.cancel()
        let grace = backgroundGraceSeconds
        backgroundSuspendTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(grace))
            guard let self, !Task.isCancelled else { return }
            self.performBackgroundSuspend()
        }
    }

    /// 回到前台：取消挂起计时；若已断开则恢复连接，并按「重连」语义触发，
    /// 让进行中会话的 runner 收到 onReconnected 续上（auth.ok 后 resume 自动补错过的事件）。
    func enterForeground() {
        backgroundSuspendTask?.cancel()
        backgroundSuspendTask = nil
        guard credentialsProvider?() != nil else { return }
        let wasBackgroundSuspended = suspendedForBackground
        suspendedForBackground = false
        switch state {
        case .disconnected, .reconnectGaveUp:
            if wasBackgroundSuspended { reconnectAttempt = max(reconnectAttempt, 1) }
            performConnect()
        default:
            // 仍连着：宽限窗口内快速切回，socket 没断——补一帧 foreground 恢复推送在线抑制。
            // （重连路径不用发：服务端 auth 成功即标记前台。）
            notifyAppState("foreground")
        }
    }

    /// 上报前后台状态（ 推送在线抑制）。未认证时静默丢弃（服务端 auth 即标记前台）。
    private func notifyAppState(_ appState: String) {
        notify(type: "app_state", payload: ["state": appState])
    }

    /// 后台挂起：关 socket、清认证态，但**保留 cursor / desiredTopics**（区别于登出 disconnect）。
    private func performBackgroundSuspend() {
        suspendedForBackground = true
        guard state != .disconnected else { return }
        cancelAllTasks()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isAuthenticated = false
        subscribedTopics.removeAll()
        failAllPending()
        state = .disconnected
        // 通知进行中会话的 runner 进入 interrupted（其重连窗口在后台被系统冻结，不会误杀）。
        onConnectionDropped?()
    }

    /// 声明式订阅：累加期望 topic，已认证则立即同步。
    func subscribe(_ topics: [String], topicContexts: [String: [String: Any]] = [:]) {
        cancelDeferredUnsubscribe(topics)
        desiredTopics.formUnion(topics)
        for topic in topics {
            if let context = topicContexts[topic] { desiredTopicContexts[topic] = context }
        }
        if isAuthenticated { syncSubscriptions() }
    }

    func unsubscribe(_ topics: [String]) {
        cancelDeferredUnsubscribe(topics)
        desiredTopics.subtract(topics)
        for topic in topics { desiredTopicContexts.removeValue(forKey: topic) }
        guard isAuthenticated, !topics.isEmpty else { return }
        send(WSEnvelope.build(type: "unsubscribe", deviceId: deviceId,
                              payload: ["topics": topics], organizationId: organizationId))
        subscribedTopics.subtract(topics)
    }

    func unsubscribeAfterDelay(_ topics: [String], delay: Duration) {
        for topic in topics where !topic.isEmpty {
            deferredUnsubscribeTasks.removeValue(forKey: topic)?.cancel()
            deferredUnsubscribeTasks[topic] = Task { @MainActor [weak self] in
                try? await Task.sleep(for: delay)
                guard let self, !Task.isCancelled else { return }
                self.deferredUnsubscribeTasks.removeValue(forKey: topic)
                self.unsubscribe([topic])
            }
        }
    }

    /// 即发即忘上行（不等回包）。未认证时静默丢弃。用于 chat.cancel 这类尽力而为的通知。
    func notify(type: String, payload: [String: Any], threadId: String? = nil) {
        guard isAuthenticated else { return }
        send(WSEnvelope.build(type: type, deviceId: deviceId, payload: payload,
                              organizationId: organizationId, threadId: threadId))
    }

    /// 发送 ASR 流式消息。ASR 走同一条 Gateway 连接，但不复用聊天 request/ack 管线。
    func sendASR(_ envelope: WSEnvelope) {
        guard envelope.type.hasPrefix("asr.stream.") else {
            logger.warning("sendASR rejected non-ASR envelope type: \(envelope.type)")
            return
        }
        guard isAuthenticated else {
            logger.warning("sendASR dropped: realtime gateway is not authenticated")
            return
        }
        send(envelope)
    }

    // MARK: - Request / Await（供 ConversationViewModel 编排发消息）

    /// 确保已连接并认证。已连接立即返回 true；否则触发连接并等待 auth.ok / 超时。
    func ensureConnected(timeout: TimeInterval = 15) async -> Bool {
        if state == .connected { return true }
        if state == .disconnected || state == .reconnectGaveUp { connect() }

        let waitId = UUID().uuidString
        return await withCheckedContinuation { continuation in
            pendingConnections[waitId] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard let self else { return }
                if let pending = self.pendingConnections.removeValue(forKey: waitId) {
                    pending.resume(returning: self.state == .connected)
                }
            }
        }
    }

    /// 订阅并等待 subscribe.ok（按 topic 集合关联）；超时/断连返回 false。
    func subscribeAndWait(
        _ topics: [String],
        topicContexts: [String: [String: Any]] = [:],
        timeout: TimeInterval = 10
    ) async -> Bool {
        let key = topics.sorted().joined(separator: ",")
        return await withCheckedContinuation { continuation in
            cancelDeferredUnsubscribe(topics)
            if let old = pendingSubscriptions.removeValue(forKey: key) {
                subscriptionTimeouts.removeValue(forKey: key)?.cancel()
                subscriptionRequestKeys = subscriptionRequestKeys.filter { $0.value != key }
                old.resume(returning: false)
            }
            pendingSubscriptions[key] = continuation
            // 强制重发 subscribe：subscribedTopics 可能已乐观登记，这里走显式 ok 确认通道。
            desiredTopics.formUnion(topics)
            for topic in topics {
                if let context = topicContexts[topic] { desiredTopicContexts[topic] = context }
            }
            let requestId = UUID().uuidString.lowercased()
            subscriptionRequestKeys[requestId] = key
            send(WSEnvelope.build(type: "subscribe", deviceId: deviceId,
                                  payload: subscriptionPayload(for: topics), organizationId: organizationId,
                                  requestId: requestId))
            subscribedTopics.formUnion(topics)

            subscriptionTimeouts[key]?.cancel()
            subscriptionTimeouts[key] = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard let self else { return }
                if let pending = self.pendingSubscriptions.removeValue(forKey: key) {
                    self.subscriptionRequestKeys = self.subscriptionRequestKeys.filter { $0.value != key }
                    self.subscriptionTimeouts.removeValue(forKey: key)
                    pending.resume(returning: false)
                }
            }
        }
    }

    /// 发上行请求并等待对应 ACK（按完整 request_id 关联）。single-fire：超时 / send 失败 /
    /// ok / nak / error 五条路径互斥，先到者抢占。返回 `.disconnected` 表示未连接或发包失败。
    func sendRequest(
        type: String,
        payload: [String: Any],
        okType: String,
        nakType: String,
        threadId: String? = nil,
        timeout: TimeInterval = 30
    ) async -> AckResult {
        guard isAuthenticated, task != nil else {
            logger.warning("sendRequest '\(type)' rejected: not connected/authenticated")
            return .disconnected
        }
        let requestId = UUID().uuidString
        let env = WSEnvelope.build(
            type: type, deviceId: deviceId, payload: payload,
            organizationId: organizationId, threadId: threadId, requestId: requestId
        )
        return await withCheckedContinuation { continuation in
            let timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard let self, !Task.isCancelled else { return }
                guard let pending = self.pendingAcks.removeValue(forKey: requestId) else { return }
                self.logger.warning("sendRequest '\(type)' timeout (\(Int(timeout))s)")
                pending.continuation.resume(returning: .timeout)
            }
            pendingAcks[requestId] = PendingAck(
                okType: okType, nakType: nakType,
                continuation: continuation, timeoutTask: timeoutTask
            )
            send(env) { [weak self] error in
                guard error != nil else { return }
                Task { @MainActor in
                    guard let self,
                          let pending = self.pendingAcks.removeValue(forKey: requestId) else { return }
                    pending.timeoutTask.cancel()
                    self.logger.warning("sendRequest '\(type)' send failed")
                    pending.continuation.resume(returning: .disconnected)
                }
            }
        }
    }

    // MARK: - Connect

    private func performConnect() {
        cancelAllTasks()

        guard let creds = credentialsProvider?() else {
            logger.info("No credentials; staying disconnected")
            state = .disconnected
            return
        }
        let wsBaseURL = AppConfig.wsBaseURL
        guard let url = URL(string: wsBaseURL) else {
            logger.error("Invalid WS URL: \(wsBaseURL)")
            state = .disconnected
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host ?? ""
        let testWSHost = URL(string: AppConfig.testWSBaseURL)?.host
        let allowCleartext = AppConfig.allowsLocalCleartextNetworking
            || ["localhost", "127.0.0.1"].contains(host)
            || host == testWSHost
            || DebugEnvironmentStore.preset == .custom
        guard scheme == "wss" || (scheme == "ws" && allowCleartext) else {
            logger.error("Refused non-TLS WebSocket URL: \(wsBaseURL)")
            state = .disconnected
            return
        }

        deviceId = creds.deviceId
        organizationId = creds.organizationId
        isAuthenticated = false
        subscribedTopics.removeAll()
        state = reconnectAttempt > 0 ? .reconnecting(attempt: reconnectAttempt) : .connecting
        DiagnosticRecorder.captureWebSocket(
            channel: "gateway",
            phase: "connect",
            attempt: reconnectAttempt
        )

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        DebugTools.instrument(config)
        let session = URLSession(configuration: config)
        self.session = session

        var request = URLRequest(url: url)
        request.addValue("Bearer \(creds.accessToken)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        startReceiveLoop(on: task)
        sendAuth(creds)
        startAuthTimeout()
        logger.info("Connecting to gateway (role=mobile)")
    }

    private func sendAuth(_ creds: Credentials) {
        state = .authenticating
        let env = WSEnvelope.build(
            type: "auth",
            deviceId: creds.deviceId,
            payload: [
                "access_token": creds.accessToken,
                "organization_id": creds.organizationId,
                "capabilities": creds.capabilities,
            ],
            organizationId: creds.organizationId
        )
        send(env)
    }

    private func startAuthTimeout() {
        authTimeoutTask?.cancel()
        let timeout = authTimeoutSeconds
        authTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            guard let self, !Task.isCancelled else { return }
            if !self.isAuthenticated {
                self.logger.warning("Auth timeout, reconnecting")
                self.scheduleReconnect()
            }
        }
    }

    // MARK: - Receive

    private func startReceiveLoop(on task: URLSessionWebSocketTask) {
        receiveLoop?.cancel()
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self, !Task.isCancelled else { return }
                    self.handle(message)
                } catch {
                    guard let self, !Task.isCancelled else { return }
                    DiagnosticRecorder.captureWebSocket(
                        channel: "gateway",
                        phase: "failure",
                        result: "failed",
                        errorClass: String(describing: type(of: error))
                    )
                    self.logger.warning("receive error: \(error.localizedDescription)")
                    self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        guard let env = try? JSONDecoder().decode(WSEnvelope.self, from: data) else {
            DiagnosticRecorder.captureWebSocket(
                channel: "gateway",
                phase: "receive",
                messageType: "invalid_envelope",
                payloadBytes: data.count,
                result: "decode_failed"
            )
            logger.warning("undecodable envelope dropped")
            return
        }
        DiagnosticRecorder.captureWebSocket(
            channel: "gateway",
            phase: "receive",
            messageType: env.type,
            payloadBytes: data.count,
            result: "succeeded"
        )
        routeEnvelope(env)
    }

    private func routeEnvelope(_ env: WSEnvelope) {
        // 续传 cursor 追踪：任何带合法 stream event_id 的下行都推进 lastEventId（含 resume 回放的事件）。
        trackEventId(env)

        // P2.1b：先匹配 pending ack（按 request_id）。命中 ok/nak/error → 吞掉，
        // 不下沉到 onEnvelope，避免 chat.send_message.ok 这类回包污染上层 stream 流。
        if matchPendingAck(env) { return }

        defer { releaseDeferredSubscriptionIfTerminal(env) }

        switch env.type {
        case "auth.ok":
            // reconnectAttempt 在重置前判断本次是否为重连路径（首次连接为 0）。
            let wasReconnect = reconnectAttempt > 0
            isAuthenticated = true
            reconnectAttempt = 0
            authTimeoutTask?.cancel()
            state = .connected
            DiagnosticRecorder.captureWebSocket(channel: "gateway", phase: "open", result: "succeeded")
            startHeartbeat()
            resolveConnections(true)
            if ConversationRecoveryPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect: wasReconnect,
                hasDesiredTopics: !desiredTopics.isEmpty
            ) {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    let topics = Array(self.desiredTopics)
                    if !topics.isEmpty {
                        _ = await self.subscribeAndWait(topics)
                    }
                    self.maybeSendResume()
                    self.dispatchReconnected()
                }
            } else {
                syncSubscriptions()
                // 有 cursor 即续传：重连补订阅期间错过的事件；冷启动有持久化 cursor 时同样回补。
                maybeSendResume()
                if wasReconnect { dispatchReconnected() }
            }
        case "auth.revoke":
            logger.warning("auth revoked by server")
            // Phase 1：接入 onAuthFailed 触发重新登录；Phase 0 先断开。
            disconnect()
            state = .authFailed
        case "subscribe.ok":
            resolveSubscribeOk(env)
            dispatchEnvelope(env)
        case "error":
            if resolveSubscribeError(env) { return }
            dispatchEnvelope(env)
        case "resume.ok":
            handleResumeOk(env)
        case "connection.resume_hint":
            // 后端 channel layer 恢复广播，提示客户端主动 resume（带 jitter 削峰）。
            scheduleResumeHint()
        default:
            dispatchEnvelope(env)
        }
    }

    // MARK: - Resume / 续传

    /// 推进续传 cursor：仅接受合法 Redis Stream event_id（过 StreamEventIdValidator + ms 时间戳语义检查）。
    private func trackEventId(_ env: WSEnvelope) {
        guard let id = env.eventId, isPersistableCursor(id) else { return }
        lastEventId = id
        persistCursorThrottled(id)
    }

    /// 合法续传 cursor：`<digits>-<digits>` 且 head ≥ 13 位（ms 时间戳形态），
    /// 防 `evt_*` 老协议或 `0-0` 这类语义可疑值触发后端 replay=0 静默失效 / replay storm。
    private func isPersistableCursor(_ id: String) -> Bool {
        guard StreamEventIdValidator.isStreamEventId(id) else { return false }
        let head = id.prefix(while: { $0 != "-" })
        return head.count >= 13
    }

    private func maybeSendResume() {
        guard let cursor = lastEventId, isPersistableCursor(cursor) else { return }
        resumePaginationCount = 0
        sendResume(cursor)
    }

    private func sendResume(_ cursor: String) {
        send(WSEnvelope.build(type: "resume", deviceId: deviceId,
                              payload: ["last_event_id": cursor], organizationId: organizationId))
    }

    /// resume.ok：后端单轮最多回放 500 条，带 next_cursor 表示还有更多 → 继续分页拉取（≤10 轮）。
    private func handleResumeOk(_ env: WSEnvelope) {
        guard let next = env.payloadString("next_cursor"), isPersistableCursor(next) else {
            resumePaginationCount = 0
            return
        }
        guard resumePaginationCount < maxResumePaginationRounds else {
            logger.warning("resume pagination hit cap (\(self.maxResumePaginationRounds)); 剩余靠 HTTP 兜底")
            resumePaginationCount = 0
            return
        }
        resumePaginationCount += 1
        sendResume(next)
    }

    private func scheduleResumeHint() {
        guard let cursor = lastEventId, isPersistableCursor(cursor) else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int.random(in: 0...2000)))
            guard let self, self.state == .connected else { return }
            self.resumePaginationCount = 0
            self.sendResume(cursor)
        }
    }

    // MARK: cursor 持久化（冷启动续传）

    private func persistCursorThrottled(_ id: String) {
        let now = Date()
        guard now.timeIntervalSince(lastCursorPersistAt) >= cursorPersistThrottle else { return }
        lastCursorPersistAt = now
        UserDefaults.standard.set(id, forKey: lastEventIdDefaultsKey)
    }

    private func restoreCursor() {
        guard let id = UserDefaults.standard.string(forKey: lastEventIdDefaultsKey),
              isPersistableCursor(id) else { return }
        lastEventId = id
    }

    private func clearCursor() {
        lastEventId = nil
        resumePaginationCount = 0
        lastCursorPersistAt = .distantPast
        UserDefaults.standard.removeObject(forKey: lastEventIdDefaultsKey)
    }

    /// 返回 true 表示已被 pending ack 消费，调用方 return 不再继续路由。
    private func matchPendingAck(_ env: WSEnvelope) -> Bool {
        guard let pending = pendingAcks[env.requestId] else { return false }
        let isError = env.type == "error"
        let isOk = env.type == pending.okType
        let isNak = env.type == pending.nakType
        guard isOk || isNak || isError else { return false }

        // single-fire：removeValue 抢占归属，timeout task 同时尝试时只有先到一方拿到 pending。
        guard let claimed = pendingAcks.removeValue(forKey: env.requestId) else { return false }
        claimed.timeoutTask.cancel()

        if isOk {
            claimed.continuation.resume(returning: .ok(payload: env.payload))
        } else {
            // nak 或网关统一 error 信封，归一为 .nak。
            let fields = Self.decodeNakFields(env)
            claimed.continuation.resume(returning: .nak(
                code: fields.code,
                message: fields.message,
                category: fields.category,
                retryable: fields.retryable,
                delivery: fields.delivery,
                executionState: fields.executionState,
                messageId: fields.messageId,
                clientEventId: fields.clientEventId
            ))
        }
        return true
    }

    private func resolveConnections(_ ok: Bool) {
        guard !pendingConnections.isEmpty else { return }
        let waiters = pendingConnections
        pendingConnections.removeAll()
        for (_, cont) in waiters { cont.resume(returning: ok) }
    }

    /// subscribe.ok 到达：把 acked topics 命中的等待者 resume(true)。
    /// payload.topics 缺省时（部分网关只回确认不带 topics），保守 resolve 全部等待者。
    private func resolveSubscribeOk(_ env: WSEnvelope) {
        guard !pendingSubscriptions.isEmpty else { return }
        if let key = subscriptionRequestKeys.removeValue(forKey: env.requestId),
           let cont = pendingSubscriptions.removeValue(forKey: key) {
            subscriptionTimeouts.removeValue(forKey: key)?.cancel()
            cont.resume(returning: true)
            return
        }
        let acked = Set((env.payload["topics"]?.arrayValue ?? []).compactMap { $0 as? String })
        let keys = Array(pendingSubscriptions.keys)
        for key in keys {
            let topics = Set(key.split(separator: ",").map(String.init))
            let hit = acked.isEmpty || topics.isSubset(of: acked)
            if hit, let cont = pendingSubscriptions.removeValue(forKey: key) {
                subscriptionRequestKeys = subscriptionRequestKeys.filter { $0.value != key }
                subscriptionTimeouts.removeValue(forKey: key)?.cancel()
                cont.resume(returning: true)
            }
        }
    }

    /// subscribe 校验失败返回通用 error envelope；按 request_id 精确结束，避免白等超时。
    private func resolveSubscribeError(_ env: WSEnvelope) -> Bool {
        guard let correlatedKey = Self.subscriptionKey(for: env, requestKeys: subscriptionRequestKeys),
              let key = subscriptionRequestKeys.removeValue(forKey: env.requestId),
              key == correlatedKey,
              let cont = pendingSubscriptions.removeValue(forKey: key) else { return false }
        subscriptionTimeouts.removeValue(forKey: key)?.cancel()
        let code = env.payloadString("code") ?? "unknown"
        logger.warning("subscribe rejected code=\(code, privacy: .public)")
        cont.resume(returning: false)
        return true
    }

    static func decodeNakFields(_ env: WSEnvelope) -> NakEnvelopeFields {
        NakEnvelopeFields(
            code: env.payloadString("error_code") ?? env.payloadString("code") ?? "unknown",
            message: env.payloadString("error_message") ?? env.payloadString("message") ?? "",
            category: env.payloadString("error_category"),
            retryable: env.payloadBool("retryable") ?? false,
            delivery: env.payloadString("delivery"),
            executionState: env.payloadString("execution_state"),
            messageId: env.payloadString("message_id"),
            clientEventId: env.payloadString("client_event_id")
        )
    }

    static func subscriptionKey(
        for env: WSEnvelope,
        requestKeys: [String: String]
    ) -> String? {
        guard env.type == "error" else { return nil }
        return requestKeys[env.requestId]
    }

    private func cancelDeferredUnsubscribe(_ topics: [String]) {
        for topic in topics {
            deferredUnsubscribeTasks.removeValue(forKey: topic)?.cancel()
        }
    }

    private func cancelAllDeferredUnsubscribes() {
        for task in deferredUnsubscribeTasks.values {
            task.cancel()
        }
        deferredUnsubscribeTasks.removeAll()
    }

    private func releaseDeferredSubscriptionIfTerminal(_ env: WSEnvelope) {
        guard let topic = env.topic,
              deferredUnsubscribeTasks[topic] != nil,
              isTerminalStreamEnvelope(env) else { return }
        deferredUnsubscribeTasks.removeValue(forKey: topic)?.cancel()
        unsubscribe([topic])
    }

    private func isTerminalStreamEnvelope(_ env: WSEnvelope) -> Bool {
        switch env.type {
        case AgentStreamEvent.fullType(AgentStreamEvent.done),
             AgentStreamEvent.fullType(AgentStreamEvent.persistError):
            return true
        case AgentStreamEvent.fullType(AgentStreamEvent.lifecycle):
            let phase = (env.payloadString("phase") ?? "").lowercased()
            return phase == "done" || phase == "end" || phase == "completed" || phase == "failed" || phase == "error"
        default:
            return false
        }
    }

    private func failAllPending() {
        let acks = pendingAcks
        pendingAcks.removeAll()
        for (_, p) in acks {
            p.timeoutTask.cancel()
            p.continuation.resume(returning: .disconnected)
        }
        resolveConnections(false)
        let subs = pendingSubscriptions
        pendingSubscriptions.removeAll()
        subscriptionRequestKeys.removeAll()
        for (key, cont) in subs {
            subscriptionTimeouts.removeValue(forKey: key)?.cancel()
            cont.resume(returning: false)
        }
    }

    // MARK: - Subscribe

    private func syncSubscriptions() {
        let needed = desiredTopics.subtracting(subscribedTopics)
        guard !needed.isEmpty else { return }
        send(WSEnvelope.build(type: "subscribe", deviceId: deviceId,
                              payload: subscriptionPayload(for: Array(needed)), organizationId: organizationId))
        // 乐观登记；Phase 1 改为按 subscribe.ok 回包确认。
        subscribedTopics.formUnion(needed)
    }

    private func subscriptionPayload(for topics: [String]) -> [String: Any] {
        var payload: [String: Any] = ["topics": topics]
        let contexts = topics.reduce(into: [String: Any]()) { result, topic in
            if let context = desiredTopicContexts[topic] { result[topic] = context }
        }
        if !contexts.isEmpty { payload["topic_contexts"] = contexts }
        return payload
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        lastOutboundAt = Date()
        lastProtocolPingAt = Date()
        let checkInterval = healthCheckInterval
        let outboundIdle = outboundPingInterval
        let protocolIdle = pingInterval
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(checkInterval))
                guard let self, !Task.isCancelled, self.isAuthenticated else { return }
                let now = Date()
                // 应用层 ping 只在出站空闲时发：有 subscribe / 发消息 / app_state 时不必再打。
                // 协议 ping 不进 Django，只喂 URLSession / NAT，成本可忽略。
                if now.timeIntervalSince(self.lastOutboundAt) >= outboundIdle {
                    self.send(WSEnvelope.build(
                        type: "ping",
                        deviceId: self.deviceId,
                        payload: [:],
                        organizationId: self.organizationId
                    ))
                }
                if now.timeIntervalSince(self.lastProtocolPingAt) >= protocolIdle {
                    self.lastProtocolPingAt = now
                    self.task?.sendPing { _ in }
                }
            }
        }
    }

    // MARK: - Send

    private func send(_ env: WSEnvelope, completion: (@Sendable (Error?) -> Void)? = nil) {
        guard let task else {
            DiagnosticRecorder.captureWebSocket(
                channel: "gateway",
                phase: "send",
                messageType: env.type,
                result: "disconnected"
            )
            completion?(URLError(.notConnectedToInternet))
            return
        }
        do {
            let data = try env.toData()
            let text = String(data: data, encoding: .utf8) ?? ""
            DiagnosticRecorder.captureWebSocket(
                channel: "gateway",
                phase: "send",
                messageType: env.type,
                payloadBytes: data.count,
                result: "queued"
            )
            lastOutboundAt = Date()
            task.send(.string(text)) { [weak self] error in
                completion?(error)
                guard let error else { return }
                Task { @MainActor in self?.onSendError(error) }
            }
        } catch {
            logger.error("encode envelope failed: \(error.localizedDescription)")
            completion?(error)
        }
    }

    private func onSendError(_ error: Error) {
        logger.warning("send error: \(error.localizedDescription)")
        scheduleReconnect()
    }

    // MARK: - Reconnect

    private func scheduleReconnect() {
        // 通知消费方连接已断（进行中的流挂起超时、提示重连）。消费方按需自去重。
        onConnectionDropped?()
        guard reconnectAttempt < maxReconnectAttempts else {
            logger.error("Reconnect gave up after \(self.maxReconnectAttempts) attempts")
            cancelAllTasks()
            task?.cancel(with: .abnormalClosure, reason: nil)
            task = nil
            isAuthenticated = false
            failAllPending()
            state = .reconnectGaveUp
            return
        }

        receiveLoop?.cancel()
        heartbeatTask?.cancel()
        authTimeoutTask?.cancel()
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        isAuthenticated = false
        failAllPending()

        let delay = min(maxReconnectDelay, baseReconnectDelay * pow(reconnectFactor, Double(reconnectAttempt)))
        reconnectAttempt += 1
        DiagnosticRecorder.captureWebSocket(
            channel: "gateway",
            phase: "reconnect_scheduled",
            attempt: reconnectAttempt
        )
        state = .reconnecting(attempt: reconnectAttempt)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.performConnect()
        }
    }

    private func cancelAllTasks() {
        receiveLoop?.cancel()
        heartbeatTask?.cancel()
        authTimeoutTask?.cancel()
        reconnectTask?.cancel()
        receiveLoop = nil
        heartbeatTask = nil
        authTimeoutTask = nil
        reconnectTask = nil
    }
}
