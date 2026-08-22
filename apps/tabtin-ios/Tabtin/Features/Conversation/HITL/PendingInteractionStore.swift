import Foundation
import os

struct PendingInteractionListResponse: Decodable, Sendable {
    let interactions: [PendingInteraction]
}

struct PendingInteractionDismissResponse: Decodable, Sendable {
    let interactionId: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case interactionId = "interaction_id"
        case status
    }
}

struct PendingInteraction: Decodable, Identifiable, Sendable, Hashable {
    let id: String
    let kind: String
    let status: String
    let threadId: String
    let sessionId: String?
    let organizationId: String?
    let requestKey: String
    let source: String
    let payload: [String: AnyCodable]
    let result: [String: AnyCodable]?
    let expiresAt: Int?
    let createdAt: Int?

    enum CodingKeys: String, CodingKey {
        case id, kind, status, source, payload, result
        case threadId = "thread_id"
        case sessionId = "session_id"
        case organizationId = "organization_id"
        case requestKey = "request_key"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }

    var isPending: Bool { status == "pending" }
    var isExpired: Bool {
        guard let expiresAt else { return false }
        return expiresAt <= Int(Date().timeIntervalSince1970 * 1000)
    }

    var stableKey: String { "\(kind):\(threadId):\(requestKey)" }

    /// 服务端 pending-interactions API 以 `created_at` 升序返回。Store 落进字典后会丢失
    /// 响应数组顺序，因此恢复会话时必须重新按同一权威字段排序；stableKey 只负责在
    /// 同毫秒时间戳或旧数据缺少 created_at 时提供确定性顺序，不能改用 expiresAt。
    static func fifoOrdered(_ interactions: [PendingInteraction]) -> [PendingInteraction] {
        interactions.sorted { lhs, rhs in
            switch (lhs.createdAt, rhs.createdAt) {
            case let (.some(left), .some(right)) where left != right:
                return left < right
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            default:
                return lhs.stableKey < rhs.stableKey
            }
        }
    }

    func toHITLEnvelope() -> WSEnvelope? {
        guard isPending, !isExpired else { return nil }
        var enrichedPayload = payload
        if enrichedPayload["request_id"] == nil {
            enrichedPayload["request_id"] = AnyCodable(requestKey)
        }
        if let expiresAt, enrichedPayload["expires_at"] == nil {
            enrichedPayload["expires_at"] = AnyCodable(expiresAt)
        }
        let eventType: String
        switch kind {
        case "tool_approval" where source == "agent_action" || payload["event_type"]?.stringValue == AgentStreamEvent.actionApprovalRequest:
            eventType = AgentStreamEvent.actionApprovalRequest
        case "tool_approval":
            eventType = "\(AgentStreamEvent.prefix)\(AgentStreamEvent.approvalRequested)"
        case "ask_choice":
            eventType = "\(AgentStreamEvent.prefix)\(AgentStreamEvent.askUserRequired)"
        case "ask_form":
            eventType = "\(AgentStreamEvent.prefix)\(AgentStreamEvent.askFormRequired)"
        case "permission_request":
            eventType = "\(AgentStreamEvent.prefix)\(AgentStreamEvent.requestApprovalRequired)"
        default:
            return nil
        }
        return WSEnvelope(
            v: 1,
            type: eventType,
            requestId: "pending-\(id)",
            ts: Int(Date().timeIntervalSince1970),
            deviceId: "server",
            role: "backend",
            payload: enrichedPayload,
            threadId: threadId,
            organizationId: organizationId,
            sessionId: sessionId
        )
    }
}

enum PendingInteractionUpdate: Sendable {
    case requested(PendingInteraction)
    case terminal(PendingInteraction)
}

/// Session HITL hydration 结果：网络失败必须 fail-closed，不能伪装成「无待办」。
enum PendingInteractionRefreshResult: Equatable, Sendable {
    case success([PendingInteraction])
    case failure
}

@MainActor
@Observable
final class PendingInteractionStore {
    static let shared = PendingInteractionStore()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "PendingInteraction")
    private let gateway = RealtimeGateway.shared
    private(set) var interactions: [String: PendingInteraction] = [:]
    private var started = false
    private var terminalKeys: Set<String> = []
    private var terminalKeyOrder: [String] = []
    private var updateListeners: [String: (PendingInteractionUpdate) -> Void] = [:]
    private var expiryTask: Task<Void, Never>?
    private let maxTerminalKeys = 512

    private init() {}

    func start() {
        guard !started else { return }
        started = true
        gateway.addEnvelopeListener(key: "pending-interactions") { [weak self] env in
            self?.handleEnvelope(env)
        }
        gateway.addReconnectListener(key: "pending-interactions") { [weak self] in
            Task { await self?.refreshAll() }
        }
        startExpirySweep()
        Task { await refreshAll() }
    }

    func stop() {
        guard started else { return }
        started = false
        expiryTask?.cancel()
        expiryTask = nil
        gateway.removeEnvelopeListener(key: "pending-interactions")
        gateway.removeReconnectListener(key: "pending-interactions")
        interactions.removeAll()
        terminalKeys.removeAll()
        terminalKeyOrder.removeAll()
    }

    func refreshAll() async {
        guard AuthService.shared.isAuthenticated else {
            logger.debug("skip pending interaction refresh without an authenticated session")
            return
        }
        do {
            let response: PendingInteractionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.pendingInteractions
            )
            // 前后台恢复或 WebSocket 重连可能漏掉 interaction_requested。只把
            // 此次全量同步中新出现的事项通知给正在打开的会话，避免重复渲染卡片。
            for interaction in merge(response.interactions) {
                emit(.requested(interaction))
            }
        } catch {
            logger.warning("refresh pending interactions failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func refreshSession(_ sessionId: String) async -> PendingInteractionRefreshResult {
        guard AuthService.shared.isAuthenticated else { return .failure }
        do {
            let response: PendingInteractionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionPendingInteractions(sessionId)
            )
            merge(response.interactions)
            return .success(pendingForSession(sessionId))
        } catch {
            logger.warning("refresh session pending interactions failed: \(error.localizedDescription, privacy: .public)")
            return .failure
        }
    }

    /// 该会话是否存在待处理事项（驱动会话列表行的「待处理」pill）。
    /// 在 View body 中调用会追踪 `interactions` 的 @Observable 变化。
    func hasPendingForSession(_ sessionId: String) -> Bool {
        interactions.values.contains {
            ($0.sessionId == sessionId || $0.threadId == "chat-session-\(sessionId)")
                && $0.isPending
                && !$0.isExpired
        }
    }

    func pendingForSession(_ sessionId: String) -> [PendingInteraction] {
        PendingInteraction.fifoOrdered(
            interactions.values.filter {
                ($0.sessionId == sessionId || $0.threadId == "chat-session-\(sessionId)")
                    && $0.isPending
                    && !$0.isExpired
            }
        )
    }

    func markResolved(kind: String, threadId: String, requestKey: String) {
        let key = "\(kind):\(threadId):\(requestKey)"
        rememberTerminalKey(key)
        interactions.removeValue(forKey: key)
    }

    func dismissExpiredInteraction(_ interactionId: String) async {
        guard AuthService.shared.isAuthenticated else { return }
        do {
            let _: PendingInteractionDismissResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.dismissPendingInteraction(interactionId)
            )
        } catch {
            logger.warning("dismiss expired pending interaction failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func addUpdateListener(key: String, _ listener: @escaping (PendingInteractionUpdate) -> Void) {
        updateListeners[key] = listener
    }

    func removeUpdateListener(key: String) {
        updateListeners.removeValue(forKey: key)
    }

    /// 合并服务端事实源，并返回此前不在本地快照中的有效待处理事项。
    ///
    /// `refreshSession` 会由会话自行 hydrate，只有 `refreshAll` 在重连恢复时
    /// 消费返回值来补偿丢失的实时事件。
    @discardableResult
    private func merge(_ incoming: [PendingInteraction]) -> [PendingInteraction] {
        var newlyPending: [PendingInteraction] = []
        for item in incoming {
            if item.isPending, !item.isExpired, !terminalKeys.contains(item.stableKey) {
                let isNew = interactions[item.stableKey] == nil
                interactions[item.stableKey] = item
                if isNew {
                    newlyPending.append(item)
                }
            } else {
                interactions.removeValue(forKey: item.stableKey)
            }
        }
        sweepExpiredInteractions()
        return newlyPending
    }

    private func handleEnvelope(_ env: WSEnvelope) {
        guard env.type.hasPrefix("agent.user.interaction_") else { return }
        guard let interaction = env.decodePayloadField(
            "interaction",
            as: PendingInteraction.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        ) else {
            logger.warning("undecodable user interaction event dropped: \(env.type, privacy: .public)")
            return
        }

        switch env.type {
        case "agent.user.interaction_requested":
            guard interaction.isPending, !interaction.isExpired, !terminalKeys.contains(interaction.stableKey) else {
                merge([interaction])
                return
            }
            // 与 refreshAll 对齐：仅对新进本地快照的事项 emit，避免 stream + WS 双投递重复弹 Ask User。
            let newlyPending = merge([interaction])
            if !newlyPending.isEmpty {
                emit(.requested(interaction))
            }
        case "agent.user.interaction_resolved", "agent.user.interaction_expired":
            rememberTerminalKey(interaction.stableKey)
            interactions.removeValue(forKey: interaction.stableKey)
            emit(.terminal(interaction))
        default:
            break
        }
    }

    private func emit(_ update: PendingInteractionUpdate) {
        for listener in updateListeners.values {
            listener(update)
        }
    }

    private func startExpirySweep() {
        expiryTask?.cancel()
        expiryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.sweepExpiredInteractions()
            }
        }
    }

    private func sweepExpiredInteractions() {
        let expired = interactions.values.filter(\.isExpired)
        guard !expired.isEmpty else { return }
        for item in expired {
            rememberTerminalKey(item.stableKey)
            interactions.removeValue(forKey: item.stableKey)
            emit(.terminal(item))
            Task { [weak self] in
                await self?.dismissExpiredInteraction(item.id)
            }
        }
    }

    private func rememberTerminalKey(_ key: String) {
        if terminalKeys.insert(key).inserted {
            terminalKeyOrder.append(key)
        }
        while terminalKeyOrder.count > maxTerminalKeys {
            let oldest = terminalKeyOrder.removeFirst()
            terminalKeys.remove(oldest)
        }
    }
}
