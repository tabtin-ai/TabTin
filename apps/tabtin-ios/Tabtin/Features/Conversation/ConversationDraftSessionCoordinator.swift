import Foundation
import Observation

/// 把「新建会话」收敛为首发前的一次性、可复用事务。
///
/// 同一个 coordinator 会复用进行中的创建任务，因此连续点按发送、自动首发与手动首发
/// 不会各自创建 Session。创建失败不会丢弃草稿；下次发送会重新发起创建。
@MainActor
@Observable
final class ConversationDraftSessionCoordinator {
    private(set) var draft: ConversationDraftState
    private(set) var sessionId: String?
    private(set) var isFirstSendInFlight = false
    @ObservationIgnored private var creationTask: Task<String, Error>?

    init(draft: ConversationDraftState) {
        self.draft = draft
    }

    var draftId: String { draft.id }
    var agentId: String? { draft.agentId }

    /// 从磁盘草稿恢复首发事务。若上次已建 Session 但未成功入队，继续复用该 Session。
    @discardableResult
    func restore(draftId: String, agentId: String?, pendingSessionId: String?) -> Bool {
        guard sessionId == nil, !isFirstSendInFlight, creationTask == nil else { return false }
        draft = ConversationDraftState(
            id: draftId,
            workspaceId: draft.workspaceId,
            organizationId: draft.organizationId,
            agentId: agentId,
            projectId: draft.projectId
        )
        sessionId = pendingSessionId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        return true
    }

    /// 只允许在草稿尚未开始首发时切换 Agent，防止一条首发请求的 agent_id 在等待网络时漂移。
    @discardableResult
    func selectAgent(id: String?) -> Bool {
        guard sessionId == nil, !isFirstSendInFlight else { return false }
        draft.agentId = id
        return true
    }

    /// 草稿态切换执行 Workspace：保持 draftId / agentId，重建冻结的 workspace/org/project。
    /// Session 已创建或首发进行中时拒绝，避免把已绑定现场改到别处。
    @discardableResult
    func selectExecutionWorkspace(
        workspaceId: String,
        organizationId: String,
        projectId: String?
    ) -> Bool {
        guard sessionId == nil, !isFirstSendInFlight else { return false }
        let workspaceId = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let organizationId = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workspaceId.isEmpty, !organizationId.isEmpty else { return false }
        let projectId = projectId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        draft = ConversationDraftState(
            id: draft.id,
            workspaceId: workspaceId,
            organizationId: organizationId,
            agentId: draft.agentId,
            projectId: projectId
        )
        return true
    }

    /// ：幂等 session_id 已在服务端冻结为不同创建配置时，轮换 draft UUID 后重试创建。
    /// 仅允许在尚未拿到 sessionId、且无进行中创建任务时调用。
    @discardableResult
    func rotateDraftIdentityForConflictRetry() -> String? {
        guard sessionId == nil, creationTask == nil else { return nil }
        let newId = UUID().uuidString
        draft = ConversationDraftState(
            id: newId,
            workspaceId: draft.workspaceId,
            organizationId: draft.organizationId,
            agentId: draft.agentId,
            projectId: draft.projectId
        )
        return newId
    }

    /// 同一轮首发只允许一个发送动作继续；调用者应在结束时调用 `finishFirstSend()`。
    func beginFirstSend() -> Bool {
        guard !isFirstSendInFlight else { return false }
        isFirstSendInFlight = true
        return true
    }

    func finishFirstSend() {
        isFirstSendInFlight = false
    }

    func ensureSession(
        create: @escaping @Sendable () async throws -> String
    ) async throws -> String {
        if let sessionId { return sessionId }
        if let creationTask { return try await creationTask.value }

        let task = Task<String, Error> {
            try await create()
        }
        creationTask = task

        do {
            let createdSessionId = try await task.value
            sessionId = createdSessionId
            creationTask = nil
            return createdSessionId
        } catch {
            creationTask = nil
            throw error
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
