package com.tabtin.mobile.data.model

import com.tabtin.mobile.data.repository.CloudDocsShareService
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 移植自 iOS CloudDocsShareTests：钉住 wire 映射、解码缺省与 public URL。
 */
class CloudDocsShareWireContractTest {

    @Test
    fun `decodes collaborator list contract used by documents and tables`() {
        val response = json.decodeFromString<CloudDocsCollaboratorsResponse>(
            """{"owner":{"user_id":"owner","nickname":"Owner","email":"o@example.com"},"collaborators":[{"user_id":"member","nickname":"Member","email":"m@example.com","permission":"editor"}]}""",
        )
        assertEquals("member", response.collaborators.single().userId)
        assertEquals("editor", response.collaborators.single().permission)
    }

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    // MARK: - anyoneWireValue（最易错：公网 share_type 不对称）

    @Test
    fun `anyone wire value is asymmetric for doc vs table`() {
        assertEquals("public", CloudShareResourceType.DOCUMENT.anyoneWireValue)
        assertEquals("data", CloudShareResourceType.TABLE.anyoneWireValue)
    }

    // MARK: - Scope 往返

    @Test
    fun `scope wire round trip for document`() {
        assertEquals("organization", CloudShareScope.ORGANIZATION.wireValue(CloudShareResourceType.DOCUMENT))
        assertEquals("public", CloudShareScope.ANYONE.wireValue(CloudShareResourceType.DOCUMENT))
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("organization", CloudShareResourceType.DOCUMENT),
        )
        assertEquals(
            CloudShareScope.ANYONE,
            CloudShareScope.fromWireValue("public", CloudShareResourceType.DOCUMENT),
        )
        // table 的公网值用在 doc 上应保守退回 organization
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("data", CloudShareResourceType.DOCUMENT),
        )
    }

    @Test
    fun `scope wire round trip for table`() {
        assertEquals("data", CloudShareScope.ANYONE.wireValue(CloudShareResourceType.TABLE))
        assertEquals(
            CloudShareScope.ANYONE,
            CloudShareScope.fromWireValue("data", CloudShareResourceType.TABLE),
        )
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("organization", CloudShareResourceType.TABLE),
        )
        // doc 的公网值用在 table 上应保守退回 organization
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("public", CloudShareResourceType.TABLE),
        )
    }

    @Test
    fun `scope from unknown wire value falls back to organization`() {
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("form", CloudShareResourceType.DOCUMENT),
        )
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("", CloudShareResourceType.TABLE),
        )
        assertEquals(
            CloudShareScope.ORGANIZATION,
            CloudShareScope.fromWireValue("unknown", CloudShareResourceType.TABLE),
        )
    }

    // MARK: - Permissions / type parse

    @Test
    fun `available permissions table omits comment`() {
        assertEquals(
            listOf(
                CloudSharePermission.VIEW,
                CloudSharePermission.COMMENT,
                CloudSharePermission.EDIT,
            ),
            CloudShareResourceType.DOCUMENT.availablePermissions,
        )
        assertEquals(
            listOf(CloudSharePermission.VIEW, CloudSharePermission.EDIT),
            CloudShareResourceType.TABLE.availablePermissions,
        )
        assertFalse(
            CloudShareResourceType.TABLE.availablePermissions.contains(CloudSharePermission.COMMENT),
        )
    }

    @Test
    fun `from normalized type only accepts tabdoc and tabdata`() {
        assertEquals(
            CloudShareResourceType.DOCUMENT,
            CloudShareResourceType.fromNormalizedType("tabdoc"),
        )
        assertEquals(
            CloudShareResourceType.TABLE,
            CloudShareResourceType.fromNormalizedType("tabdata"),
        )
        assertNull(CloudShareResourceType.fromNormalizedType("tabfiles"))
        assertNull(CloudShareResourceType.fromNormalizedType(""))
        assertNull(CloudShareResourceType.fromNormalizedType("doc"))
        assertNull(CloudShareResourceType.fromNormalizedType("TABDOC"))
    }

    // MARK: - publicURL

    @Test
    fun `public url path segments use share id`() {
        val docUrl = CloudDocsShareService.publicUrl(
            shareId = "share-doc-1",
            type = CloudShareResourceType.DOCUMENT,
            webBaseUrl = "https://web.example",
        )
        assertTrue(docUrl!!.contains("/shared/docs/share-doc-1"))
        assertFalse(docUrl.contains("/shared/tables/"))

        val tableUrl = CloudDocsShareService.publicUrl(
            shareId = "share-table-9",
            type = CloudShareResourceType.TABLE,
            webBaseUrl = "https://web.example/",
        )
        assertTrue(tableUrl!!.contains("/shared/tables/share-table-9"))
        assertFalse(tableUrl.contains("/shared/docs/"))
    }

    @Test
    fun `public url rejects empty share id`() {
        assertNull(
            CloudDocsShareService.publicUrl("", CloudShareResourceType.DOCUMENT, "https://web.example"),
        )
        assertNull(
            CloudDocsShareService.publicUrl("   ", CloudShareResourceType.TABLE, "https://web.example"),
        )
    }

    @Test
    fun `public path segment`() {
        assertEquals("docs", CloudShareResourceType.DOCUMENT.publicPathSegment)
        assertEquals("tables", CloudShareResourceType.TABLE.publicPathSegment)
    }

    // MARK: - Decoding

    @Test
    fun `decodes cloud doc share with optional fields missing`() {
        val share = json.decodeFromString<CloudDocShare>(
            """
            {
              "share_id": "sh-1",
              "share_type": "organization",
              "permission": "view",
              "has_password": false
            }
            """.trimIndent(),
        )
        assertEquals("sh-1", share.shareId)
        assertEquals("organization", share.shareType)
        assertEquals("view", share.permission)
        assertFalse(share.hasPassword)
        assertNull(share.expireAt)
        assertNull(share.organizationId)
        assertNull(share.visitCount)
        assertTrue(share.isActive)
        assertNull(share.createdAt)
    }

    @Test
    fun `decodes cloud doc share full fields and ignores allow flags`() {
        val share = json.decodeFromString<CloudDocShare>(
            """
            {
              "share_id": "sh-2",
              "share_type": "public",
              "permission": "edit",
              "has_password": true,
              "expire_at": "2026-08-01T00:00:00+00:00",
              "organization_id": "org-1",
              "visit_count": 12,
              "is_active": true,
              "created_at": "2026-07-30T00:00:00+00:00",
              "allow_download": true,
              "allow_copy": false
            }
            """.trimIndent(),
        )
        assertEquals("sh-2", share.shareId)
        assertEquals("public", share.shareType)
        assertEquals(12, share.visitCount)
        assertEquals("org-1", share.organizationId)
        assertTrue(share.hasPassword)
        assertTrue(share.isActive)
    }

    @Test
    fun `decodes fetch response when share null`() {
        val response = json.decodeFromString<CloudDocShareFetchResponse>(
            """{ "share": null, "enabled": false }""",
        )
        assertNull(response.share)
        assertEquals(false, response.enabled)
    }

    @Test
    fun `share endpoint paths match iOS`() {
        assertEquals("tabdoc/documents/doc-1/share", CloudDocsSharePaths.documentShare("doc-1"))
        assertEquals(
            "tabdoc/documents/doc-1/share/refresh",
            CloudDocsSharePaths.documentShareRefresh("doc-1"),
        )
        assertEquals("tabdata/tables/table-1/share", CloudDocsSharePaths.tableShare("table-1"))
    }
}
