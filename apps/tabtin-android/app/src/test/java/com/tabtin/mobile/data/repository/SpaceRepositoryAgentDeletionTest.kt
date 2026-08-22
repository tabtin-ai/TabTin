package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class SpaceRepositoryAgentDeletionTest {
    private val contextApi = mockk<ContextApi>()
    private val repository = SpaceRepository(contextApi, mockk<TokenManager>(relaxed = true))

    @Test
    fun `deactivate accepts a successful envelope without data`() = runTest {
        coEvery { contextApi.deleteAgent("agent-1") } returns successWithoutData()

        repository.deleteAgent("agent-1")

        coVerify(exactly = 1) { contextApi.deleteAgent("agent-1") }
    }

    @Test
    fun `permanent delete accepts a successful envelope without data`() = runTest {
        coEvery { contextApi.permanentlyDeleteAgent("agent-1") } returns successWithoutData()

        repository.permanentlyDeleteAgent("agent-1")

        coVerify(exactly = 1) { contextApi.permanentlyDeleteAgent("agent-1") }
    }

    @Test
    fun `permanent delete still surfaces a failed envelope`() = runTest {
        coEvery { contextApi.permanentlyDeleteAgent("agent-1") } returns ApiEnvelope(
            success = false,
            data = null,
            message = "默认分身不可删除",
            code = "DEFAULT_AGENT_PROTECTED",
        )

        try {
            repository.permanentlyDeleteAgent("agent-1")
            fail("expected deletion failure")
        } catch (error: AppError.RequestFailed) {
            assertEquals("默认分身不可删除", error.serverMessage)
            assertEquals("DEFAULT_AGENT_PROTECTED", error.errorCode)
        }
    }

    private fun successWithoutData(): ApiEnvelope<JsonObject> = ApiEnvelope(
        success = true,
        data = null,
    )
}
