import XCTest
@testable import Tabtin

final class CheckpointPresentationPolicyTests: XCTestCase {
    func testOnlyPreviewRevisionConflictsTriggerFreshConfirmation() {
        XCTAssertTrue(
            CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                statusCode: 409,
                businessCode: "ROLLBACK_PREVIEW_STALE"
            )
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                statusCode: 409,
                businessCode: "FILE_PREVIEW_REQUIRED"
            )
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                statusCode: 409,
                businessCode: "FILE_PREVIEW_ACK_REQUIRED"
            )
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                statusCode: 409,
                businessCode: "RUNTIME_REWIND_UNAVAILABLE"
            ),
            "执行设备离线不能伪装成预览过期"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.shouldRefreshEditResendPreview(
                statusCode: 500,
                businessCode: "ROLLBACK_PREVIEW_STALE"
            )
        )
    }

    func testConfirmRequiresARealPreviewAndNeverRunsWhileSubmitting() {
        XCTAssertFalse(
            CheckpointPresentationPolicy.eligibility(
                for: .confirmRollback,
                isSubmitting: false
            ).isEnabled
        )

        let preview = makePreview(noImpact: false)
        XCTAssertTrue(
            CheckpointPresentationPolicy.eligibility(
                for: .confirmRollback,
                preview: preview,
                isSubmitting: false
            ).isEnabled
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.eligibility(
                for: .confirmRollback,
                preview: preview,
                isSubmitting: true
            ).isEnabled
        )
    }

    func testResourceSelectionHonorsServerPlanAndCapabilityScope() {
        let unsupportedPreview = makePreview(resourceRestore: false)
        let restorable = ChatCheckpointResourcePlanItem(
            resourceType: "docs", resourceId: "doc-1", resourceName: "方案",
            action: "restore_version", actionLabel: "恢复到历史版本", canRestore: true,
            restoreToVersionId: "version-1", changeCount: 2
        )
        let locked = CheckpointPresentationPolicy.eligibility(
            for: .selectResourceRestore,
            preview: unsupportedPreview,
            resource: restorable,
            isSubmitting: false
        )
        XCTAssertFalse(locked.isEnabled)
        XCTAssertEqual(locked.disabledReason, "当前 checkpoint 不支持自动恢复资源")

        let unsupportedItem = ChatCheckpointResourcePlanItem(
            resourceType: "docs", resourceId: "doc-2", resourceName: "无版本资源",
            action: "skip", actionLabel: "没有历史版本", canRestore: false,
            restoreToVersionId: nil, changeCount: nil
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.eligibility(
                for: .selectResourceRestore,
                preview: makePreview(resourceRestore: true),
                resource: unsupportedItem,
                isSubmitting: false
            ).isEnabled
        )
    }

    func testUnrevertAndRetryFollowServerRollbackState() {
        let noPermission = makeRollbackState(canUnrevert: false, retryable: [])
        XCTAssertFalse(
            CheckpointPresentationPolicy.eligibility(
                for: .unrevert,
                rollbackState: noPermission,
                isSubmitting: false
            ).isEnabled
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.eligibility(
                for: .retryResources,
                rollbackState: noPermission,
                isSubmitting: false
            ).isEnabled
        )

        let retryable = ChatCheckpointRetryableResource(
            resourceType: "docs", resourceId: "doc-3", resourceName: "故障文档",
            error: "无编辑权限", action: "restore_version", restoreToVersionId: "version-3"
        )
        let actionable = makeRollbackState(canUnrevert: true, retryable: [retryable])
        XCTAssertTrue(
            CheckpointPresentationPolicy.eligibility(
                for: .unrevert,
                rollbackState: actionable,
                isSubmitting: false
            ).isEnabled
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.eligibility(
                for: .retryResources,
                rollbackState: actionable,
                isSubmitting: false
            ).isEnabled
        )
    }

    func testPartialReceiptKeepsRetryableOutcomeVisible() {
        let retryable = ChatCheckpointRetryableResource(
            resourceType: "table", resourceId: "table-1", resourceName: "数据表",
            error: "暂时不可用", action: "restore_version", restoreToVersionId: "version-1"
        )
        let state = makeRollbackState(canUnrevert: true, retryable: [retryable], failedCount: 1)
        let receipt = CheckpointPresentationPolicy.receipt(
            kind: .rollback,
            success: true,
            rollbackState: state
        )

        XCTAssertEqual(receipt.title, "对话已回退，部分内容未恢复")
        XCTAssertTrue(receipt.isFailure)
        XCTAssertTrue(receipt.detail.contains("1 项文档或表格未恢复"))
        XCTAssertEqual(
            CheckpointPresentationPolicy.rollbackStatePresentation(
                state: state,
                receipt: nil
            ).detail,
            "1 项文档或表格未恢复"
        )
    }

    func testSuccessfulReceiptOnlyUsesCompletedCopyAfterServerSuccess() {
        let failed = CheckpointPresentationPolicy.receipt(
            kind: .rollback,
            success: false,
            rollbackState: nil
        )
        let succeeded = CheckpointPresentationPolicy.receipt(
            kind: .rollback,
            success: true,
            rollbackState: nil
        )

        XCTAssertEqual(failed.title, "回退未完成")
        XCTAssertTrue(failed.isFailure)
        XCTAssertEqual(succeeded.title, "对话已回退")
        XCTAssertFalse(succeeded.isFailure)
    }

    func testCapabilityNoticesNameItemsThatWillNotBeRestored() {
        let preview = makePreview(fileRestore: false, resourceRestore: false, unrestorableItems: ["外部链接资源"])
        let notices = CheckpointPresentationPolicy.capabilityNotices(for: preview)

        XCTAssertTrue(notices.contains(where: { $0.id == "file_restore" }))
        XCTAssertTrue(notices.contains(where: { $0.id == "resource_restore" }))
        XCTAssertTrue(notices.contains(where: { $0.id == "unrestorable_items" }))
    }

    func testEditResendBlocksWhenFilePreviewIsUnavailable() throws {
        let payload = """
        {
          "target_message_id": "message-1",
          "messages_to_remove": 3,
          "affected_paths": ["Sources/App.swift", "README.md"],
          "file_preview_status": "unavailable",
          "file_preview_reason": "当前设备没有这轮对话的本地文件版本"
        }
        """
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(payload.utf8)
        )

        XCTAssertEqual(preview.affectedPaths, ["Sources/App.swift", "README.md"])
        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertFalse(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertTrue(risk.detail.contains("当前设备没有这轮对话的本地文件版本"))
    }

    func testEditResendTreatsNoFileChangesAsNotApplicableInsteadOfFailure() throws {
        let payload = """
        {
          "target_message_id": "message-1",
          "messages_to_remove": 1,
          "file_preview_status": "not_applicable",
          "file_preview_reason": "本轮没有工作区文件变更"
        }
        """
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(payload.utf8)
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertFalse(risk.blocksExecution)
        XCTAssertFalse(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertEqual(risk.detail, "本轮没有工作区文件变更")
    }

    func testEditResendBlocksContradictoryFilePreviewStatusAndPaths() throws {
        let availableWithoutPaths = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"available","affected_paths":[]}"#.utf8
            )
        )
        let notApplicableWithPaths = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","affected_paths":["Sources/App.swift"]}"#.utf8
            )
        )

        XCTAssertTrue(
            CheckpointPresentationPolicy.editResendRisk(for: availableWithoutPaths).blocksExecution
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.editResendRisk(for: notApplicableWithPaths).blocksExecution
        )
    }

    func testUnrestorableFilesRequiresNonEmptyDetailsAndExactExecutionSubset() throws {
        let missingDetails = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"unavailable","file_preview_reason":"unrestorable_files","unrestorable_files":[]}"#.utf8
            )
        )
        XCTAssertTrue(CheckpointPresentationPolicy.editResendRisk(for: missingDetails).blocksExecution)
        XCTAssertNil(
            CheckpointPresentationPolicy.acknowledgedFilePreviewReason(for: missingDetails)
        )

        let detailed = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"unavailable","file_preview_reason":"unrestorable_files","unrestorable_files":[{"path":"Known.swift","reason":"file_snapshot_missing"},{"path":"README.md","reason":"no_file_history"}]}"#.utf8
            )
        )
        let risk = CheckpointPresentationPolicy.editResendRisk(for: detailed)
        XCTAssertFalse(risk.blocksExecution)
        XCTAssertTrue(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertEqual(
            CheckpointPresentationPolicy.acknowledgedFilePreviewReason(for: detailed),
            "unrestorable_files"
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: detailed,
                executionStatus: "failed",
                executionReason: "unrestorable_files",
                failedFiles: ["Known.swift"],
                acknowledged: true
            )
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: detailed,
                executionStatus: "failed",
                executionReason: "unrestorable_files",
                failedFiles: [],
                acknowledged: true
            ),
            "明细原因不能在执行阶段丢失 failed_files 后继续发送"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: detailed,
                executionStatus: "failed",
                executionReason: "unrestorable_files",
                failedFiles: ["New.swift"],
                acknowledged: true
            ),
            "执行阶段新增的失败路径不能复用预览许可"
        )
    }

    func testEditResendFailsClosedForMissingOrUnknownFilePreviewStatus() throws {
        let missingStatus = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","messages_to_remove":1,"impact":{"files":{"available":true}}}"#.utf8
            )
        )
        let missingStatusWithLegacySuccess = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","messages_to_remove":1,"file_preview_success":true,"affected_paths":["Sources/App.swift"]}"#.utf8
            )
        )
        let unknownStatus = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","messages_to_remove":1,"file_preview_status":"future_status","file_preview_success":true}"#.utf8
            )
        )

        XCTAssertTrue(CheckpointPresentationPolicy.editResendRisk(for: missingStatus).blocksExecution)
        XCTAssertTrue(
            CheckpointPresentationPolicy.editResendRisk(for: missingStatusWithLegacySuccess).blocksExecution,
            "v2 编辑重发不能用旧布尔字段替代结构化文件状态"
        )
        XCTAssertTrue(CheckpointPresentationPolicy.editResendRisk(for: unknownStatus).blocksExecution)
    }

    func testEditResendBlocksAvailableResourcePreviewWithoutAffectedEvidence() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_preview_status":"available","resource_changes":[],"resource_restore_plan":[]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertTrue(risk.blockingDetail?.contains("资源影响结果") == true)
    }

    func testEditResendFailsClosedWhenResourceRestoreCapabilityIsUnknown() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","messages_to_remove":1,"file_preview_status":"not_applicable","resource_preview_status":"available","resource_changes":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","change_type":"update"}],"resource_restore_plan":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","change_count":1}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertFalse(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertTrue(risk.blockingDetail?.contains("需求文档") == true)
    }

    func testEditResendFailsClosedWhenChangedResourcesHaveNoRestorePlan() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_changes":[{"resource_type":"document","resource_id":"doc-1","change_type":"update"},{"resource_type":"table","resource_id":"table-1","change_type":"update"}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertFalse(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertTrue(risk.blockingDetail?.contains("2 项文档或表格") == true)
    }

    func testEditResendFailsClosedForMalformedRestorableResourcePlan() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_preview_status":"available","resource_changes":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","change_type":"update"}],"resource_restore_plan":[{"resource_type":"document","resource_name":"需求文档","can_restore":true,"action":"restore_version","change_count":1}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertTrue(risk.blockingDetail?.contains("需求文档") == true)
    }

    func testEditResendBlocksWhenResourcePreviewIsUnavailable() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_preview_status":"unavailable","resource_preview_reason":"resource_preview_failed","resource_changes":[{"resource_type":"document","resource_id":"doc-1","change_type":"update"}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertFalse(risk.blockingDetail?.contains("resource_preview_failed") == true)
    }

    func testEditResendBlocksMissingResourceStatusWhenPreviewIsDegraded() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","degraded_reasons":["missing_resource_snapshot"]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertTrue(risk.blockingDetail?.contains("文档和表格") == true)
    }

    func testKnownUnrestorableResourceRequiresCompleteAffectedChangeCoverage() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_preview_status":"available","resource_changes":[{"resource_type":"document","resource_id":"doc-1","change_type":"update"},{"resource_type":"document","resource_id":"doc-1","change_type":"update"}],"resource_restore_plan":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","can_restore":false,"action":"skip","change_count":1}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertTrue(risk.blocksExecution)
        XCTAssertFalse(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertTrue(risk.blockingDetail?.contains("不完整") == true)
    }

    func testEditResendMapsStableFileReasonCodeToFriendlyCopy() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","messages_to_remove":1,"file_preview_status":"unavailable","file_preview_reason":"no_control_device"}"#.utf8
            )
        )

        let detail = CheckpointPresentationPolicy.editResendRisk(for: preview).detail
        XCTAssertFalse(detail.contains("no_control_device"))
        XCTAssertTrue(detail.contains("没有找到执行此任务"))
    }

    func testKnownMissingFileHistoryRequiresExplicitConversationOnlyChoice() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"unavailable","file_preview_reason":"no_file_history"}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertFalse(risk.blocksExecution)
        XCTAssertTrue(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertFalse(risk.acknowledgementDetail?.contains("no_file_history") == true)
        XCTAssertTrue(risk.acknowledgementDetail?.contains("文件不会恢复") == true)

        let contradictoryStatus = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"available","file_preview_reason":"no_file_history","affected_paths":["Sources/App.swift"]}"#.utf8
            )
        )
        XCTAssertNil(
            CheckpointPresentationPolicy.acknowledgedFilePreviewReason(for: contradictoryStatus),
            "只有结构化状态明确 unavailable 时才允许发送文件缺失 ACK"
        )
    }

    func testPreviewFileGapPermissionOnlyMatchesSameConfirmedExecutionGap() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"unavailable","file_preview_reason":"path_guard_denied","affected_paths":["Known.swift","Restorable.swift"],"unrestorable_files":[{"path":"Known.swift","reason":"path_guard_denied"}]}"#.utf8
            )
        )

        XCTAssertTrue(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: preview,
                executionStatus: "failed",
                executionReason: "path_guard_denied",
                failedFiles: ["Known.swift"],
                acknowledged: true
            )
        )
        XCTAssertEqual(preview.unrestorableFiles?.first?.path, "Known.swift")
        XCTAssertFalse(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: preview,
                executionStatus: "unavailable",
                executionReason: "device_offline",
                failedFiles: [],
                acknowledged: true
            ),
            "执行阶段的新失败原因不能复用预览许可"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: preview,
                executionStatus: "partial",
                executionReason: "path_guard_denied",
                failedFiles: ["README.md"],
                acknowledged: true
            ),
            "部分文件写盘失败不能被“没有历史版本”的许可豁免"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: preview,
                executionStatus: "unavailable",
                executionReason: "path_guard_denied",
                failedFiles: ["Restorable.swift"],
                acknowledged: true
            ),
            "仅出现在 affected_paths、但未列入 unrestorable_files 的新失败不能复用预览许可"
        )
    }

    func testEditResendAllowsExplicitConversationOnlyChoiceForKnownUnrestorableResource() throws {
        let payload = """
        {
          "target_message_id": "message-1",
          "messages_to_remove": 1,
          "file_preview_status": "not_applicable",
          "resource_preview_status": "available",
          "resource_changes": [
            {"resource_type": "document", "resource_id": "doc-1", "change_type": "update"},
            {"resource_type": "document", "resource_id": "doc-1", "change_type": "update"}
          ],
          "resource_restore_plan": [{
            "resource_type": "document",
            "resource_id": "doc-1",
            "resource_name": "需求文档",
            "can_restore": false,
            "action": "skip",
            "action_label": "没有可恢复的历史版本",
            "change_count": 2
          }]
        }
        """
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(payload.utf8)
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertFalse(risk.blocksExecution)
        XCTAssertTrue(risk.requiresConversationOnlyAcknowledgement)
        XCTAssertTrue(risk.acknowledgementDetail?.contains("需求文档") == true)
    }

    func testEditResendTreatsExplicitSkipAsKnownConversationOnlyImpact() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","file_preview_status":"not_applicable","resource_preview_status":"available","resource_changes":[{"resource_type":"document","resource_id":"doc-1","change_type":"update"}],"resource_restore_plan":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","can_restore":false,"action":"skip","action_label":"没有可恢复版本","change_count":1}]}"#.utf8
            )
        )

        let risk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        XCTAssertFalse(risk.blocksExecution)
        XCTAssertTrue(risk.requiresConversationOnlyAcknowledgement)
    }

    func testResourceRestorePlanDecodesVersionTimeShownBeforeConfirmation() throws {
        let preview = try JSONDecoder().decode(
            ChatCheckpointRollbackPreview.self,
            from: Data(
                #"{"target_message_id":"message-1","preview_revision":"revision-7","file_preview_revision":"file-revision-7","rollback_contract_version":2,"file_preview_status":"not_applicable","resource_preview_status":"available","resource_preview_reason":null,"resource_changes":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","change_type":"update","summary":"修改 1 处"}],"resource_restore_plan":[{"resource_type":"document","resource_id":"doc-1","resource_name":"需求文档","can_restore":true,"action":"restore_version","restore_to_version_id":"version-1","restore_to_version_time":"2026-08-14T05:20:00Z","change_count":1}]}"#.utf8
            )
        )

        XCTAssertEqual(preview.previewRevision, "revision-7")
        XCTAssertEqual(preview.filePreviewRevision, "file-revision-7")
        XCTAssertEqual(preview.rollbackContractVersion, 2)
        XCTAssertEqual(preview.resourcePreviewStatus, "available")
        XCTAssertEqual(preview.resourceChanges?.first?.summary, "修改 1 处")
        XCTAssertEqual(
            preview.resourceRestorePlan?.first?.restoreToVersionTime,
            "2026-08-14T05:20:00Z"
        )
        XCTAssertFalse(CheckpointPresentationPolicy.editResendRisk(for: preview).blocksExecution)
    }

    func testEditResendExecutePayloadCarriesPreviewRevision() {
        let payload = ChatCheckpointWirePayload.rollbackExecute(
            messageId: "message-1",
            reason: "编辑用户消息",
            mode: "editAndResend",
            previewRevision: "revision-7",
            filePreviewRevision: "file-revision-7",
            acknowledgedFilePreviewReason: "no_file_history"
        )

        XCTAssertEqual(payload["target_message_id"] as? String, "message-1")
        XCTAssertEqual(payload["mode"] as? String, "editAndResend")
        XCTAssertEqual(payload["preview_revision"] as? String, "revision-7")
        XCTAssertEqual(payload["file_preview_revision"] as? String, "file-revision-7")
        XCTAssertEqual(payload["rollback_contract_version"] as? Int, 2)
        XCTAssertEqual(
            payload["acknowledged_file_preview_reason"] as? String,
            "no_file_history"
        )
        XCTAssertNil(
            CheckpointPresentationPolicy.editResendRevisionBlockingDetail(
                previewRevision: "revision-7",
                filePreviewRevision: "file-revision-7"
            )
        )

        let ordinaryRollback = ChatCheckpointWirePayload.rollbackExecute(
            messageId: "message-1",
            reason: "",
            mode: nil,
            previewRevision: nil,
            filePreviewRevision: nil,
            acknowledgedFilePreviewReason: "no_file_history"
        )
        XCTAssertNil(ordinaryRollback["preview_revision"])
        XCTAssertNil(ordinaryRollback["file_preview_revision"])
        XCTAssertNil(ordinaryRollback["rollback_contract_version"])
        XCTAssertNil(ordinaryRollback["acknowledged_file_preview_reason"])

        let editWithoutFileAcknowledgement = ChatCheckpointWirePayload.rollbackExecute(
            messageId: "message-1",
            reason: "编辑用户消息",
            mode: "editAndResend",
            previewRevision: "revision-7",
            filePreviewRevision: "file-revision-7",
            acknowledgedFilePreviewReason: nil
        )
        XCTAssertNil(editWithoutFileAcknowledgement["acknowledged_file_preview_reason"])
        XCTAssertNotNil(
            CheckpointPresentationPolicy.editResendRevisionBlockingDetail(
                previewRevision: nil,
                filePreviewRevision: nil
            )
        )
        XCTAssertNotNil(
            CheckpointPresentationPolicy.editResendRevisionBlockingDetail(
                previewRevision: "revision-7",
                filePreviewRevision: nil
            )
        )

        let resourcePayload = ChatCheckpointWirePayload.resourceRestore(
            items: [
                ChatCheckpointResourceRestoreItem(
                    resourceType: "document",
                    resourceId: "doc-1",
                    action: "restore_version",
                    restoreToVersionId: "version-1"
                ),
            ],
            previewRevision: "revision-7",
            rollbackContractVersion: 2
        )
        XCTAssertEqual(resourcePayload["preview_revision"] as? String, "revision-7")
        XCTAssertEqual(resourcePayload["rollback_contract_version"] as? Int, 2)
        let resourceItems = resourcePayload["items"] as? [[String: Any]]
        XCTAssertEqual(resourceItems?.first?["resource_id"] as? String, "doc-1")
        XCTAssertEqual(resourceItems?.first?["restore_to_version_id"] as? String, "version-1")

        let explicitDecisions = ChatCheckpointWirePayload.resourceRestoreItems(
            from: [
                ChatCheckpointResourcePlanItem(
                    resourceType: "document",
                    resourceId: "doc-1",
                    resourceName: "需求文档",
                    action: "restore_version",
                    actionLabel: nil,
                    canRestore: true,
                    restoreToVersionId: "version-1",
                    changeCount: 1
                ),
                ChatCheckpointResourcePlanItem(
                    resourceType: "table",
                    resourceId: "table-1",
                    resourceName: "排期表",
                    action: "skip",
                    actionLabel: nil,
                    canRestore: true,
                    restoreToVersionId: nil,
                    changeCount: 1
                ),
                ChatCheckpointResourcePlanItem(
                    resourceType: "document",
                    resourceId: "doc-2",
                    resourceName: "无版本文档",
                    action: "no_version",
                    actionLabel: nil,
                    canRestore: false,
                    restoreToVersionId: nil,
                    changeCount: 1
                ),
            ],
            includesExplicitSkips: true
        )
        XCTAssertEqual(explicitDecisions.count, 3, "v2 必须提交预览计划全集")
        XCTAssertEqual(explicitDecisions.map(\.action), ["restore_version", "skip", "skip"])
        XCTAssertEqual(explicitDecisions[0].restoreToVersionId, "version-1")
        XCTAssertNil(explicitDecisions[1].restoreToVersionId)
        XCTAssertNil(explicitDecisions[2].restoreToVersionId)
        let fullDecisionPayload = ChatCheckpointWirePayload.resourceRestore(
            items: explicitDecisions,
            previewRevision: "revision-7",
            rollbackContractVersion: 2
        )
        let fullDecisionItems = fullDecisionPayload["items"] as? [[String: Any]]
        XCTAssertEqual(fullDecisionItems?.count, 3)
        XCTAssertEqual(fullDecisionItems?.compactMap { $0["action"] as? String }, [
            "restore_version", "skip", "skip",
        ])

        let legacySelectedItems = ChatCheckpointWirePayload.resourceRestoreItems(
            from: [
                ChatCheckpointResourcePlanItem(
                    resourceType: "document",
                    resourceId: "doc-1",
                    resourceName: nil,
                    action: "restore_version",
                    actionLabel: nil,
                    canRestore: true,
                    restoreToVersionId: "version-1",
                    changeCount: 1
                ),
                ChatCheckpointResourcePlanItem(
                    resourceType: "document",
                    resourceId: "doc-2",
                    resourceName: nil,
                    action: "skip",
                    actionLabel: nil,
                    canRestore: true,
                    restoreToVersionId: nil,
                    changeCount: 1
                ),
            ],
            includesExplicitSkips: false
        )
        XCTAssertEqual(legacySelectedItems.count, 1, "普通回退继续保持旧客户端仅提交恢复项的语义")
    }

    func testResourceRestoreConflictGetsStructuredFriendlyHandling() {
        XCTAssertTrue(
            CheckpointPresentationPolicy.isResourceRestoreContractConflict(
                statusCode: 409,
                businessCode: "RESOURCE_RESTORE_PLAN_INCOMPLETE"
            )
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.isResourceRestoreContractConflict(
                statusCode: 409,
                businessCode: "RESOURCE_RESTORE_PLAN_STALE"
            )
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.isResourceRestoreContractConflict(
                statusCode: 409,
                businessCode: "RUNTIME_BUSY"
            )
        )
    }

    func testRollbackResponseDecodesModeAndStructuredFileStatus() throws {
        let payload = """
        {
          "success": true,
          "mode": "editAndResend",
          "file_restore_success": false,
          "file_restore_status": "partial",
          "file_restore_reason": "device_offline",
          "failed_files": ["Sources/App.swift"],
          "rollback_state": {
            "session_id": "session-1",
            "revert_active": true,
            "last_operation_mode": "editAndResend",
            "partial_success_details": {
              "workspace_files": {
                "success": false,
                "status": "partial_success",
                "reason": "device_offline"
              }
            }
          }
        }
        """

        let response = try JSONDecoder().decode(
            ChatCheckpointRollbackResponse.self,
            from: Data(payload.utf8)
        )
        XCTAssertEqual(response.mode, "editAndResend")
        XCTAssertEqual(response.fileRestoreStatus, "partial")
        XCTAssertEqual(response.failedFiles, ["Sources/App.swift"])
        XCTAssertEqual(response.rollbackState?.lastOperationMode, "editAndResend")
        XCTAssertTrue(response.rollbackState?.hasFileFailure == true)
        XCTAssertEqual(response.rollbackState?.effectiveFileRestoreReason, "device_offline")
    }

    func testEditResendOnlySendsAfterAuthoritativeRefreshAndCompleteRestore() {
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: false,
                fileRestoreStatus: "success",
                resourceFailedCount: 0
            )
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "unavailable",
                resourceFailedCount: 0
            ),
            "预览许可未在调用前完成精确匹配时，不得宽泛放行 unavailable"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "failed",
                resourceFailedCount: 0
            )
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "not_applicable",
                resourceFailedCount: 0
            ),
            "明确为无需恢复时可以继续发送"
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "success",
                resourceFailedCount: 0
            )
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "future_status",
                resourceFailedCount: 0
            ),
            "无法识别新的恢复状态时必须阻断自动发送"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: nil,
                resourceFailedCount: 0
            ),
            "缺失结构化恢复状态时不能把未知结果当作成功"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteEditResend(
                historyRefreshSucceeded: true,
                fileRestoreStatus: "success",
                resourceFailedCount: 1
            ),
            "任何已选择资源的新恢复失败都必须停止发送"
        )

        XCTAssertTrue(
            CheckpointPresentationPolicy.canCompleteSelectedResourceRestore(
                responseSuccess: true,
                restoredCount: 2,
                failedCount: 0,
                expectedRestoreCount: 2,
                rollbackContractVersion: 2
            )
        )
        XCTAssertTrue(
            CheckpointPresentationPolicy.canCompleteSelectedResourceRestore(
                responseSuccess: true,
                restoredCount: 0,
                failedCount: 0,
                expectedRestoreCount: 0,
                rollbackContractVersion: 2
            ),
            "计划全集均显式 skip 时，服务端无需恢复任何资源即可完成"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteSelectedResourceRestore(
                responseSuccess: true,
                restoredCount: 1,
                failedCount: 0,
                expectedRestoreCount: 2,
                rollbackContractVersion: 2
            ),
            "v2 回执未覆盖所有已选择资源时必须停止发送"
        )
        XCTAssertFalse(
            CheckpointPresentationPolicy.canCompleteSelectedResourceRestore(
                responseSuccess: true,
                restoredCount: nil,
                failedCount: nil,
                expectedRestoreCount: 1,
                rollbackContractVersion: 2
            ),
            "v2 缺失资源结果不能按成功处理"
        )
    }

    func testRollbackBannerUsesStructuredNotApplicableStatusAndOperationKey() throws {
        let firstPayload = #"{"session_id":"session-1","revert_active":true,"target_message_id":"message-1","last_apply_result":"success","last_operation_mode":"rollback","updated_at":"2026-08-14T05:20:00Z","partial_success_details":{"workspace_files":{"success":false,"status":"not_applicable"}}}"#
        let secondPayload = #"{"session_id":"session-1","revert_active":true,"target_message_id":"message-1","last_apply_result":"success","last_operation_mode":"rollback","updated_at":"2026-08-14T05:21:00Z","partial_success_details":{"workspace_files":{"success":false,"status":"not_applicable"}}}"#
        let first = try JSONDecoder().decode(
            ChatCheckpointSessionRollbackState.self,
            from: Data(firstPayload.utf8)
        )
        let second = try JSONDecoder().decode(
            ChatCheckpointSessionRollbackState.self,
            from: Data(secondPayload.utf8)
        )

        XCTAssertFalse(first.hasFileFailure)
        XCTAssertTrue(first.hasFileRestoreOutcome)
        XCTAssertEqual(first.fileRestoreBadgeDetail, "无需恢复")
        XCTAssertNotEqual(first.operationKey, second.operationKey)
    }

    private func makePreview(
        noImpact: Bool = false,
        fileRestore: Bool = true,
        resourceRestore: Bool = true,
        unrestorableItems: [String] = []
    ) -> ChatCheckpointRollbackPreview {
        let record = ChatCheckpointRecord(
            checkpointId: "checkpoint-1", sessionId: "session-1", anchorType: "assistant_turn",
            status: .ready,
            capabilityScope: ChatCheckpointCapabilityScope(
                messagePreview: true, fileDiff: true, fileRestore: fileRestore,
                resourceRestore: resourceRestore, unrevert: true
            ),
            degradedReasons: nil,
            contextSummary: nil,
            impactSummary: ChatCheckpointImpactSummary(
                fileSummary: ChatCheckpointFileSummary(changed: 1, insertions: 1, deletions: 0, files: [])
            )
        )
        return ChatCheckpointRollbackPreview(
            targetMessageId: "message-1", messagesToRemove: 2, messagesPreview: [],
            resourceRestorePlan: [], effectiveCheckpoint: record, degradedReasons: nil,
            noImpact: noImpact,
            impact: ChatCheckpointImpact(
                files: ChatCheckpointImpactFiles(available: true, diffAvailable: true),
                resources: ChatCheckpointImpactResources(available: true, changeCount: 0, restoreCount: 0),
                messages: ChatCheckpointImpactMessages(toRemove: 2)
            ),
            unrestorableItems: unrestorableItems
        )
    }

    private func makeRollbackState(
        canUnrevert: Bool,
        retryable: [ChatCheckpointRetryableResource],
        failedCount: Int = 0
    ) -> ChatCheckpointSessionRollbackState {
        ChatCheckpointSessionRollbackState(
            sessionId: "session-1", revertActive: true, targetMessageId: "message-1",
            cleanupStatus: "pending", canUnrevert: canUnrevert,
            lastApplyResult: failedCount > 0 ? "partial_success" : "success",
            lastRollbackReason: nil,
            partialSuccessDetails: ChatCheckpointPartialSuccessDetails(
                workspaceFiles: .init(success: true, reason: nil),
                resources: .init(restoredCount: 1, failedCount: failedCount, retryable: retryable)
            )
        )
    }
}
