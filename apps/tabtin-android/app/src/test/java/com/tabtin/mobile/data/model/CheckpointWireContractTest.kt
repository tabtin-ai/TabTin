package com.tabtin.mobile.data.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckpointWireContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun missingLegacyFileRestoreFlagIsNotDecodedAsFailure() {
        val response = json.decodeFromString<RollbackResponse>(
            """{"success":true,"overall_status":"success"}""",
        )

        assertTrue(response.fileRestoreSuccess)
        assertFalse(response.hasFileRestoreFailure)
    }

    @Test
    fun structuredFileStatusOverridesLegacyBoolean() {
        val response = json.decodeFromString<RollbackResponse>(
            """
            {
              "success": true,
              "file_restore_success": true,
              "file_restore_status": "failed",
              "file_restore_reason": "device offline",
              "failed_files": ["notes.md"]
            }
            """.trimIndent(),
        )

        assertTrue(response.hasFileRestoreFailure)
        assertEquals("device offline", response.fileRestoreReason)
        assertEquals(listOf("notes.md"), response.failedFiles)
    }

    @Test
    fun notApplicableStatusDoesNotInheritLegacyFalseFailure() {
        val response = json.decodeFromString<RollbackResponse>(
            """
            {
              "success": true,
              "file_restore_success": false,
              "file_restore_status": "not_applicable",
              "file_restore_reason": "no_file_history"
            }
            """.trimIndent(),
        )

        assertFalse(response.hasFileRestoreFailure)
    }

    @Test
    fun previewDecodesControlDeviceFileImpact() {
        val preview = json.decodeFromString<RollbackPreviewResponse>(
            """
            {
              "target_message_id": "m-1",
              "affected_paths": ["README.md"],
              "rewind_anchor_id": "a-1",
              "file_restore_host": "electron",
              "rollback_contract_version": 2,
              "preview_revision": "preview-v1",
              "file_preview_revision": "file-v1",
              "file_preview_status": "unavailable",
              "file_preview_reason": "unrestorable_files",
              "unrestorable_files": [{"path":"src/app.kt","reason":"backup_missing"}],
              "resource_preview_status": "unavailable",
              "resource_preview_reason": "resource_change_query_failed"
            }
            """.trimIndent(),
        )

        assertEquals(listOf("README.md"), preview.affectedPaths)
        assertEquals("unavailable", preview.effectiveFilePreviewStatus)
        assertEquals("unavailable", preview.resourcePreviewStatus)
        assertEquals("resource_change_query_failed", preview.resourcePreviewReason)
        assertEquals(2, preview.rollbackContractVersion)
        assertEquals("preview-v1", preview.previewRevision)
        assertEquals("file-v1", preview.filePreviewRevision)
        assertEquals("src/app.kt", preview.unrestorableFiles.single().path)
        assertEquals("backup_missing", preview.unrestorableFiles.single().reason)
    }

    @Test
    fun rollbackStateDecodesEditResendModeForBannerSuppression() {
        val response = json.decodeFromString<RollbackResponse>(
            """
            {
              "success": true,
              "mode": "editAndResend",
              "rollback_state": {
                "session_id": "s-1",
                "revert_active": true,
                "last_operation_mode": "editAndResend"
              }
            }
            """.trimIndent(),
        )

        assertEquals("editAndResend", response.mode)
        assertEquals("editAndResend", response.rollbackState?.lastOperationMode)
    }

    @Test
    fun persistedPartialFileFailureKeepsStatusAndSpecificReason() {
        val state = json.decodeFromString<SessionRollbackState>(
            """
            {
              "session_id": "s-1",
              "revert_active": true,
              "partial_success_details": {
                "workspace_files": {
                  "status": "partial_success",
                  "reason": "control_device_offline"
                }
              }
            }
            """.trimIndent(),
        )

        assertEquals("partial_success", state.partialSuccessDetails?.workspaceFiles?.status)
        assertEquals("control_device_offline", state.partialSuccessDetails?.workspaceFiles?.reason)
    }

    @Test
    fun editResendRequestCarriesTimelineRewriteMode() {
        val payload = json.encodeToString(
            RollbackRequest(
                targetMessageId = "m-1",
                rollbackReason = "edit",
                mode = "editAndResend",
            ),
        )

        assertTrue(payload.contains("\"mode\":\"editAndResend\""))
    }

    @Test
    fun editResendRequestCarriesExplicitConversationOnlyAcknowledgement() {
        val payload = json.encodeToString(
            RollbackRequest(
                targetMessageId = "m-1",
                mode = "editAndResend",
                previewRevision = "preview-v1",
                filePreviewRevision = "file-v1",
                acknowledgedFilePreviewReason = "no_file_history",
                rollbackContractVersion = 2,
            ),
        )

        assertTrue(payload.contains("\"acknowledged_file_preview_reason\":\"no_file_history\""))
    }

    @Test
    fun resourceRestoreRequestCarriesConfirmedPreviewRevision() {
        val payload = json.encodeToString(
            ResourceRestoreRequest(
                items = listOf(
                    ResourceRestoreItem(
                        resourceType = "docs",
                        resourceId = "doc-1",
                        action = "trash",
                    ),
                ),
                previewRevision = "preview-v1",
                rollbackContractVersion = 2,
            ),
        )

        assertTrue(payload.contains("\"preview_revision\":\"preview-v1\""))
        assertTrue(payload.contains("\"rollback_contract_version\":2"))
    }
}
