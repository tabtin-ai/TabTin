import Foundation

/// Checkpoint 的客户端只负责解释后端已给出的预览、能力范围与回执；
/// 是否能读写 Project / 资源仍由每个 endpoint 以当前身份判定。
enum CheckpointPresentationAction: Equatable {
    case confirmRollback
    case viewFileDiff
    case selectResourceRestore
    case retryResources
    case unrevert
}

struct CheckpointActionEligibility: Equatable {
    let isEnabled: Bool
    let disabledReason: String?
}

struct CheckpointCapabilityNotice: Equatable, Identifiable {
    let id: String
    let title: String
    let detail: String
    let isAvailable: Bool
}

struct CheckpointRollbackStatePresentation: Equatable {
    let title: String
    let detail: String
    let isPartial: Bool
}

enum CheckpointOperationKind: Equatable {
    case rollback
    case restoreResources
    case unrevert
}

struct CheckpointOperationReceipt: Equatable {
    let kind: CheckpointOperationKind
    let title: String
    let detail: String
    let isFailure: Bool
}

struct CheckpointEditResendRisk: Equatable {
    let blocksExecution: Bool
    let requiresConversationOnlyAcknowledgement: Bool
    let detail: String
    let resourceDetail: String
    let blockingDetail: String?
    let acknowledgementDetail: String?
}

enum CheckpointPresentationPolicy {
    static func shouldRefreshEditResendPreview(
        statusCode: Int,
        businessCode: String?
    ) -> Bool {
        guard statusCode == 409, let businessCode else { return false }
        return [
            "ROLLBACK_PREVIEW_REQUIRED",
            "FILE_PREVIEW_REQUIRED",
            "ROLLBACK_PREVIEW_STALE",
            "FILE_PREVIEW_STALE",
            "FILE_PREVIEW_ACK_REQUIRED",
        ].contains(businessCode)
    }

    static func isResourceRestoreContractConflict(
        statusCode: Int,
        businessCode: String?
    ) -> Bool {
        guard statusCode == 409, let businessCode else { return false }
        return [
            "ROLLBACK_PREVIEW_REQUIRED",
            "ROLLBACK_PREVIEW_STALE",
            "RESOURCE_RESTORE_PLAN_INVALID",
            "RESOURCE_RESTORE_PLAN_STALE",
            "RESOURCE_RESTORE_PLAN_INCOMPLETE",
            "RESOURCE_PREVIEW_UNAVAILABLE",
        ].contains(businessCode)
    }

    static func editResendRevisionBlockingDetail(
        previewRevision: String?,
        filePreviewRevision: String?
    ) -> String? {
        guard let revision = previewRevision?.trimmingCharacters(in: .whitespacesAndNewlines),
              !revision.isEmpty else {
            return "影响预览缺少有效版本，请重新检查后再发送"
        }
        guard let fileRevision = filePreviewRevision?.trimmingCharacters(in: .whitespacesAndNewlines),
              !fileRevision.isEmpty else {
            return "文件影响预览缺少有效版本，请重新检查后再发送"
        }
        return nil
    }

    /// 编辑重发是时间线重写。文件影响必须在执行前得到确定结果；不可用或未知时
    /// fail-closed，只允许重试/取消。只有预览已证明不可恢复的资源，才允许用户明确
    /// 接受“仅重写对话”。`not_applicable` 代表本轮确实没有文件变更。
    static func editResendRisk(for preview: ChatCheckpointRollbackPreview) -> CheckpointEditResendRisk {
        let normalizedStatus = preview.filePreviewStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let filePreviewBlocksExecution: Bool
        let fileDetail: String
        var fileAcknowledgementDetail: String? = nil
        switch normalizedStatus {
        case "available":
            let paths = preview.affectedPaths ?? []
            let hasValidAffectedPaths = !paths.isEmpty && paths.allSatisfy {
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            filePreviewBlocksExecution = !hasValidAffectedPaths
            fileDetail = hasValidAffectedPaths
                ? "将尝试恢复 \(paths.count) 个工作区文件"
                : "文件影响结果与恢复范围不一致，请重新检查"
        case "not_applicable":
            let hasAffectedPaths = !(preview.affectedPaths ?? []).isEmpty
            filePreviewBlocksExecution = hasAffectedPaths
            fileDetail = hasAffectedPaths
                ? "文件影响结果与受影响路径不一致，请重新检查"
                : "本轮没有工作区文件变更"
        case "unavailable":
            fileDetail = filePreviewUnavailableMessage(preview.filePreviewReason)
            if acknowledgedFilePreviewReason(for: preview) != nil {
                filePreviewBlocksExecution = false
                fileAcknowledgementDetail = "工作区文件：\(fileDetail)"
            } else {
                filePreviewBlocksExecution = true
            }
        case .some:
            filePreviewBlocksExecution = true
            fileDetail = "当前版本无法识别文件影响结果，请更新应用或重新检查"
        case nil:
            // 编辑重发固定使用 v2 时间线重写契约。旧布尔字段只能用于普通回退展示，
            // 不能代替结构化状态，否则空路径会再次被误判为“没有文件影响”。
            filePreviewBlocksExecution = true
            fileDetail = "当前版本无法提前确认文件变化，请重新检查后再继续"
        }

        let resourceRisk = resourcePreviewRisk(for: preview)
        let acknowledgementDetail = [fileAcknowledgementDetail, resourceRisk.acknowledgementDetail]
            .compactMap { $0 }
            .joined(separator: "；")
        return .init(
            blocksExecution: filePreviewBlocksExecution || resourceRisk.blocksExecution,
            requiresConversationOnlyAcknowledgement: !acknowledgementDetail.isEmpty,
            detail: fileDetail,
            resourceDetail: resourceRisk.detail,
            blockingDetail: filePreviewBlocksExecution ? fileDetail : resourceRisk.blockingDetail,
            acknowledgementDetail: acknowledgementDetail.isEmpty ? nil : acknowledgementDetail
        )
    }

    static func filePreviewUnavailableMessage(_ reason: String?) -> String {
        let normalized = reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "device_offline", "control_device_offline", "preview_not_delivered", "preview_timeout",
             "preview_failed", "preview_error":
            return "执行此任务的桌面设备未连接或未响应，暂时无法确认文件变化"
        case "execution_context_missing", "no_control_device", "device_fingerprint_missing":
            return "没有找到执行此任务且保存文件版本的设备"
        case "not_electron_host":
            return "文件版本保存在其他执行设备上，当前手机无法确认变化"
        case "file_snapshot_missing", "no_file_history":
            return "这轮操作没有可用的文件版本，工作区文件不会恢复"
        case "no_file_anchor":
            return "没有找到这轮操作对应的文件版本位置，暂时无法确认变化"
        case "path_guard_denied":
            return "部分文件位于当前工作区之外或受系统保护，无法安全恢复"
        case "unrestorable_files":
            return "预览列出的文件没有可恢复版本，工作区文件不会恢复"
        default:
            if let reason, !reason.isEmpty, !looksLikeStableReasonCode(reason) {
                return reason
            }
            return "当前无法确认或恢复工作区文件，请连接执行此任务的设备后重试"
        }
    }

    static func fileRestoreFailureMessage(_ reason: String?) -> String {
        let normalized = reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "device_offline", "control_device_offline", "preview_not_delivered", "preview_timeout":
            return "执行此任务的桌面设备未连接或未响应，工作区文件未恢复"
        case "execution_context_missing", "no_control_device", "device_fingerprint_missing":
            return "没有找到保存这轮文件版本的执行设备，工作区文件未恢复"
        case "not_electron_host":
            return "文件版本保存在其他执行设备上，当前手机无法恢复"
        case "file_snapshot_missing", "no_file_history", "no_file_anchor", "no_file_changes",
             "unrestorable_files":
            return "这轮操作没有可用的文件版本记录，工作区文件未恢复"
        case "path_guard_denied":
            return "部分文件位于当前工作区之外或受系统保护，无法安全恢复"
        default:
            if let reason, !reason.isEmpty, !looksLikeStableReasonCode(reason) {
                return reason
            }
            return "工作区文件未恢复，请在执行此任务的桌面设备上检查"
        }
    }

    private static func looksLikeStableReasonCode(_ value: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return !value.isEmpty && value.unicodeScalars.allSatisfy(allowed.contains)
    }

    private static func knownUnrestorableFileReasonCode(_ reason: String?) -> String? {
        let normalized = reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "no_file_history", "file_snapshot_missing", "path_guard_denied", "unrestorable_files":
            return normalized
        default:
            return nil
        }
    }

    /// v2 execute 只接受预览已明确证明的稳定缺口；瞬时故障和未知码绝不进入 ACK。
    static func acknowledgedFilePreviewReason(
        for preview: ChatCheckpointRollbackPreview
    ) -> String? {
        guard preview.filePreviewStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() == "unavailable" else {
            return nil
        }
        guard let reason = knownUnrestorableFileReasonCode(preview.filePreviewReason) else {
            return nil
        }
        if reason == "unrestorable_files" {
            let items = preview.unrestorableFiles ?? []
            guard !items.isEmpty,
                  items.allSatisfy({ !$0.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                return nil
            }
        }
        return reason
    }

    /// 预览许可只能覆盖同一轮已经明确告知的文件缺失。瞬时失败、未知状态、partial，
    /// 或执行阶段换成了另一种原因，都必须重新暂停。
    static func executionMatchesAcknowledgedPreviewFileGap(
        preview: ChatCheckpointRollbackPreview,
        executionStatus: String?,
        executionReason: String?,
        failedFiles: [String],
        acknowledged: Bool
    ) -> Bool {
        let normalizedExecutionStatus = executionStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard acknowledged,
              normalizedExecutionStatus == "unavailable" || normalizedExecutionStatus == "failed",
              let previewReason = acknowledgedFilePreviewReason(for: preview),
              let executionReason = knownUnrestorableFileReasonCode(executionReason),
              previewReason == executionReason else {
            return false
        }

        if previewReason == "unrestorable_files" {
            guard !failedFiles.isEmpty else { return false }
            let knownFailedPaths = Set(
                (preview.unrestorableFiles ?? []).map(\.path)
            )
            return Set(failedFiles).isSubset(of: knownFailedPaths)
        }

        if !failedFiles.isEmpty {
            let knownFailedPaths = Set(
                (preview.unrestorableFiles ?? []).compactMap { item -> String? in
                    guard knownUnrestorableFileReasonCode(item.reason) == executionReason else {
                        return nil
                    }
                    return item.path
                }
            )
            guard !knownFailedPaths.isEmpty else { return false }
            return Set(failedFiles).isSubset(of: knownFailedPaths)
        }
        return true
    }

    private struct ResourcePreviewRisk {
        let blocksExecution: Bool
        let detail: String
        let blockingDetail: String?
        let acknowledgementDetail: String?
    }

    private static func resourcePreviewRisk(
        for preview: ChatCheckpointRollbackPreview
    ) -> ResourcePreviewRisk {
        let status = preview.resourcePreviewStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let changes = preview.resourceChanges ?? []
        let plan = preview.resourceRestorePlan ?? []
        let impactCount = preview.impact?.resources?.changeCount ?? 0
        let hasAffectedResources = !changes.isEmpty || !plan.isEmpty || impactCount > 0
        let hasDegradedPreview = !(preview.degradedReasons ?? []).isEmpty
            || !(preview.effectiveCheckpoint?.degradedReasons ?? []).isEmpty
            || preview.effectiveCheckpoint?.status == .degraded

        switch status {
        case "not_applicable":
            guard !hasAffectedResources else {
                return blockedResourceRisk("资源预览与受影响内容不一致，请重新检查")
            }
            return .init(
                blocksExecution: false,
                detail: "本轮没有文档或表格变更",
                blockingDetail: nil,
                acknowledgementDetail: nil
            )
        case "unavailable":
            return blockedResourceRisk(resourcePreviewUnavailableMessage(preview.resourcePreviewReason))
        case "available":
            guard hasAffectedResources else {
                return blockedResourceRisk("资源影响结果与恢复范围不一致，请重新检查")
            }
            if let invalidDetail = invalidResourcePlanDetail(
                changes: changes,
                plan: plan,
                impactCount: preview.impact?.resources?.changeCount,
                resourceRestoreCapability: preview.effectiveCheckpoint?.capabilityScope?.resourceRestore
            ) {
                return blockedResourceRisk(invalidDetail)
            }
            let unavailable = plan.filter { $0.canRestore == false }
            if let first = unavailable.first {
                let name = first.resourceName.flatMap { $0.isEmpty ? nil : $0 } ?? "文档或表格"
                let label = first.actionLabel.flatMap {
                    $0.isEmpty || looksLikeStableReasonCode($0) ? nil : $0
                } ?? "没有可恢复的历史版本"
                let suffix = unavailable.count > 1 ? "等 \(unavailable.count) 项" : ""
                return .init(
                    blocksExecution: false,
                    detail: "有 \(unavailable.count) 项文档或表格不会恢复",
                    blockingDetail: nil,
                    acknowledgementDetail: "\(name)\(suffix)：\(label)"
                )
            }
            return .init(
                blocksExecution: false,
                detail: "将按预览恢复 \(plan.count) 项文档或表格",
                blockingDetail: nil,
                acknowledgementDetail: nil
            )
        case .some:
            return blockedResourceRisk("当前版本无法识别资源影响结果，请更新应用或重新检查")
        case nil:
            if hasAffectedResources || hasDegradedPreview {
                return blockedResourceRisk("文档和表格的影响结果尚未确认，请重新检查")
            }
            return .init(
                blocksExecution: false,
                detail: "未发现文档或表格变更",
                blockingDetail: nil,
                acknowledgementDetail: nil
            )
        }
    }

    private static func blockedResourceRisk(_ detail: String) -> ResourcePreviewRisk {
        .init(
            blocksExecution: true,
            detail: detail,
            blockingDetail: detail,
            acknowledgementDetail: nil
        )
    }

    private static func resourcePreviewUnavailableMessage(_ reason: String?) -> String {
        let normalized = reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "resource_preview_timeout", "resource_preview_failed", "resource_query_failed",
             "resource_preview_error":
            return "文档和表格的版本检查未完成，请重新检查"
        case "resource_service_unavailable", "resource_device_offline":
            return "文档和表格的版本服务暂时不可用，请稍后重试"
        default:
            if let reason, !reason.isEmpty, !looksLikeStableReasonCode(reason) {
                return reason
            }
            return "当前无法确认文档和表格的恢复范围，请重新检查"
        }
    }

    private static func invalidResourcePlanDetail(
        changes: [ChatCheckpointResourceChange],
        plan: [ChatCheckpointResourcePlanItem],
        impactCount: Int?,
        resourceRestoreCapability: Bool?
    ) -> String? {
        guard !changes.isEmpty, !plan.isEmpty else {
            return "受影响文档和表格的恢复计划不完整，请重新检查"
        }
        if let impactCount, impactCount != changes.count {
            return "受影响文档和表格的数量与恢复计划不一致，请重新检查"
        }

        var changesByResource: [String: Int] = [:]
        for change in changes {
            guard let key = resourceKey(type: change.resourceType, id: change.resourceId) else {
                return "受影响文档或表格缺少必要信息，请重新检查"
            }
            changesByResource[key, default: 0] += 1
        }

        var planByResource: [String: ChatCheckpointResourcePlanItem] = [:]
        for item in plan {
            let name = item.resourceName.flatMap { $0.isEmpty ? nil : $0 } ?? "文档或表格"
            guard let key = resourceKey(type: item.resourceType, id: item.resourceId),
                  planByResource[key] == nil,
                  let expectedCount = changesByResource[key],
                  item.changeCount == expectedCount,
                  let canRestore = item.canRestore,
                  let action = item.action?.lowercased(), !action.isEmpty else {
                return "\(name)的恢复计划不完整，请重新检查"
            }
            if canRestore {
                guard resourceRestoreCapability != false else {
                    return "\(name)当前无法确认是否可以恢复，请重新检查"
                }
                if action == "restore_version" {
                    guard item.restoreToVersionId?.isEmpty == false else {
                        return "\(name)缺少要恢复到的版本，请重新检查"
                    }
                } else if action != "trash" {
                    return "\(name)的恢复方式尚未确认，请重新检查"
                }
            } else if action != "skip" && action != "no_version" {
                return "\(name)的不可恢复范围尚未确认，请重新检查"
            }
            planByResource[key] = item
        }

        guard Set(planByResource.keys) == Set(changesByResource.keys) else {
            return "受影响文档和表格的恢复计划不完整，请重新检查"
        }
        return nil
    }

    private static func resourceKey(type: String?, id: String?) -> String? {
        guard let type = type?.trimmingCharacters(in: .whitespacesAndNewlines), !type.isEmpty,
              let id = id?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
            return nil
        }
        return "\(type):\(id)"
    }

    /// 只有权威历史已经替换成功，且结构化恢复结果明确为成功/无需恢复，
    /// 编辑后的内容才可以发送。预览已确认的文件缺失要先做精确原因匹配，再由调用方归一化。
    static func canCompleteEditResend(
        historyRefreshSucceeded: Bool,
        fileRestoreStatus: String?,
        resourceFailedCount: Int
    ) -> Bool {
        guard historyRefreshSucceeded else { return false }

        let normalizedStatus = fileRestoreStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard normalizedStatus == "success" || normalizedStatus == "not_applicable" else {
            return false
        }
        return resourceFailedCount == 0
    }

    /// v2 编辑重发要求资源恢复回执覆盖每一个已选择项；缺字段、少回执或任一失败
    /// 都不能继续发送。普通回退保留旧服务端兼容语义。
    static func canCompleteSelectedResourceRestore(
        responseSuccess: Bool?,
        restoredCount: Int?,
        failedCount: Int?,
        expectedRestoreCount: Int,
        rollbackContractVersion: Int?
    ) -> Bool {
        guard responseSuccess == true else { return false }
        if rollbackContractVersion == 2 {
            return failedCount == 0 && restoredCount == expectedRestoreCount
        }
        return (failedCount ?? 0) == 0
    }

    static func eligibility(
        for action: CheckpointPresentationAction,
        preview: ChatCheckpointRollbackPreview? = nil,
        resource: ChatCheckpointResourcePlanItem? = nil,
        rollbackState: ChatCheckpointSessionRollbackState? = nil,
        isSubmitting: Bool
    ) -> CheckpointActionEligibility {
        if isSubmitting {
            return .init(isEnabled: false, disabledReason: "正在提交本次回退，请等待处理结果")
        }

        switch action {
        case .confirmRollback:
            guard let preview else {
                return .init(isEnabled: false, disabledReason: "尚未取得回退预览")
            }
            guard preview.noImpact != true else {
                return .init(isEnabled: false, disabledReason: "此位置没有可回退的内容")
            }
            // preview 由同一身份的受保护 endpoint 返回；客户端不凭空推导 Project 写权限。
            return .init(isEnabled: true, disabledReason: nil)
        case .viewFileDiff:
            let scope = preview?.effectiveCheckpoint?.capabilityScope
            let hasFileSummary = (preview?.effectiveCheckpoint?.impactSummary?.fileSummary?.changed ?? 0) > 0
                || !(preview?.effectiveCheckpoint?.impactSummary?.fileSummary?.files ?? []).isEmpty
            guard scope?.fileDiff == true, hasFileSummary else {
                return .init(isEnabled: false, disabledReason: "当前 checkpoint 未提供可查看的文件变更")
            }
            return .init(isEnabled: true, disabledReason: nil)
        case .selectResourceRestore:
            guard let resource else {
                return .init(isEnabled: false, disabledReason: "资源恢复项不存在")
            }
            guard resource.canRestore == true else {
                return .init(isEnabled: false, disabledReason: resource.actionLabel ?? "该资源没有可恢复的历史版本")
            }
            if preview?.effectiveCheckpoint?.capabilityScope?.resourceRestore == false {
                return .init(isEnabled: false, disabledReason: "当前 checkpoint 不支持自动恢复资源")
            }
            return .init(isEnabled: true, disabledReason: nil)
        case .retryResources:
            guard let rollbackState, !rollbackState.retryableItems.isEmpty else {
                return .init(isEnabled: false, disabledReason: "没有可重试的资源恢复")
            }
            return .init(isEnabled: true, disabledReason: nil)
        case .unrevert:
            guard rollbackState?.revertActive == true else {
                return .init(isEnabled: false, disabledReason: "当前对话不在回退状态")
            }
            guard rollbackState?.canUnrevert == true else {
                return .init(isEnabled: false, disabledReason: "当前无法恢复到回退前的状态")
            }
            return .init(isEnabled: true, disabledReason: nil)
        }
    }

    static func capabilityNotices(for preview: ChatCheckpointRollbackPreview) -> [CheckpointCapabilityNotice] {
        let scope = preview.effectiveCheckpoint?.capabilityScope
        let fallbackReasons = preview.degradedReasons ?? preview.effectiveCheckpoint?.degradedReasons ?? []
        var notices: [CheckpointCapabilityNotice] = []

        if scope?.fileRestore == false || fallbackReasons.contains("missing_file_snapshot") {
            notices.append(.init(
                id: "file_restore",
                title: "工作区文件不会自动恢复",
                detail: "这个位置没有可用的文件版本；本次只会处理预览中已确认的对话与资源。",
                isAvailable: false
            ))
        }
        if scope?.resourceRestore == false || fallbackReasons.contains("missing_resource_snapshot") {
            notices.append(.init(
                id: "resource_restore",
                title: "资源不会自动恢复",
                detail: "没有保存文档、表格等资源的历史版本，相关资源需要手动检查。",
                isAvailable: false
            ))
        }
        if !(preview.unrestorableItems ?? []).isEmpty {
            notices.append(.init(
                id: "unrestorable_items",
                title: "存在不可自动恢复的项目",
                detail: "下方列出的项目不会被本次回退自动恢复。",
                isAvailable: false
            ))
        }
        if notices.isEmpty {
            notices.append(.init(
                id: "scope_ready",
                title: "按预览范围回退",
                detail: "仅处理服务端预览明确列出的影响范围。",
                isAvailable: true
            ))
        }
        return notices
    }

    static func rollbackStatePresentation(
        state: ChatCheckpointSessionRollbackState,
        receipt: CheckpointOperationReceipt?
    ) -> CheckpointRollbackStatePresentation {
        if let receipt {
            return .init(title: receipt.title, detail: receipt.detail, isPartial: receipt.isFailure)
        }
        if state.hasFileFailure || state.resourceFailedCount > 0 {
            var incompleteItems: [String] = []
            if state.hasFileFailure {
                incompleteItems.append(
                    fileRestoreFailureMessage(state.effectiveFileRestoreReason)
                )
            }
            if state.resourceFailedCount > 0 {
                incompleteItems.append("\(state.resourceFailedCount) 项文档或表格未恢复")
            }
            return .init(
                title: "对话已回退，部分内容未恢复",
                detail: incompleteItems.joined(separator: "；"),
                isPartial: true
            )
        }
        return .init(
            title: "对话已回退",
            detail: state.canUnrevert == true
                ? "发送新消息前，仍可恢复到回退前的状态。"
                : "本次影响已按预览处理。",
            isPartial: false
        )
    }

    static func receipt(
        kind: CheckpointOperationKind,
        success: Bool,
        rollbackState: ChatCheckpointSessionRollbackState?,
        fallbackError: String? = nil
    ) -> CheckpointOperationReceipt {
        if !success {
            let title: String
            switch kind {
            case .rollback: title = "回退未完成"
            case .restoreResources: title = "资源恢复未完成"
            case .unrevert: title = "撤销回退未完成"
            }
            return .init(
                kind: kind,
                title: title,
                detail: fallbackError ?? "服务端未确认本次操作，请检查后重试。",
                isFailure: true
            )
        }

        if let rollbackState, rollbackState.hasFileFailure || rollbackState.resourceFailedCount > 0 {
            var incompleteItems: [String] = []
            if rollbackState.hasFileFailure {
                incompleteItems.append(
                    fileRestoreFailureMessage(rollbackState.effectiveFileRestoreReason)
                )
            }
            if rollbackState.resourceFailedCount > 0 {
                incompleteItems.append("\(rollbackState.resourceFailedCount) 项文档或表格未恢复")
            }
            return .init(
                kind: kind,
                title: "对话已回退，部分内容未恢复",
                detail: incompleteItems.joined(separator: "；"),
                isFailure: true
            )
        }
        switch kind {
        case .rollback:
            return .init(kind: kind, title: "对话已回退", detail: "影响范围已按发送前预览处理。", isFailure: false)
        case .restoreResources:
            return .init(kind: kind, title: "资源恢复已完成", detail: "资源恢复结果已写入本次回退状态。", isFailure: false)
        case .unrevert:
            return .init(kind: kind, title: "已撤销回退", detail: "对话已恢复到回退前的状态。", isFailure: false)
        }
    }
}
