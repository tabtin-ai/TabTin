package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CreateOrganizationRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class OrganizationRepositoryMutationErrorTest {

    @Test
    fun `create organization error preserves server message and code`() {
        val response = Response.error<Any>(
            400,
            """{
                "success": false,
                "code": "ORGANIZATION_LIMIT_EXCEEDED",
                "message": "每个用户最多可创建 3 个组织，当前已达到上限"
            }""".trimIndent().toResponseBody("application/json".toMediaType()),
        )

        val error = organizationMutationError(HttpException(response))

        assertEquals(
            AppError.RequestFailed(
                serverMessage = "每个用户最多可创建 3 个组织，当前已达到上限",
                errorCode = "ORGANIZATION_LIMIT_EXCEEDED",
            ),
            error,
        )
    }

    @Test
    fun `nonstandard error body falls back without exposing http status`() {
        val response = Response.error<Any>(
            400,
            "bad request".toResponseBody("text/plain".toMediaType()),
        )

        val error = organizationMutationError(HttpException(response))

        assertNull(error.serverMessage)
        assertNull(error.errorCode)
        assertNull(error.message)
    }

    @Test
    fun `minimal create request omits empty optional fields`() {
        val payload = Json.encodeToString(
            CreateOrganizationRequest(
                name = "十月份",
                description = null,
                icon = null,
            ),
        )

        val jsonObject = Json.parseToJsonElement(payload).jsonObject
        assertEquals("{\"name\":\"十月份\"}", payload)
        assertNull(jsonObject["description"])
        assertNull(jsonObject["icon"])
    }
}
