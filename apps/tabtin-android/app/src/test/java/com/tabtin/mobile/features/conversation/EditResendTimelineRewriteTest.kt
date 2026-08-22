package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ResourceRestoreResponse
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.data.model.RollbackResponse
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.toOutboundMessageBlock
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditResendTimelineRewriteTest {
    @Test
    fun outboundBlockMappingPreservesPreciseReferenceScope() {
        val outbound = BlockItem(
            type = "table_selection",
            content = "selected rows",
            tableId = "table-1",
            memoId = "memo-1",
            fieldIds = listOf("field-1", "field-2"),
            rowIds = listOf("row-1"),
            preview = "2 fields · 1 row",
            spaceId = "space-1",
            spaceName = "Project Alpha",
        ).toOutboundMessageBlock()

        requireNotNull(outbound)
        assertEquals("table-1", outbound.tableId)
        assertEquals("memo-1", outbound.memoId)
        assertEquals(listOf("field-1", "field-2"), outbound.fieldIds)
        assertEquals(listOf("row-1"), outbound.rowIds)
        assertEquals("space-1", outbound.spaceId)
        assertEquals("Project Alpha", outbound.spaceName)
    }

    @Test
    fun editResendCanContinueOnlyWithActionableFilePreviewAndTimelineImpact() {
        assertTrue(
            RollbackPreviewResponse(
                filePreviewStatus = "available",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(),
        )
        assertTrue(
            RollbackPreviewResponse(
                filePreviewStatus = "not_applicable",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                filePreviewStatus = "unavailable",
                filePreviewReason = "device_offline",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                rollbackContractVersion = 2,
                filePreviewStatus = "not_applicable",
                resourcePreviewStatus = "not_applicable",
            ).canExecuteEditResend(),
        )
        assertTrue(
            RollbackPreviewResponse(
                rollbackContractVersion = 2,
                previewRevision = "preview-v1",
                filePreviewRevision = "file-v1",
                filePreviewStatus = "not_applicable",
                resourcePreviewStatus = "not_applicable",
            ).canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                rollbackContractVersion = 2,
                previewRevision = "preview-v1",
                filePreviewRevision = "file-v1",
                filePreviewStatus = "available",
                resourcePreviewStatus = "not_applicable",
            ).canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                rollbackContractVersion = 2,
                previewRevision = "preview-v1",
                filePreviewRevision = "file-v1",
                filePreviewStatus = "not_applicable",
                affectedPaths = listOf("src/app.kt"),
                resourcePreviewStatus = "not_applicable",
            ).canExecuteEditResend(),
        )
        assertTrue(
            RollbackPreviewResponse(
                rollbackContractVersion = 2,
                previewRevision = "preview-v1",
                filePreviewRevision = "file-v1",
                filePreviewStatus = "available",
                affectedPaths = listOf("src/app.kt"),
                resourcePreviewStatus = "not_applicable",
            ).canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                filePreviewStatus = "unavailable",
                filePreviewReason = "no_file_history",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(),
        )
        assertTrue(
            RollbackPreviewResponse(
                filePreviewStatus = "unavailable",
                filePreviewReason = "no_file_history",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(allowConversationOnly = true),
        )
        val knownUnrestorableFiles = RollbackPreviewResponse(
            filePreviewStatus = "unavailable",
            filePreviewReason = "unrestorable_files",
            unrestorableFiles = listOf(
                com.tabtin.mobile.data.model.FilePreviewIssue(
                    path = "src/app.kt",
                    reason = "backup_missing",
                ),
            ),
            resourcePreviewStatus = "not_applicable",
        )
        assertFalse(knownUnrestorableFiles.canExecuteEditResend())
        assertTrue(knownUnrestorableFiles.canExecuteEditResend(allowConversationOnly = true))
        assertFalse(
            RollbackPreviewResponse()
                .canExecuteEditResend(),
        )
        assertFalse(
            RollbackPreviewResponse(
                noImpact = true,
                filePreviewStatus = "not_applicable",
                resourcePreviewStatus = "not_applicable",
            )
                .canExecuteEditResend(),
        )
    }

    @Test
    fun resourcePreviewRiskRequiresExplicitConversationOnlyAcknowledgement() {
        val knownUnrestorable = RollbackPreviewResponse(
            filePreviewStatus = "not_applicable",
            resourcePreviewStatus = "available",
            resourceChanges = listOf(
                com.tabtin.mobile.data.model.ResourceChangeInfo(resourceType = "docs", resourceId = "doc-1"),
            ),
            resourceRestorePlan = listOf(
                com.tabtin.mobile.data.model.ResourceRestorePlanItem(
                    resourceType = "docs",
                    resourceId = "doc-1",
                    canRestore = false,
                ),
            ),
        )
        assertFalse(knownUnrestorable.canExecuteEditResend())
        assertTrue(knownUnrestorable.canExecuteEditResend(allowConversationOnly = true))

        val unknown = RollbackPreviewResponse(
            filePreviewStatus = "not_applicable",
            resourcePreviewStatus = "available",
            resourceChanges = listOf(
                com.tabtin.mobile.data.model.ResourceChangeInfo(resourceType = "docs", resourceId = "doc-1"),
            ),
        )
        assertFalse(unknown.canExecuteEditResend())
        assertFalse(unknown.canExecuteEditResend(allowConversationOnly = true))

        val incompletePlan = RollbackPreviewResponse(
            filePreviewStatus = "not_applicable",
            resourcePreviewStatus = "available",
            resourceChanges = listOf(
                com.tabtin.mobile.data.model.ResourceChangeInfo(resourceType = "docs", resourceId = "doc-1"),
                com.tabtin.mobile.data.model.ResourceChangeInfo(resourceType = "table", resourceId = "table-1"),
            ),
            resourceRestorePlan = listOf(
                com.tabtin.mobile.data.model.ResourceRestorePlanItem(
                    resourceType = "docs",
                    resourceId = "doc-1",
                    canRestore = true,
                ),
            ),
        )
        assertFalse(incompletePlan.canExecuteEditResend())
        assertFalse(incompletePlan.canExecuteEditResend(allowConversationOnly = true))
    }

    @Test
    fun successfulRewriteRefreshesAuthoritativeHistoryBeforeSending() = runTest {
        val calls = mutableListOf<String>()

        val outcome = executeEditResendTimelineRewrite(
            rollback = {
                calls += "rollback"
                RollbackResponse(success = true, fileRestoreSuccess = true)
            },
            restoreResources = {
                calls += "resources"
                ResourceRestoreResponse(success = true)
            },
            refreshAuthoritativeHistory = {
                calls += "refresh"
                true
            },
            sendEditedMessage = { calls += "send"; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Success)
        assertEquals(listOf("rollback", "resources", "refresh", "send"), calls)
    }

    @Test
    fun failedRollbackNeverSendsEditedMessage() = runTest {
        var sent = false

        val outcome = executeEditResendTimelineRewrite(
            rollback = { RollbackResponse(success = false, message = "rollback rejected") },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { sent = true; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Failure)
        assertFalse(sent)
    }

    @Test
    fun failedAuthoritativeRefreshNeverSendsEditedMessage() = runTest {
        var sent = false

        val outcome = executeEditResendTimelineRewrite(
            rollback = { RollbackResponse(success = true, fileRestoreSuccess = true) },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { false },
            sendEditedMessage = { sent = true; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Failure)
        assertFalse(sent)
    }

    @Test
    fun failedFileRestoreNeverSendsEditedMessage() = runTest {
        var sent = false

        val outcome = executeEditResendTimelineRewrite(
            rollback = {
                RollbackResponse(
                    success = true,
                    fileRestoreSuccess = false,
                    fileRestoreStatus = "failed",
                )
            },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { sent = true; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Failure)
        assertEquals(
            EditResendTimelineRewriteOutcome.FailureStage.FILES,
            (outcome as EditResendTimelineRewriteOutcome.Failure).stage,
        )
        assertFalse(sent)
    }

    @Test
    fun exactPreviewedUnavailableFileReasonCanProceedButDifferentReasonCannot() = runTest {
        var acceptedSent = false
        val accepted = executeEditResendTimelineRewrite(
            rollback = {
                RollbackResponse(
                    success = true,
                    fileRestoreSuccess = false,
                    fileRestoreStatus = "unavailable",
                    fileRestoreReason = "no_file_history",
                )
            },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { acceptedSent = true; true },
            approvedUnavailableFileReason = "no_file_history",
        )
        assertTrue(accepted is EditResendTimelineRewriteOutcome.Success)
        assertTrue(acceptedSent)

        var rejectedSent = false
        val rejected = executeEditResendTimelineRewrite(
            rollback = {
                RollbackResponse(
                    success = true,
                    fileRestoreSuccess = false,
                    fileRestoreStatus = "unavailable",
                    fileRestoreReason = "file_snapshot_missing",
                )
            },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { rejectedSent = true; true },
            approvedUnavailableFileReason = "no_file_history",
        )
        assertTrue(rejected is EditResendTimelineRewriteOutcome.Failure)
        assertFalse(rejectedSent)
    }

    @Test
    fun unrestorableFileAcknowledgementOnlyCoversPreviewedPaths() = runTest {
        suspend fun execute(failedFiles: List<String>): EditResendTimelineRewriteOutcome =
            executeEditResendTimelineRewrite(
                rollback = {
                    RollbackResponse(
                        success = true,
                        fileRestoreSuccess = false,
                        fileRestoreStatus = "failed",
                        fileRestoreReason = "unrestorable_files",
                        failedFiles = failedFiles,
                    )
                },
                restoreResources = { ResourceRestoreResponse(success = true) },
                refreshAuthoritativeHistory = { true },
                sendEditedMessage = { true },
                approvedUnavailableFileReason = "unrestorable_files",
                approvedUnrestorableFilePaths = setOf("src/known.kt"),
            )

        assertTrue(execute(listOf("src/known.kt")) is EditResendTimelineRewriteOutcome.Success)
        assertTrue(execute(emptyList()) is EditResendTimelineRewriteOutcome.Failure)
        assertTrue(execute(listOf("src/new.kt")) is EditResendTimelineRewriteOutcome.Failure)
    }

    @Test
    fun failedResourceRestoreNeverSendsEditedMessage() = runTest {
        var sent = false

        val outcome = executeEditResendTimelineRewrite(
            rollback = { RollbackResponse(success = true) },
            restoreResources = {
                ResourceRestoreResponse(success = false, failedCount = 1)
            },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { sent = true; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Failure)
        assertEquals(
            EditResendTimelineRewriteOutcome.FailureStage.RESOURCES,
            (outcome as EditResendTimelineRewriteOutcome.Failure).stage,
        )
        assertFalse(sent)
    }

    @Test
    fun missingLegacyFileRestoreFlagDoesNotBecomeFailure() = runTest {
        var sent = false

        val outcome = executeEditResendTimelineRewrite(
            rollback = { RollbackResponse(success = true) },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { sent = true; true },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Success)
        assertTrue(sent)
    }

    @Test
    fun failedMessagePersistenceDoesNotReportRewriteSuccess() = runTest {
        val outcome = executeEditResendTimelineRewrite(
            rollback = { RollbackResponse(success = true, fileRestoreSuccess = true) },
            restoreResources = { ResourceRestoreResponse(success = true) },
            refreshAuthoritativeHistory = { true },
            sendEditedMessage = { false },
        )

        assertTrue(outcome is EditResendTimelineRewriteOutcome.Failure)
        assertEquals(
            EditResendTimelineRewriteOutcome.FailureStage.SEND,
            (outcome as EditResendTimelineRewriteOutcome.Failure).stage,
        )
    }
}
