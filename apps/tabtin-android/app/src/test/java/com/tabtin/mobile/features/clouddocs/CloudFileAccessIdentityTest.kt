package com.tabtin.mobile.features.clouddocs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudFileAccessIdentityTest {

    @Test
    fun `conversation workbench file uses file record route`() {
        assertEquals(
            CloudFileAccessRoute.FILE_RECORD,
            CloudFileAccessIdentity.route(
                organizationId = "org-1",
                contextItemId = "",
                fileRecordId = "file-abc",
            ),
        )
    }

    @Test
    fun `cloud drive file prefers context item route`() {
        assertEquals(
            CloudFileAccessRoute.CONTEXT_ITEM,
            CloudFileAccessIdentity.route(
                organizationId = "org-1",
                contextItemId = "ctx-1",
                fileRecordId = "file-abc",
            ),
        )
    }

    @Test
    fun `file record still works without organization`() {
        assertEquals(
            CloudFileAccessRoute.FILE_RECORD,
            CloudFileAccessIdentity.route(
                organizationId = "",
                contextItemId = "",
                fileRecordId = "file-abc",
            ),
        )
    }

    @Test
    fun `blank identifiers are missing`() {
        assertEquals(
            CloudFileAccessRoute.MISSING,
            CloudFileAccessIdentity.route(
                organizationId = "org-1",
                contextItemId = "  ",
                fileRecordId = "",
            ),
        )
        assertNull(
            CloudFileAccessIdentity.cacheKey(
                CloudFileAccessRoute.MISSING,
                contextItemId = "",
                fileRecordId = "",
            ),
        )
    }
}
