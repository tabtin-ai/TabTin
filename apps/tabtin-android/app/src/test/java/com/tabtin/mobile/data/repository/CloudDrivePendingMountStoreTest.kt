package com.tabtin.mobile.data.repository

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.data.model.files.CloudDrivePendingMountTask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CloudDrivePendingMountStoreTest {

    @Test
    fun `upsert persists and dedupes by org and fileRecord`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = CloudDrivePendingMountStore(context)
        store.upsert(
            CloudDrivePendingMountTask(
                fileRecordId = "fr-1",
                organizationId = "org-1",
                collectionId = "c1",
                title = "a.pdf",
                error = "timeout",
                createdAt = "2026-07-31T10:00:00Z",
            ),
        )
        store.upsert(
            CloudDrivePendingMountTask(
                fileRecordId = "fr-1",
                organizationId = "org-1",
                collectionId = "c1",
                title = "a.pdf",
                error = "retry",
                createdAt = "2026-07-31T10:01:00Z",
            ),
        )
        assertEquals(1, store.count())
        assertEquals("retry", store.list().single().error)

        store.remove("org-1", "fr-1")
        assertTrue(store.list().isEmpty())
    }
}
