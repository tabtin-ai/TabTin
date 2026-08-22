import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Checkpoint models

enum ChatCheckpointStatus: String, Codable, Hashable, Sendable {
    case ready
    case degraded
    case unavailable
}

struct ChatCheckpointCapabilityScope: Codable, Hashable, Sendable {
    var messagePreview: Bool?
    var fileDiff: Bool?
    var fileRestore: Bool?
    var resourceRestore: Bool?
    var unrevert: Bool?

    enum CodingKeys: String, CodingKey {
        case messagePreview = "message_preview"
        case fileDiff = "file_diff"
        case fileRestore = "file_restore"
        case resourceRestore = "resource_restore"
        case unrevert
    }
}

struct ChatCheckpointContextSummary: Codable, Hashable, Sendable {
    var intentSummary: String?

    enum CodingKeys: String, CodingKey {
        case intentSummary = "intent_summary"
    }
}

struct ChatCheckpointFileSummary: Codable, Hashable, Sendable {
    var changed: Int?
    var insertions: Int?
    var deletions: Int?
    var files: [ChatCheckpointDiffFileSummary]?
}

struct ChatCheckpointDiffFileSummary: Codable, Hashable, Identifiable, Sendable {
    var file: String
    var changes: Int?
    var insertions: Int?
    var deletions: Int?

    var id: String { file }
}

struct ChatCheckpointImpactSummary: Codable, Hashable, Sendable {
    var fileSummary: ChatCheckpointFileSummary?

    enum CodingKeys: String, CodingKey {
        case fileSummary = "file_summary"
    }
}

struct ChatCheckpointRecord: Codable, Hashable, Sendable {
    var checkpointId: String?
    var sessionId: String?
    var anchorType: String?
    var status: ChatCheckpointStatus?
    var capabilityScope: ChatCheckpointCapabilityScope?
    var degradedReasons: [String]?
    var contextSummary: ChatCheckpointContextSummary?
    var impactSummary: ChatCheckpointImpactSummary?

    enum CodingKeys: String, CodingKey {
        case checkpointId = "checkpoint_id"
        case sessionId = "session_id"
        case anchorType = "anchor_type"
        case status
        case capabilityScope = "capability_scope"
        case degradedReasons = "degraded_reasons"
        case contextSummary = "context_summary"
        case impactSummary = "impact_summary"
    }

    var normalizedStatus: ChatCheckpointStatus { status ?? .unavailable }
}

struct ChatCheckpointMessagePreview: Codable, Identifiable, Hashable, Sendable {
    var id: String?
    var role: String?
    var contentPreview: String?

    enum CodingKeys: String, CodingKey {
        case id, role
        case contentPreview = "content_preview"
    }
}

struct ChatCheckpointResourceChange: Codable, Hashable, Sendable {
    var resourceType: String?
    var resourceId: String?
    var resourceName: String?
    var changeType: String?
    var summary: String?
    var agentRunId: String?

    enum CodingKeys: String, CodingKey {
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case resourceName = "resource_name"
        case changeType = "change_type"
        case summary
        case agentRunId = "agent_run_id"
    }
}

struct ChatCheckpointUnrestorableFile: Codable, Hashable, Sendable {
    var path: String
    var reason: String?
}

struct ChatCheckpointResourcePlanItem: Codable, Identifiable, Hashable, Sendable {
    var resourceType: String?
    var resourceId: String?
    var resourceName: String?
    var action: String?
    var actionLabel: String?
    var canRestore: Bool?
    var restoreToVersionId: String?
    var restoreToVersionTime: String? = nil
    var changeCount: Int?

    var id: String { "\(resourceType ?? "resource")_\(resourceId ?? UUID().uuidString)" }

    enum CodingKeys: String, CodingKey {
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case resourceName = "resource_name"
        case action
        case actionLabel = "action_label"
        case canRestore = "can_restore"
        case restoreToVersionId = "restore_to_version_id"
        case restoreToVersionTime = "restore_to_version_time"
        case changeCount = "change_count"
    }
}

struct ChatCheckpointImpactMessages: Codable, Hashable, Sendable {
    var toRemove: Int?

    enum CodingKeys: String, CodingKey {
        case toRemove = "to_remove"
    }
}

struct ChatCheckpointImpactResources: Codable, Hashable, Sendable {
    var available: Bool?
    var changeCount: Int?
    var restoreCount: Int?

    enum CodingKeys: String, CodingKey {
        case available
        case changeCount = "change_count"
        case restoreCount = "restore_count"
    }
}

struct ChatCheckpointImpactFiles: Codable, Hashable, Sendable {
    var available: Bool?
    var diffAvailable: Bool?

    enum CodingKeys: String, CodingKey {
        case available
        case diffAvailable = "diff_available"
    }
}

struct ChatCheckpointImpact: Codable, Hashable, Sendable {
    var files: ChatCheckpointImpactFiles?
    var resources: ChatCheckpointImpactResources?
    var messages: ChatCheckpointImpactMessages?
}

struct ChatCheckpointRollbackPreview: Codable, Hashable, Sendable {
    var targetMessageId: String?
    var previewRevision: String? = nil
    var filePreviewRevision: String? = nil
    var rollbackContractVersion: Int? = nil
    var messagesToRemove: Int?
    var messagesPreview: [ChatCheckpointMessagePreview]?
    var resourceChanges: [ChatCheckpointResourceChange]? = nil
    var resourceRestorePlan: [ChatCheckpointResourcePlanItem]?
    var effectiveCheckpoint: ChatCheckpointRecord?
    var degradedReasons: [String]?
    var noImpact: Bool?
    var impact: ChatCheckpointImpact?
    var unrestorableItems: [String]?
    /// 控制设备返回的本地文件影响。旧后端没有这些字段时保持 nil，继续按旧 impact 解读。
    var affectedPaths: [String]? = nil
    var rewindAnchorId: String? = nil
    var fileRestoreHost: String? = nil
    var filePreviewSuccess: Bool? = nil
    var filePreviewStatus: String? = nil
    var filePreviewReason: String? = nil
    var unrestorableFiles: [ChatCheckpointUnrestorableFile]? = nil
    var resourcePreviewStatus: String? = nil
    var resourcePreviewReason: String? = nil

    enum CodingKeys: String, CodingKey {
        case targetMessageId = "target_message_id"
        case previewRevision = "preview_revision"
        case filePreviewRevision = "file_preview_revision"
        case rollbackContractVersion = "rollback_contract_version"
        case messagesToRemove = "messages_to_remove"
        case messagesPreview = "messages_preview"
        case resourceChanges = "resource_changes"
        case resourceRestorePlan = "resource_restore_plan"
        case effectiveCheckpoint = "effective_checkpoint"
        case degradedReasons = "degraded_reasons"
        case noImpact = "no_impact"
        case impact
        case unrestorableItems = "unrestorable_items"
        case affectedPaths = "affected_paths"
        case rewindAnchorId = "rewind_anchor_id"
        case fileRestoreHost = "file_restore_host"
        case filePreviewSuccess = "file_preview_success"
        case filePreviewStatus = "file_preview_status"
        case filePreviewReason = "file_preview_reason"
        case unrestorableFiles = "unrestorable_files"
        case resourcePreviewStatus = "resource_preview_status"
        case resourcePreviewReason = "resource_preview_reason"
    }
}

enum ChatCheckpointWirePayload {
    static func resourceRestoreItems(
        from plan: [ChatCheckpointResourcePlanItem],
        includesExplicitSkips: Bool
    ) -> [ChatCheckpointResourceRestoreItem] {
        plan.compactMap { item in
            guard let resourceType = item.resourceType,
                  let resourceId = item.resourceId else { return nil }
            let plannedAction = item.action?.lowercased() ?? "skip"
            if includesExplicitSkips {
                let action = item.canRestore == true && plannedAction != "skip"
                    ? plannedAction
                    : "skip"
                return ChatCheckpointResourceRestoreItem(
                    resourceType: resourceType,
                    resourceId: resourceId,
                    action: action,
                    restoreToVersionId: action == "skip" ? nil : item.restoreToVersionId
                )
            }
            guard item.canRestore == true, plannedAction != "skip" else { return nil }
            return ChatCheckpointResourceRestoreItem(
                resourceType: resourceType,
                resourceId: resourceId,
                action: plannedAction,
                restoreToVersionId: item.restoreToVersionId
            )
        }
    }

    static func rollbackExecute(
        messageId: String,
        reason: String,
        mode: String?,
        previewRevision: String?,
        filePreviewRevision: String?,
        acknowledgedFilePreviewReason: String?
    ) -> [String: Any] {
        var body: [String: Any] = ["target_message_id": messageId]
        let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedReason.isEmpty {
            body["rollback_reason"] = trimmedReason
        }
        if let mode, !mode.isEmpty {
            body["mode"] = mode
        }
        if let previewRevision {
            let trimmedRevision = previewRevision.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedRevision.isEmpty {
                body["preview_revision"] = trimmedRevision
            }
        }
        if let filePreviewRevision {
            let trimmedRevision = filePreviewRevision.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedRevision.isEmpty {
                body["file_preview_revision"] = trimmedRevision
            }
        }
        if mode == "editAndResend" {
            body["rollback_contract_version"] = 2
            if let acknowledgedFilePreviewReason {
                let trimmedReason = acknowledgedFilePreviewReason
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedReason.isEmpty {
                    body["acknowledged_file_preview_reason"] = trimmedReason
                }
            }
        }
        return body
    }

    static func resourceRestore(
        items: [ChatCheckpointResourceRestoreItem],
        previewRevision: String?,
        rollbackContractVersion: Int?
    ) -> [String: Any] {
        var itemPayloads: [[String: Any]] = []
        itemPayloads.reserveCapacity(items.count)
        for item in items {
            var payload: [String: Any] = [
                "resource_type": item.resourceType,
                "resource_id": item.resourceId,
                "action": item.action,
            ]
            if let restoreToVersionId = item.restoreToVersionId {
                payload["restore_to_version_id"] = restoreToVersionId
            }
            itemPayloads.append(payload)
        }

        var body: [String: Any] = ["items": itemPayloads]
        if let previewRevision {
            let trimmedRevision = previewRevision.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedRevision.isEmpty {
                body["preview_revision"] = trimmedRevision
            }
        }
        if let rollbackContractVersion {
            body["rollback_contract_version"] = rollbackContractVersion
        }
        return body
    }
}

struct ChatCheckpointSessionRollbackState: Codable, Equatable, Sendable {
    var sessionId: String?
    var revertActive: Bool?
    var targetMessageId: String?
    var cleanupStatus: String?
    var canUnrevert: Bool?
    var lastApplyResult: String?
    var lastRollbackReason: String?
    var lastOperationMode: String? = nil
    var updatedAt: String? = nil
    /// 执行响应顶层的文件状态会合并到本地状态；服务端若未来直接下发也可兼容解码。
    var fileRestoreStatus: String? = nil
    var fileRestoreReason: String? = nil
    var partialSuccessDetails: ChatCheckpointPartialSuccessDetails?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case revertActive = "revert_active"
        case targetMessageId = "target_message_id"
        case cleanupStatus = "cleanup_status"
        case canUnrevert = "can_unrevert"
        case lastApplyResult = "last_apply_result"
        case lastRollbackReason = "last_rollback_reason"
        case lastOperationMode = "last_operation_mode"
        case updatedAt = "updated_at"
        case fileRestoreStatus = "file_restore_status"
        case fileRestoreReason = "file_restore_reason"
        case partialSuccessDetails = "partial_success_details"
    }

    var hasFileFailure: Bool {
        switch effectiveFileRestoreStatus?.lowercased() {
        case "success", "not_applicable": return false
        case "unavailable", "partial", "partial_success", "failed": return true
        case nil: return partialSuccessDetails?.workspaceFiles?.success == false
        default: return true
        }
    }
    var effectiveFileRestoreStatus: String? {
        fileRestoreStatus ?? partialSuccessDetails?.workspaceFiles?.status
    }
    var effectiveFileRestoreReason: String? {
        fileRestoreReason ?? partialSuccessDetails?.workspaceFiles?.reason
    }
    var hasFileRestoreOutcome: Bool {
        effectiveFileRestoreStatus != nil || partialSuccessDetails?.workspaceFiles?.success != nil
    }
    var fileRestoreBadgeDetail: String {
        switch effectiveFileRestoreStatus?.lowercased() {
        case "not_applicable": return "无需恢复"
        case "success": return "已恢复"
        case "unavailable", "partial", "partial_success", "failed": return "未恢复"
        case .some: return "结果未知"
        case nil:
            switch partialSuccessDetails?.workspaceFiles?.success {
            case true: return "已恢复"
            case false: return "未恢复"
            case nil: return "结果未知"
            }
        }
    }
    var operationKey: String {
        [sessionId, targetMessageId, updatedAt, lastOperationMode, lastApplyResult]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: "|")
    }
    var resourceRestoredCount: Int { partialSuccessDetails?.resources?.restoredCount ?? 0 }
    var resourceFailedCount: Int { partialSuccessDetails?.resources?.failedCount ?? 0 }
    var retryableItems: [ChatCheckpointRetryableResource] { partialSuccessDetails?.resources?.retryable ?? [] }
}

struct ChatCheckpointPartialSuccessDetails: Codable, Equatable, Sendable {
    var workspaceFiles: WorkspaceFilesDetail?
    var resources: ResourcesDetail?

    struct WorkspaceFilesDetail: Codable, Equatable, Sendable {
        var success: Bool?
        var status: String? = nil
        var reason: String?
    }

    struct ResourcesDetail: Codable, Equatable, Sendable {
        var restoredCount: Int?
        var failedCount: Int?
        var retryable: [ChatCheckpointRetryableResource]?

        enum CodingKeys: String, CodingKey {
            case restoredCount = "restored_count"
            case failedCount = "failed_count"
            case retryable
        }
    }

    enum CodingKeys: String, CodingKey {
        case workspaceFiles = "workspace_files"
        case resources
    }
}

struct ChatCheckpointRetryableResource: Codable, Equatable, Sendable {
    var resourceType: String?
    var resourceId: String?
    var resourceName: String?
    var error: String?
    var action: String?
    var restoreToVersionId: String?

    enum CodingKeys: String, CodingKey {
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case resourceName = "resource_name"
        case error
        case action
        case restoreToVersionId = "restore_to_version_id"
    }
}

struct ChatCheckpointRollbackResponse: Codable, Sendable {
    var success: Bool?
    var mode: String?
    var fileRestoreSuccess: Bool?
    var fileRestoreStatus: String?
    var fileRestoreReason: String?
    var failedFiles: [String]?
    var overallStatus: String?
    var rollbackState: ChatCheckpointSessionRollbackState?

    enum CodingKeys: String, CodingKey {
        case success
        case mode
        case fileRestoreSuccess = "file_restore_success"
        case fileRestoreStatus = "file_restore_status"
        case fileRestoreReason = "file_restore_reason"
        case failedFiles = "failed_files"
        case overallStatus = "overall_status"
        case rollbackState = "rollback_state"
    }
}

struct ChatCheckpointUnrevertResponse: Codable, Sendable {
    var success: Bool?
    var fileRestoreSuccess: Bool?
    var rollbackState: ChatCheckpointSessionRollbackState?

    enum CodingKeys: String, CodingKey {
        case success
        case fileRestoreSuccess = "file_restore_success"
        case rollbackState = "rollback_state"
    }
}

struct ChatCheckpointResourceRestoreRequest: Encodable, Sendable {
    let items: [ChatCheckpointResourceRestoreItem]
    let previewRevision: String?
    let rollbackContractVersion: Int?

    enum CodingKeys: String, CodingKey {
        case items
        case previewRevision = "preview_revision"
        case rollbackContractVersion = "rollback_contract_version"
    }
}

struct ChatCheckpointResourceRestoreItem: Encodable, Sendable {
    let resourceType: String
    let resourceId: String
    let action: String
    let restoreToVersionId: String?

    enum CodingKeys: String, CodingKey {
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case action
        case restoreToVersionId = "restore_to_version_id"
    }
}

struct ChatCheckpointResourceRestoreResponse: Codable, Sendable {
    var success: Bool?
    var restoredCount: Int?
    var failedCount: Int?
    var overallStatus: String?
    var rollbackState: ChatCheckpointSessionRollbackState?

    enum CodingKeys: String, CodingKey {
        case success
        case restoredCount = "restored_count"
        case failedCount = "failed_count"
        case overallStatus = "overall_status"
        case rollbackState = "rollback_state"
    }
}

struct AgentRunRollbackResponse: Codable, Sendable {
    var agentRunId: String?
    var rollbackResults: [AgentRunRollbackResultItem]?
    var allSkipped: Bool?
    var cascadedRunCount: Int?

    enum CodingKeys: String, CodingKey {
        case agentRunId = "agent_run_id"
        case rollbackResults = "rollback_results"
        case allSkipped = "all_skipped"
        case cascadedRunCount = "cascaded_run_count"
    }
}

struct AgentRunRollbackResultItem: Codable, Identifiable, Sendable {
    var resourceType: String?
    var resourceId: String?
    var resourceName: String?
    var status: String?
    var reason: String?

    var id: String { "\(resourceType ?? "resource")_\(resourceId ?? UUID().uuidString)" }

    enum CodingKeys: String, CodingKey {
        case resourceType = "resource_type"
        case resourceId = "resource_id"
        case resourceName = "resource_name"
        case status, reason
    }
}

struct ChatCheckpointRevertHistoryEntry: Codable, Identifiable, Sendable {
    var type: String?
    var applyId: String?
    var targetMessageId: String?
    var messagesRemoved: Int?
    var restoredCount: Int?
    var failedCount: Int?
    var applyResult: String?
    var createdAt: String?

    var id: String { "\(createdAt ?? "")-\(type ?? "rollback")-\(applyId ?? "")" }

    enum CodingKeys: String, CodingKey {
        case type
        case applyId = "apply_id"
        case targetMessageId = "target_message_id"
        case messagesRemoved = "messages_removed"
        case restoredCount = "restored_count"
        case failedCount = "failed_count"
        case applyResult = "apply_result"
        case createdAt = "created_at"
    }
}

struct ChatCheckpointRevertHistoryResponse: Codable, Sendable {
    var history: [ChatCheckpointRevertHistoryEntry]?
}

private struct CheckpointTimeoutError: Error {}

private func withCheckpointTimeout<T: Sendable>(
    seconds: TimeInterval,
    operation: @Sendable @escaping () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw CheckpointTimeoutError()
        }
        guard let result = try await group.next() else { throw CheckpointTimeoutError() }
        group.cancelAll()
        return result
    }
}

@MainActor
@Observable
final class ChatCheckpointService {
    static let shared = ChatCheckpointService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ChatCheckpoint")

    private(set) var rollbackPreview: ChatCheckpointRollbackPreview?
    private(set) var isLoadingPreview = false
    private(set) var isReverting = false
    private(set) var restoringPhase: String?
    private(set) var rollbackStateBySession: [String: ChatCheckpointSessionRollbackState] = [:]
    private(set) var revertHistory: [ChatCheckpointRevertHistoryEntry] = []
    private(set) var isLoadingHistory = false
    private(set) var historyLoadFailed = false
    /// 最近一次回滚相关操作的本机回执；只复述服务端状态，不推导额外能力。
    private(set) var lastOperationReceipt: CheckpointOperationReceipt?

    var showRewindSheet = false
    var showRevertHistorySheet = false
    var previewTargetMessageId: String?
    var lastError: String?
    private(set) var lastPreviewStale = false
    var lastFileRestoreWarning: String?
    private(set) var lastFileRestoreStatus: String?
    private(set) var lastFileRestoreSuccess: Bool?
    private(set) var lastFileRestoreReason: String?
    private(set) var lastFailedFiles: [String] = []
    private(set) var lastResourceRestoreFailed = false
    private(set) var lastResourceRestoreWarning: String?

    private init() {}

    func rollbackState(for sessionId: String) -> ChatCheckpointSessionRollbackState? {
        rollbackStateBySession[sessionId]
    }

    func updateRollbackState(_ state: ChatCheckpointSessionRollbackState?) {
        guard let state, let sessionId = state.sessionId else { return }
        rollbackStateBySession[sessionId] = state
    }

    @discardableResult
    func fetchRollbackPreview(sessionId: String, messageId: String) async -> ChatCheckpointRollbackPreview? {
        isLoadingPreview = true
        lastError = nil
        lastPreviewStale = false
        lastOperationReceipt = nil
        previewTargetMessageId = messageId
        defer { isLoadingPreview = false }

        do {
            let preview: ChatCheckpointRollbackPreview = try await withCheckpointTimeout(seconds: 15) {
                try await APIClient.shared.post(
                    path: Endpoints.Chat.rollbackPreview(sessionId),
                    body: ["target_message_id": messageId]
                )
            }
            rollbackPreview = preview
            showRewindSheet = true
            return preview
        } catch is CheckpointTimeoutError {
            lastError = "回退预览超时，请重试"
        } catch {
            lastError = error.localizedDescription
            logger.error("rollback preview failed: \(error.localizedDescription, privacy: .public)")
        }
        return nil
    }

    func clearPreview() {
        rollbackPreview = nil
        previewTargetMessageId = nil
        showRewindSheet = false
        lastError = nil
        lastPreviewStale = false
    }

    func executeRollback(
        sessionId: String,
        messageId: String,
        reason: String = "",
        resourceRestorePlan: [ChatCheckpointResourcePlanItem] = [],
        mode: String? = nil,
        previewRevision: String? = nil,
        filePreviewRevision: String? = nil,
        acknowledgedFilePreviewReason: String? = nil
    ) async -> Bool {
        guard !isReverting else { return false }
        isReverting = true
        restoringPhase = "preparing"
        lastError = nil
        lastPreviewStale = false
        lastOperationReceipt = nil
        lastFileRestoreWarning = nil
        lastFileRestoreStatus = nil
        lastFileRestoreSuccess = nil
        lastFileRestoreReason = nil
        lastFailedFiles = []
        lastResourceRestoreFailed = false
        lastResourceRestoreWarning = nil
        defer {
            isReverting = false
            restoringPhase = nil
        }

        do {
            restoringPhase = "files"
            let body = ChatCheckpointWirePayload.rollbackExecute(
                messageId: messageId,
                reason: reason,
                mode: mode,
                previewRevision: previewRevision,
                filePreviewRevision: filePreviewRevision,
                acknowledgedFilePreviewReason: acknowledgedFilePreviewReason
            )
            let response: ChatCheckpointRollbackResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.rollbackExecute(sessionId),
                body: body
            )
            let nestedFileResult = response.rollbackState?.partialSuccessDetails?.workspaceFiles
            lastFileRestoreStatus = response.fileRestoreStatus
                ?? response.rollbackState?.fileRestoreStatus
                ?? nestedFileResult?.status
            lastFileRestoreSuccess = response.fileRestoreSuccess ?? nestedFileResult?.success
            lastFileRestoreReason = response.fileRestoreReason
                ?? response.rollbackState?.fileRestoreReason
                ?? nestedFileResult?.reason
            lastFailedFiles = response.failedFiles ?? []
            var responseState = response.rollbackState
            if responseState?.lastOperationMode == nil {
                responseState?.lastOperationMode = response.mode ?? mode
            }
            responseState?.fileRestoreStatus = lastFileRestoreStatus
            responseState?.fileRestoreReason = lastFileRestoreReason
            updateRollbackState(responseState)
            let isEditAndResend = mode == "editAndResend"
            let restoreItems = ChatCheckpointWirePayload.resourceRestoreItems(
                from: resourceRestorePlan,
                includesExplicitSkips: isEditAndResend
            )
            if response.success == true, !restoreItems.isEmpty {
                restoringPhase = "resources"
                lastResourceRestoreFailed = !(await restoreResourcesInternal(
                    sessionId: sessionId,
                    items: restoreItems,
                    previewRevision: isEditAndResend ? previewRevision : nil,
                    rollbackContractVersion: isEditAndResend ? 2 : nil
                ))
            }
            lastFileRestoreWarning = fileRestoreWarning(
                status: lastFileRestoreStatus,
                legacySuccess: lastFileRestoreSuccess,
                reason: lastFileRestoreReason,
                failedFiles: lastFailedFiles,
                rollbackSucceeded: response.success == true
            )
            if lastResourceRestoreFailed, lastResourceRestoreWarning == nil {
                lastResourceRestoreWarning = "对话已回退，但部分文档或表格没有恢复。"
            }
            let succeeded = response.success == true
            if !succeeded, lastError == nil {
                lastError = "服务端未确认本次回退"
            }
            lastOperationReceipt = CheckpointPresentationPolicy.receipt(
                kind: .rollback,
                success: succeeded,
                rollbackState: rollbackState(for: sessionId),
                fallbackError: lastError
            )
            if succeeded { clearPreview() }
            return succeeded
        } catch {
            if case let APIError.serverError(statusCode, _) = error,
               CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                   statusCode: statusCode,
                   businessCode: (error as? APIError)?.businessCode
               ) {
                lastPreviewStale = true
                lastError = "对话已发生变化，影响预览已更新，请重新确认后再发送。"
            } else {
                lastError = error.localizedDescription
            }
            lastOperationReceipt = CheckpointPresentationPolicy.receipt(
                kind: .rollback,
                success: false,
                rollbackState: rollbackState(for: sessionId),
                fallbackError: lastError
            )
            logger.error("rollback failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func fileRestoreWarning(
        status: String?,
        legacySuccess: Bool?,
        reason: String?,
        failedFiles: [String],
        rollbackSucceeded: Bool
    ) -> String? {
        guard rollbackSucceeded else { return nil }
        let failureDetail = CheckpointPresentationPolicy.fileRestoreFailureMessage(
            reason
        )
        switch status?.lowercased() {
        case "success", "not_applicable":
            return nil
        case "unavailable":
            return "对话已回退，但\(failureDetail)。"
        case "partial", "partial_success":
            let count = failedFiles.count
            if count > 0 { return "对话已回退，但有 \(count) 个文件未恢复。" }
            return "对话已回退，但部分文件未恢复。\(failureDetail)。"
        case "failed":
            return "对话已回退，但\(failureDetail)。"
        default:
            if status != nil {
                return "对话已回退，但文件恢复结果无法确认。\(failureDetail)。"
            }
            switch legacySuccess {
            case true: return nil
            case false: return "对话已回退，但\(failureDetail)。"
            case nil: return "对话已回退，但文件恢复结果无法确认，请先在执行设备检查文件状态。"
            }
        }
    }

    private func restoreResourcesInternal(
        sessionId: String,
        items: [ChatCheckpointResourceRestoreItem],
        previewRevision: String? = nil,
        rollbackContractVersion: Int? = nil
    ) async -> Bool {
        do {
            let body = ChatCheckpointWirePayload.resourceRestore(
                items: items,
                previewRevision: previewRevision,
                rollbackContractVersion: rollbackContractVersion
            )
            let response: ChatCheckpointResourceRestoreResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.rollbackResources(sessionId),
                body: body
            )
            var responseState = response.rollbackState
            let previousState = rollbackState(for: sessionId)
            if responseState?.fileRestoreStatus == nil {
                responseState?.fileRestoreStatus = lastFileRestoreStatus
            }
            if responseState?.fileRestoreReason == nil {
                responseState?.fileRestoreReason = lastFileRestoreReason
            }
            if responseState?.lastOperationMode == nil {
                responseState?.lastOperationMode = previousState?.lastOperationMode
            }
            updateRollbackState(responseState)
            let succeeded = CheckpointPresentationPolicy.canCompleteSelectedResourceRestore(
                responseSuccess: response.success,
                restoredCount: response.restoredCount,
                failedCount: response.failedCount ?? response.rollbackState?.resourceFailedCount,
                expectedRestoreCount: items.filter { $0.action != "skip" }.count,
                rollbackContractVersion: rollbackContractVersion
            )
            if !succeeded {
                lastResourceRestoreWarning = "部分已选择的文档或表格没有恢复。"
                lastError = lastResourceRestoreWarning
            }
            return succeeded
        } catch {
            logger.error("restore resources failed: \(error.localizedDescription, privacy: .public)")
            if let apiError = error as? APIError,
               case let .serverError(statusCode, _) = apiError,
               CheckpointPresentationPolicy.isResourceRestoreContractConflict(
                   statusCode: statusCode,
                   businessCode: apiError.businessCode
               ) {
                lastResourceRestoreWarning = "文档或表格的恢复范围已发生变化，请重新检查后再继续。"
            } else {
                lastResourceRestoreWarning = "文档或表格恢复未完成，请稍后重试。"
            }
            lastError = lastResourceRestoreWarning
            return false
        }
    }

    func restoreRetryableResources(sessionId: String, items: [ChatCheckpointRetryableResource]) async -> Bool {
        guard !isReverting else { return false }
        let restoreItems = items.compactMap { item -> ChatCheckpointResourceRestoreItem? in
            guard let resourceType = item.resourceType, let resourceId = item.resourceId else { return nil }
            return ChatCheckpointResourceRestoreItem(
                resourceType: resourceType,
                resourceId: resourceId,
                action: item.action ?? "restore_version",
                restoreToVersionId: item.restoreToVersionId
            )
        }
        guard !restoreItems.isEmpty else { return true }
        isReverting = true
        restoringPhase = "resources"
        lastError = nil
        lastResourceRestoreWarning = nil
        lastOperationReceipt = nil
        defer {
            isReverting = false
            restoringPhase = nil
        }
        let succeeded = await restoreResourcesInternal(sessionId: sessionId, items: restoreItems)
        lastOperationReceipt = CheckpointPresentationPolicy.receipt(
            kind: .restoreResources,
            success: succeeded,
            rollbackState: rollbackState(for: sessionId),
            fallbackError: lastError ?? lastResourceRestoreWarning
        )
        return succeeded
    }

    func executeUnrevert(sessionId: String) async -> Bool {
        guard !isReverting else { return false }
        isReverting = true
        restoringPhase = "finalizing"
        lastError = nil
        lastOperationReceipt = nil
        defer {
            isReverting = false
            restoringPhase = nil
        }

        do {
            let response: ChatCheckpointUnrevertResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.unrevert(sessionId)
            )
            updateRollbackState(response.rollbackState)
            let succeeded = response.success == true
            if !succeeded, lastError == nil {
                lastError = "服务端未确认撤销回退"
            }
            lastOperationReceipt = CheckpointPresentationPolicy.receipt(
                kind: .unrevert,
                success: succeeded,
                rollbackState: rollbackState(for: sessionId),
                fallbackError: lastError
            )
            return succeeded
        } catch {
            lastError = error.localizedDescription
            lastOperationReceipt = CheckpointPresentationPolicy.receipt(
                kind: .unrevert,
                success: false,
                rollbackState: rollbackState(for: sessionId),
                fallbackError: lastError
            )
            logger.error("unrevert failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func fetchRevertHistory(sessionId: String) async {
        isLoadingHistory = true
        historyLoadFailed = false
        defer { isLoadingHistory = false }
        do {
            let response: ChatCheckpointRevertHistoryResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.revertHistory(sessionId)
            )
            revertHistory = response.history ?? []
        } catch {
            historyLoadFailed = true
            revertHistory = []
            logger.error("revert history failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func rollbackAgentRun(_ agentRunId: String) async -> AgentRunRollbackResponse? {
        guard !isReverting else { return nil }
        isReverting = true
        restoringPhase = "resources"
        lastError = nil
        defer {
            isReverting = false
            restoringPhase = nil
        }
        do {
            let response: AgentRunRollbackResponse = try await APIClient.shared.post(
                path: Endpoints.Chat.rollbackAgentRun(agentRunId)
            )
            return response
        } catch {
            lastError = error.localizedDescription
            logger.error("agent run rollback failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
