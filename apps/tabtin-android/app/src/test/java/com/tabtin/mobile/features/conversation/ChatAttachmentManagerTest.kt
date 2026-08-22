package com.tabtin.mobile.features.conversation

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.api.UploadResult
import com.tabtin.mobile.data.model.AttachmentStatus
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class ChatAttachmentManagerTest {
    @Test
    fun `late organization binding enables attachments for the current session`() {
        val context = mockk<Context>(relaxed = true)
        val uploadService = mockk<OSSUploadService>(relaxed = true)
        val manager = ChatAttachmentManager(context, uploadService)

        manager.bindSession("session-1", organizationId = null)
        assertFalse(manager.hasUploadScope)

        manager.bindSession("session-1", organizationId = "organization-1")

        assertTrue(manager.hasUploadScope)
    }

    @Test
    fun `rebinding organization for same session keeps composer attachments`() = runTest {
        val uri = mockk<Uri>()
        val cursor = mockk<Cursor>(relaxed = true) {
            every { moveToFirst() } returns true
            every { getColumnIndex(OpenableColumns.DISPLAY_NAME) } returns 0
            every { getColumnIndex(OpenableColumns.SIZE) } returns 1
            every { getString(0) } returns "queued.pdf"
            every { getLong(1) } returns 128L
        }
        val contentResolver = mockk<ContentResolver>(relaxed = true) {
            every { query(uri, null, null, null, null) } returns cursor
            every { getType(uri) } returns "application/pdf"
        }
        val context = mockk<Context>(relaxed = true) {
            every { this@mockk.contentResolver } returns contentResolver
        }
        val uploadService = mockk<OSSUploadService>(relaxed = true)
        val manager = ChatAttachmentManager(context, uploadService)
        manager.bindSession("session-1", "organization-1")
        val added = manager.addAttachment(uri, this) as ChatAttachmentManager.AddResult.Success

        manager.bindSession("session-1", "organization-2")

        assertEquals(1, manager.attachments.value.size)
        manager.removeAttachment(added.id)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `durably queued attachments leave composer without deactivating uploaded usage`() = runTest {
        val uri = mockk<Uri>()
        val cursor = mockk<Cursor>(relaxed = true) {
            every { moveToFirst() } returns true
            every { getColumnIndex(OpenableColumns.DISPLAY_NAME) } returns 0
            every { getColumnIndex(OpenableColumns.SIZE) } returns 1
            every { getString(0) } returns "queued.pdf"
            every { getLong(1) } returns 128L
        }
        val contentResolver = mockk<ContentResolver>(relaxed = true) {
            every { query(uri, null, null, null, null) } returns cursor
            every { getType(uri) } returns "application/pdf"
        }
        val context = mockk<Context>(relaxed = true) {
            every { this@mockk.contentResolver } returns contentResolver
        }
        val uploadService = mockk<OSSUploadService>()
        coEvery {
            uploadService.directUploadFromUri(
                uri = uri,
                fileSize = 128L,
                fileName = "queued.pdf",
                contentType = "application/pdf",
                folder = any(),
                scope = UploadScope(
                    module = "chat",
                    contextType = "message",
                    contextId = "session-1",
                    organizationId = "organization-1",
                    isPublic = false,
                ),
                onProgress = any(),
            )
        } returns UploadResult(
            fileId = "file-1",
            accessUrl = "https://files.example/queued.pdf",
            fileName = "queued.pdf",
        )

        val manager = ChatAttachmentManager(context, uploadService)
        manager.bindSession("session-1", "organization-1")
        val added = manager.addAttachment(uri, this) as ChatAttachmentManager.AddResult.Success
        advanceUntilIdle()

        assertEquals(AttachmentStatus.READY, manager.attachments.value.single().status)
        manager.removeAttachments(setOf(added.id), deactivateUploaded = false)

        assertTrue(manager.attachments.value.isEmpty())
        coVerify(exactly = 0) {
            uploadService.deactivateUsage(any(), any(), any(), any())
        }
    }
}
