package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.DocApi
import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.SharedDocRow
import com.tabtin.mobile.data.model.SharedDocsResponse
import com.tabtin.mobile.data.model.SharedResourcesLoadException
import com.tabtin.mobile.data.model.SharedTableRow
import com.tabtin.mobile.data.model.SharedTablesResponse
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class SharedResourcesRepositoryTest {

    @Test
    fun `blank organizationId is rejected before any request`() = runTest {
        val docApi = mockk<DocApi>()
        val tabDataApi = mockk<TabDataApi>()
        val repository = SharedResourcesRepository(docApi, tabDataApi)

        try {
            repository.listSharedWithMe("   ")
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected
        }

        coVerify(exactly = 0) { docApi.listSharedWithMe(any()) }
        coVerify(exactly = 0) { tabDataApi.listSharedWithMe(any()) }
    }

    @Test
    fun `keeps tables when docs source fails`() = runTest {
        val docApi = mockk<DocApi>()
        val tabDataApi = mockk<TabDataApi>()
        coEvery { docApi.listSharedWithMe("org-1") } throws RuntimeException("docs down")
        coEvery { tabDataApi.listSharedWithMe("org-1") } returns ApiEnvelope(
            success = true,
            data = SharedTablesResponse(
                tables = listOf(
                    SharedTableRow(
                        tableId = "t-1",
                        title = "表 1",
                        organizationId = "org-1",
                        permission = "viewer",
                    ),
                ),
            ),
        )
        val repository = SharedResourcesRepository(docApi, tabDataApi)

        val items = repository.listSharedWithMe("org-1")

        assertEquals(listOf("t-1"), items.map { it.resourceId })
        assertEquals("shared:table:t-1", items.single().id)
    }

    @Test
    fun `throws when both sources fail`() = runTest {
        val docApi = mockk<DocApi>()
        val tabDataApi = mockk<TabDataApi>()
        coEvery { docApi.listSharedWithMe("org-1") } throws RuntimeException("docs down")
        coEvery { tabDataApi.listSharedWithMe("org-1") } throws RuntimeException("tables down")
        val repository = SharedResourcesRepository(docApi, tabDataApi)

        try {
            repository.listSharedWithMe("org-1")
            fail("expected SharedResourcesLoadException")
        } catch (_: SharedResourcesLoadException) {
            // expected
        }
    }

    @Test
    fun `merges both sources`() = runTest {
        val docApi = mockk<DocApi>()
        val tabDataApi = mockk<TabDataApi>()
        coEvery { docApi.listSharedWithMe("org-1") } returns ApiEnvelope(
            success = true,
            data = SharedDocsResponse(
                documents = listOf(
                    SharedDocRow(
                        documentId = "d-1",
                        title = "文档",
                        organizationId = "org-1",
                        permission = "editor",
                        updatedAt = "2026-07-01T00:00:00Z",
                    ),
                ),
            ),
        )
        coEvery { tabDataApi.listSharedWithMe("org-1") } returns ApiEnvelope(
            success = true,
            data = SharedTablesResponse(
                tables = listOf(
                    SharedTableRow(
                        tableId = "t-1",
                        title = "表格",
                        organizationId = "org-1",
                        permission = "viewer",
                        updatedAt = "2026-07-20T00:00:00Z",
                    ),
                ),
            ),
        )
        val repository = SharedResourcesRepository(docApi, tabDataApi)

        val items = repository.listSharedWithMe("org-1")

        assertEquals(listOf("t-1", "d-1"), items.map { it.resourceId })
    }
}
