import Foundation
import os

struct PendingSessionReadAck: Codable, Equatable, Sendable {
    let sessionId: String
    let throughRunId: String
    let throughSequence: Int
    let throughRevision: Int
    let mutationId: String
}

enum SessionReadWatermarkPolicy {
    static func newer(
        _ incoming: PendingSessionReadAck,
        than existing: PendingSessionReadAck?
    ) -> Bool {
        guard let existing else { return true }
        return incoming.throughSequence > existing.throughSequence
            || (
                incoming.throughSequence == existing.throughSequence
                    && incoming.throughRevision > existing.throughRevision
            )
    }
}

/// 会话阅读水位 outbox：内容已完成展示后入队，网络失败保留；同一会话只保留最新水位。
@MainActor
final class SessionReadStore {
    /// 已读回执发送注入点：shared 走 APIClient，测试注入假发送器。
    typealias ReadAckSender = @MainActor (PendingSessionReadAck) async throws -> Void

    static let shared = SessionReadStore(
        isAuthenticated: { AuthService.shared.isAuthenticated },
        registerLogoutHook: { hook in AuthService.shared.registerLogoutHook(hook) }
    )

    private static let pendingKey = "tabtin.pending-session-read-acks.v1"
    private static let acknowledgedKey = "tabtin.acknowledged-session-read-acks.v1"
    private var pendingBySession: [String: PendingSessionReadAck]
    private var acknowledgedBySession: [String: PendingSessionReadAck]
    private var flushing = false
    private let sendReadAck: ReadAckSender
    private let isAuthenticated: () -> Bool
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "SessionReadStore")

    init(
        sendReadAck: ReadAckSender? = nil,
        isAuthenticated: @escaping () -> Bool = { true },
        registerLogoutHook: (@escaping @MainActor () -> Void) -> Void = { _ in }
    ) {
        self.sendReadAck = sendReadAck ?? { candidate in
            let _: SessionReadAckResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.sessionRead(candidate.sessionId),
                body: [
                    "through_run_id": candidate.throughRunId,
                    "through_revision": candidate.throughRevision,
                    "mutation_id": candidate.mutationId,
                ]
            )
        }
        self.isAuthenticated = isAuthenticated
        if let data = UserDefaults.standard.data(forKey: Self.pendingKey),
           let pending = try? JSONDecoder().decode([String: PendingSessionReadAck].self, from: data) {
            pendingBySession = pending
        } else {
            pendingBySession = [:]
        }
        if let data = UserDefaults.standard.data(forKey: Self.acknowledgedKey),
           let acknowledged = try? JSONDecoder().decode(
               [String: PendingSessionReadAck].self,
               from: data
           ) {
            acknowledgedBySession = acknowledged
        } else {
            acknowledgedBySession = [:]
        }
        registerLogoutHook { [weak self] in self?.clear() }
    }

    func acknowledgeContentDisplayed(_ candidate: PendingSessionReadAck) async {
        guard SessionReadWatermarkPolicy.newer(
            candidate,
            than: pendingBySession[candidate.sessionId]
        ), SessionReadWatermarkPolicy.newer(
            candidate,
            than: acknowledgedBySession[candidate.sessionId]
        ) else { return }
        pendingBySession[candidate.sessionId] = candidate
        persist()
        await flush()
    }

    func flush() async {
        guard !flushing, isAuthenticated() else { return }
        flushing = true
        defer { flushing = false }

        let candidates = pendingBySession.values.sorted {
            ($0.throughSequence, $0.throughRevision) < ($1.throughSequence, $1.throughRevision)
        }
        for candidate in candidates {
            guard pendingBySession[candidate.sessionId] == candidate else { continue }
            do {
                try await sendReadAck(candidate)
                settleLocally(candidate)
                RecentSessionsStore.shared.markReadAcknowledged(
                    sessionId: candidate.sessionId,
                    sequence: candidate.throughSequence,
                    revision: candidate.throughRevision
                )
            } catch {
                if error.isTerminalSessionReadAckFailure {
                    // 永久失败（400/404/409）：同一 sequence/revision 重放不会成功。
                    // 必须写入 acknowledged 做本地结算，否则进会话会换新 mutationId 再入队。
                    // 未读角标仍跟服务端 read_state，这里不调用 markReadAcknowledged。
                    settleLocally(candidate)
                    logger.debug(
                        "session read ACK settled as terminal session=\(candidate.sessionId, privacy: .private(mask: .hash))"
                    )
                } else {
                    logger.debug(
                        "session read ACK deferred session=\(candidate.sessionId, privacy: .private(mask: .hash))"
                    )
                }
            }
        }
    }

    private func settleLocally(_ candidate: PendingSessionReadAck) {
        guard pendingBySession[candidate.sessionId] == candidate else { return }
        pendingBySession.removeValue(forKey: candidate.sessionId)
        if SessionReadWatermarkPolicy.newer(
            candidate,
            than: acknowledgedBySession[candidate.sessionId]
        ) {
            acknowledgedBySession[candidate.sessionId] = candidate
        }
        persist()
    }

    private func persist() {
        if pendingBySession.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.pendingKey)
        } else if let data = try? JSONEncoder().encode(pendingBySession) {
            UserDefaults.standard.set(data, forKey: Self.pendingKey)
        }
        if acknowledgedBySession.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.acknowledgedKey)
        } else if let data = try? JSONEncoder().encode(acknowledgedBySession) {
            UserDefaults.standard.set(data, forKey: Self.acknowledgedKey)
        }
    }

    private func clear() {
        pendingBySession = [:]
        acknowledgedBySession = [:]
        UserDefaults.standard.removeObject(forKey: Self.pendingKey)
        UserDefaults.standard.removeObject(forKey: Self.acknowledgedKey)
    }
}

private struct SessionReadAckResponse: Decodable, Sendable {}
