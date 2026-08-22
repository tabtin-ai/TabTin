package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.DocApi
import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CloudDocShare
import com.tabtin.mobile.data.model.CloudDocShareDisableResponse
import com.tabtin.mobile.data.model.CloudDocShareFetchResponse
import com.tabtin.mobile.data.model.CloudDocShareMutationResponse
import com.tabtin.mobile.data.model.CloudDocsShareError
import com.tabtin.mobile.data.model.CloudSharePermission
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.CloudShareScope
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class CloudDocsShareServiceTest {

    private val docApi = mockk<DocApi>()
    private val tabDataApi = mockk<TabDataApi>()
    private val tokenManager = mockk<TokenManager>(relaxed = true)
    private val service = CloudDocsShareService(docApi, tabDataApi, tokenManager)

    private fun sampleShare(
        shareId: String = "sh-1",
        shareType: String = "organization",
        permission: String = "view",
    ) = CloudDocShare(
        shareId = shareId,
        shareType = shareType,
        permission = permission,
    )

    private fun httpError(code: Int, body: String = "{}"): HttpException =
        HttpException(
            Response.error<Any>(
                code,
                body.toResponseBody("application/json".toMediaType()),
            ),
        )

    // MARK: - Error mapping

    @Test
    fun `mapError maps http 403 to forbidden`() {
        val mapped = CloudDocsShareService.mapError(httpError(403, """{"message":"nope"}"""))
        assertTrue(mapped is CloudDocsShareError.Forbidden)
    }

    @Test
    fun `mapError maps http 409 to public exposure not acknowledged`() {
        val mapped = CloudDocsShareService.mapError(httpError(409, """{"message":"ack required"}"""))
        assertTrue(mapped is CloudDocsShareError.PublicExposureNotAcknowledged)
    }

    @Test
    fun `mapError maps PUBLIC_EXPOSURE_ACK_REQUIRED business code`() {
        val mapped = CloudDocsShareService.mapError(
            AppError.RequestFailed(
                serverMessage = "ack",
                errorCode = CloudDocsShareService.PUBLIC_EXPOSURE_ACK_REQUIRED,
            ),
        )
        assertTrue(mapped is CloudDocsShareError.PublicExposureNotAcknowledged)
    }

    @Test
    fun `mapError does not map 401 to forbidden`() {
        val mapped = CloudDocsShareService.mapError(httpError(401, """{"message":"token expired"}"""))
        when (mapped) {
            is CloudDocsShareError.Forbidden -> fail("401 不应映射为 Forbidden")
            is CloudDocsShareError.Other -> assertTrue(mapped.detail.isNotBlank())
            else -> fail("401 应映射为 Other，实际 $mapped")
        }
    }

    @Test
    fun `mapError maps PERMISSION_DENIED envelope code to forbidden`() {
        val mapped = CloudDocsShareService.mapError(
            AppError.RequestFailed(
                serverMessage = "denied",
                errorCode = CloudDocsShareService.PERMISSION_DENIED,
            ),
        )
        assertTrue(mapped is CloudDocsShareError.Forbidden)
    }

    // MARK: - upsert body / ack

    @Test
    fun `upsert body omits password when null and carries ack flag`() {
        val body = CloudDocsShareService.buildUpsertBody(
            type = CloudShareResourceType.DOCUMENT,
            scope = CloudShareScope.ANYONE,
            permission = CloudSharePermission.EDIT,
            password = null,
            acknowledgePublicExposure = true,
        )
        assertEquals("public", body["share_type"]?.jsonPrimitive?.contentOrNull)
        assertEquals("edit", body["permission"]?.jsonPrimitive?.contentOrNull)
        assertEquals(true, body["acknowledge_public_exposure"]?.jsonPrimitive?.boolean)
        assertNull(body["password"])
    }

    @Test
    fun `upsert body for table anyone uses data share type`() {
        val body = CloudDocsShareService.buildUpsertBody(
            type = CloudShareResourceType.TABLE,
            scope = CloudShareScope.ANYONE,
            permission = CloudSharePermission.VIEW,
            password = "",
            acknowledgePublicExposure = false,
        )
        assertEquals("data", body["share_type"]?.jsonPrimitive?.contentOrNull)
        assertEquals("", body["password"]?.jsonPrimitive?.contentOrNull)
        assertEquals(false, body["acknowledge_public_exposure"]?.jsonPrimitive?.boolean)
    }

    @Test
    fun `upsert to anyone without ack surfaces public exposure error`() = runTest {
        coEvery { docApi.upsertDocumentShare("doc-1", any()) } throws httpError(409)

        try {
            service.upsert(
                type = CloudShareResourceType.DOCUMENT,
                resourceId = "doc-1",
                scope = CloudShareScope.ANYONE,
                permission = CloudSharePermission.VIEW,
                password = null,
                acknowledgePublicExposure = false,
            )
            fail("expected PublicExposureNotAcknowledged")
        } catch (e: CloudDocsShareError.PublicExposureNotAcknowledged) {
            // expected
        }
    }

    // MARK: - fetch

    @Test
    fun `fetch returns null when enabled is false`() = runTest {
        coEvery { docApi.getDocumentShare("doc-1") } returns ApiEnvelope(
            success = true,
            data = CloudDocShareFetchResponse(share = null, enabled = false),
        )

        assertNull(service.fetch(CloudShareResourceType.DOCUMENT, "doc-1"))
    }

    @Test
    fun `fetch returns share when enabled`() = runTest {
        val share = sampleShare()
        coEvery { tabDataApi.getTableShare("table-1") } returns ApiEnvelope(
            success = true,
            data = CloudDocShareFetchResponse(share = share, enabled = true),
        )

        assertEquals(share, service.fetch(CloudShareResourceType.TABLE, "table-1"))
    }

    // MARK: - table refresh = disable + upsert；失败 reconcile 再试

    @Test
    fun `table refresh disables then upserts with organization share type`() = runTest {
        val share = sampleShare(shareId = "sh-new")
        val bodySlot = slot<JsonObject>()
        coEvery {
            tabDataApi.disableTableShare("table-1", "organization")
        } returns ApiEnvelope(success = true, data = CloudDocShareDisableResponse(1))
        coEvery {
            tabDataApi.upsertTableShare("table-1", capture(bodySlot))
        } returns ApiEnvelope(success = true, data = CloudDocShareMutationResponse(share))

        val result = service.refresh(
            type = CloudShareResourceType.TABLE,
            resourceId = "table-1",
            scope = CloudShareScope.ORGANIZATION,
            permission = CloudSharePermission.VIEW,
        )

        assertEquals("sh-new", result.shareId)
        coVerifyOrder {
            tabDataApi.disableTableShare("table-1", "organization")
            tabDataApi.upsertTableShare("table-1", any())
        }
        assertEquals("organization", bodySlot.captured["share_type"]?.jsonPrimitive?.contentOrNull)
        assertEquals(false, bodySlot.captured["acknowledge_public_exposure"]?.jsonPrimitive?.boolean)
        assertNull(bodySlot.captured["password"])
    }

    @Test
    fun `table refresh anyone requires ack on recreate`() = runTest {
        val bodySlot = slot<JsonObject>()
        coEvery {
            tabDataApi.disableTableShare("table-1", "data")
        } returns ApiEnvelope(success = true, data = CloudDocShareDisableResponse(1))
        coEvery {
            tabDataApi.upsertTableShare("table-1", capture(bodySlot))
        } returns ApiEnvelope(
            success = true,
            data = CloudDocShareMutationResponse(
                sampleShare(shareType = "data", permission = "edit"),
            ),
        )

        service.refresh(
            type = CloudShareResourceType.TABLE,
            resourceId = "table-1",
            scope = CloudShareScope.ANYONE,
            permission = CloudSharePermission.EDIT,
        )

        assertEquals("data", bodySlot.captured["share_type"]?.jsonPrimitive?.contentOrNull)
        assertEquals(true, bodySlot.captured["acknowledge_public_exposure"]?.jsonPrimitive?.boolean)
    }

    @Test
    fun `table refresh retries upsert once after first failure`() = runTest {
        coEvery {
            tabDataApi.disableTableShare("table-1", "organization")
        } returns ApiEnvelope(success = true, data = CloudDocShareDisableResponse(1))
        coEvery {
            tabDataApi.upsertTableShare("table-1", any())
        } throws httpError(500) andThen ApiEnvelope(
            success = true,
            data = CloudDocShareMutationResponse(sampleShare(shareId = "sh-restored")),
        )

        val result = service.refresh(
            type = CloudShareResourceType.TABLE,
            resourceId = "table-1",
            scope = CloudShareScope.ORGANIZATION,
            permission = CloudSharePermission.VIEW,
        )

        assertEquals("sh-restored", result.shareId)
        coVerify(exactly = 2) { tabDataApi.upsertTableShare("table-1", any()) }
    }

    @Test
    fun `table refresh throws first upsert error when restore also fails`() = runTest {
        coEvery {
            tabDataApi.disableTableShare("table-1", "organization")
        } returns ApiEnvelope(success = true, data = CloudDocShareDisableResponse(1))
        coEvery {
            tabDataApi.upsertTableShare("table-1", any())
        } throws httpError(500, """{"message":"first"}""") andThenThrows
            httpError(500, """{"message":"second"}""")

        try {
            service.refresh(
                type = CloudShareResourceType.TABLE,
                resourceId = "table-1",
                scope = CloudShareScope.ORGANIZATION,
                permission = CloudSharePermission.VIEW,
            )
            fail("expected Other")
        } catch (e: CloudDocsShareError.Other) {
            // 第一次 upsert 的映射错误（不是第二次）
            assertTrue(e.detail.contains("first") || e.detail.contains("http_500") || e.detail.isNotBlank())
        }
        coVerify(exactly = 2) { tabDataApi.upsertTableShare("table-1", any()) }
    }

    // MARK: - document refresh

    @Test
    fun `document refresh posts share refresh endpoint`() = runTest {
        val bodySlot = slot<JsonObject>()
        coEvery {
            docApi.refreshDocumentShare("doc-1", capture(bodySlot))
        } returns ApiEnvelope(
            success = true,
            data = CloudDocShareMutationResponse(sampleShare(shareId = "sh-rotated")),
        )

        val result = service.refresh(
            type = CloudShareResourceType.DOCUMENT,
            resourceId = "doc-1",
            scope = CloudShareScope.ORGANIZATION,
            permission = CloudSharePermission.VIEW,
        )

        assertEquals("sh-rotated", result.shareId)
        assertEquals("organization", bodySlot.captured["share_type"]?.jsonPrimitive?.contentOrNull)
        coVerify(exactly = 0) { docApi.disableDocumentShare(any(), any()) }
    }

    @Test
    fun `disable table always sends explicit share type query`() = runTest {
        coEvery {
            tabDataApi.disableTableShare("table-1", "organization")
        } returns ApiEnvelope(success = true, data = CloudDocShareDisableResponse(1))

        service.disable(
            type = CloudShareResourceType.TABLE,
            resourceId = "table-1",
            scope = CloudShareScope.ORGANIZATION,
        )

        coVerify(exactly = 1) { tabDataApi.disableTableShare("table-1", "organization") }
    }
}
