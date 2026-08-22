package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.AppError
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class DocRepositoryQuotaErrorTest {

    @Test
    fun `document limit error preserves server usage details`() {
        val data = Json.parseToJsonElement("""{"quotaKey":"max_documents","used":10,"limit":10}""")

        val error = documentQuotaExceededFromApiError(
            errorCode = DOCUMENT_LIMIT_EXCEEDED_CODE,
            data = data,
            serverMessage = "当前套餐文档额度已用完",
        )

        assertEquals(
            AppError.DocumentQuotaExceeded(
                used = 10,
                limit = 10,
                serverMessage = "当前套餐文档额度已用完",
            ),
            error,
        )
    }

    @Test
    fun `other api failures remain generic`() {
        assertNull(
            documentQuotaExceededFromApiError(
                errorCode = "PERMISSION_DENIED",
            ),
        )
    }

    @Test
    fun `http 403 payload is converted before the generic error reaches UI`() {
        val response = Response.error<Any>(
            403,
            """{
                "success": false,
                "code": "ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED",
                "message": "当前套餐文档额度已用完",
                "data": {"quotaKey": "max_documents", "used": 10, "limit": 10}
            }""".trimIndent().toResponseBody("application/json".toMediaType()),
        )

        val error = documentQuotaExceededFromHttpException(HttpException(response))

        assertEquals(
            AppError.DocumentQuotaExceeded(
                used = 10,
                limit = 10,
                serverMessage = "当前套餐文档额度已用完",
            ),
            error,
        )
    }
}
