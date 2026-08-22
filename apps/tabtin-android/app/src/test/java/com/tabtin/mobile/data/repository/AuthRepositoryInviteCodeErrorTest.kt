package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.AppError
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class AuthRepositoryInviteCodeErrorTest {

    @Test
    fun `http rate limit envelope becomes a localized invite error`() {
        val response = Response.error<Any>(
            429,
            """{
                "success": false,
                "code": "RATE_LIMITED",
                "message": "请求频率过高，请稍后再试"
            }""".trimIndent().toResponseBody("application/json".toMediaType()),
        )
        val error = inviteCodeRedeemError(HttpException(response))

        assertEquals(AppError.InviteCodeRateLimited, error)
    }

    @Test
    fun `legacy success status rate limit envelope stays readable`() {
        val error = inviteCodeRedeemError(
            AppError.RequestFailed(
                serverMessage = "auth.rate_limited",
                errorCode = "RATE_LIMITED",
            ),
        )

        assertEquals(AppError.InviteCodeRateLimited, error)
    }
}
